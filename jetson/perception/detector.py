"""YOLO inference wrapper. Loads the trained trash model once; exposes a typed detect() call.

The heavy TensorRT-on-Jetson work happens later (export_tensorrt.py). This module accepts
any format Ultralytics can load (.pt, .onnx, .engine), so the same code runs on laptop with
.pt and on Jetson with .engine.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np
from ultralytics import YOLO


@dataclass(frozen=True)
class Detection:
    class_id: int
    class_name: str
    confidence: float
    xyxy: tuple[int, int, int, int]  # pixel coords, top-left + bottom-right

    @property
    def center(self) -> tuple[int, int]:
        x1, y1, x2, y2 = self.xyxy
        return (x1 + x2) // 2, (y1 + y2) // 2

    @property
    def area(self) -> int:
        x1, y1, x2, y2 = self.xyxy
        return max(0, x2 - x1) * max(0, y2 - y1)


class Detector:
    def __init__(self, weights: str | Path, conf: float = 0.25, imgsz: int = 640) -> None:
        self._model = YOLO(str(weights))
        self._conf = conf
        self._imgsz = imgsz
        # model.names is dict[int, str]; snapshot to avoid per-call attribute access.
        self._names: dict[int, str] = dict(self._model.names)

    @property
    def names(self) -> dict[int, str]:
        return self._names

    def detect(self, frame: np.ndarray, conf: float | None = None) -> list[Detection]:
        """Run inference on a single BGR frame, return detections in descending confidence."""
        results = self._model.predict(
            frame,
            conf=conf if conf is not None else self._conf,
            imgsz=self._imgsz,
            verbose=False,
        )[0]
        out: list[Detection] = []
        if results.boxes is None:
            return out
        for b in results.boxes:
            cls_id = int(b.cls[0].item())
            c = float(b.conf[0].item())
            x1, y1, x2, y2 = (int(v) for v in b.xyxy[0].tolist())
            out.append(
                Detection(
                    class_id=cls_id,
                    class_name=self._names.get(cls_id, str(cls_id)),
                    confidence=c,
                    xyxy=(x1, y1, x2, y2),
                )
            )
        out.sort(key=lambda d: d.confidence, reverse=True)
        return out
