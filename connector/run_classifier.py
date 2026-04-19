"""Pull frames from the Pi's MJPEG stream and run the trash classifier on each.

The classifier is **gated** on arrival: we don't open the MJPEG connection
until the robot has reached the final Apple Maps waypoint. See `gate.py`.

Run as:
    python -m connector.run_classifier --weights models/trash_v1.pt
    python -m connector.run_classifier --url http://<pi-ip>:8080/stream.mjpg --weights ...

Gating (default: manual flag file):
    --gate relay --relay-url http://localhost:4000       # prod: relay tells us when we've arrived
    --gate manual --manual-gate-file arrived.flag        # dev: touch the file to open
    --gate always                                        # bypass — stream all the time (legacy)

Debugging helpers
-----------------
  --save-dir PATH       Dump received frames to disk (faithful, no re-encode).
  --save-every N        With --save-dir, save every Nth frame (default 15).
  --log-every N         Print a stats line every N frames (default 30).
  --no-display          Headless; don't open the OpenCV preview window.
  -v                    DEBUG-level logs.

Preview window keys: `q` = quit, `s` = save the current frame.
"""
from __future__ import annotations

import argparse
import logging
import signal
import sys
import time
from collections import deque
from pathlib import Path
from types import FrameType

import cv2
import numpy as np

# Let `python -m connector.run_classifier` import the repo's brain/ package
# even if the user hasn't set PYTHONPATH.
_REPO_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from brain.perception.detector import Detection, Detector  # noqa: E402

from .gate import AlwaysOpenGate, Gate, ManualFileGate, RelayArrivalGate
from .pi_stream import MjpegClient, StreamFrame


# Per-class BGR colors, mirroring tools/live_detect.py so the preview feels familiar.
_COLORS = [
    (0, 200, 0),      # bottle  — green
    (0, 200, 255),    # cup     — yellow
    (255, 150, 0),    # can     — blue
    (255, 0, 200),    # wrapper — magenta
    (200, 200, 200),  # paper   — light gray
]


def _draw_overlay(
    canvas,
    detections: list[Detection],
    fps: float,
    sf: StreamFrame,
    recv_latency_s: float | None,
) -> None:
    for d in detections:
        x1, y1, x2, y2 = d.xyxy
        color = _COLORS[d.class_id % len(_COLORS)]
        cv2.rectangle(canvas, (x1, y1), (x2, y2), color, 2)
        label = f"{d.class_name} {d.confidence:.2f}"
        (tw, th), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.6, 2)
        cv2.rectangle(canvas, (x1, y1 - th - 8), (x1 + tw + 4, y1), color, -1)
        cv2.putText(canvas, label, (x1 + 2, y1 - 4), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 0), 2)

    kb = sf.size_bytes / 1024.0
    lat_s = f"{recv_latency_s * 1000:.0f}ms" if recv_latency_s is not None else "—"
    hud = f"{fps:5.1f} fps | {kb:6.1f} KB | pi_idx={sf.index} | Δrecv={lat_s} | dets={len(detections)}"
    cv2.putText(canvas, hud, (10, 28), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 0, 0), 3)
    cv2.putText(canvas, hud, (10, 28), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 0), 2)


def _draw_idle(title: str, reason: str) -> np.ndarray:
    """A 640x360 placeholder shown while the gate is closed, so the preview
    window stays responsive and tells the user what's going on."""
    canvas = np.zeros((360, 640, 3), dtype=np.uint8)
    canvas[:] = (28, 28, 28)
    cv2.putText(canvas, title, (20, 60), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (180, 180, 180), 2)
    cv2.putText(canvas, "waiting for arrival before opening stream...", (20, 110),
                cv2.FONT_HERSHEY_SIMPLEX, 0.7, (120, 120, 120), 1)
    # Wrap `reason` so long strings don't overrun.
    wrap = 50
    lines = [reason[i:i + wrap] for i in range(0, len(reason), wrap)] or ["(no reason yet)"]
    for i, line in enumerate(lines[:6]):
        cv2.putText(canvas, line, (20, 160 + i * 30), cv2.FONT_HERSHEY_SIMPLEX, 0.6,
                    (200, 200, 80), 1)
    return canvas


