"""Tests for brain/perception/servo.py.

Each case builds a synthetic Detection at a known position/size and asserts the
resulting ServoCommand matches expectation. Frame is 640x480 unless otherwise
stated.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from brain.perception.types import Detection
from brain.perception.servo import (
    ALIGNMENT_TOLERANCE,
    APPROACH_BOX_FILL,
    KP_VISUAL_TURN,
    MAX_FWD_M_S,
    MAX_TURN_RAD_S,
    no_target,
    servo_from_detection,
)

FW, FH = 640, 480


def _det(cx: int, cy: int, w: int, h: int) -> Detection:
    """Build a Detection centered at (cx, cy) with (w, h) pixels."""
    x1 = cx - w // 2
    y1 = cy - h // 2
    return Detection(class_id=0, class_name="target", confidence=1.0,
                     xyxy=(x1, y1, x1 + w, y1 + h))


def test_centered_small_target_drives_forward_no_turn() -> None:
    # Target dead-center, small (~10% frame height) — drive forward, no turn.
    det = _det(cx=FW // 2, cy=FH // 2, w=60, h=48)  # bbox_h/FH = 0.1
    cmd = servo_from_detection(det, FW, FH)
    assert cmd.turn_rad_s == pytest.approx(0.0, abs=1e-6)
    assert cmd.fwd_m_s > 0
    assert cmd.fwd_m_s <= MAX_FWD_M_S
    assert cmd.done is False


def test_target_left_of_center_turns_left() -> None:
    # Target in left quarter — err_frac ~ -0.5 → negative turn (left).
    det = _det(cx=FW // 4, cy=FH // 2, w=60, h=48)
    cmd = servo_from_detection(det, FW, FH)
    assert cmd.turn_rad_s < 0
    assert cmd.fwd_m_s > 0  # still moving forward, just with steering
    assert cmd.done is False


def test_target_right_of_center_turns_right() -> None:
    det = _det(cx=3 * FW // 4, cy=FH // 2, w=60, h=48)
    cmd = servo_from_detection(det, FW, FH)
    assert cmd.turn_rad_s > 0
    assert cmd.done is False


def test_turn_rate_is_clamped_to_max() -> None:
    # Push the target to the extreme edge to force saturation.
    det = _det(cx=0, cy=FH // 2, w=20, h=20)
    cmd = servo_from_detection(det, FW, FH, kp_turn=10.0)
    assert cmd.turn_rad_s == pytest.approx(-MAX_TURN_RAD_S)


def test_forward_speed_tapers_as_bbox_fills_frame() -> None:
    small = _det(cx=FW // 2, cy=FH // 2, w=60, h=48)       # 10% fill
    medium = _det(cx=FW // 2, cy=FH // 2, w=200, h=192)    # 40% fill
    large = _det(cx=FW // 2, cy=FH // 2, w=400, h=432)     # 90% fill
    cmd_small = servo_from_detection(small, FW, FH)
    cmd_medium = servo_from_detection(medium, FW, FH)
    cmd_large = servo_from_detection(large, FW, FH)
    assert cmd_small.fwd_m_s > cmd_medium.fwd_m_s > cmd_large.fwd_m_s >= 0


def test_done_fires_when_centered_and_close() -> None:
    # bbox_h > APPROACH_BOX_FILL * FH, centered.
    h = int(APPROACH_BOX_FILL * FH) + 20
    det = _det(cx=FW // 2, cy=FH // 2, w=h, h=h)
    cmd = servo_from_detection(det, FW, FH)
    assert cmd.done is True


def test_done_does_not_fire_when_close_but_off_center() -> None:
    # Close (bbox_fill high) but horizontally offset beyond alignment tolerance.
    h = int(APPROACH_BOX_FILL * FH) + 20
    # Offset so err_frac > ALIGNMENT_TOLERANCE.
    offset_px = int((ALIGNMENT_TOLERANCE + 0.1) * (FW / 2))
    det = _det(cx=FW // 2 + offset_px, cy=FH // 2, w=h, h=h)
    cmd = servo_from_detection(det, FW, FH)
    assert cmd.done is False


def test_done_does_not_fire_when_centered_but_far() -> None:
    det = _det(cx=FW // 2, cy=FH // 2, w=40, h=30)  # ~6% fill
    cmd = servo_from_detection(det, FW, FH)
    assert cmd.done is False


def test_no_target_is_safe_stop() -> None:
    cmd = no_target()
    assert cmd.fwd_m_s == 0.0
    assert cmd.turn_rad_s == 0.0
    assert cmd.done is False


def test_kp_turn_scales_linearly() -> None:
    # Same target, different kp — turn output should scale proportionally
    # (below saturation).
    det = _det(cx=FW // 2 + 80, cy=FH // 2, w=40, h=40)  # small offset, small bbox
    low = servo_from_detection(det, FW, FH, kp_turn=0.5)
    high = servo_from_detection(det, FW, FH, kp_turn=1.0)
    assert high.turn_rad_s == pytest.approx(2 * low.turn_rad_s, rel=1e-6)


def test_forward_never_negative() -> None:
    # Pathological: bbox exactly fills the frame vertically.
    det = _det(cx=FW // 2, cy=FH // 2, w=FW, h=FH)
    cmd = servo_from_detection(det, FW, FH)
    assert cmd.fwd_m_s >= 0.0


def test_default_kp_matches_module_constant() -> None:
    det = _det(cx=FW // 2 + 64, cy=FH // 2, w=40, h=40)
    cmd_default = servo_from_detection(det, FW, FH)
    cmd_explicit = servo_from_detection(det, FW, FH, kp_turn=KP_VISUAL_TURN)
    assert cmd_default.turn_rad_s == pytest.approx(cmd_explicit.turn_rad_s)
