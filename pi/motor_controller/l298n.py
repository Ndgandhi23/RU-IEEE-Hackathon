"""L298N H-bridge driver for two NeveRest 60W gear motors.

L298N direction logic per channel:
    IN1=H, IN2=L  -> forward
    IN1=L, IN2=H  -> reverse
    IN1=L, IN2=L  -> coast (freewheel)     <-- used for "stop"
    IN1=H, IN2=H  -> brake (shorts both motor terminals)

We never brake — coast-to-stop is gentler on the chip and the mechanics.
Signed PWM convention: +N = forward, -N = reverse, 0 = coast, |N| ≤ 255.

The real driver assumes ENA / ENB are strapped high. Signed speed control is
implemented by PWM-ing the active direction input pin (IN1 or IN2) while
holding the opposite pin low.

`open_driver` returns the real pigpio-backed driver on a Pi, or a Mock
driver off-target (e.g. your Windows laptop during dev) so the rest of the
stack is runnable without hardware.
"""
from __future__ import annotations

import logging
from typing import Protocol, Tuple, runtime_checkable

from .config import PWM_FREQUENCY_HZ, PWM_RANGE, MotorPins

log = logging.getLogger(__name__)


@runtime_checkable
class MotorDriver(Protocol):
    def set_pwm(self, left: int, right: int) -> None: ...
    def stop(self) -> None: ...
    def close(self) -> None: ...
    @property
    def last_pwm(self) -> Tuple[int, int]: ...


class _MotorDriverBase:
    def __init__(self) -> None:
        self._last_left = 0
        self._last_right = 0

    @property
    def last_pwm(self) -> Tuple[int, int]:
        return self._last_left, self._last_right


class PigpioL298N(_MotorDriverBase):
    """Real hardware implementation.

    ENA / ENB are treated as always-enabled. We PWM the active direction pin so
    the existing signed-speed protocol still supports proportional turning.
    """

    def __init__(self, pi, left: MotorPins, right: MotorPins) -> None:
        super().__init__()
        self._pi = pi
        self._left = left
        self._right = right
        # pigpio mode constants — kept as literals so we don't require `import pigpio`
        # at module-load time on non-Pi hosts.
        _OUTPUT = 1
        for pin in (left.in1, left.in2, right.in1, right.in2):
            pi.set_mode(pin, _OUTPUT)
            pi.write(pin, 0)
            pi.set_PWM_range(pin, PWM_RANGE)
            pi.set_PWM_frequency(pin, PWM_FREQUENCY_HZ)
            pi.set_PWM_dutycycle(pin, 0)
        for en in (left.enable, right.enable):
            if en is None:
                continue
            pi.set_mode(en, _OUTPUT)
            pi.write(en, 1)

    def set_pwm(self, left: int, right: int) -> None:
        left = _clip(left)
        right = _clip(right)
        self._apply(self._left, left)
        self._apply(self._right, right)
        self._last_left = left
        self._last_right = right

    def _apply(self, pins: MotorPins, pwm: int) -> None:
        if pwm > 0:
            self._pi.set_PWM_dutycycle(pins.in2, 0)
            self._pi.write(pins.in2, 0)
            self._pi.set_PWM_dutycycle(pins.in1, pwm)
        elif pwm < 0:
            self._pi.set_PWM_dutycycle(pins.in1, 0)
            self._pi.write(pins.in1, 0)
            self._pi.set_PWM_dutycycle(pins.in2, -pwm)
        else:
            self._pi.set_PWM_dutycycle(pins.in1, 0)
            self._pi.set_PWM_dutycycle(pins.in2, 0)
            self._pi.write(pins.in1, 0)
            self._pi.write(pins.in2, 0)

    def stop(self) -> None:
        self.set_pwm(0, 0)

    def close(self) -> None:
        try:
            self.stop()
        except Exception as e:  # best-effort on shutdown
            log.warning("error stopping motors on close: %s", e)


class MockL298N(_MotorDriverBase):
    """No-hardware stand-in. Records commanded PWM so the simulator (and
    log-based smoke tests) can see what would have been driven."""

    def set_pwm(self, left: int, right: int) -> None:
        self._last_left = _clip(left)
        self._last_right = _clip(right)
        log.debug("mock L298N: left=%+d right=%+d", self._last_left, self._last_right)

    def stop(self) -> None:
        self._last_left = 0
        self._last_right = 0

    def close(self) -> None:
        self.stop()


def _clip(v: int) -> int:
    try:
        n = int(v)
    except (TypeError, ValueError):
        return 0
    if n > PWM_RANGE:
        return PWM_RANGE
    if n < -PWM_RANGE:
        return -PWM_RANGE
    return n


__all__ = ["MotorDriver", "PigpioL298N", "MockL298N"]