def _install_sigint(stop_flag: list[bool]) -> None:
    def handle(_sig: int, _frame: FrameType | None) -> None:
        stop_flag[0] = True

    signal.signal(signal.SIGINT, handle)
    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, handle)


def _parse_args(argv: list[str] | None) -> argparse.Namespace:
    ap = argparse.ArgumentParser(
        prog="python -m connector.run_classifier",
        description="Consume the Pi's MJPEG stream and run the trash classifier on each frame.",
    )
    ap.add_argument(
        "--url",
        default="http://127.0.0.1:8080/stream.mjpg",
        help="Pi MJPEG URL (default http://127.0.0.1:8080/stream.mjpg)",
    )
    ap.add_argument("--weights", required=True, type=Path,
                    help="path to trained .pt/.onnx/.engine (YOLO)")
    ap.add_argument("--conf", type=float, default=0.25, help="min detection confidence")
    ap.add_argument("--imgsz", type=int, default=640, help="YOLO inference size")

    # Gating — only stream once we've arrived at the task destination.
    ap.add_argument(
        "--gate",
        choices=("manual", "relay", "always"),
        default="manual",
        help="when to consume frames. "
             "manual: open while a flag file exists (dev). "
             "relay:  poll the relay's /robot/packet and open when within arrival threshold. "
             "always: never gate (legacy — stream constantly).",
    )
    ap.add_argument("--relay-url", default="http://127.0.0.1:4000",
                    help="relay base URL (for --gate relay; default http://127.0.0.1:4000)")
    ap.add_argument("--arrival-threshold-m", type=float, default=10.0,
                    help="relay gate opens when robot is within this many meters of the task destination (default 10.0 — generous for consumer phone GPS; tighten for precise arrival)")
    ap.add_argument("--manual-gate-file", type=Path, default=Path("arrived.flag"),
                    help="manual gate is open while this path exists (default ./arrived.flag)")
    ap.add_argument("--gate-poll-s", type=float, default=1.0,
                    help="how often the relay gate polls the relay (default 1.0s)")

    ap.add_argument("--no-display", action="store_true",
                    help="headless — don't open a preview window")
    ap.add_argument("--save-dir", type=Path, default=None,
                    help="if set, write received JPEGs to this directory (no re-encode)")
    ap.add_argument("--save-every", type=int, default=15,
                    help="with --save-dir, save every Nth frame (default 15)")
    ap.add_argument("--log-every", type=int, default=30,
                    help="print one stats line every N frames (default 30)")
    ap.add_argument("-v", "--verbose", action="store_true", help="DEBUG-level logging")
    return ap.parse_args(argv)


