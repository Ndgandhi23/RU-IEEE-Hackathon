"""Integration tests for brain/io/pi_bridge.py against the new motor-controller protocol.

Spins up a real WebSocket server in a background thread that mimics
pi/motor_controller/ws_server.py: receives drive/stop/reset_encoders,
broadcasts {type:"state", encoders, motors, watchdog_ok, ts} pushes.
"""
from __future__ import annotations

import asyncio
import json
import socket
import sys
import threading
import time
from pathlib import Path
from typing import Callable

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

pytest.importorskip("websockets")

try:
    from websockets.asyncio.server import serve
except ImportError:
    from websockets.server import serve  # type: ignore[no-redef]

from brain.io.pi_bridge import PiBridge


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _wait_for(pred: Callable[[], bool], timeout_s: float = 2.0) -> bool:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if pred():
            return True
        time.sleep(0.02)
    return False


class FakePi:
    def __init__(self, port: int) -> None:
        self.port = port
        self.received: list[dict] = []
        self._clients: set = set()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._stopped: asyncio.Event | None = None
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        ready = threading.Event()

        def run() -> None:
            self._loop = asyncio.new_event_loop()
            asyncio.set_event_loop(self._loop)
            self._stopped = asyncio.Event()
            self._loop.run_until_complete(self._main(ready))
            self._loop.close()

        self._thread = threading.Thread(target=run, daemon=True)
        self._thread.start()
        assert ready.wait(timeout=2.0)

    async def _main(self, ready: threading.Event) -> None:
        async def handler(ws) -> None:
            self._clients.add(ws)
            try:
                async for raw in ws:
                    try:
                        self.received.append(json.loads(raw))
                    except json.JSONDecodeError:
                        pass
            except Exception:
                pass
            finally:
                self._clients.discard(ws)

        async with serve(handler, "127.0.0.1", self.port):
            ready.set()
            assert self._stopped is not None
            await self._stopped.wait()

    async def _push(self, payload: str) -> None:
        for ws in list(self._clients):
            try:
                await ws.send(payload)
            except Exception:
                self._clients.discard(ws)

    def push_state(
        self,
        enc_left: int = 0, enc_right: int = 0,
        pwm_left: int = 0, pwm_right: int = 0,
        watchdog_ok: bool = True,
    ) -> None:
        payload = json.dumps({
            "type": "state",
            "ts": time.monotonic(),
            "encoders": {"left": enc_left, "right": enc_right},
            "motors":   {"left_pwm": pwm_left, "right_pwm": pwm_right},
            "watchdog_ok": watchdog_ok,
        })
        assert self._loop is not None
        asyncio.run_coroutine_threadsafe(self._push(payload), self._loop).result(timeout=1.0)

    def client_count(self) -> int:
        return len(self._clients)

    def stop(self) -> None:
        if self._loop is not None and self._stopped is not None:
            self._loop.call_soon_threadsafe(self._stopped.set)
        if self._thread is not None:
            self._thread.join(timeout=2.0)


@pytest.fixture
def fake_pi():
    pi = FakePi(port=_free_port())
    pi.start()
    yield pi
    pi.stop()


@pytest.fixture
def bridge(fake_pi: FakePi):
    b = PiBridge(host="127.0.0.1", port=fake_pi.port)
    b.start()
    assert _wait_for(lambda: b.is_connected, 3.0), "bridge never connected"
    yield b
    b.stop()


# ---------- outbound (brain → pi) ----------

def test_set_motors_emits_drive_cmd(bridge: PiBridge, fake_pi: FakePi) -> None:
    bridge.set_motors(100, -50)
    assert _wait_for(lambda: len(fake_pi.received) >= 1)
    assert fake_pi.received[0] == {"cmd": "drive", "left": 100, "right": -50}


def test_set_motors_clamps_to_pwm_range(bridge: PiBridge, fake_pi: FakePi) -> None:
    bridge.set_motors(500, -500)
    assert _wait_for(lambda: len(fake_pi.received) >= 1)
    assert fake_pi.received[0] == {"cmd": "drive", "left": 255, "right": -255}


def test_stop_motors_emits_stop_cmd(bridge: PiBridge, fake_pi: FakePi) -> None:
    bridge.stop_motors()
    assert _wait_for(lambda: len(fake_pi.received) >= 1)
    assert fake_pi.received[0] == {"cmd": "stop"}


def test_reset_encoders_emits_reset_cmd(bridge: PiBridge, fake_pi: FakePi) -> None:
    bridge.reset_encoders()
    assert _wait_for(lambda: len(fake_pi.received) >= 1)
    assert fake_pi.received[0] == {"cmd": "reset_encoders"}


# ---------- inbound (pi → brain) ----------

def test_state_push_is_received(bridge: PiBridge, fake_pi: FakePi) -> None:
    assert bridge.get_state() is None
    fake_pi.push_state(enc_left=1234, enc_right=1190, pwm_left=200, pwm_right=200)
    assert _wait_for(lambda: bridge.get_state() is not None)
    s = bridge.get_state()
    assert s is not None
    assert s.encoder_left == 1234
    assert s.encoder_right == 1190
    assert s.motor_left_pwm == 200
    assert s.motor_right_pwm == 200
    assert s.watchdog_ok is True


def test_watchdog_flag_is_propagated(bridge: PiBridge, fake_pi: FakePi) -> None:
    fake_pi.push_state(watchdog_ok=False)
    assert _wait_for(lambda: bridge.get_state() is not None)
    s = bridge.get_state()
    assert s is not None and s.watchdog_ok is False


def test_state_becomes_stale() -> None:
    """Tight staleness window via monkeypatch."""
    from brain.io import pi_bridge as pb
    orig = pb.STATE_STALENESS_S
    pb.STATE_STALENESS_S = 0.05
    try:
        pi = FakePi(port=_free_port())
        pi.start()
        b = PiBridge(host="127.0.0.1", port=pi.port)
        b.start()
        try:
            assert _wait_for(lambda: b.is_connected, 3.0)
            pi.push_state(enc_left=10)
            assert _wait_for(lambda: b.get_state() is not None)
            time.sleep(0.15)
            assert b.get_state() is None
        finally:
            b.stop()
            pi.stop()
    finally:
        pb.STATE_STALENESS_S = orig


# ---------- robustness ----------

def test_send_when_disconnected_is_noop(fake_pi: FakePi) -> None:
    b = PiBridge(host="127.0.0.1", port=fake_pi.port)
    # Don't start() — never connected.
    b.set_motors(100, 100)
    b.stop_motors()
    b.reset_encoders()
    assert not b.is_connected
    assert fake_pi.client_count() == 0


def test_malformed_state_is_ignored(bridge: PiBridge, fake_pi: FakePi) -> None:
    """A push missing required fields shouldn't crash the receive loop."""
    assert bridge.get_state() is None
    # Send a malformed state (missing 'encoders').
    bad = json.dumps({"type": "state", "ts": time.monotonic(),
                      "motors": {"left_pwm": 0, "right_pwm": 0},
                      "watchdog_ok": True})
    assert fake_pi._loop is not None  # type: ignore[union-attr]
    asyncio.run_coroutine_threadsafe(fake_pi._push(bad), fake_pi._loop).result(timeout=1.0)
    # Then a valid one.
    fake_pi.push_state(enc_left=42)
    assert _wait_for(lambda: bridge.get_state() is not None)
    assert bridge.get_state().encoder_left == 42  # type: ignore[union-attr]
