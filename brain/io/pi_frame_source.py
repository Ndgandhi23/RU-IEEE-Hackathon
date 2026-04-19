"""Consume the Pi's MJPEG stream, expose the same Frame API as webcam.Webcam.

Drop-in swap for local development on a Mac webcam vs. the robot's Pi-mounted
C270: tools can switch between `Webcam(device=0)` and
`PiFrameSource(pi_url("192.168.1.42"))` without touching downstream code.

The Pi side of this link is `pi/camera_streamer/` (already shipped). Contract:
`GET http://<pi-ip>:8080/stream.mjpg` — multipart/x-mixed-replace MJPEG.
OpenCV reads that natively via cv2.VideoCapture, so this module is mostly a
background-thread wrapper + reconnect policy.
"""
from __future__ import annotations

import logging
import threading
import time

import cv2

from brain.io.webcam import Frame

log = logging.getLogger(__name__)

DEFAULT_PORT = 8080
RECONNECT_BACKOFF_S = 1.0
FRAME_READ_TIMEOUT_S = 2.0


def pi_url(host: str, port: int = DEFAULT_PORT) -> str:
    """Build the MJPEG URL for the Pi. Matches pi/camera_streamer's endpoint."""
    return f"http://{host}:{port}/stream.mjpg"


class PiFrameSource:
    """Background-thread MJPEG consumer. Same sync API as webcam.Webcam."""

    def __init__(self, url: str, reconnect_backoff_s: float = RECONNECT_BACKOFF_S) -> None:
        self._url = url
        self._reconnect_backoff_s = reconnect_backoff_s
        self._cap: cv2.VideoCapture | None = None
        self._lock = threading.Lock()
        self._latest: Frame | None = None
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._count = 0

    def start(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(
            target=self._run, name="pi-frame-source", daemon=True,
        )
        self._thread.start()

    def get(self, max_age_s: float | None = None) -> Frame | None:
        """Most recent frame, or None if nothing yet / stale."""
        with self._lock:
            f = self._latest
        if f is None:
            return None
        if max_age_s is not None and time.monotonic() - f.timestamp > max_age_s:
            return None
        return f

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=2.0)
            self._thread = None
        if self._cap is not None:
            self._cap.release()
            self._cap = None

    def __enter__(self) -> "PiFrameSource":
        self.start()
        return self

    def __exit__(self, *exc) -> None:
        self.stop()

    # ---------- internals ----------

    def _open(self) -> bool:
        cap = cv2.VideoCapture(self._url)
        if not cap.isOpened():
            cap.release()
            return False
        # BUFFERSIZE=1 so we're reading live frames, not catching up on a backlog.
        # Some FFmpeg builds ignore this; harmless either way.
        cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        self._cap = cap
        log.info("pi frame source connected: %s", self._url)
        return True

    def _run(self) -> None:
        while not self._stop.is_set():
            if self._cap is None and not self._open():
                log.warning("pi mjpeg open failed (%s), retry in %.1fs",
                            self._url, self._reconnect_backoff_s)
                if self._stop.wait(self._reconnect_backoff_s):
                    return
                continue

            assert self._cap is not None
            ok, img = self._cap.read()
            if not ok:
                log.warning("pi mjpeg read failed, reconnecting")
                self._cap.release()
                self._cap = None
                continue

            frame = Frame(image=img, timestamp=time.monotonic(), index=self._count)
            self._count += 1
            with self._lock:
                self._latest = frame
