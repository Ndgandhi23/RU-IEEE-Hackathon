"""Entry point: `python -m pi.camera_streamer`.

Opens the USB webcam and serves it as MJPEG on :8080 for the brain machine.
Can also run in upload mode so another device posts fresh image files to the Pi,
while the downstream classifier keeps reading the same MJPEG endpoint.
Contract (from writeup/CLAUDE.md):

    GET http://<pi-ip>:8080/stream.mjpg   # multipart/x-mixed-replace MJPEG

The brain's perception module reads this URL in place of a local webcam and
feeds the frames into `brain.perception.detector.Detector` — the same class
`demo.py` uses for the laptop smoke-test.

Flags deliberately mirror `tools/live_detect.py` (--device, --width, --height)
so muscle memory transfers between the laptop and the Pi.
"""
from __future__ import annotations

import argparse
import logging
import signal
import sys
import time
from types import FrameType

from .mjpeg_server import MjpegServer
from .webcam import Webcam


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        prog="python -m pi.camera_streamer",
        description="Serve Pi camera frames as MJPEG, either from a USB webcam or from uploaded image files.",
    )
    p.add_argument(
        "--source",
        choices=("webcam", "upload"),
        default="webcam",
        help="frame source mode (default webcam)",
    )
    p.add_argument("--device", type=int, default=0, help="V4L2 device index (default 0 = /dev/video0)")
    p.add_argument("--width", type=int, default=640, help="capture width in pixels (default 640)")
    p.add_argument("--height", type=int, default=480, help="capture height in pixels (default 480)")
    p.add_argument("--fps", type=int, default=15, help="requested capture FPS (default 15)")
    p.add_argument("--host", type=str, default="0.0.0.0", help="bind address (default 0.0.0.0)")
    p.add_argument("--port", type=int, default=8080, help="MJPEG HTTP port (default 8080)")
    p.add_argument("--quality", type=int, default=80, help="JPEG quality 1-100 (default 80)")
    p.add_argument(
        "--accept-uploads",
        action="store_true",
        help="enable POST /upload while using webcam mode (latest upload wins until the next webcam frame)",
    )
    p.add_argument("--warmup-s", type=float, default=1.0, help="seconds to wait for first frame before serving")
    p.add_argument("-v", "--verbose", action="store_true", help="DEBUG-level logging")
    return p.parse_args(argv)


def _install_signal_handlers(stop_flag: list[bool]) -> None:
    def _handle(signum: int, _frame: FrameType | None) -> None:
        logging.getLogger(__name__).info("received signal %s, shutting down", signum)
        stop_flag[0] = True

    signal.signal(signal.SIGINT, _handle)
    # SIGTERM isn't available on Windows; guard for portability during dev.
    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, _handle)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    log = logging.getLogger("pi.camera_streamer")

    stop_flag = [False]
    _install_signal_handlers(stop_flag)

    cam = Webcam(
        device=args.device if args.source == "webcam" else None,
        width=args.width,
        height=args.height,
        fps=args.fps,
    )
    if args.source == "webcam":
        try:
            cam.start()
        except RuntimeError as e:
            log.error("failed to open webcam: %s", e)
            return 1

        # Wait for a first frame so /stream.mjpg doesn't open just to stall.
        deadline = time.monotonic() + args.warmup_s
        while cam.get() is None and time.monotonic() < deadline:
            time.sleep(0.05)
        if cam.get() is None:
            log.warning(
                "no frame after %.1fs warmup; serving anyway, health endpoint will flag it",
                args.warmup_s,
            )
    else:
        log.info(
            "upload mode enabled; POST a JPEG/PNG/WebP file to http://%s:%d/upload",
            args.host,
            args.port,
        )

    server = MjpegServer(
        cam=cam,
        host=args.host,
        port=args.port,
        jpeg_quality=args.quality,
        upload_enabled=args.source == "upload" or args.accept_uploads,
    )
    try:
        server.start()
    except OSError as e:
        log.error("failed to bind %s:%d — %s", args.host, args.port, e)
        cam.stop()
        return 1

    try:
        while not stop_flag[0]:
            time.sleep(0.25)
    finally:
        log.info("stopping server and camera")
        server.stop()
        cam.stop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