def _build_gate(args: argparse.Namespace) -> Gate:
    if args.gate == "always":
        return AlwaysOpenGate()
    if args.gate == "manual":
        return ManualFileGate(args.manual_gate_file)
    if args.gate == "relay":
        return RelayArrivalGate(
            relay_url=args.relay_url,
            arrival_threshold_m=args.arrival_threshold_m,
            poll_interval_s=args.gate_poll_s,
        )
    raise ValueError(f"unknown gate: {args.gate}")


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    log = logging.getLogger("connector")

    if not args.weights.exists():
        log.error("weights not found: %s", args.weights)
        return 1

    save_dir: Path | None = args.save_dir
    if save_dir is not None:
        save_dir.mkdir(parents=True, exist_ok=True)
        log.info("saving every %dth frame to %s", args.save_every, save_dir)

    log.info("loading model: %s", args.weights)
    detector = Detector(str(args.weights), conf=args.conf, imgsz=args.imgsz)
    log.info("classes: %s", detector.names)

    stop = [False]
    _install_sigint(stop)

    gate = _build_gate(args)
    gate.start()
    log.info("gate=%s initial=%s reason=%s",
             type(gate).__name__, "OPEN" if gate.is_open() else "CLOSED", gate.reason())

    client = MjpegClient(args.url)

    # Rolling FPS window over the last ~30 frames.
    dts: deque[float] = deque(maxlen=30)
    t_prev = time.monotonic()
    count = 0
    saved = 0
    first_pi_ts: float | None = None
    first_local_ts: float | None = None

    try:
        while not stop[0]:
            # --- idle: wait for gate to open ---
            if not gate.is_open():
                if not args.no_display:
                    canvas = _draw_idle("gate closed (not arrived yet)", gate.reason())
                    cv2.imshow("pi stream  (q quit, s save)", canvas)
                    key = cv2.waitKey(200) & 0xFF
                    if key == ord("q"):
                        stop[0] = True
                else:
                    time.sleep(0.5)
                continue

            log.info("gate open — starting stream consumption (%s)", gate.reason())
            # Reset latency anchor for each streaming session so latency stats
            # are accurate across reconnects / gate reopens.
            first_pi_ts = None
            first_local_ts = None
            dts.clear()
            t_prev = time.monotonic()

            # --- active: consume one stream session ---
            try:
                for sf in client.frames():
                    if stop[0]:
                        break
                    if not gate.is_open():
                        log.info("gate closed mid-stream (%s) — disconnecting", gate.reason())
                        break

                    now = time.monotonic()
                    dts.append(now - t_prev)
                    t_prev = now
                    fps = len(dts) / sum(dts) if sum(dts) > 0 else 0.0

                    recv_latency_s: float | None = None
                    if sf.pi_timestamp > 0.0:
                        if first_pi_ts is None:
                            first_pi_ts = sf.pi_timestamp
                            first_local_ts = now
                        elif first_local_ts is not None:
                            pi_elapsed = sf.pi_timestamp - first_pi_ts
                            local_elapsed = now - first_local_ts
                            recv_latency_s = max(0.0, local_elapsed - pi_elapsed)

                    detections = detector.detect(sf.image)
                    count += 1

                    if save_dir is not None and count % max(1, args.save_every) == 0:
                        out = save_dir / f"frame_{count:06d}_idx{sf.index}.jpg"
                        out.write_bytes(sf.jpeg)
                        saved += 1

                    if count % max(1, args.log_every) == 0:
                        dets_str = ", ".join(
                            f"{d.class_name}({d.confidence:.2f})" for d in detections[:3]
                        ) or "-"
                        lat_ms = f"{recv_latency_s * 1000:.0f}ms" if recv_latency_s is not None else "-"
                        log.info(
                            "n=%d fps=%.1f KB=%.1f pi_idx=%d recv_lat=%s dets=[%s]",
                            count, fps, sf.size_bytes / 1024.0, sf.index, lat_ms, dets_str,
                        )

                    if not args.no_display:
                        canvas = sf.image.copy()
                        _draw_overlay(canvas, detections, fps, sf, recv_latency_s)
                        cv2.imshow("pi stream  (q quit, s save)", canvas)
                        key = cv2.waitKey(1) & 0xFF
                        if key == ord("q"):
                            stop[0] = True
                            break
                        if key == ord("s"):
                            if save_dir is None:
                                save_dir = Path.cwd() / "connector_saves"
                                save_dir.mkdir(parents=True, exist_ok=True)
                            out = save_dir / f"manual_{count:06d}_idx{sf.index}.jpg"
                            out.write_bytes(sf.jpeg)
                            log.info("saved %s", out)
                            saved += 1
            # MjpegClient.frames() handles its own errors, but if the generator
            # exits (e.g. server closes cleanly), we loop back to the gate check.
            finally:
                pass
    finally:
        gate.stop()
        if not args.no_display:
            cv2.destroyAllWindows()
        log.info("done. frames=%d saved=%d", count, saved)

    return 0


if __name__ == "__main__":
    sys.exit(main())
