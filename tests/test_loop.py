"""Tests for brain/control/loop.py.

Mocks the target detector and VLM scout so nothing real is loaded. Covers the
fast path (YOLO hits), the slow path (VLM scout -> burst rotation), and the
new passive-scoop lifecycle (scoop push -> verify -> recover/retry).
"""
from __future__ import annotations

import math
import sys
from pathlib import Path
from unittest.mock import MagicMock

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from brain.control.loop import (
    ALIGN_TOLERANCE,
    SEARCH_FRAMES,
    STOP_AREA_FRAC,
    Action,
    ApproachController,
    ApproachPhase,
)
from brain.perception.types import Detection

FW, FH = 640, 480


def _frame(w: int = FW, h: int = FH) -> np.ndarray:
    return np.zeros((h, w, 3), dtype=np.uint8)


def _det(cx: int, cy: int, w: int, h: int) -> Detection:
    x1 = cx - w // 2
    y1 = cy - h // 2
    return Detection(
        class_id=0,
        class_name="bottle",
        confidence=1.0,
        xyxy=(x1, y1, x1 + w, y1 + h),
    )


def _make_scout_result(direction: str, rationale: str = "test") -> MagicMock:
    result = MagicMock()
    result.direction = direction
    result.rationale = rationale
    return result


@pytest.fixture
def mock_finder() -> MagicMock:
    finder = MagicMock()
    finder.detect.return_value = []
    return finder


@pytest.fixture
def mock_scout() -> MagicMock:
    scout = MagicMock()
    scout.scout.return_value = _make_scout_result("left")
    return scout


@pytest.fixture
def controller(mock_finder: MagicMock, mock_scout: MagicMock) -> ApproachController:
    return ApproachController(
        target_finder=mock_finder,
        vlm_scout=mock_scout,
        reference_photo="ref.jpg",
        reporter_photo="context.jpg",
    )


