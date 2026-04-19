"""Manual WebSocket driver for ``pi.motor_controller``.

This speaks the same JSON command protocol used by ``robot-console/pi-link.ts``
so you can smoke-test the robot without launching Expo.

Examples
--------

Interactive session against a local controller on the Pi:

    python3 -m pi.manual_drive

Interactive session against a remote Pi from another machine:

    python3 -m pi.manual_drive --host 192.168.1.177 --telemetry

One-shot commands:

    python3 -m pi.manual_drive --host 192.168.1.177 drive 120 120 --duration 1.0
    python3 -m pi.manual_drive --host 192.168.1.177 stop
    python3 -m pi.manual_drive --host 192.168.1.177 reset
"""
from __future__ import annotations

import argparse
import asyncio
import json
import shlex
import sys
from typing import Any, Dict, List, Optional

import websockets

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8765

HELP_TEXT = """Commands:
  drive <left> <right>      Send raw signed PWM values (-255..255)
  forward <pwm>             Alias for drive <pwm> <pwm>
  back <pwm>                Alias for drive -<pwm> -<pwm>
  left <pwm>                Spin in place left  (drive -<pwm> <pwm>)
  right <pwm>               Spin in place right (drive <pwm> -<pwm>)
  stop                      Zero both motors
  reset                     Reset encoder counts
  status                    Print the latest telemetry snapshot
  help                      Show this help
  quit / exit               Close the connection
"""


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Manual control client for pi.motor_controller",
    )
    parser.add_argument(
        "--host",
        default=DEFAULT_HOST,
        help="Target host running pi.motor_controller (default: %(default)s)",
    )
    parser.add_argument(
        "--port",
        default=DEFAULT_PORT,
        type=int,
        help="Target port running pi.motor_controller (default: %(default)s)",
    )
    parser.add_argument(
        "--telemetry",
        action="store_true",
        help="Print incoming telemetry continuously",
    )
    parser.add_argument(
        "--duration",
        default=0.0,
        type=float,
        help=(
            "When used with a one-shot drive command, sleep this many seconds "
            "and then send stop before exiting"
        ),
    )
    parser.add_argument(
        "command",
        nargs=argparse.REMAINDER,
        help=(
            "Optional one-shot command. Omit to start an interactive session. "
            "Examples: drive 120 120, stop, reset"
        ),
    )
    return parser


class ManualDriveClient:
    def __init__(self, url: str, telemetry: bool) -> None:
        self.url = url
        self.show_telemetry = telemetry
        self.last_state = None  # type: Optional[Dict[str, Any]]

    async def run(self, argv_command: List[str], duration: float) -> int:
        try:
            async with websockets.connect(self.url) as ws:
                print("connected -> {0}".format(self.url))

                receiver = asyncio.create_task(self._recv_loop(ws))
                try:
                    if argv_command:
                        await self._run_one_shot(ws, argv_command, duration)
                    else:
                        await self._run_repl(ws)
                finally:
                    receiver.cancel()
                    try:
                        await receiver
                    except asyncio.CancelledError:
                        pass
        except OSError as error:
            print("connect failed: {0}".format(error), file=sys.stderr)
            return 1
        except websockets.exceptions.WebSocketException as error:
            print("websocket error: {0}".format(error), file=sys.stderr)
            return 1
        return 0

    async def _recv_loop(self, ws) -> None:
        async for message in ws:
            try:
                payload = json.loads(message)
            except ValueError:
                continue
            if isinstance(payload, dict) and payload.get("type") == "state":
                self.last_state = payload
                if self.show_telemetry:
                    print(format_state(payload))

    async def _run_one_shot(self, ws, argv_command: List[str], duration: float) -> None:
        action = parse_command(argv_command)
        if action is None:
            raise SystemExit(2)
        await self._send_action(ws, action)
        if action["cmd"] == "drive" and duration > 0:
            await asyncio.sleep(duration)
            await self._send_action(ws, {"cmd": "stop"})

    async def _run_repl(self, ws) -> None:
        print(HELP_TEXT.strip())
        loop = asyncio.get_running_loop()
        while True:
            try:
                raw = await loop.run_in_executor(None, input, "manual-drive> ")
            except EOFError:
                print()
                break
            line = raw.strip()
            if not line:
                continue
            argv_command = shlex.split(line)
            action = parse_command(argv_command, last_state=self.last_state)
            if action is None:
                continue
            if action.get("_local") == "quit":
                break
            if action.get("_local") == "help":
                print(HELP_TEXT.strip())
                continue
            if action.get("_local") == "status":
                if self.last_state is None:
                    print("no telemetry received yet")
                else:
                    print(format_state(self.last_state))
                continue
            await self._send_action(ws, action)

    async def _send_action(self, ws, action: Dict[str, Any]) -> None:
        printable = dict(action)
        printable.pop("_local", None)
        await ws.send(json.dumps(printable))
        print("sent -> {0}".format(json.dumps(printable)))


