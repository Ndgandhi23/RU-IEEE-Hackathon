# Running the stack (no robot hardware yet)

This is the end-to-end test playbook while the robot chassis isn't built.
You play "the robot" by walking around with a phone running `robot-console`.
Your laptop hosts everything else: the relay, the trash classifier, and
mocked Pi services. Someone (or a second phone / emulator) runs the
reporter `app` to drop jobs into the queue.

```
   phone A                         laptop                             phone B
┌────────────┐              ┌──────────────────────┐            ┌─────────────┐
│  app       │ POST /reports│  relay (Node, :4000) │  heartbeat │ robot-      │
│ (reporter) │─────────────▶│                      │◀──────────▶│ console     │
└────────────┘              │   queue + Apple Maps │  packet    │ (GPS+nav)   │
                            │                      │            └──────┬──────┘
                            │  pi.motor_controller │   WebSocket       │
                            │  --mock  (:8765)     │◀──────────────────┤
                            │                      │                   │
                            │  pi.camera_streamer  │ MJPEG             │
                            │  --device 0 (:8080)  │◀──┐               │
                            │                      │   │               │
                            │  demo.py (connector) │   │               │
                            │  gated on arrived   ─┼───┘               │
                            └──────────────────────┘                   │
                                      ▲                                │
                                      └────────── arrival gate ────────┘
```

All components are optional except **relay**, **app**, and **robot-console**.
Motor controller, camera streamer, and classifier slot in one at a time as
you verify each loop.

---

## 0. Prerequisites

- Node 18+ (for `relay` + Expo).
- Python 3.11 with the repo's virtualenv activated and `requirements.txt`
  installed (`ultralytics`, `opencv-python`, `requests`, `websockets`,
  `numpy`). `pigpio` is **not** needed on the laptop — `--mock` skips it.
- Two iOS or Android devices running **Expo Go** (or one device + an
  emulator / simulator on the laptop). Expo Go can only hold one project
  at a time, so two of them is the simple path.
- Phone(s) and laptop on the **same Wi-Fi**. Guest networks that isolate
  clients will not work.
- Windows Firewall must allow inbound on **4000, 8080, 8765** from the
  private network. First run of each service will usually prompt you.

Your laptop's current LAN IP is **`192.168.1.167`**. Every command below
assumes that; if it changes, update the `.env` files and re-run
`npx expo start`.

---

## 1. One-time configuration

`robot-console/.env`:

```
EXPO_PUBLIC_API_BASE_URL=http://192.168.1.167:4000
EXPO_PUBLIC_PI_WS_URL=ws://192.168.1.167:8765
```

`app/.env`:

```
EXPO_PUBLIC_API_BASE_URL=http://192.168.1.167:4000
```

If either `.env` changes you must restart the corresponding `npx expo start`.

---

## 2. Commands — one terminal per service

Open each in a fresh PowerShell window. Keep them all running for the
duration of a test session.

### Terminal 1 — Relay (required)

```powershell
cd relay
npm install           # first time only
npm start
```

Look for `campus-cleanup-relay listening on :4000`. This is the source of
truth for the queue, Apple Maps routes, and robot assignment.

### Terminal 2 — Reporter app (required, phone A)

```powershell
cd app
npm install           # first time only
npx expo start
```

Scan the QR with Expo Go on **phone A**. This phone submits reports. If
the QR doesn't work over LAN, add `--tunnel`.

### Terminal 3 — Robot console (required, phone B)

```powershell
cd robot-console
npm install           # first time only
npx expo start
```

Scan the QR with Expo Go on **phone B**. This is the one you treat as
"the robot" — walk around with it.

### Terminal 4 — Fake Pi motor controller (optional)

```powershell
python -m pi.motor_controller --mock --host 0.0.0.0 -v
```

`--mock` means no pigpio / GPIO dependency; encoder counts are simulated
from commanded PWM. Listens on `ws://0.0.0.0:8765`. Keeps the robot
console's **Pi** tab honest: open/close the socket, watch telemetry,
flip motors on and see the mock encoders move.

### Terminal 5 — Fake Pi camera streamer (optional)

```powershell
python -m pi.camera_streamer --device 0 --host 0.0.0.0 -v
```

Uses your laptop webcam as a stand-in for the Pi's C270. Serves MJPEG at
`http://192.168.1.167:8080/stream.mjpg`. The `/healthz` endpoint gives
you a quick smoke test in a browser.

### Terminal 6 — Classifier, gated on arrival (optional)

```powershell
python demo.py --url http://192.168.1.167:8080/stream.mjpg --gate relay --relay-url http://192.168.1.167:4000
```

- Uses `models/trash_v1.pt` via `brain.perception.detector` — **that is
  your trash detector.**
- The preview window is on by default. Add `--no-display` for
  headless runs.
- `--gate relay` polls `/robot/packet` and only opens the MJPEG stream
  once the robot is within arrival radius of its destination (default
  **10 m**, tune with `--arrival-threshold-m`). Until then it displays
  an idle placeholder. 10 m is a "we're in the area, start looking"
  threshold — it accounts for consumer phone GPS accuracy of 5-8 m.
- For ungated smoke tests: `--gate always` (streams immediately).
- For manual dev: `--gate manual --manual-gate-file arrived.flag` and
  create `arrived.flag` when you want it to start.

---

## 3. Happy-path test flow

1. **Start Terminals 1, 2, 3.** In relay's console you should see one
   heartbeat come through as soon as phone B boots the console.

2. **Phone B → GPS tab → "Start auto mode."** Accept location + compass
   permissions. Coords populate, heading ticks, top strip shows
   `gps on`. GPS log fills with `tracking: …` entries.

