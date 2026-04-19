"""Brain-side nearby-pickup demo: Pi camera -> hybrid perception -> Pi motors.

Scope: the minimal end-to-end loop described in HANDOFF.md Section 6. This is
not the full state machine yet (IDLE -> PLANNING -> NAVIGATING -> ...); that
wraps this controller and is future work. Today this script assumes the robot
is already near the target and just needs to find, approach, scoop, and stop.

    python -m brain.main --pi-ip 192.168.1.42 \
        --reference ref_crop.jpg --context wider.jpg

Flags:
    --pi-ip HOST           IP of the Pi on the LAN. Required for robot runs.
    --reference PATH       tight crop of the target trash item.
    --context PATH         wider reporter photo with surroundings (for VLM scout).
    --dry-run              print PWM commands instead of sending them.
    --webcam N             use local webcam N instead of the Pi's MJPEG feed.
    --rate-hz F            target loop frequency. Default 10 Hz.
    --no-4bit              skip Qwen3-VL 4-bit quant.

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
from brain.perception.vlm_scout import DEFAULT_MODEL as VLM_DEFAULT, VLMScout
from brain.perception.yolo_finder import YoloFinder

log = logging.getLogger("brain.main")


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    ap = argparse.ArgumentParser(prog="python -m brain.main")
    ap.add_argument(
        "--pi-ip",
        type=str,
        default=None,
        help="Pi IP on the LAN. Required unless --dry-run is set.",
    )
    ap.add_argument(
        "--reference",
        type=Path,
        required=True,
        help="tight crop of the target trash item",
    )
    ap.add_argument(
        "--context",
        type=Path,
        required=True,
        help="wider reporter photo with surroundings",
    )
    ap.add_argument(
        "--dry-run",
        action="store_true",
        help="print PWM commands instead of sending them",
    )
    ap.add_argument(
        "--webcam",
        type=int,
        default=None,
        help="use local webcam index N instead of Pi MJPEG",
    )
    ap.add_argument(
        "--rate-hz",
        type=float,
        default=10.0,
        help="target loop frequency (default 10 Hz)",
    )
    ap.add_argument(
        "--yolo-weights",
        type=Path,
        default=Path("models/trash_v1.pt"),
        help="path to YOLO weights (default: models/trash_v1.pt)",
    )
    ap.add_argument(
        "--yolo-min-conf",
        type=float,
        default=0.5,
        help="YOLO detection confidence floor (default 0.5)",
    )
    ap.add_argument("--vlm-model", default=VLM_DEFAULT)
    ap.add_argument(
        "--no-4bit",
        action="store_true",
        help="disable Qwen3-VL 4-bit quant",
    )
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

    for label, path in (("reference", args.reference), ("context", args.context)):
        if not path.exists():
            log.error("%s image not found: %s", label, path)
            return 2

    if not args.dry_run and args.pi_ip is None:
        log.error("--pi-ip is required unless --dry-run is set")
        return 2
    if args.webcam is None and args.pi_ip is None:
        log.error("either --webcam N or --pi-ip HOST must be provided")
        return 2

    log.info("loading YOLO (%s, min_conf=%.2f)", args.yolo_weights, args.yolo_min_conf)
    finder = YoloFinder(weights=args.yolo_weights, min_conf=args.yolo_min_conf)

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
                time.sleep(0.01)
                continue
            last_idx = frame_pkt.index

            action: Action = controller.step(frame_pkt.image)
            left, right = pwm_for(action)

            if pi_bridge is not None:
                pi_bridge.set_motors(left, right)

            log.info(
                "frame=%d phase=%s action=%s pwm=(%+d,%+d)%s",
                frame_pkt.index,
                controller.phase.value,
                action.name,
                left,
                right,
                "  [dry-run]" if pi_bridge is None else "",
            )

            if controller.pickup_complete:
                log.info("pickup verified; ending nearby-pickup loop")
                stop_flag[0] = True

            elapsed = time.monotonic() - tick
            sleep_for = period - elapsed
            if sleep_for > 0:
                time.sleep(sleep_for)
    finally:
        log.info("stopping; zeroing motors")
        if pi_bridge is not None:
            try:
                pi_bridge.stop_motors()
                time.sleep(0.05)
            finally:
                pi_bridge.stop()
        frame_source.stop()
    return 0


if __name__ == "__main__":
    sys.exit(_main())
