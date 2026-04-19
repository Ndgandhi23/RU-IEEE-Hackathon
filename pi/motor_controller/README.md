# pi/motor_controller

Motor control + encoder telemetry on the Raspberry Pi. Sibling of
[`pi/camera_streamer`](../camera_streamer/README.md): same architecture
(thin I/O proxy, no business logic), different I/O.

```
┌────────────────────────────┐                    ┌──────────────────────────┐
│  Robot console (phone)     │   ws://pi:8765     │  Raspberry Pi 3B         │
│  useRobotNav + nav-loop.ts │<──────────────────>│  pi.motor_controller     │
└────────────────────────────┘   JSON commands    └───┬──────────────┬───────┘
                                 + 20Hz state         │              │
                                                      │              │
                                               L298N  │              │ encoder
                                               IN1-4  │              │ A/B (x2)
                                                      ▼              ▼
                                               ┌─────────┐    ┌──────────────┐
                                               │ NeveRest│    │ encoders on  │
                                               │ drive   │    │ motor shafts │
                                               │ motors  │    │ (4-pin each) │
                                               └─────────┘    └──────────────┘
```

## Protocol

WebSocket on `:8765`, JSON frames. Pin this as authoritative per
`writeup/CLAUDE.md > Open Questions`.

### Inbound (brain → Pi)

```jsonc
{"cmd": "drive", "left": -255..255, "right": -255..255}
{"cmd": "stop"}               // zero both motors immediately
{"cmd": "reset_encoders"}     // zero cumulative tick counters
```

Signed PWM: `+` = forward, `−` = reverse, `0` = coast.

### Outbound (Pi → brain), 20 Hz

```jsonc
{
  "type": "state",
  "ts":   1234.567,                              // Pi time.monotonic()
  "encoders":   {"left":  1234, "right": 1190},  // signed cumulative ticks
  "motors":     {"left_pwm": 200, "right_pwm": 200},
  "watchdog_ok": true                            // last drive cmd within 500ms
}
```

### Watchdog

Any `drive` or `stop` refreshes a 500 ms deadline. When it expires, the Pi
zeroes both motors — WiFi drops and brain crashes halt the robot. `watchdog_ok`
in telemetry lets the brain know before it commits to a new maneuver.

## Files

| File | Purpose |
|---|---|
| `config.py`      | Pin map + protocol constants. Edit to match wiring. |
| `l298n.py`       | L298N driver. `PigpioL298N` (real) + `MockL298N` (dev). |
| `encoder.py`     | Quadrature decoder. `PigpioEncoders` (real) + `MockEncoders` (dev). |
| `ws_server.py`   | WebSocket server: dispatch + 20 Hz telemetry loop. |
| `__main__.py`    | Entry point. Auto-picks real vs. mock backends. |
| `requirements.txt` | `pigpio`, `websockets`. |

## Wiring

Default pin map (override in `config.py` or by editing the `@dataclass`
defaults):

**L298N motor driver** — assume **ENA** and **ENB** are strapped high on the
board. The Pi only needs the four direction pins:

| Function | GPIO (BCM) | Goes to... |
|---|---|---|
| Left motor IN1  | 17  | L298N IN1 |
| Left motor IN2  | 27  | L298N IN2 |
| Right motor IN3 | 22  | L298N IN3 |
| Right motor IN4 | 23  | L298N IN4 |

If your module exposes ENA / ENB jumpers, leave them installed so each
channel stays enabled. The software now PWM-controls the active direction pin
instead of ENA / ENB, so you do not need dedicated PWM wiring for the enable
pins.

**Encoders** — 4-pin hall-effect quadrature (V+, GND, A, B). Power them
from the Pi's 3.3V rail so A/B swing 0..3.3V and go straight into GPIO —
no level shifter, no divider. Run ONE pair of +3V3 / GND wires from the
Pi header to a small junction, then fan out to both encoders.

| Encoder pin | Goes to... | Notes |
|---|---|---|
| Left V+      | Pi **3.3V** (header pin 1 or 17) | shared with right V+ |
| Left GND     | Pi **GND** (e.g. header pin 6, 9, 14, 20, 25, 30, 34, 39) | shared w/ everything |
| Left A       | **GPIO 5**  | internal pull-up enabled in firmware |
| Left B       | **GPIO 6**  | internal pull-up enabled in firmware |
| Right V+     | Pi **3.3V** (shared) | |
| Right GND    | Pi **GND** (shared) | |
| Right A      | **GPIO 19** | internal pull-up enabled in firmware |
| Right B      | **GPIO 26** | internal pull-up enabled in firmware |

### Critical hardware notes

- **Power encoders from 3.3V, not 5V.** Hall-effect encoders run fine at
  3.3V and their A/B outputs become Pi-safe automatically. If for some
  reason yours *requires* 5V supply, you must add a level shifter
  (TXB0108, BSS138) or a 10k/20k divider on every A/B line — 5V direct
  into a Pi GPIO will damage the pin.
