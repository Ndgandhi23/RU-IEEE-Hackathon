"""Approach-phase control loop: orchestrates OWLv2 (fast) + Qwen3-VL (slow).

Each call to `step(frame)` returns one discrete `Action` for the motor layer
to execute. The state machine calls this every tick during the combined
SEARCHING/APPROACHING phases.

Fast path (OWLv2 finds the target):
    bbox area  > STOP_AREA_FRAC * frame_area  →  STOP
    |err_frac| < ALIGN_TOLERANCE               →  FORWARD
    bbox left of center                        →  LEFT
    bbox right of center                       →  RIGHT

Slow path (OWLv2 returns nothing):
    If a search rotation is already queued, continue rotating.
    Otherwise call the VLM once, queue `SEARCH_FRAMES` rotation ticks in the
    direction the VLM returns, then resume at the top.

The VLM is called at most once per SEARCH_FRAMES-long burst — that's what
keeps the ~1 Hz VLM from bottlenecking the ~10 Hz outer loop.
"""
from __future__ import annotations

from enum import Enum

import numpy as np

from brain.perception.target_finder import TargetFinder
from brain.perception.vlm_scout import VLMScout


class Action(str, Enum):
    FORWARD = "forward"
    LEFT = "left"
    RIGHT = "right"
    STOP = "stop"
    SEARCH_LEFT = "search_left"
    SEARCH_RIGHT = "search_right"


# Tuning constants
STOP_AREA_FRAC = 0.15      # fraction of frame area that triggers STOP
ALIGN_TOLERANCE = 0.15     # |err_frac| ≤ this → drive FORWARD instead of turning
SEARCH_FRAMES = 15         # how many rotation ticks per VLM scout call


class ApproachController:
    def __init__(
        self,
        target_finder: TargetFinder,
        vlm_scout: VLMScout,
        reference_photo: np.ndarray | str,
        reporter_photo: np.ndarray | str,
        stop_area_frac: float = STOP_AREA_FRAC,
        align_tolerance: float = ALIGN_TOLERANCE,
        search_frames: int = SEARCH_FRAMES,
    ) -> None:
        self.target_finder = target_finder
        self.vlm_scout = vlm_scout
        self.reference_photo = reference_photo
        self.reporter_photo = reporter_photo
        self.stop_area_frac = stop_area_frac
        self.align_tolerance = align_tolerance
        self.search_frames = search_frames

        self._search_remaining = 0
        self._search_direction: str | None = None

    def step(self, frame: np.ndarray) -> Action:
        """Decide what the robot should do this tick. Pure function of inputs
        + the internal search-burst counter."""
        h, w = frame.shape[:2]
        frame_area = h * w

        detections = self.target_finder.detect(frame)

        # --- Fast path: OWLv2 sees the target ---
        if detections:
            # Cancel any ongoing search rotation — we found it.
            self._search_remaining = 0
            self._search_direction = None

            top = detections[0]
            x1, y1, x2, y2 = top.xyxy
            bbox_area = max(0, x2 - x1) * max(0, y2 - y1)
            if bbox_area / frame_area > self.stop_area_frac:
                return Action.STOP

            cx = (x1 + x2) / 2.0
            err_frac = (cx - w / 2.0) / (w / 2.0)
            if abs(err_frac) < self.align_tolerance:
                return Action.FORWARD
            return Action.RIGHT if err_frac > 0 else Action.LEFT

        # --- Slow path: still rotating from a prior VLM scout ---
        if self._search_remaining > 0:
            self._search_remaining -= 1
            return (
                Action.SEARCH_LEFT if self._search_direction == "left"
                else Action.SEARCH_RIGHT
            )

        # --- Slow path: query the VLM for a fresh direction ---
        result = self.vlm_scout.scout(frame, self.reference_photo, self.reporter_photo)
        self._search_direction = result.direction
        # This tick counts as the first rotation frame; queue the remaining.
        self._search_remaining = self.search_frames - 1
        return (
            Action.SEARCH_LEFT if result.direction == "left"
            else Action.SEARCH_RIGHT
        )
