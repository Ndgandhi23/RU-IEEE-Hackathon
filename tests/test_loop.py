"""Tests for brain/control/loop.py.

Mocks OWLv2 (TargetFinder) and Qwen3-VL (VLMScout) so nothing real is loaded.
Covers the fast path (OWLv2 hits), the slow path (VLM scout → burst rotation),
and burst deduplication (VLM called at most once per burst).
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
        class_name="target",
        confidence=1.0,
        xyxy=(x1, y1, x1 + w, y1 + h),
    )


def _make_scout_result(direction: str, rationale: str = "test") -> MagicMock:
    m = MagicMock()
    m.direction = direction
    m.rationale = rationale
    return m


@pytest.fixture
def mock_finder() -> MagicMock:
    m = MagicMock()
    m.detect.return_value = []
    return m


@pytest.fixture
def mock_scout() -> MagicMock:
    m = MagicMock()
    m.scout.return_value = _make_scout_result("left")
    return m


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


def test_target_on_left_turns_left(controller, mock_finder) -> None:
    mock_finder.detect.return_value = [_det(FW // 4, FH // 2, 60, 60)]
    assert controller.step(_frame()) == Action.LEFT


def test_target_on_right_turns_right(controller, mock_finder) -> None:
    mock_finder.detect.return_value = [_det(3 * FW // 4, FH // 2, 60, 60)]
    assert controller.step(_frame()) == Action.RIGHT


def test_large_bbox_triggers_stop(controller, mock_finder) -> None:
    # Square bbox large enough that area/frame_area > STOP_AREA_FRAC.
    side = int(math.sqrt(STOP_AREA_FRAC * FW * FH) * 1.1)
    mock_finder.detect.return_value = [_det(FW // 2, FH // 2, side, side)]
    assert controller.step(_frame()) == Action.STOP


def test_empty_detection_queries_vlm_and_starts_search(controller, mock_finder, mock_scout) -> None:
    mock_finder.detect.return_value = []
    mock_scout.scout.return_value = _make_scout_result("left")
    action = controller.step(_frame())
    assert action == Action.SEARCH_LEFT
    assert mock_scout.scout.call_count == 1


def test_search_direction_matches_vlm_output(controller, mock_finder, mock_scout) -> None:
    mock_finder.detect.return_value = []
    mock_scout.scout.return_value = _make_scout_result("right")
    assert controller.step(_frame()) == Action.SEARCH_RIGHT


def test_vlm_called_at_most_once_per_search_burst(controller, mock_finder, mock_scout) -> None:
    mock_finder.detect.return_value = []
    # SEARCH_FRAMES consecutive empty ticks — VLM should fire exactly once.
    for _ in range(SEARCH_FRAMES):
        controller.step(_frame())
    assert mock_scout.scout.call_count == 1


def test_burst_exhaustion_triggers_fresh_vlm_call(controller, mock_finder, mock_scout) -> None:
    mock_finder.detect.return_value = []
    # First burst — one VLM call.
    for _ in range(SEARCH_FRAMES):
        controller.step(_frame())
    assert mock_scout.scout.call_count == 1
    # Next tick: burst is done, still no detection → second VLM call.
    controller.step(_frame())
    assert mock_scout.scout.call_count == 2


def test_detection_during_burst_cancels_search(controller, mock_finder, mock_scout) -> None:
    mock_finder.detect.return_value = []
    controller.step(_frame())  # start a search burst
    assert mock_scout.scout.call_count == 1

    # Target appears mid-burst.
    mock_finder.detect.return_value = [_det(FW // 2, FH // 2, 60, 60)]
    assert controller.step(_frame()) == Action.FORWARD

    # Next empty frame should trigger a new VLM call (burst was cancelled).
    mock_finder.detect.return_value = []
    controller.step(_frame())
    assert mock_scout.scout.call_count == 2


def test_all_burst_ticks_share_same_direction(controller, mock_finder, mock_scout) -> None:
    mock_finder.detect.return_value = []
    mock_scout.scout.return_value = _make_scout_result("right")
    actions = [controller.step(_frame()) for _ in range(SEARCH_FRAMES)]
    assert all(a == Action.SEARCH_RIGHT for a in actions)


def test_near_center_inside_tolerance_is_forward_not_turn(controller, mock_finder) -> None:
    # Place bbox just inside the alignment tolerance.
    offset_px = int(ALIGN_TOLERANCE * (FW / 2) * 0.5)  # half the tolerance
    mock_finder.detect.return_value = [_det(FW // 2 + offset_px, FH // 2, 60, 60)]
    assert controller.step(_frame()) == Action.FORWARD


def test_just_outside_tolerance_turns(controller, mock_finder) -> None:
    offset_px = int(ALIGN_TOLERANCE * (FW / 2) * 1.5)  # 1.5x the tolerance
    mock_finder.detect.return_value = [_det(FW // 2 + offset_px, FH // 2, 60, 60)]
    assert controller.step(_frame()) == Action.RIGHT


def test_multiple_detections_use_top_scoring(controller, mock_finder) -> None:
    # Loop takes detections[0] — contract is "sorted by confidence, desc."
    # Verify STOP is decided from the first (largest) box.
    big_side = int(math.sqrt(STOP_AREA_FRAC * FW * FH) * 1.1)
    detections = [
        _det(FW // 2, FH // 2, big_side, big_side),  # big, centered
        _det(FW // 4, FH // 2, 40, 40),              # small, left
    ]
    mock_finder.detect.return_value = detections
    assert controller.step(_frame()) == Action.STOP