3. **Phone B → Task tab.** `Status: idle`, `Pending reports: 0`. The
   **relay I/O log** panel ticks every ~8 s with `idle-ping` round
   trips. That's the assignment poller.

4. **Phone A → reporter app.** Submit a real report (photo + current
   location). In Terminal 1 you see `[reports] created …` and
   `[assignment] assigned task …`.

5. **Phone B → Task tab** updates within one heartbeat:
   - `Status: assigned`
   - Active task id
   - Target lat/lon, route distance, ETA, waypoint + step count
   - Top strip pill reads `task <abcdef>`

   Switch to the **Nav tab**: Step `1/N`, the Apple Maps turn
   instruction, distance to next waypoint, bearing, heading error, and
   the proposed motor command. Until you enable motors this is a
   dry-run — the commands are computed but nothing ships to the Pi.

6. **Walk phone B toward the report.** Every couple of seconds you'll
   see `gps-watch` entries in the relay log. That's the console pushing
   fresh GPS so the relay reshoots Apple Maps from where you *are*, not
   where you started — overshoots self-correct as the route updates.
   The waypoint counter advances as you pass each one.

7. **Arrival.** Once you're within ~10 m of the destination the **Nav
   tab** flips `Arrived: YES — search phase` and the top strip lights
   up `ARRIVED`. If Terminal 6 is running, `demo.py` opens its preview
   and starts running the trash detector on the MJPEG stream.

   **Short-route note:** if the reported location is only 30-70 m away,
   Apple Maps will typically return a route with zero turn-by-turn
   steps (because there are no turns — "walk straight"). The Nav tab
   shows `Route source: straight-line fallback (no Apple steps)` and
   navigates directly toward the report GPS. This is expected, not a
   bug; it only matters that Apple's total distance + ETA come back.

8. **Phone B → Task tab → "Complete current task."** The relay assigns
   the next pending report immediately; otherwise status returns to
   idle, `ARRIVED` goes away, the idle-ping loop resumes.

---

## 4. Exercising the Pi link (Terminal 4 required)

On phone B's **Pi tab**:

1. Tap **Connect**. Socket goes `connecting → open`. Pi log prints
   `status -> open`. Telemetry panel populates within ~50 ms
   (zeros for encoders and PWM, `Watchdog: OK`).
2. Flip **Enable motors** on. Top strip: `motors LIVE`. The nav loop
   now actually sends drive commands. The mocked encoders drift based
   on commanded PWM, so both the **Nav** `PWM` row and the **Pi**
   `Motor PWM` row should match.
3. Tap **Send STOP**, or flip motors off — both PWMs snap to 0 and the
   mock encoders stop accumulating.
4. Disconnect the socket entirely. Within 500 ms the **Pi tab** reports
   `Watchdog: TRIPPED (motors halted)`. That's the Pi-side safety net
   confirming it halts motors on its own if commands stop flowing.

---

## 5. Forcing the classifier on (without walking anywhere)

Useful when you want to smoke-test the MJPEG → YOLO pipe on its own.

```powershell
python demo.py --url http://192.168.1.167:8080/stream.mjpg --gate always
```

Or leave it running in `manual` mode and toggle it with a file:

```powershell
python demo.py --url http://192.168.1.167:8080/stream.mjpg --gate manual --manual-gate-file arrived.flag
# In another shell:
New-Item arrived.flag -ItemType File   # opens the gate
Remove-Item arrived.flag               # closes it again
```

---

## 6. Troubleshooting cheatsheet

| Symptom                                         | Likely cause / fix                                                                 |
| ----------------------------------------------- | ---------------------------------------------------------------------------------- |
| Robot console: red `no relay` pill              | `.env` not loaded. Save, **stop** `npx expo start`, start it again.                |
| Task tab relay log shows `✖ heartbeat` errors   | Firewall blocking 4000, or laptop IP changed. Re-check `ipconfig` and `.env`.      |
| Task never gets assigned after submitting       | Terminal 1 logs should show `[apple-maps] …`. If it errors, MapKit token config.   |
| Pi tab won't leave `connecting`                 | Terminal 4 not running, or firewall on 8765. `netstat -an | findstr 8765` to check.|
| `motors LIVE` but PWM stays 0                   | Nav tab says why in "Reason" — usually no compass, or already arrived.             |
| `demo.py` never opens a preview window          | Gate is closed. Inspect connector log; or run with `--gate always` to verify deps. |
| `ModuleNotFoundError: ultralytics`              | Activate the venv and `pip install -r requirements.txt`.                           |
| Phone B's GPS log stops mid-run                 | Phone locked the screen and throttled the watcher — keep it awake.                 |

When things get weird, the best first move is the **Logs tab** on the
robot console. Every stream (gps / relay / pi / nav / system) is
interleaved by timestamp there and color-coded. Clear it, reproduce the
bug, screenshot.

---

## 7. Quick reference

| Service              | Where                | Port    | Required | Start                                                      |
| -------------------- | -------------------- | ------- | -------- | ---------------------------------------------------------- |
| Relay                | laptop               | 4000    | yes      | `cd relay && npm start`                                    |
| Reporter app         | laptop → phone A     | Metro   | yes      | `cd app && npx expo start`                                 |
| Robot console        | laptop → phone B     | Metro   | yes      | `cd robot-console && npx expo start`                       |
| Pi motor (mock)      | laptop               | 8765    | no       | `python -m pi.motor_controller --mock --host 0.0.0.0 -v`   |
| Pi camera (laptop)   | laptop               | 8080    | no       | `python -m pi.camera_streamer --device 0 --host 0.0.0.0`   |
| Classifier           | laptop               | display | no       | `python demo.py --url http://.../stream.mjpg --gate relay --relay-url http://192.168.1.167:4000`           |

That's the whole rig. You can bring any subset up for targeted
debugging — everything except the three `required` services fails open.
