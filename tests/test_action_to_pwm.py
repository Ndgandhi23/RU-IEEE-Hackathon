"""Tests for brain/control/action_to_pwm.py."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from brain.control.action_to_pwm import ACTION_TO_PWM, pwm_for
from brain.control.loop import Action


def test_every_action_has_a_mapping() -> None:
    for action in Action:
        assert action in ACTION_TO_PWM, f"missing PWM for {action}"


def test_forward_is_both_positive_matched() -> None:
    left, right = pwm_for(Action.FORWARD)
    assert left > 0 and right > 0
    assert left == right


def test_stop_is_zero() -> None:
    assert pwm_for(Action.STOP) == (0, 0)


def test_left_turns_left_wheel_reverse_right_forward() -> None:
    left, right = pwm_for(Action.LEFT)
    assert left < 0 < right


def test_right_turns_left_forward_right_reverse() -> None:
    left, right = pwm_for(Action.RIGHT)
    assert right < 0 < left


def test_search_is_same_sign_pattern_as_turn_but_slower() -> None:
    sl_left, sl_right = pwm_for(Action.SEARCH_LEFT)
    l_left, l_right = pwm_for(Action.LEFT)
    assert sl_left < 0 < sl_right
    assert abs(sl_left) <= abs(l_left)
    assert abs(sl_right) <= abs(l_right)


def test_scoop_forward_is_positive_and_more_controlled_than_cruise() -> None:
    scoop_left, scoop_right = pwm_for(Action.SCOOP_FORWARD)
    fwd_left, fwd_right = pwm_for(Action.FORWARD)
    assert scoop_left > 0 and scoop_right > 0
    assert scoop_left == scoop_right
    assert abs(scoop_left) < abs(fwd_left)
    assert abs(scoop_right) < abs(fwd_right)


def test_backup_is_matched_reverse() -> None:
    left, right = pwm_for(Action.BACKUP)
    assert left < 0 and right < 0
    assert left == right


def test_all_pwms_within_pi_motor_range() -> None:
    for action, (left, right) in ACTION_TO_PWM.items():
        assert -255 <= left <= 255, f"{action} left out of range"
        assert -255 <= right <= 255, f"{action} right out of range"
