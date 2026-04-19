"""Glue between the Pi's MJPEG camera stream and the brain's YOLO classifier.

- `pi_stream.MjpegClient` pulls frames from `http://<pi-ip>:8080/stream.mjpg`
  (or the localhost dev equivalent) and exposes per-frame metadata for
  debugging: Pi-side frame index, Pi capture timestamp, byte size.
- `run_classifier` (runnable as `python -m connector.run_classifier ...`) wires
  that client into `brain.perception.detector.Detector` and optionally
  displays a debug preview + saves frames.

See `connector/README.md` for usage.
"""
from __future__ import annotations

from .pi_stream import MjpegClient, StreamFrame

__all__ = ["MjpegClient", "StreamFrame"]