def parse_command(
    argv_command: List[str],
    last_state: Optional[Dict[str, Any]] = None,
) -> Optional[Dict[str, Any]]:
    if not argv_command:
        return None
    name = argv_command[0].lower()

    if name in ("quit", "exit"):
        return {"_local": "quit"}
    if name == "help":
        return {"_local": "help"}
    if name == "status":
        return {"_local": "status"}
    if name == "stop":
        return {"cmd": "stop"}
    if name in ("reset", "reset-encoders", "reset_encoders"):
        return {"cmd": "reset_encoders"}

    if name == "drive":
        if len(argv_command) != 3:
            print("usage: drive <left> <right>", file=sys.stderr)
            return None
        left = clamp_pwm(argv_command[1])
        right = clamp_pwm(argv_command[2])
        return {"cmd": "drive", "left": left, "right": right}

    if name in ("forward", "back", "left", "right"):
        if len(argv_command) != 2:
            print("usage: {0} <pwm>".format(name), file=sys.stderr)
            return None
        pwm = abs(clamp_pwm(argv_command[1]))
        if name == "forward":
            return {"cmd": "drive", "left": pwm, "right": pwm}
        if name == "back":
            return {"cmd": "drive", "left": -pwm, "right": -pwm}
        if name == "left":
            return {"cmd": "drive", "left": -pwm, "right": pwm}
        return {"cmd": "drive", "left": pwm, "right": -pwm}

    if name == "repeat":
        if last_state is None:
            print("no prior telemetry to use with repeat", file=sys.stderr)
            return None
        motors = last_state.get("motors") or {}
        left = clamp_pwm(motors.get("left_pwm", 0))
        right = clamp_pwm(motors.get("right_pwm", 0))
        return {"cmd": "drive", "left": left, "right": right}

    print("unknown command: {0}".format(name), file=sys.stderr)
    print("type 'help' for available commands", file=sys.stderr)
    return None


def clamp_pwm(value: Any) -> int:
    try:
        pwm = int(float(value))
    except (TypeError, ValueError):
        raise SystemExit("invalid pwm value: {0}".format(value))
    if pwm > 255:
        return 255
    if pwm < -255:
        return -255
    return pwm


def format_state(payload: Dict[str, Any]) -> str:
    encoders = payload.get("encoders") or {}
    motors = payload.get("motors") or {}
    return (
        "state ts={ts:.3f} enc=({left_enc},{right_enc}) "
        "pwm=({left_pwm},{right_pwm}) watchdog_ok={watchdog}"
    ).format(
        ts=float(payload.get("ts", 0.0)),
        left_enc=int(encoders.get("left", 0)),
        right_enc=int(encoders.get("right", 0)),
        left_pwm=int(motors.get("left_pwm", 0)),
        right_pwm=int(motors.get("right_pwm", 0)),
        watchdog=bool(payload.get("watchdog_ok", False)),
    )


async def _main_async(args: argparse.Namespace) -> int:
    url = "ws://{0}:{1}".format(args.host, args.port)
    client = ManualDriveClient(url, telemetry=args.telemetry)
    return await client.run(args.command, args.duration)


def main(argv: Optional[List[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return asyncio.run(_main_async(args))


if __name__ == "__main__":
    raise SystemExit(main())
