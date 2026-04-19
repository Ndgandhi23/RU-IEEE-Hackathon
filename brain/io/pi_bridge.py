"""WebSocket client from the brain to the Pi motor controller.

Runs an asyncio loop in a background thread; the rest of the brain talks
through a sync API so the 10 Hz control loop in `brain/control/loop.py`
doesn't have to be async.

Protocol (matches pi/motor_controller/ws_server.py):

Brain → Pi
    {"cmd": "drive", "left": int, "right": int}    # pwm in [-255, 255]
    {"cmd": "stop"}                                  # zero both motors
    {"cmd": "reset_encoders"}                        # zero cumulative ticks

Pi → Brain (broadcast at 20 Hz)
    {"type": "state",
     "ts": float,                                    # Pi monotonic time
     "encoders":   {"left": int, "right": int},     # signed cumulative ticks
     "motors":     {"left_pwm": int, "right_pwm": int},
     "watchdog_ok": bool}

Coordination note: the phone is also a WS client during NAVIGATING. Both
clients can send `drive` simultaneously; the Pi's 500 ms watchdog naturally
arbitrates by acting on whoever sent most recently. The brain is expected
to take over only after the phone signals it has reached the last waypoint
(see brain/main.py / iphone_listener handoff logic).
"""
from __future__ import annotations

import asyncio
import json
import logging
import threading
import time
from dataclasses import dataclass

try:
    from websockets.asyncio.client import connect as ws_connect
    from websockets.exceptions import ConnectionClosed, WebSocketException
except ImportError:
    from websockets.client import connect as ws_connect  # type: ignore[no-redef]
    from websockets.exceptions import ConnectionClosed, WebSocketException

log = logging.getLogger(__name__)

PI_LINK_TIMEOUT_S = 2.0
STATE_STALENESS_S = 0.2  # Pi pushes at 20 Hz (~50 ms); 200 ms covers WiFi hiccups
RECONNECT_BACKOFF_S = 1.0
OPEN_TIMEOUT_S = 3.0


@dataclass(frozen=True)
class RobotState:
    encoder_left: int
    encoder_right: int
    motor_left_pwm: int
    motor_right_pwm: int
    watchdog_ok: bool
    pi_ts: float        # Pi-side monotonic timestamp from the message
    received_at: float  # brain-side monotonic time when received


def _clamp(v: int, lo: int, hi: int) -> int:
    return max(lo, min(hi, int(v)))


class PiBridge:
    def __init__(
        self,
        host: str,
        port: int = 8765,
        link_timeout_s: float = PI_LINK_TIMEOUT_S,
    ) -> None:
        self._url = f"ws://{host}:{port}"
        self.link_timeout_s = link_timeout_s

        self._loop: asyncio.AbstractEventLoop | None = None
        self._thread: threading.Thread | None = None
        self._ws = None
        self._connected = threading.Event()
        self._stop = threading.Event()

        self._latest_state: RobotState | None = None
        self._latest_lock = threading.Lock()

    # ---------- lifecycle ----------

    def start(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(
            target=self._thread_main, name="pi-bridge", daemon=True,
        )
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        loop, ws = self._loop, self._ws
        if loop is not None and ws is not None:
            try:
                fut = asyncio.run_coroutine_threadsafe(ws.close(), loop)
                fut.result(timeout=1.0)
            except Exception:
                pass
        if self._thread is not None:
            self._thread.join(timeout=2.0)
            self._thread = None
        self._loop = None
        self._ws = None
        self._connected.clear()

    def __enter__(self) -> "PiBridge":
        self.start()
        return self

    def __exit__(self, *exc) -> None:
        self.stop()

    # ---------- public sync API ----------

    @property
    def is_connected(self) -> bool:
        return self._connected.is_set()

    def set_motors(self, left: int, right: int) -> None:
        """Drive both wheels. pwm ∈ [-255, 255]. Fire-and-forget."""
        self._send({
            "cmd": "drive",
            "left": _clamp(left, -255, 255),
            "right": _clamp(right, -255, 255),
        })

    def stop_motors(self) -> None:
        """Zero both motors immediately. Fire-and-forget."""
        self._send({"cmd": "stop"})

    def reset_encoders(self) -> None:
        """Zero cumulative encoder counts on the Pi. Fire-and-forget."""
        self._send({"cmd": "reset_encoders"})

    def get_state(self) -> RobotState | None:
        """Most recent state push, or None if stale (>200 ms)."""
        with self._latest_lock:
            s = self._latest_state
        if s is None:
            return None
        if time.monotonic() - s.received_at > STATE_STALENESS_S:
            return None
        return s

    # ---------- internals ----------

    def _send(self, msg: dict) -> None:
        loop, ws = self._loop, self._ws
        if loop is None or ws is None or not self._connected.is_set():
            return  # Pi watchdog will zero motors; dropped cmd is safe.
        payload = json.dumps(msg)

        async def _do_send() -> None:
            try:
                await ws.send(payload)
            except (ConnectionClosed, WebSocketException):
                pass

        try:
            asyncio.run_coroutine_threadsafe(_do_send(), loop)
        except RuntimeError:
            pass

    def _thread_main(self) -> None:
        self._loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self._loop)
        try:
            self._loop.run_until_complete(self._run())
        finally:
            self._loop.close()

    async def _run(self) -> None:
        while not self._stop.is_set():
            try:
                async with ws_connect(self._url, open_timeout=OPEN_TIMEOUT_S) as ws:
                    self._ws = ws
                    self._connected.set()
                    log.info("pi bridge connected: %s", self._url)
                    await self._receive_loop(ws)
            except (OSError, WebSocketException, asyncio.TimeoutError) as e:
                log.warning("pi bridge connection failed: %s", e)
            finally:
                self._connected.clear()
                self._ws = None
            if self._stop.is_set():
                return
            await asyncio.sleep(RECONNECT_BACKOFF_S)

    async def _receive_loop(self, ws) -> None:
        async for raw in ws:
            if self._stop.is_set():
                return
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if msg.get("type") != "state":
                continue
            try:
                encoders = msg["encoders"]
                motors = msg["motors"]
                state = RobotState(
                    encoder_left=int(encoders["left"]),
                    encoder_right=int(encoders["right"]),
                    motor_left_pwm=int(motors["left_pwm"]),
                    motor_right_pwm=int(motors["right_pwm"]),
                    watchdog_ok=bool(msg["watchdog_ok"]),
                    pi_ts=float(msg["ts"]),
                    received_at=time.monotonic(),
                )
            except (KeyError, TypeError, ValueError) as e:
                log.warning("malformed state from pi: %s (%r)", e, msg)
                continue
            with self._latest_lock:
                self._latest_state = state
