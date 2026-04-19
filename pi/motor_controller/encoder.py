"""Quadrature encoder reader for 4-pin hall-effect motor-shaft encoders.

Each motor has a 4-pin encoder cable: V+, GND, A, B. Power V+ from the
Pi's 3.3V rail so the A/B outputs swing 0..3.3V (safe for GPIO). Internal
pull-ups are enabled on A and B below, which also handles open-collector
hall sensors that need a pull-up to idle high.

If you ever wire a 5V-only encoder into a Pi GPIO pin directly, you WILL
damage the pin — use a level shifter or voltage divider on A and B. This
module assumes the signals arriving at the Pi are already at 3.3V.

Decoding: full quadrature (4X). We maintain a 2-bit "previous AB" value and
on each edge of either channel look up `TRANSITION[prev << 2 | cur]` to get
+1, -1, or 0 (invalid double-edge — ignored for robustness).

`count` is signed cumulative ticks since the last `reset()`. Positive
corresponds to "A leads B", which we define as the motor's forward direction.
Swap A and B in config.py if your wiring polarity is reversed.
"""
from __future__ import annotations

import logging
import threading
import time
from typing import Protocol

from .config import EncoderPins

log = logging.getLogger(__name__)


# Lookup table: index = (prev_ab << 2) | cur_ab, value = tick delta.
#
# Forward (A leads B): 00 -> 10 -> 11 -> 01 -> 00   (each transition = +1)
# Reverse (B leads A): 00 -> 01 -> 11 -> 10 -> 00   (each transition = -1)
#
# Legal quadrature transitions flip exactly one of A or B. Illegal
# (double-flip) transitions produce 0 — we'd rather lose a count than
# integrate garbage from a glitch.
_TRANSITION: list[int] = [
    #   cur=00 cur=01 cur=10 cur=11
    0,   -1,    +1,     0,   # prev=00
    +1,   0,     0,    -1,   # prev=01
    -1,   0,     0,    +1,   # prev=10
    0,   +1,    -1,     0,   # prev=11
]


class EncoderReader(Protocol):
    def read(self) -> tuple[int, int]: ...
    def reset(self) -> None: ...
    def close(self) -> None: ...


class PigpioQuadrature:
    """Single-encoder quadrature decoder, backed by pigpio edge callbacks."""

    def __init__(self, pi, pins: EncoderPins, glitch_us: int = 100) -> None:
        self._pi = pi
        self._pin_a = pins.a
        self._pin_b = pins.b
        self._lock = threading.Lock()
        self._count = 0

        _INPUT = 0
        _PUD_UP = 2
        _EITHER_EDGE = 2

        pi.set_mode(self._pin_a, _INPUT)
        pi.set_mode(self._pin_b, _INPUT)
        pi.set_pull_up_down(self._pin_a, _PUD_UP)
        pi.set_pull_up_down(self._pin_b, _PUD_UP)
        # Glitch filter ignores pulses shorter than glitch_us (hardware debounce).
        pi.set_glitch_filter(self._pin_a, glitch_us)
        pi.set_glitch_filter(self._pin_b, glitch_us)

        a = pi.read(self._pin_a) & 1
        b = pi.read(self._pin_b) & 1
        self._prev_ab = (a << 1) | b

        # pigpio callbacks fire on the pigpiod worker thread; all shared
        # state is guarded by self._lock.
        self._cb_a = pi.callback(self._pin_a, _EITHER_EDGE, self._on_edge)
        self._cb_b = pi.callback(self._pin_b, _EITHER_EDGE, self._on_edge)

    def _on_edge(self, _gpio: int, _level: int, _tick: int) -> None:
        a = self._pi.read(self._pin_a) & 1
        b = self._pi.read(self._pin_b) & 1
        cur = (a << 1) | b
        delta = _TRANSITION[(self._prev_ab << 2) | cur]
        if delta:
            with self._lock:
                self._count += delta
        self._prev_ab = cur

    def read(self) -> int:
        with self._lock:
            return self._count

    def reset(self) -> None:
        with self._lock:
            self._count = 0

    def close(self) -> None:
        for cb in (getattr(self, "_cb_a", None), getattr(self, "_cb_b", None)):
            if cb is not None:
                try:
                    cb.cancel()
                except Exception:
                    pass


class PigpioEncoders:
    """Pair of PigpioQuadrature (left + right)."""

    def __init__(self, pi, left_pins: EncoderPins, right_pins: EncoderPins) -> None:
        self._left = PigpioQuadrature(pi, left_pins)
        self._right = PigpioQuadrature(pi, right_pins)

    def read(self) -> tuple[int, int]:
        return self._left.read(), self._right.read()

    def reset(self) -> None:
        self._left.reset()
        self._right.reset()

    def close(self) -> None:
        self._left.close()
        self._right.close()


class MockEncoders:
    """Integrates commanded PWM over time to produce fake encoder counts.

    Useful for end-to-end testing off-target: drive +200 and you'll see the
    counts climb; drive -200 and they fall; stop and they hold. The constant
    `ticks_per_pwm_per_second` is a rough calibration knob — pick whatever
    makes the fake numbers look reasonable for your sim.
    """

    def __init__(self, motor_driver, ticks_per_pwm_per_second: float = 8.0) -> None:
        self._drv = motor_driver
        self._k = ticks_per_pwm_per_second
        self._lock = threading.Lock()
        self._last_t = time.monotonic()
        self._left = 0.0
        self._right = 0.0

    def _advance_locked(self) -> None:
        now = time.monotonic()
        dt = now - self._last_t
        self._last_t = now
        if dt <= 0:
            return
        pl, pr = self._drv.last_pwm
        self._left += pl * self._k * dt
        self._right += pr * self._k * dt

    def read(self) -> tuple[int, int]:
        with self._lock:
            self._advance_locked()
            return int(self._left), int(self._right)

    def reset(self) -> None:
        with self._lock:
            self._last_t = time.monotonic()
            self._left = 0.0
            self._right = 0.0

    def close(self) -> None:
        pass


__all__ = ["EncoderReader", "PigpioEncoders", "PigpioQuadrature", "MockEncoders"]
