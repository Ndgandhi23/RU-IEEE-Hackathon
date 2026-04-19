# Running the stack — full live playbook

End-to-end playbook for the trash-pickup robot with real hardware on the Pi
and the AI brain on the 4080 laptop.

## What runs where

Two machines + two phones. Nothing ambiguous.

| Where | What runs | Why |
| --- | --- | --- |
| **Laptop** (Windows, RTX 4080) = `192.168.1.167` | `relay` (Node, :4000) • reporter app Metro (:19000ish) • robot-console Metro (:19000ish) • `brain.main` (Python, YOLO brain) • optional `demo.py` | Relay backend, Metro bundlers for both Expo apps, and the YOLO brain that talks to the Pi over Wi-Fi. |
| **Raspberry Pi** (on the robot) = `<pi-lan-ip>` | `pi.motor_controller` (Python, WS :8765) • `pi.camera_streamer` (Python, MJPEG :8080) | Pure I/O: drives L298N H-bridge, reads encoders, streams C270 webcam. No logic. |
| **Phone A** | Expo Go → reporter app (loaded from the laptop's Metro) | User submits trash photo + GPS. |
| **Phone B** | Expo Go → robot-console (loaded from the laptop's Metro) | GPS + nav. Sends drive cmds to Pi during NAVIGATING. |

All four devices on the **same Wi-Fi**.

Two operating modes for the AI:

- **Autonomous mode** — `brain.main` (on the laptop) pulls Pi MJPEG frames,
  runs `YoloFinder` every frame. If a bottle/can is detected it approaches;
  if not, it spins right in place until YOLO finds one. Converts chosen
  `Action` → PWM, drives Pi motors over WebSocket. This is the real robot.
- **Preview mode** — `demo.py` (on the laptop) opens the Pi stream, runs YOLO,
  draws boxes. **No motor commands sent.** For sanity-checking the
  camera → detector pipe.

```
   phone A                   LAPTOP (Win, RTX 4080, .167)            phone B
┌────────────┐          ┌─────────────────────────────────┐     ┌─────────────┐
│  app       │ /reports │  relay   (Node,  :4000)         │ hb  │ robot-      │
│ (reporter) │─────────▶│  queue + Apple Maps proxy       │◀───▶│ console     │
└────────────┘          │                                 │     │ (GPS + nav) │
                        │  brain.main  (YOLO brain)       │     └──────┬──────┘
                        │    YoloFinder → Approach FSM    │            │
                        │    → Action → PWM               │─── drive ──┤  SEARCHING+
                        │                                 │            │ NAVIGATING
                        │  demo.py  (optional preview)    │            │
                        └───────────────▲─────────────────┘            │
                                        │ frames                       │
                                  MJPEG │                              │
                                        │              drive           │
                        ┌───────────────┴──────────┐                   │
                        │  RASPBERRY PI (on robot) │◀──────────────────┘
                        │   pi.camera_streamer :8080
                        │   pi.motor_controller :8765
                        └──────────────────────────┘
```

Required services: **relay**, **app**, **robot-console**, **Pi motor
controller**, **Pi camera streamer**, **brain.main**.

---

## 0. Prerequisites (hardware + software)

### Hardware
- **Any CUDA GPU (≥4 GB)** or reasonable CPU on the laptop — YOLOv8n is
  the only model `brain.main` loads and it runs fine on CPU if needed.
- **Raspberry Pi 3B+** with:
  - L298N H-bridge wired to the two NeveRest motors (pins in
    `pi/motor_controller/README.md`).
  - Logitech C270 webcam on USB.
  - `pigpio` installed and `pigpiod` running.
- **Two phones** with **Expo Go** installed. Reporter phone = phone A,
  robot-console phone = phone B (mounted on the robot).
- Laptop (running relay) + brain desktop + Pi + both phones all on the
  **same Wi-Fi**. Guest networks that isolate clients don't work.
- Windows Firewall on the laptop must allow inbound **4000, 8080, 8765,
  8000** from the private network.

Pick **one LAN IP** for the machine running the relay. Below it is
**`192.168.1.167`** — replace everywhere if `ipconfig` shows something else.
The repo's `.env` files are already set to this IP.

### Software install (one time on the brain desktop)

```powershell
cd "C:\Users\loorj\Documents\RIEEE Hackathon"
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

**CUDA torch.** `requirements.txt` pins `torch>=2.5`; if pip pulls a CPU-only
wheel or a wheel that doesn't have `nn.Module.set_submodule`, force the CUDA
build (pick the index matching your driver — `nvidia-smi` top-right shows
the CUDA version):

```powershell
pip install -U "torch>=2.5" "torchvision>=0.20" --index-url https://download.pytorch.org/whl/cu124
# use cu121 instead of cu124 if your driver is older
```

---

## 1. First-time setup

### 1a. YOLO weights

`models/trash_v1.pt` is already in the repo (~6 MB). That's the only model
`brain.main` loads. No HuggingFace downloads, no 17 GB caches. Smoke test
with:

```powershell
python tools/live_detect.py --weights models/trash_v1.pt
```

If bottles / cans in front of your webcam light up with boxes, you're good.

### 1b. Relay credentials (`relay/.env`)

Copy the example and fill in Apple Maps auth. The repo already includes
`relay/AuthKey_H2C3BVC6A9.p8`.

```powershell
cd relay
Copy-Item .env.example .env
```

Edit `relay/.env`:

```
PORT=4000
PUBLIC_BASE_URL=http://192.168.1.167:4000
APPLE_MAPS_TEAM_ID=<your 10-char Apple developer team id>
APPLE_MAPS_KEY_ID=H2C3BVC6A9
APPLE_MAPS_PRIVATE_KEY_PATH=./AuthKey_H2C3BVC6A9.p8
APPLE_MAPS_TOKEN_ORIGIN=http://192.168.1.167:4000
```

Without Apple Maps auth `/routes/apple` returns 503 and the robot console's
Nav tab won't populate — reports still queue, but routing doesn't work.

Verify later with: `curl http://192.168.1.167:4000/health` → should show
`apple_maps: ok`.

### 1c. App env files (already configured)

Both `app/.env` and `robot-console/.env` already point at
`http://192.168.1.167:4000`. If the laptop IP changes (different router /
hotspot), edit both to the new IP and restart `npx expo start`.

`robot-console` derives the Pi WebSocket as `ws://<relay-host>:8765`. Since
the Pi is **not** on the laptop in a live run, set this explicitly:

```
# robot-console/.env (add this line with the Pi's LAN IP)
EXPO_PUBLIC_PI_WS_URL=ws://<pi-lan-ip>:8765
```

### 1d. Node deps (one time, per machine)

```powershell
cd relay; npm install
cd ..\app; npm install
cd ..\robot-console; npm install
```

### 1e. Ship the code to the Pi

The Pi only needs the `pi/` package — not `brain/`, `relay/`, `app/`, or the
model weights. Two ways to get it there:

**Option A — git clone on the Pi (easiest if the Pi has internet):**

```bash
# On the Pi (SSH in first)
ssh pi@<pi-lan-ip>
sudo apt-get update
sudo apt-get install -y python3-pip python3-opencv pigpio git
sudo systemctl enable --now pigpiod
git clone <this-repo-url> ~/RIEEE-Hackathon
cd ~/RIEEE-Hackathon
python3 -m pip install -r pi/motor_controller/requirements.txt
python3 -m pip install -r pi/camera_streamer/requirements.txt
```

**Option B — scp from the laptop (if the Pi has no internet / you're
iterating on local edits):**

From PowerShell on the laptop, in the repo root:

```powershell
# one-time: install apt packages on the Pi
ssh pi@<pi-lan-ip> "sudo apt-get update && sudo apt-get install -y python3-pip python3-opencv pigpio && sudo systemctl enable --now pigpiod"

# copy just the pi/ folder to the Pi
scp -r pi pi@<pi-lan-ip>:~/RIEEE-Hackathon/

# install python deps on the Pi
ssh pi@<pi-lan-ip> "cd ~/RIEEE-Hackathon && python3 -m pip install -r pi/motor_controller/requirements.txt && python3 -m pip install -r pi/camera_streamer/requirements.txt"
```

**Re-syncing after laptop-side edits to `pi/`:**

```powershell
# fastest: re-scp only the changed subpackage
scp -r pi/motor_controller pi@<pi-lan-ip>:~/RIEEE-Hackathon/pi/
# or the camera streamer
scp -r pi/camera_streamer  pi@<pi-lan-ip>:~/RIEEE-Hackathon/pi/
```

Then restart the affected terminal on the Pi (Ctrl-C + relaunch).

Note the Pi's LAN IP (`hostname -I | awk '{print $1}'` on the Pi) — you'll
use it as `<pi-lan-ip>` in every command below and in
`robot-console/.env` (§1c).

---

## 2. Live run — terminals in order

Six terminals total: **four on the laptop**, **two on the Pi (via SSH)**.
Every heading below is tagged `[LAPTOP]` or `[PI]` — don't mix them up.

### Terminal 1 `[LAPTOP]` — Relay

```powershell
cd relay
npm start
```

Expect `campus-cleanup-relay listening on :4000`. Smoke check:

```powershell
curl http://192.168.1.167:4000/health
```

### Terminal 2 `[LAPTOP]` — Reporter app Metro (serves phone A)

```powershell
cd app
npx expo start
```

Scan the QR with Expo Go on **phone A**. Phone A loads the bundle from the
laptop's Metro and talks only to the relay at `192.168.1.167:4000`.

### Terminal 3 `[LAPTOP]` — Robot console Metro (serves phone B)

```powershell
cd robot-console
npx expo start
```

Scan the QR with Expo Go on **phone B**. Mount on the robot. Phone B
talks to:
- Relay at `192.168.1.167:4000` (heartbeats, task assignment, routes).
- **Pi motor WS at `ws://<pi-lan-ip>:8765`** — the one set in
  `robot-console/.env` as `EXPO_PUBLIC_PI_WS_URL`. This is how phone B
  sends drive commands directly to the Pi during NAVIGATING.

### Terminal 4 `[PI]` — Motor controller (drives the robot)

SSH from the laptop to the Pi:

```bash
ssh pi@<pi-lan-ip>
cd ~/RIEEE-Hackathon
python3 -m pi.motor_controller --host 0.0.0.0 -v
```

Listens on `ws://0.0.0.0:8765`. Accepts `drive` / `stop` / `reset_encoders`
from any client. Broadcasts `{type:"state", encoders, motors, watchdog_ok}`
at 20 Hz. Motors auto-zero after 500 ms of silence (watchdog).

**This is the port the laptop talks to for motor control**, from two
different clients:
1. Robot console (phone B) while NAVIGATING.
2. `brain.main` (laptop) while SEARCHING / APPROACHING / VERIFYING.

Keep the Pi on a UPS / wall-wart during bring-up, not the Ryobi
battery — a brownout restarts the controller.

### Terminal 5 `[PI]` — Camera streamer (feeds frames to the laptop)

Second SSH session to the Pi:

```bash
ssh pi@<pi-lan-ip>
cd ~/RIEEE-Hackathon
python3 -m pi.camera_streamer --host 0.0.0.0 -v
```

Serves MJPEG at `http://<pi-lan-ip>:8080/stream.mjpg`. Browser test:
paste that URL in a laptop browser, confirm live video.

`brain.main` on the laptop opens this URL automatically when you pass
`--pi-ip <pi-lan-ip>` (§Terminal 6).

### Terminal 6 `[LAPTOP]` — Brain (AI, sends control to the Pi)

This is the loop that closes camera → YOLO → motors: it GETs MJPEG frames
from the Pi, runs YOLO every frame, and **sends `drive` JSON messages back
to the Pi's WS at :8765**. Same WebSocket endpoint Terminal 4 is
serving; same protocol phone B uses during NAVIGATING.

Behavior:
- YOLO sees a bottle/can → approach it (turn toward it if off-center,
  forward when centered, scoop when the bbox fills the frame).
- YOLO sees nothing → spin right in place until it does.

**Dry-run first** — computes PWM but does NOT send to the Pi. Confirm
the per-frame log looks sane before letting it drive.

```powershell
.\.venv\Scripts\Activate.ps1
python -m brain.main ^
    --pi-ip <pi-lan-ip> ^
    --rate-hz 10 ^
    --dry-run -v
```

Expect per-frame log lines like:

```
frame=47 phase=searching action=SEARCH_RIGHT pwm=(+80,-80)  [dry-run]
frame=48 phase=approaching action=FORWARD     pwm=(+150,+150)
```

**Live run** — drop `--dry-run`. The brain now opens `ws://<pi-lan-ip>:8765`
and streams `{"cmd":"drive","left":<pwm>,"right":<pwm>}` every loop tick
(10 Hz) until shutdown, at which point it sends `{"cmd":"stop"}` and
closes cleanly.

```powershell
python -m brain.main --pi-ip <pi-lan-ip> --rate-hz 10 -v
```

Flags:
- `--pi-ip` — Pi's LAN IP (not the laptop's).
- `--yolo-weights` — default `models/trash_v1.pt`, present in repo.
- `--yolo-min-conf` — detection confidence floor, default 0.5.
- `--rate-hz` — control loop frequency, default 10.
- `--webcam N` — bypass the Pi MJPEG; pull frames from local webcam N
  (dress-rehearsal only).
- `--dry-run` — compute but don't send PWM.
- `-v` — DEBUG logging.

### Terminal 7 (optional) — Preview / classifier

**Not** the AI brain. YOLO-only visualization of the Pi stream.

```powershell
python demo.py ^
    --url http://<pi-lan-ip>:8080/stream.mjpg ^
    --gate relay ^
    --relay-url http://192.168.1.167:4000
```

- `--gate relay` — poll the relay and open the stream only when the robot
  is inside arrival radius (default 10 m, tune with `--arrival-threshold-m`).
- `--gate always` — always stream (pure smoke test).
- `--gate manual --manual-gate-file arrived.flag` — open while flag exists.
- `--no-display` — headless.

Run this while **`brain.main` is running** to watch what the brain sees.
`demo.py` never sends motor commands, so it won't fight the brain on the WS.

### Optional — Manual motor REPL

```powershell
python -m pi.manual_drive --host <pi-lan-ip> --telemetry
```

Interactive `drive / forward / back / left / right / stop / reset / status`
REPL. Useful for bench-testing the motors before connecting the brain.

---

## 3. Happy-path test flow

1. **Terminals 1–3** up on the laptop. Phone B's console boots; relay log
   shows one heartbeat.
2. **Terminals 4–5** up on the Pi. Browser-test the MJPEG URL; Pi tab on
   phone B → **Connect** → status flips `connecting → open`, `Watchdog: OK`.
3. **Terminal 6** (`brain.main`) up in **dry-run**. Watch the log — it
   should step through phases without moving motors.
4. **Phone A** submits a trash report (photo + current location). Relay
   logs `[reports] created …` + `[assignment] assigned task …`.
5. **Phone B → Task tab**: `Status: assigned`, target lat/lon populated,
   Nav tab shows waypoints + distance.
6. Walk phone B toward the report. Waypoint counter advances; within ~10 m
   of the destination, Nav flips `Arrived: YES — search phase`.
7. **Re-launch `brain.main` without `--dry-run`** (Ctrl-C the dry-run and
   relaunch, this time with the `--reference` / `--context` cropped from
   the reporter's actual photo). The brain takes over the Pi's WS:
   SEARCHING → APPROACHING → SCOOP_PUSH → VERIFYING, then exits on
   `pickup_complete`.
8. **Phone B → Task tab → "Complete current task"**. Relay assigns the
   next pending report, or returns to idle.

For bench tests, steps 4–6 are optional — `brain.main` runs against
whatever it sees from the webcam / Pi stream.

---

## 4. Pi WebSocket — who's driving when

Two clients share `:8765`:
- **Robot console (phone B)** — drives during NAVIGATING (walking Apple
  Maps waypoints).
- **Brain (`brain.main`)** — drives during SEARCHING and later phases.

The Pi's watchdog arbitrates: whoever sent `drive` most recently wins for
the next 500 ms. Today the handoff is implicit — phone stops sending when
its waypoint chain ends; brain starts sending when you launch it after
`ARRIVED`. Explicit signaling over `iphone_listener` is future work.

**Safety:**
- Leave phone B's **Enable motors** off until you've seen the proposed
  PWM on the Nav tab look sane.
- Launch `brain.main` with `--dry-run` first, confirm phase/action/PWM
  pattern, then relaunch without `--dry-run`.
- Watchdog halts motors 500 ms after the last `drive`. Any brain/phone
  crash or Wi-Fi hiccup stops the robot automatically.

---

## 5. Troubleshooting

| Symptom | Fix |
| --- | --- |
| `brain.main`: `ModuleNotFoundError: ultralytics` (or any other dep) | venv not activated, or `pip install -r requirements.txt` not done. |
| `brain.main`: frames stale / timeout | MJPEG server down, wrong `--pi-ip`, Wi-Fi saturated. Open `http://<pi-lan-ip>:8080/stream.mjpg` in a browser. |
| `brain.main`: motors don't move | Still in `--dry-run`? Watchdog tripped (no recent `drive`)? Wrong `--pi-ip`? Pi WS not running? |
| `brain.main`: spins right forever | YOLO isn't seeing a bottle/can. Drop `--yolo-min-conf 0.3` or test with `tools/live_detect.py`. |
| Robot console: red `no relay` pill | `.env` not loaded. Stop + restart `npx expo start`. |
| Task tab `✖ heartbeat` errors | Firewall blocking 4000, or laptop IP changed. Check `ipconfig` and both `.env` files. |
| Task never assigned after reporter submit | Relay log should show `[apple-maps] …`. If it errors, Apple Maps creds in `relay/.env` are wrong — curl `/health` to check. |
| Pi tab stuck on `connecting` | Terminal 4 not running, firewall blocks 8765, or `EXPO_PUBLIC_PI_WS_URL` points at the wrong host. |
| `Pi URL: unset` on Pi tab | `EXPO_PUBLIC_API_BASE_URL` missing — fix `robot-console/.env`, restart Expo. |
| `demo.py` preview never opens | Gate is closed. Try `--gate always` to isolate. |
| Phone B's GPS log stops mid-run | Phone locked & throttled the watcher — keep screen awake. |
| `cache-system uses symlinks` warning on Windows | Harmless. Enable Developer Mode to silence. |

First debug move when anything feels off: the **Logs tab** on the robot
console. Every stream (gps / relay / pi / nav / system) is interleaved by
timestamp and color-coded there. Clear, reproduce, screenshot.

---

## 6. Quick reference

| Service | Host | Port | Required | Start |
| --- | --- | --- | --- | --- |
| Relay | **LAPTOP** | 4000 | yes | `cd relay && npm start` |
| Reporter app Metro | **LAPTOP** → phone A | Metro | yes | `cd app && npx expo start` |
| Robot console Metro | **LAPTOP** → phone B | Metro | yes | `cd robot-console && npx expo start` |
| Pi motor controller | **PI** | 8765 | yes | `python3 -m pi.motor_controller --host 0.0.0.0 -v` |
| Pi camera streamer | **PI** | 8080 | yes | `python3 -m pi.camera_streamer --host 0.0.0.0 -v` |
| **Brain (YOLO, sends control → Pi)** | **LAPTOP** | — | yes | `python -m brain.main --pi-ip <pi-lan-ip> -v` |
| Preview classifier | **LAPTOP** | display | no | `python demo.py --url http://<pi-lan-ip>:8080/stream.mjpg --gate relay --relay-url http://192.168.1.167:4000` |
| Manual motor REPL | **LAPTOP** | — | no | `python -m pi.manual_drive --host <pi-lan-ip> --telemetry` |
| YOLO webcam smoke test | **LAPTOP** | — | one-time | `python tools/live_detect.py --weights models/trash_v1.pt` |

### Port cheat sheet (who listens, who talks)

| Port | Listener | Connected by |
| --- | --- | --- |
| `4000` (HTTP) | **Laptop** relay | Phones A+B, `brain.main` (for `/robot/packet` when gated) |
| `8080` (MJPEG) | **Pi** camera streamer | `brain.main` (laptop), `demo.py` (laptop), browser |
| `8765` (WS JSON) | **Pi** motor controller | `brain.main` (laptop) **and** phone B (robot-console) simultaneously |
| `19000–19006` (Metro) | **Laptop** Expo | Phones A+B over LAN |

`brain.main` is the AI. `demo.py` is a visualizer. Don't confuse them.
