"""Pi-side camera capture and MJPEG transmission.

See `writeup/CLAUDE.md` for the big picture: this is the transmit half of the
Pi's camera proxy. The brain machine (Mac, later Jetson) connects to
`http://<pi-ip>:8080/stream.mjpg` and feeds frames into the same YOLO
`Detector` used by `demo.py`.
"""
from __future__ import annotations

from .mjpeg_server import MjpegServer
from .webcam import Frame, Webcam

__all__ = ["Frame", "MjpegServer", "Webcam"]
