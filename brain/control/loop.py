"""Approach-phase control loop: nearby search, visual approach, scoop, verify.

Each call to ``step(frame)`` returns one discrete ``Action`` for the motor
layer. YOLO is the only perception used: detected -> approach; empty -> spin
right until YOLO picks up a box.

State flow:
    SEARCHING       -> spin right in place until YOLO sees a target
    APPROACHING     -> steer toward the top bottle/can detection
    SCOOP_PUSH      -> short low-speed forward shove into the passive scoop
    VERIFYING       -> hold still and confirm the target disappeared
    RECOVERING      -> short reverse to reset for another attempt
    COLLECTED       -> hold STOP forever

This stays intentionally discrete because the Pi contract is left/right PWM,
not velocity setpoints. ``servo.py`` still exists for future smooth-control
work, but the current field path is coarse actions plus timing.
"""
from __future__ import annotations

from enum import Enum
from typing import Protocol

import numpy as np

from brain.perception.types import Detection


class TargetDetector(Protocol):
    """Anything with a ``detect(frame) -> list[Detection]`` method satisfies this.

    Concrete implementations in this repo:
        brain.perception.yolo_finder.YoloFinder    (primary for nearby bottle/can pickup)
        brain.perception.target_finder.TargetFinder (image-guided fallback for future use)
    """

    def detect(self, frame: np.ndarray) -> list[Detection]: ...


class Action(str, Enum):
    FORWARD = "forward"
    LEFT = "left"
    RIGHT = "right"
    STOP = "stop"
    SEARCH_LEFT = "search_left"
    SEARCH_RIGHT = "search_right"
    SCOOP_FORWARD = "scoop_forward"
    BACKUP = "backup"


class ApproachPhase(str, Enum):
    SEARCHING = "searching"
    APPROACHING = "approaching"
    SCOOP_PUSH = "scoop_push"
    VERIFYING = "verifying"
    RECOVERING = "recovering"
    COLLECTED = "collected"


# Tuning constants
PICKUP_AREA_FRAC = 0.15          # fraction of frame area that triggers scoop
ALIGN_TOLERANCE = 0.15           # |err_frac| <= this -> drive FORWARD instead of turning
PICKUP_ALIGN_TOLERANCE = 0.10    # tighter centering gate before entering scoop
SCOOP_FRAMES = 8                 # short shove into the passive scoop
VERIFY_FRAMES = 6                # dwell frames to check whether the target vanished
VERIFY_CLEAR_FRAMES = 3          # consecutive empty frames required for success
RECOVERY_BACKUP_FRAMES = 4       # reverse a little before retrying
STOP_AREA_FRAC = PICKUP_AREA_FRAC  # backwards-compatible alias


class ApproachController:
    def __init__(
        self,
        target_finder: TargetDetector,
        vlm_scout: object | None = None,  # unused; kept for backwards-compat with callers
        reference_photo: object | None = None,
        reporter_photo: object | None = None,
        stop_area_frac: float = PICKUP_AREA_FRAC,
        align_tolerance: float = ALIGN_TOLERANCE,
        pickup_align_tolerance: float = PICKUP_ALIGN_TOLERANCE,
        scoop_frames: int = SCOOP_FRAMES,
        verify_frames: int = VERIFY_FRAMES,
        verify_clear_frames: int = VERIFY_CLEAR_FRAMES,
        recovery_backup_frames: int = RECOVERY_BACKUP_FRAMES,
    ) -> None:
        self.target_finder = target_finder
        self.stop_area_frac = stop_area_frac
        self.align_tolerance = align_tolerance
        self.pickup_align_tolerance = pickup_align_tolerance
        self.scoop_frames = scoop_frames
        self.verify_frames = verify_frames
        self.verify_clear_frames = verify_clear_frames
        self.recovery_backup_frames = recovery_backup_frames

        self._phase = ApproachPhase.SEARCHING
        self._pickup_complete = False

        self._scoop_remaining = 0
        self._verify_remaining = 0
        self._verify_clear_streak = 0
        self._recovery_remaining = 0

    @property
    def phase(self) -> ApproachPhase:
        return self._phase

    @property
    def pickup_complete(self) -> bool:
        return self._pickup_complete

    def step(self, frame: np.ndarray) -> Action:
        """Decide what the robot should do this tick."""
        if self._pickup_complete:
            self._phase = ApproachPhase.COLLECTED
            return Action.STOP

        detections = self.target_finder.detect(frame)
        top = detections[0] if detections else None

        if self._phase == ApproachPhase.SCOOP_PUSH:
            return self._step_scoop_push(top)
        if self._phase == ApproachPhase.VERIFYING:
            return self._step_verifying(top)
        if self._phase == ApproachPhase.RECOVERING:
            return self._step_recovering()

        if top is not None:
            return self._step_approach(frame, top)
        return self._step_search(frame)

    def _step_scoop_push(self, top: Detection | None) -> Action:
        if self._scoop_remaining > 0:
            self._scoop_remaining -= 1
            return Action.SCOOP_FORWARD

        self._phase = ApproachPhase.VERIFYING
        self._verify_remaining = self.verify_frames
        self._verify_clear_streak = 0
        return self._step_verifying(top)

    def _step_verifying(self, top: Detection | None) -> Action:
        if top is None:
            self._verify_clear_streak += 1
        else:
            self._verify_clear_streak = 0

        if self._verify_clear_streak >= self.verify_clear_frames:
            self._pickup_complete = True
            self._phase = ApproachPhase.COLLECTED
            return Action.STOP

        if self._verify_remaining > 0:
            self._verify_remaining -= 1
            return Action.STOP

        self._phase = ApproachPhase.RECOVERING
        self._recovery_remaining = self.recovery_backup_frames
        return self._step_recovering()

    def _step_recovering(self) -> Action:
        if self._recovery_remaining > 0:
            self._recovery_remaining -= 1
            return Action.BACKUP

        self._phase = ApproachPhase.SEARCHING
        return Action.STOP

    def _step_approach(self, frame: np.ndarray, top: Detection) -> Action:
        self._phase = ApproachPhase.APPROACHING

        h, w = frame.shape[:2]
        frame_area = h * w
        x1, _y1, x2, _y2 = top.xyxy
        bbox_area = top.area

        cx = (x1 + x2) / 2.0
        err_frac = (cx - w / 2.0) / (w / 2.0)
        bbox_frac = bbox_area / frame_area if frame_area > 0 else 0.0

        if (
            bbox_frac > self.stop_area_frac
            and abs(err_frac) < self.pickup_align_tolerance
        ):
            self._phase = ApproachPhase.SCOOP_PUSH
            self._scoop_remaining = max(0, self.scoop_frames - 1)
            return Action.SCOOP_FORWARD

        if abs(err_frac) < self.align_tolerance:
            return Action.FORWARD
        return Action.RIGHT if err_frac > 0 else Action.LEFT

    def _step_search(self, frame: np.ndarray) -> Action:
        self._phase = ApproachPhase.SEARCHING
        return Action.SEARCH_RIGHT
