"""Async USB webcam capture. Grabs frames in a background thread; consumers read the latest frame.

Design: the C270 at 720p can't keep up with a main loop that also runs YOLO + nav.
Capturing in a thread decouples them — we always have the most recent frame, stale frames get dropped.
"""
from __future__ import annotations

import threading
import time
from dataclasses import dataclass

import cv2
import numpy as np


@dataclass(frozen=True)
class Frame:
    image: np.ndarray  # BGR, shape (H, W, 3)
    timestamp: float  # time.monotonic() when captured
    index: int  # monotonic counter of frames captured


class Webcam:
    def __init__(self, device: int = 0, width: int = 1280, height: int = 720, fps: int = 30) -> None:
        self._device = device
        self._width = width
        self._height = height
        self._fps = fps
        self._cap: cv2.VideoCapture | None = None
        self._lock = threading.Lock()
        self._latest: Frame | None = None
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._count = 0

    def start(self) -> None:
        self._cap = cv2.VideoCapture(self._device)
        if not self._cap.isOpened():
            raise RuntimeError(f"could not open video device {self._device}")
        self._cap.set(cv2.CAP_PROP_FRAME_WIDTH, self._width)
        self._cap.set(cv2.CAP_PROP_FRAME_HEIGHT, self._height)
        self._cap.set(cv2.CAP_PROP_FPS, self._fps)
        # Minimize buffering so we read the freshest frame.
        self._cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def _run(self) -> None:
        assert self._cap is not None
        while not self._stop.is_set():
            ok, img = self._cap.read()
            if not ok:
                time.sleep(0.01)
                continue
            frame = Frame(image=img, timestamp=time.monotonic(), index=self._count)
            self._count += 1
            with self._lock:
                self._latest = frame

    def get(self, max_age_s: float | None = None) -> Frame | None:
        """Most recent frame, or None if none captured yet / stale."""
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
            self._thread.join(timeout=1.0)
        if self._cap is not None:
            self._cap.release()
            self._cap = None

    def __enter__(self) -> "Webcam":
        self.start()
        return self

    def __exit__(self, *exc) -> None:
        self.stop()
