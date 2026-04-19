# Demo mode — skip navigation, go straight to autonomous pickup

This is the **only** supported path for the live demo. It keeps the Apple Maps
route visible on the mounted iPhone (for show), but skips the drive-to-waypoint
sequence entirely: the moment the relay assigns a task, the robot-console
declares ARRIVED and the brain-side ML loop starts searching + approaching +
scooping trash on its own.

Anything not listed here is out of scope for demo mode.

---

## What runs where

| Machine                 | LAN IP           | Process                                             |
|-------------------------|------------------|-----------------------------------------------------|
| Brain laptop (RTX 4080) | `192.168.1.167`  | `relay/` (Node, :4000), `brain.main` (Python)       |
| Raspberry Pi on robot   | `192.168.1.177`  | motor WS (:8765), camera MJPEG (:8080)              |
| Reporter phone          | DHCP             | `app/` in Expo Go                                   |
| Mounted iPhone on robot | DHCP             | `robot-console/` in Expo Go — DEMO toggle ON        |

All four devices must be on the same LAN. The two `.env` files already point
at the IPs above (`app/.env`, `robot-console/.env`).

---

## Boot order

Start in this order so the robot-console has a relay to talk to and the brain
has a Pi to drive:

### 1. Pi (robot)

SSH in from the brain laptop. You'll need **two** SSH sessions (or `tmux`) —
the motor controller and camera streamer both block their terminal.

First, make sure the pigpio daemon is up (the real motor driver needs it —
without it `pi.motor_controller` falls back to the mock backend and no GPIOs
get driven):

```bash
ssh pi@192.168.1.177
systemctl status pigpiod --no-pager    # want: active (running)
# if not:
sudo systemctl restart pigpiod
```

Then in SSH session #1 — motor controller, from the repo root on the Pi:

```bash
cd ~/RIEEE\ Hackathon     # adjust if the repo lives elsewhere on the Pi
python3 -m pi.motor_controller -v      # WebSocket on :8765
```

Watch the log line — you want the real pigpio backend, **not** "mock". If
you see mock, fix `pigpiod` before going further.

SSH session #2 — camera streamer, from the repo root on the Pi:

```bash
cd ~/RIEEE\ Hackathon
python3 -m pi.camera_streamer --device 0 --host 0.0.0.0 -v   # MJPEG on :8080
```

Quick sanity check from the brain laptop:

```bash
curl http://192.168.1.177:8080/healthz
curl -o /tmp/test.jpg http://192.168.1.177:8080/frame.jpg
```

### 2. Relay (brain laptop)

```bash
cd relay
npm install           # first time only
npm start             # listens on :4000
```

Note the brain laptop's LAN IP — both phones need it.

### 3. Brain autonomous loop (brain laptop)

The brain's approach/scoop/verify loop has **no arrival gate of its own** — it
starts driving the autonomous ML pipeline the moment it launches. That's what
makes the demo work: flip the phone's DEMO switch, launch the brain, done.

```bash
python -m brain.main \
  --pi-ip 192.168.1.177 \
  --reference references/ref.jpg \
  --context   references/ctx.jpg
```

Dry-run first if you haven't tested today:

```bash
python -m brain.main --dry-run --webcam 0 \
  --reference references/ref.jpg \
  --context   references/ctx.jpg
```

### 4. Robot-console (mounted iPhone)

`robot-console/.env` is already set to `http://192.168.1.167:4000` and
`ws://192.168.1.177:8765`. If you want the DEMO switch pre-flipped on boot,
append `EXPO_PUBLIC_DEMO_AUTO_ARRIVE=1` to that file.

```bash
cd robot-console
npx expo start
```

Open in Expo Go on the mounted iPhone. In the app:

1. **GPS tab** → Start tracking.
2. **Pi tab** → Connect (status should go `open`). Leave motors **OFF** — the
   brain is driving directly, the phone doesn't need to send drive commands
   in demo mode.
3. **Nav tab** → **Debug controls → "DEMO: assume already arrived"** → flip
   ON. (Or skip this if you set `EXPO_PUBLIC_DEMO_AUTO_ARRIVE=1` in `.env`.)

From this point on, any task the relay assigns shows ARRIVED immediately on
the nav header, the Apple Maps route remains visible for the audience, and the
brain's ML loop takes over motor control.

### 5. Reporter phone

`app/.env` is already set to `http://192.168.1.167:4000`.

```bash
cd app
npx expo start
```

Open in Expo Go. Take a photo of the target item, submit the report. That
pushes a new task through the relay, which triggers everything downstream.

---

## What each piece does in demo mode

- **Reporter app** — submits a trash report with photo + GPS. Unchanged.
- **Relay** — stores the task, computes an Apple Maps route, publishes via
  `/robot/packet`. Unchanged.
- **Robot-console** — resolves the Apple Maps route and shows it in the UI,
  **but with DEMO auto-arrive ON, reports `arrived=true` on the very first
  render** and stops sending drive commands to the Pi. (See
  `robot-console/nav-loop.ts` — the `demoAutoArrive` branch.)
- **Brain `brain.main`** — starts the autonomous loop: YOLO-driven approach,
  VLM scout for search, scoop + verify. Sends PWM to the Pi via
  `brain/io/pi_bridge.py`.
- **Pi** — executes drive commands exactly the same way manual control does
  (`manual_control.py` at the repo root — IN1..IN4 pin logic mirrored by
  `pi/motor_controller/l298n.py::PigpioL298N._apply`).

The brain's motor commands are the normalized signed-PWM table in
`brain/control/action_to_pwm.py`. All values are in `[-255, 255]` and produce
the same GPIO pattern that the manual keyboard-control script produces when a
key is held.

---

## Optional: classifier preview window

If you want a second screen showing the YOLO detections that the brain is
seeing, run this on the brain laptop (or any machine that can reach the Pi
camera):

```bash
python -m connector.run_classifier \
  --weights models/trash_v1.pt \
  --url http://192.168.1.177:8080/stream.mjpg \
  --gate demo \
  --relay-url http://192.168.1.167:4000
```

`--gate demo` uses the new `DemoTaskAssignedGate` — the preview opens as soon
as a task is assigned, without waiting for the robot to physically arrive.

---

## Checklist before going live

- [ ] `pigpiod` active on the Pi (`systemctl status pigpiod`)
- [ ] `pi.motor_controller -v` running and reporting the real pigpio backend (not mock)
- [ ] `pi.camera_streamer --device 0 -v` running; `curl /healthz` returns OK from the laptop
- [ ] Relay up on the brain laptop, reachable from both phones
- [ ] `brain.main` launched with correct `--pi-ip` and reference/context images
- [ ] Robot-console: GPS tracking on, Pi socket open, **DEMO auto-arrive ON**
- [ ] Reporter phone: connected to relay
- [ ] Clear floor space between the robot and the demo target item

---

## Stopping the demo

- Ctrl+C `brain.main` → motors zero out on exit via `pi_bridge.stop_motors()`.
- On the Pi, the 500 ms watchdog in `motor_controller/ws_server.py` will halt
  the motors anyway if the brain disappears.
- In robot-console: flip **DEMO auto-arrive OFF** to return to real nav.
