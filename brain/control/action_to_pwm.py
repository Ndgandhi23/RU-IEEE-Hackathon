"""Map discrete approach-controller Actions to (left, right) motor PWM.

Kept as a standalone module (rather than a method on ApproachController) so
the mapping is trivially tunable on the real robot without threading config
through the controller. Tune these against the actual drive train — see
writeup/CLAUDE.md § Tuning Constants for the wider context on gain choices.

Sign convention matches Pi motor_controller contract:
    positive = forward on that wheel
    negative = reverse on that wheel
    range    = [-255, 255]

The resulting GPIO pattern on the Pi L298N is identical to manual_control.py
at the repo root (which uses pure GPIO.HIGH/LOW). Cross-reference:

    manual forward  : IN1=H IN2=L IN3=H IN4=L  ≡  (+full, +full)  → FORWARD
    manual backward : IN1=L IN2=H IN3=L IN4=H  ≡  (-full, -full)  → BACKUP
    manual left     : IN1=L IN2=H IN3=H IN4=L  ≡  (-turn, +turn)  → LEFT  / SEARCH_LEFT
    manual right    : IN1=H IN2=L IN3=L IN4=H  ≡  (+turn, -turn)  → RIGHT / SEARCH_RIGHT
    manual stop     : all LOW                  ≡  (0, 0)          → STOP

Speed levels (all in [-255, 255], single source of truth — edit here):
    FULL   — straight-line drive authority; near manual's 100% duty cycle.
    TURN   — in-place pivots; lower than FULL so turns don't overshoot.
    SEARCH — slow scan rotation while looking for a target.
    SCOOP  — controlled shove into the passive scoop; slower than FULL.
"""
from __future__ import annotations

from brain.control.loop import Action

FULL_PWM   = 220   # close to manual's 100% duty, with a little headroom
TURN_PWM   = 180   # in-place pivot magnitude
SEARCH_PWM = 140   # slow scan rotation
SCOOP_PWM  = 170   # controlled shove

_PWM_MAX = 255
assert all(
    0 < level <= _PWM_MAX
    for level in (FULL_PWM, TURN_PWM, SEARCH_PWM, SCOOP_PWM)
), "motor PWM levels must all be within (0, 255]"


ACTION_TO_PWM: dict[Action, tuple[int, int]] = {
    Action.FORWARD:       (+FULL_PWM,   +FULL_PWM),
    Action.BACKUP:        (-FULL_PWM,   -FULL_PWM),
    Action.LEFT:          (-TURN_PWM,   +TURN_PWM),
    Action.RIGHT:         (+TURN_PWM,   -TURN_PWM),
    Action.SEARCH_LEFT:   (-SEARCH_PWM, +SEARCH_PWM),
    Action.SEARCH_RIGHT:  (+SEARCH_PWM, -SEARCH_PWM),
    Action.SCOOP_FORWARD: (+SCOOP_PWM,  +SCOOP_PWM),
    Action.STOP:          (0, 0),
}


def pwm_for(action: Action) -> tuple[int, int]:
    """(left, right) PWM for a given Action. Unknown actions map to STOP."""
    return ACTION_TO_PWM.get(action, (0, 0))
