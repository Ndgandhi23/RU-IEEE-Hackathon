"""Shared perception types. Kept here (not detector.py) so pure-logic modules
like servo.py can import Detection without dragging in heavy deps (ultralytics,
torch) just to get the dataclass.
"""
from __future__ import annotations

from dataclasses import dataclass


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
