"""YOLO-backed target finder. Drop-in replacement for TargetFinder.

Use this when the demo scene has one target and you want the trained
`models/trash_v1.pt` (mAP 0.98 on bottle/can, 100+ FPS on a 4080) instead
of OWLv2's image-conditioned matching — which struggles with transparent
objects like water bottles because the query embedding gets dominated
by whatever the bottle is sitting on.

Trade-off: YOLO finds ANY bottle/can. If the scene has multiple candidates
and you need to disambiguate to the one in the reporter's photo, use
TargetFinder (OWLv2 image-guided) instead.

Same interface as TargetFinder so ApproachController works unchanged.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np

from brain.perception.detector import Detector
from brain.perception.types import Detection

DEFAULT_WEIGHTS = "models/trash_v1.pt"
DEFAULT_CLASSES = ("bottle", "can")


class YoloFinder:
    def __init__(
        self,
        weights: str | Path = DEFAULT_WEIGHTS,
        classes: tuple[str, ...] = DEFAULT_CLASSES,
        min_conf: float = 0.5,
    ) -> None:
        self._det = Detector(weights, conf=min_conf)
        self.classes = set(classes)
        self.min_conf = min_conf
        # Aliases so reports written against TargetFinder's surface still work.
        self.min_sim = min_conf
        self.device = "cuda"
        self._query = True  # sentinel — YOLO needs no reference image

    def load_reference(self, _ref) -> None:
        """No-op. Kept for API parity with TargetFinder."""

    def detect(self, frame: np.ndarray) -> list[Detection]:
        dets = self._det.detect(frame)
        return [d for d in dets
                if d.class_name in self.classes and d.confidence >= self.min_conf]