def test_centered_detection_drives_forward(controller, mock_finder) -> None:
    mock_finder.detect.return_value = [_det(FW // 2, FH // 2, 60, 60)]
    assert controller.step(_frame()) == Action.FORWARD
    assert controller.phase == ApproachPhase.APPROACHING


def test_target_on_left_turns_left(controller, mock_finder) -> None:
    mock_finder.detect.return_value = [_det(FW // 4, FH // 2, 60, 60)]
    assert controller.step(_frame()) == Action.LEFT


def test_target_on_right_turns_right(controller, mock_finder) -> None:
    mock_finder.detect.return_value = [_det(3 * FW // 4, FH // 2, 60, 60)]
    assert controller.step(_frame()) == Action.RIGHT


def test_large_centered_bbox_starts_scoop_push(controller, mock_finder) -> None:
    side = int(math.sqrt(STOP_AREA_FRAC * FW * FH) * 1.1)
    mock_finder.detect.return_value = [_det(FW // 2, FH // 2, side, side)]
    assert controller.step(_frame()) == Action.SCOOP_FORWARD
    assert controller.phase == ApproachPhase.SCOOP_PUSH


def test_large_bbox_off_center_keeps_turning_not_scooping(controller, mock_finder) -> None:
    side = int(math.sqrt(STOP_AREA_FRAC * FW * FH) * 1.1)
    offset_px = int((ALIGN_TOLERANCE + 0.1) * (FW / 2))
    mock_finder.detect.return_value = [_det(FW // 2 + offset_px, FH // 2, side, side)]
    assert controller.step(_frame()) == Action.RIGHT
    assert controller.phase == ApproachPhase.APPROACHING


def test_empty_detection_queries_vlm_and_starts_search(controller, mock_finder, mock_scout) -> None:
    mock_finder.detect.return_value = []
    mock_scout.scout.return_value = _make_scout_result("left")
    action = controller.step(_frame())
    assert action == Action.SEARCH_LEFT
    assert controller.phase == ApproachPhase.SEARCHING
    assert mock_scout.scout.call_count == 1


def test_search_direction_matches_vlm_output(controller, mock_finder, mock_scout) -> None:
    mock_finder.detect.return_value = []
    mock_scout.scout.return_value = _make_scout_result("right")
    assert controller.step(_frame()) == Action.SEARCH_RIGHT


def test_vlm_called_at_most_once_per_search_burst(controller, mock_finder, mock_scout) -> None:
    mock_finder.detect.return_value = []
    for _ in range(SEARCH_FRAMES):
        controller.step(_frame())
    assert mock_scout.scout.call_count == 1


def test_burst_exhaustion_triggers_fresh_vlm_call(controller, mock_finder, mock_scout) -> None:
    mock_finder.detect.return_value = []
    for _ in range(SEARCH_FRAMES):
        controller.step(_frame())
    assert mock_scout.scout.call_count == 1
    controller.step(_frame())
    assert mock_scout.scout.call_count == 2


def test_detection_during_burst_cancels_search(controller, mock_finder, mock_scout) -> None:
    mock_finder.detect.return_value = []
    controller.step(_frame())
    assert mock_scout.scout.call_count == 1

    mock_finder.detect.return_value = [_det(FW // 2, FH // 2, 60, 60)]
    assert controller.step(_frame()) == Action.FORWARD

    mock_finder.detect.return_value = []
    controller.step(_frame())
    assert mock_scout.scout.call_count == 2


def test_scoop_push_runs_for_configured_number_of_frames(mock_finder, mock_scout) -> None:
    controller = ApproachController(
        target_finder=mock_finder,
        vlm_scout=mock_scout,
        reference_photo="ref.jpg",
        reporter_photo="context.jpg",
        scoop_frames=3,
    )
    side = int(math.sqrt(STOP_AREA_FRAC * FW * FH) * 1.1)
    mock_finder.detect.return_value = [_det(FW // 2, FH // 2, side, side)]

    assert controller.step(_frame()) == Action.SCOOP_FORWARD
    mock_finder.detect.return_value = []
    assert controller.step(_frame()) == Action.SCOOP_FORWARD
    assert controller.step(_frame()) == Action.SCOOP_FORWARD
    assert controller.step(_frame()) == Action.STOP
    assert controller.phase == ApproachPhase.VERIFYING


def test_verify_success_marks_pickup_complete(mock_finder, mock_scout) -> None:
    controller = ApproachController(
        target_finder=mock_finder,
        vlm_scout=mock_scout,
        reference_photo="ref.jpg",
        reporter_photo="context.jpg",
        scoop_frames=1,
        verify_frames=5,
        verify_clear_frames=2,
    )
    side = int(math.sqrt(STOP_AREA_FRAC * FW * FH) * 1.1)
    mock_finder.detect.return_value = [_det(FW // 2, FH // 2, side, side)]

    assert controller.step(_frame()) == Action.SCOOP_FORWARD
    mock_finder.detect.return_value = []
    assert controller.step(_frame()) == Action.STOP
    assert controller.step(_frame()) == Action.STOP
    assert controller.pickup_complete is True
    assert controller.phase == ApproachPhase.COLLECTED
    assert controller.step(_frame()) == Action.STOP


def test_verify_failure_backs_up_then_returns_to_search(mock_finder, mock_scout) -> None:
    controller = ApproachController(
        target_finder=mock_finder,
        vlm_scout=mock_scout,
        reference_photo="ref.jpg",
        reporter_photo="context.jpg",
        scoop_frames=1,
        verify_frames=1,
        verify_clear_frames=2,
        recovery_backup_frames=2,
    )
    side = int(math.sqrt(STOP_AREA_FRAC * FW * FH) * 1.1)
    mock_finder.detect.return_value = [_det(FW // 2, FH // 2, side, side)]

    assert controller.step(_frame()) == Action.SCOOP_FORWARD
    mock_finder.detect.return_value = [_det(FW // 2, FH // 2, side, side)]
    assert controller.step(_frame()) == Action.STOP
    assert controller.step(_frame()) == Action.BACKUP
    assert controller.phase == ApproachPhase.RECOVERING
    assert controller.step(_frame()) == Action.BACKUP
    assert controller.step(_frame()) == Action.STOP
    assert controller.phase == ApproachPhase.SEARCHING


def test_multiple_detections_use_top_scoring(controller, mock_finder) -> None:
    big_side = int(math.sqrt(STOP_AREA_FRAC * FW * FH) * 1.1)
    detections = [
        _det(FW // 2, FH // 2, big_side, big_side),
        _det(FW // 4, FH // 2, 40, 40),
    ]
    mock_finder.detect.return_value = detections
    assert controller.step(_frame()) == Action.SCOOP_FORWARD
