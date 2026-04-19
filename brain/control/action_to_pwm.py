"""Map discrete approach-controller Actions to (left, right) motor PWM.

Kept as a standalone module (rather than a method on ApproachController) so
the mapping is trivially tunable on the real robot without threading config
through the controller. Tune these against the actual drive train — see
writeup/CLAUDE.md § Tuning Constants for the wider context on gain choices.

Sign convention matches Pi motor_controller contract:
    positive = forward on that wheel
    negative = reverse on that wheel
    range    = [-255, 255]

Differential drive:
    FORWARD       — both positive, matched magnitude → straight ahead
    LEFT / RIGHT  — opposite signs, lower magnitude → pivot in place
    SEARCH_*      — opposite signs, even lower magnitude → slow scan rotation
    STOP          — zero
"""
from __future__ import annotations

from brain.control.loop import Action

ACTION_TO_PWM: dict[Action, tuple[int, int]] = {
    Action.FORWARD:      (+150, +150),
    Action.LEFT:         (-100, +100),
    Action.RIGHT:        (+100, -100),
    Action.STOP:         (0, 0),
    Action.SEARCH_LEFT:  (-80,  +80),
    Action.SEARCH_RIGHT: (+80,  -80),
}


def pwm_for(action: Action) -> tuple[int, int]:
    """(left, right) PWM for a given Action. Unknown actions map to STOP."""
    return ACTION_TO_PWM.get(action, (0, 0))
