"""Brain-side approach demo: Pi camera → hybrid perception → Pi motors.

Scope: the minimal end-to-end loop described in HANDOFF.md § Step 6. This is
**not** the full state machine yet (IDLE → PLANNING → NAVIGATING → ...) —
that wraps this controller and is future work. Today this script assumes the
robot is already near the target and just needs to find + approach + stop.

    python -m brain.main --pi-ip 192.168.1.42 \\
        --reference ref_crop.jpg --context wider.jpg

Flags:
    --pi-ip HOST           IP of the Pi on the LAN. Required for robot runs.
    --reference PATH       tight crop of the target trash item (reporter photo).
    --context   PATH       wider reporter photo with surroundings (for VLM scout).
    --dry-run              print PWM commands instead of sending them (no Pi needed).
    --webcam N             use local webcam N instead of the Pi's MJPEG feed
                           (useful when the Pi is offline; combine with --dry-run
                           for a hardware-free dress rehearsal).
    --rate-hz F            target loop frequency. Default 10 Hz.
    --no-4bit              skip Qwen3-VL 4-bit quant (likely OOMs on a 4080).

On SIGINT / SIGTERM: motors are zeroed before exit.
"""
from __future__ import annotations

import argparse
import logging
import signal
import sys
import time
from pathlib import Path
from types import FrameType

from brain.control.action_to_pwm import pwm_for
from brain.control.loop import Action, ApproachController
from brain.io.pi_bridge import PiBridge
from brain.io.pi_frame_source import PiFrameSource, pi_url
from brain.io.webcam import Webcam
from brain.perception.target_finder import TargetFinder
from brain.perception.vlm_scout import DEFAULT_MODEL as VLM_DEFAULT, VLMScout

log = logging.getLogger("brain.main")


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    ap = argparse.ArgumentParser(prog="python -m brain.main")
    ap.add_argument("--pi-ip", type=str, default=None,
                    help="Pi IP on the LAN. Required unless --dry-run and --webcam are both set.")
    ap.add_argument("--reference", type=Path, required=True,
                    help="tight crop of the target trash item")
    ap.add_argument("--context", type=Path, required=True,
                    help="wider reporter photo with surroundings")
    ap.add_argument("--dry-run", action="store_true",
                    help="print PWM commands instead of sending them")
    ap.add_argument("--webcam", type=int, default=None,
                    help="use local webcam index N instead of Pi MJPEG")
    ap.add_argument("--rate-hz", type=float, default=10.0,
                    help="target loop frequency (default 10 Hz)")
    ap.add_argument("--owlv2-model", default="google/owlv2-base-patch16-ensemble")
    ap.add_argument("--vlm-model", default=VLM_DEFAULT)
    ap.add_argument("--torch-device", default=None,
                    help="force torch device for OWLv2 (cuda/mps/cpu)")
    ap.add_argument("--no-4bit", action="store_true",
                    help="disable Qwen3-VL 4-bit quant")
    ap.add_argument("-v", "--verbose", action="store_true")
    return ap.parse_args(argv)


def _install_signal_handlers(stop_flag: list[bool]) -> None:
    def _handle(signum: int, _frame: FrameType | None) -> None:
        log.info("received signal %s, shutting down", signum)
        stop_flag[0] = True

    signal.signal(signal.SIGINT, _handle)
    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, _handle)


def _main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    for label, p in (("reference", args.reference), ("context", args.context)):
        if not p.exists():
            log.error("%s image not found: %s", label, p)
            return 2

    if not args.dry_run and args.pi_ip is None:
        log.error("--pi-ip is required unless --dry-run is set")
        return 2
    if args.webcam is None and args.pi_ip is None:
        log.error("either --webcam N or --pi-ip HOST must be provided")
        return 2

    # ---- Perception ----
    log.info("loading OWLv2 (%s)", args.owlv2_model)
    finder = TargetFinder(model_name=args.owlv2_model, device=args.torch_device)
    log.info("OWLv2 on %s", finder.device)
    finder.load_reference(args.reference)

    log.info("loading VLMScout (%s, 4bit=%s)", args.vlm_model, not args.no_4bit)
    t0 = time.monotonic()
    scout = VLMScout(model_name=args.vlm_model, load_in_4bit=not args.no_4bit)
    log.info("VLM ready in %.1fs", time.monotonic() - t0)

    controller = ApproachController(
        target_finder=finder,
        vlm_scout=scout,
        reference_photo=str(args.reference),
        reporter_photo=str(args.context),
    )

    # ---- I/O ----
    frame_source: Webcam | PiFrameSource
    if args.webcam is not None:
        log.info("using local webcam %d as frame source", args.webcam)
        frame_source = Webcam(device=args.webcam)
    else:
        url = pi_url(args.pi_ip)
        log.info("using pi mjpeg stream %s", url)
        frame_source = PiFrameSource(url=url)

    pi_bridge: PiBridge | None = None
    if not args.dry_run:
        pi_bridge = PiBridge(host=args.pi_ip)

    stop_flag = [False]
    _install_signal_handlers(stop_flag)

    frame_source.start()
    if pi_bridge is not None:
        pi_bridge.start()

    last_idx = -1
    period = 1.0 / max(args.rate_hz, 0.1)
    try:
        while not stop_flag[0]:
            tick = time.monotonic()
            frame_pkt = frame_source.get(max_age_s=1.0)
            if frame_pkt is None or frame_pkt.index == last_idx:
                # No new frame yet — skip this tick. Don't send stale commands;
                # the Pi's 500 ms watchdog will zero motors if we go quiet.
                time.sleep(0.01)
                continue
            last_idx = frame_pkt.index

            action: Action = controller.step(frame_pkt.image)
            left, right = pwm_for(action)

            if pi_bridge is not None:
                pi_bridge.set_motors(left, right)

            log.info(
                "frame=%d action=%s pwm=(%+d,%+d)%s",
                frame_pkt.index, action.name, left, right,
                "  [dry-run]" if pi_bridge is None else "",
            )

            # Pace the loop.
            elapsed = time.monotonic() - tick
            sleep_for = period - elapsed
            if sleep_for > 0:
                time.sleep(sleep_for)
    finally:
        log.info("stopping; zeroing motors")
        if pi_bridge is not None:
            try:
                pi_bridge.stop_motors()
                # Give the send a moment to flush before we close the socket.
                time.sleep(0.05)
            finally:
                pi_bridge.stop()
        frame_source.stop()
    return 0


if __name__ == "__main__":
    sys.exit(_main())
