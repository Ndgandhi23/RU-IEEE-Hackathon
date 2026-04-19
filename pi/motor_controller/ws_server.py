"""WebSocket control channel on :8765.

Protocol (JSON, one message per WebSocket frame):

Inbound (brain -> pi):
    {"cmd": "drive", "left":  <int -255..255>, "right": <int -255..255>}
    {"cmd": "stop"}                                  # zero both motors
    {"cmd": "reset_encoders"}                        # zero cumulative ticks

Outbound (pi -> brain), pushed at TELEMETRY_HZ:
    {"type": "state",
     "ts":  <pi_monotonic_float>,
     "encoders":   {"left": <int>, "right": <int>},  # signed cumulative ticks
     "motors":     {"left_pwm": <int>, "right_pwm": <int>},
     "watchdog_ok": <bool>}                           # last drive cmd within 500ms

Watchdog:
  Any `drive` (or `stop`) command refreshes an internal deadline. If the
  deadline expires (WATCHDOG_TIMEOUT_S), the telemetry loop force-stops the
  motors. This covers WiFi drops and brain-side crashes per CLAUDE.md.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import dataclass, field
from typing import Any

import websockets
from websockets.exceptions import ConnectionClosed

from .config import TELEMETRY_HZ, WATCHDOG_TIMEOUT_S, WS_HOST, WS_PORT
from .encoder import EncoderReader
from .l298n import MotorDriver

log = logging.getLogger(__name__)


@dataclass
class ControlState:
    drv: MotorDriver
    enc: EncoderReader
    watchdog_deadline: float = field(default=0.0)

    def refresh_watchdog(self) -> None:
        self.watchdog_deadline = time.monotonic() + WATCHDOG_TIMEOUT_S

    def watchdog_ok(self) -> bool:
        return time.monotonic() < self.watchdog_deadline


async def _handle_client(ws, state: ControlState) -> None:
    peer = getattr(ws, "remote_address", "?")
    log.info("client connected: %s", peer)
    try:
        async for message in ws:
            try:
                msg = json.loads(message)
            except (TypeError, ValueError):
                log.warning("bad json from %s: %r", peer, str(message)[:80])
                continue
            if not isinstance(msg, dict):
                continue
            cmd = msg.get("cmd")
            if cmd == "drive":
                left = _safe_int(msg.get("left"), 0)
                right = _safe_int(msg.get("right"), 0)
                state.drv.set_pwm(left, right)
                state.refresh_watchdog()
            elif cmd == "stop":
                state.drv.stop()
                state.refresh_watchdog()
            elif cmd == "reset_encoders":
                state.enc.reset()
            else:
                log.warning("unknown cmd from %s: %r", peer, cmd)
    except ConnectionClosed:
        pass
    finally:
        log.info("client disconnected: %s", peer)


async def _telemetry_loop(state: ControlState, clients: "set[Any]") -> None:
    period = 1.0 / TELEMETRY_HZ
    next_t = time.monotonic()
    while True:
        # Enforce watchdog — halt motors if no recent drive command.
        if not state.watchdog_ok():
            state.drv.stop()

        le, re = state.enc.read()
        pl, pr = state.drv.last_pwm
        payload = json.dumps({
            "type": "state",
            "ts": time.monotonic(),
            "encoders": {"left": le, "right": re},
            "motors":   {"left_pwm": pl, "right_pwm": pr},
            "watchdog_ok": state.watchdog_ok(),
        })

        if clients:
            dead = []
            for c in clients:
                try:
                    await c.send(payload)
                except ConnectionClosed:
                    dead.append(c)
            for c in dead:
                clients.discard(c)

        next_t += period
        sleep_for = next_t - time.monotonic()
        if sleep_for > 0:
            await asyncio.sleep(sleep_for)
        else:
            # Fell behind — resync rather than firing a burst of catch-up frames.
            next_t = time.monotonic()


async def serve(
    state: ControlState,
    host: str = WS_HOST,
    port: int = WS_PORT,
    stop_event: asyncio.Event | None = None,
) -> None:
    """Run forever (or until `stop_event` is set)."""
    clients: set[Any] = set()

    async def handler(ws) -> None:
        clients.add(ws)
        try:
            await _handle_client(ws, state)
        finally:
            clients.discard(ws)

    log.info("websocket server listening on ws://%s:%d", host, port)
    async with websockets.serve(handler, host, port):
        telemetry = asyncio.create_task(_telemetry_loop(state, clients))
        try:
            if stop_event is None:
                await telemetry
            else:
                stop_wait = asyncio.create_task(stop_event.wait())
                done, pending = await asyncio.wait(
                    {telemetry, stop_wait}, return_when=asyncio.FIRST_COMPLETED,
                )
                for t in pending:
                    t.cancel()
        finally:
            if not telemetry.done():
                telemetry.cancel()


def _safe_int(v: object, default: int) -> int:
    try:
        return int(v)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return default


__all__ = ["ControlState", "serve"]
