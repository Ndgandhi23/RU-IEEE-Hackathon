"""Entry point: `python -m pi.motor_controller`.

Runs:
- L298N driver for two NeveRest motors (via pigpio HW PWM)
- Quadrature encoder reader on 4 GPIO pins (2 motors x 2 channels)
- WebSocket server on :8765 — brain connects here for commands + telemetry

On non-Pi hosts, or if pigpio is missing / the daemon isn't running, we
fall back to mock backends automatically. Use `--mock` to force the mock
backends even when real hardware is available (useful for unit tests).
"""
from __future__ import annotations

import argparse
import asyncio
import logging
import os
import signal
import sys

from .config import (
    LEFT_ENCODER, LEFT_MOTOR, RIGHT_ENCODER, RIGHT_MOTOR,
    WS_HOST, WS_PORT,
)
from .encoder import EncoderReader, MockEncoders, PigpioEncoders
from .l298n import MockL298N, MotorDriver, PigpioL298N
from .ws_server import ControlState, serve

log = logging.getLogger("pi.motor_controller")


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        prog="python -m pi.motor_controller",
        description="L298N motor control + quadrature encoder + WebSocket server.",
    )
    p.add_argument("--mock", action="store_true",
                   help="force mock GPIO backends (for dev on non-Pi hosts)")
    p.add_argument("--host", default=WS_HOST, help="WebSocket bind address")
    p.add_argument("--port", type=int, default=WS_PORT, help="WebSocket port")
    p.add_argument("-v", "--verbose", action="store_true")
    return p.parse_args()


def _connect_pigpio():
    """Return a connected pigpio.pi instance, or None if unavailable."""
    try:
        import pigpio  # type: ignore[import-not-found]
    except ImportError as e:
        log.warning("pigpio not installed (%s) — using mock backends", e)
        return None
    host = os.environ.get("PIGPIO_HOST")
    pi = pigpio.pi(host) if host else pigpio.pi()
    if not pi.connected:
        log.warning(
            "pigpio daemon not reachable — start it with `sudo pigpiod`. "
            "Falling back to mock backends."
        )
        return None
    return pi


def _build(mock: bool) -> tuple[MotorDriver, EncoderReader, object | None]:
    if not mock:
        pi = _connect_pigpio()
        if pi is not None:
            log.info("using pigpio hardware backends")
            drv: MotorDriver = PigpioL298N(pi, LEFT_MOTOR, RIGHT_MOTOR)
            enc: EncoderReader = PigpioEncoders(pi, LEFT_ENCODER, RIGHT_ENCODER)
            return drv, enc, pi
    log.info("using mock motor + encoder backends")
    drv = MockL298N()
    enc = MockEncoders(drv)
    return drv, enc, None


async def _main_async(state: ControlState, host: str, port: int) -> None:
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()

    def _stop() -> None:
        if not stop.is_set():
            log.info("shutdown signal received")
            stop.set()

    for sig in (signal.SIGINT, getattr(signal, "SIGTERM", None)):
        if sig is None:
            continue
        try:
            loop.add_signal_handler(sig, _stop)
        except NotImplementedError:
            # Windows's ProactorEventLoop doesn't support add_signal_handler.
            signal.signal(sig, lambda *_: _stop())

    await serve(state, host=host, port=port, stop_event=stop)


def main() -> int:
    args = _parse_args()
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    drv, enc, pi = _build(args.mock)
    state = ControlState(drv=drv, enc=enc)

    try:
        asyncio.run(_main_async(state, args.host, args.port))
    finally:
        log.info("stopping motors and closing GPIO")
        try:
            drv.stop()
        finally:
            drv.close()
            enc.close()
            if pi is not None:
                try:
                    pi.stop()
                except Exception:
                    pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
