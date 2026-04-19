"""USB webcam capture on the Pi.

Runs a background grabber thread so the MJPEG server always serves the freshest
frame without blocking on V4L2 reads. Stale frames are dropped — we never queue
up a backlog, which is important because the Pi 3B can't process frames faster
than it captures them and we'd just build latency.

The Pi is a dumb camera proxy (see writeup/CLAUDE.md): no color conversion,
no resizing beyond what the V4L2 pipeline negotiates, no inference. JPEG
encoding happens in `mjpeg_server.py` so we can cache one encoded frame and
fan it out to multiple subscribers.
"""
from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass

import cv2
import numpy as np

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class Frame:
    image: np.ndarray  # BGR, shape (H, W, 3)
    timestamp: float  # time.monotonic() when captured
    index: int  # monotonic counter of frames captured


class Webcam:
    def __init__(
        self,
        device: int = 0,
        width: int = 640,
        height: int = 480,
        fps: int = 15,
    ) -> None:
        self._device = device
        self._width = width
        self._height = height
        self._fps = fps
        self._cap: cv2.VideoCapture | None = None
        self._lock = threading.Lock()
        self._cond = threading.Condition(self._lock)
        self._latest: Frame | None = None
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._count = 0

    def start(self) -> None:
        # V4L2 is the sane default on Linux; fall back to ANY if unavailable.
        self._cap = cv2.VideoCapture(self._device, cv2.CAP_V4L2)
        if not self._cap.isOpened():
            self._cap = cv2.VideoCapture(self._device)
        if not self._cap.isOpened():
            raise RuntimeError(f"could not open video device {self._device}")

        # MJPG pixel format: the C270 delivers hardware-compressed MJPEG which
        # is dramatically cheaper on a Pi 3B than raw YUYV. We decode once here
        # to BGR, then re-encode to JPEG at the server layer. Net win: the USB
        # bus carries MJPEG frames and the Pi doesn't saturate.
        fourcc = cv2.VideoWriter_fourcc(*"MJPG")
        self._cap.set(cv2.CAP_PROP_FOURCC, fourcc)
        self._cap.set(cv2.CAP_PROP_FRAME_WIDTH, self._width)
        self._cap.set(cv2.CAP_PROP_FRAME_HEIGHT, self._height)
        self._cap.set(cv2.CAP_PROP_FPS, self._fps)
        self._cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)

        actual_w = int(self._cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        actual_h = int(self._cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        actual_fps = self._cap.get(cv2.CAP_PROP_FPS)
        log.info(
            "opened device %s at %sx%s @ %.1f fps",
            self._device, actual_w, actual_h, actual_fps,
        )

        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="webcam-grabber", daemon=True)
        self._thread.start()

    def _run(self) -> None:
        assert self._cap is not None
        failures = 0
        while not self._stop.is_set():
            ok, img = self._cap.read()
            if not ok:
                failures += 1
                if failures % 30 == 1:
                    log.warning("cv2.VideoCapture.read() failed (count=%d)", failures)
                time.sleep(0.01)
                continue
            failures = 0
            frame = Frame(image=img, timestamp=time.monotonic(), index=self._count)
            self._count += 1
            with self._cond:
                self._latest = frame
                self._cond.notify_all()

    def get(self, max_age_s: float | None = None) -> Frame | None:
        """Most recent frame, or None if none captured yet / stale."""
        with self._lock:
            f = self._latest
        if f is None:
            return None
        if max_age_s is not None and time.monotonic() - f.timestamp > max_age_s:
            return None
        return f

    def wait_next(self, after_index: int, timeout_s: float = 1.0) -> Frame | None:
        """Block until a frame newer than `after_index` arrives, or timeout.

        Used by the MJPEG server's per-client send loop so it sleeps on the
        grabber instead of polling. Returns None on timeout so callers can
        periodically check connection state.
        """
        deadline = time.monotonic() + timeout_s
        with self._cond:
            while True:
                f = self._latest
                if f is not None and f.index > after_index:
                    return f
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return None
                self._cond.wait(timeout=remaining)

    def stop(self) -> None:
        self._stop.set()
        with self._cond:
            self._cond.notify_all()
        if self._thread is not None:
            self._thread.join(timeout=1.0)
        if self._cap is not None:
            self._cap.release()
            self._cap = None

    def __enter__(self) -> "Webcam":
        self.start()
        return self

    def __exit__(self, *exc) -> None:
        self.stop()
