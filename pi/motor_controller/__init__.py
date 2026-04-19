"""Pi-side motor control + encoder telemetry.

The Pi drives two NeveRest 60W gear motors through an L298N H-bridge and
reads their on-shaft 4-pin quadrature encoders. A WebSocket server on
:8765 accepts `drive` / `stop` / `reset_encoders` commands from the brain
and pushes encoder + motor state at 20 Hz.

No business logic lives here (per writeup/CLAUDE.md). The brain converts
Apple Maps step distances into target encoder ticks, issues `drive` PWM
commands, and watches the telemetry stream to know when to stop / turn.
"""
from __future__ import annotations

from typing import List

__all__: List[str] = []