- **Don't skip the common ground.** Encoder GND, Pi GND, L298N GND, and
  motor-battery GND all tie together. Without it the A/B signals float
  and you'll get spurious counts (or nothing at all).
- **Separate motor +V from Pi +5V.** Power the L298N's motor supply from
  the robot's main battery (via a UBEC or straight from a battery within
  the L298N's 5–35V range), not the Pi's 5V rail. The Pi will reset on
  motor-inrush otherwise.
- **L298N 5V jumper.** If you keep the L298N's onboard regulator enabled
  (jumper on), feed motor +V ≥ 7V. If you disable it (jumper off), provide
  external 5V to the L298N's +5V pin.

### Encoder counts

NeveRest Classic 60:

- 7 CPR on the motor shaft
- 60:1 gearbox
- Full quadrature (4X) decoding → **1680 counts per output-shaft revolution**

Distance per tick (for a given wheel): `π × wheel_diameter_m / 1680`. The
brain does this math — the Pi just streams raw ticks. The constant is
reproduced in `config.py > COUNTS_PER_OUTPUT_REV` for reference.

### Direction convention

Positive encoder counts correspond to **A leading B**. Positive commanded
speed drives **IN1=PWM, IN2=L**. If your first smoke test shows encoder counts
going negative when you expected positive, either:

1. Swap `a` and `b` in the relevant `EncoderPins(...)` in `config.py`, **or**
2. Swap IN1 and IN2 (or the motor's + and −) in the relevant `MotorPins(...)`.

Pick one convention — don't do both or they'll cancel.

## Install (on the Pi)

```bash
# System-level: pigpio daemon
sudo apt update
sudo apt install -y pigpio python3-pigpio
sudo systemctl enable --now pigpiod        # runs on boot

# Python deps (venv recommended, or use system python)
pip install -r pi/motor_controller/requirements.txt
```

## Run (on the Pi)

From the repo root so the `pi` package resolves:

```bash
python3 -m pi.motor_controller
# INFO: using pigpio hardware backends
# INFO: websocket server listening on ws://0.0.0.0:8765
```

## Run (on your laptop, mock mode — for dev)

```bash
python -m pi.motor_controller --mock
# INFO: using mock motor + encoder backends
# INFO: websocket server listening on ws://0.0.0.0:8765
```

Mock encoders *integrate commanded speed values over time*, so drive commands
produce believable monotonic tick counts without any hardware.

## Smoke-testing from your laptop

With the server running on the Pi (or in `--mock` mode locally), use any
WebSocket client. Quick Python REPL:

```python
import asyncio, json, websockets

async def demo():
    async with websockets.connect("ws://127.0.0.1:8765") as ws:
        # Push forward at 3/4 throttle
        await ws.send(json.dumps({"cmd": "drive", "left": 192, "right": 192}))
        # Read a second of telemetry
        end = asyncio.get_event_loop().time() + 1.0
        while asyncio.get_event_loop().time() < end:
            print(json.loads(await ws.recv()))
        await ws.send(json.dumps({"cmd": "stop"}))

asyncio.run(demo())
```

You should see `encoders.left` and `encoders.right` climbing, then holding
steady after the `stop`.

## How the robot console uses this for Apple Maps step-by-step nav

The phone-side `robot-console/nav-loop.ts` (`useRobotNav`) consumes the
Apple route's `steps[]` / flattened `waypoints[]` returned by the relay.
The loop is:

1. Flatten the route's step waypoints into a single ordered list and keep
   a cursor starting at index 0.
2. On each GPS + compass update, compute bearing + heading error to the
   waypoint at the cursor and emit a `drive` command (spin in place while
   heading error is large, proportional steering once pointed within
   tolerance).
3. When the robot is within a few meters of the current waypoint,
   advance the cursor. When the cursor passes the final waypoint, send
   `stop` and the classifier gate opens (see `connector/gate.py`).
4. Encoder telemetry from this Pi module is surfaced in the robot
   console UI for live debug — eventually a closed-loop distance
   controller can use it, but the first-pass test run is GPS + compass
   only.

None of that logic lives in `pi/`. The Pi just drives what it's told and
reports what the wheels actually did.

## Autostart (systemd, optional)

```ini
# /etc/systemd/system/pi-motor-controller.service
[Unit]
Description=Pi motor controller (L298N + encoders + WebSocket)
After=pigpiod.service network-online.target
Requires=pigpiod.service
Wants=network-online.target

[Service]
WorkingDirectory=/home/pi/trash-robot
ExecStart=/usr/bin/python3 -m pi.motor_controller
Restart=on-failure
User=pi

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now pi-motor-controller.service
journalctl -u pi-motor-controller -f
```
