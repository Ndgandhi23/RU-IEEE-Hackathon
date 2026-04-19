# CLAUDE.md

This file gives AI coding assistants the context needed to work on this repo. Read it before making changes.

> **Start here for "what's happening right now":** [NEXT.md](../NEXT.md) at the repo root. It tracks the current state of the project (what's shipped, what's next, blockers). This doc is architecture + conventions; NEXT.md is the running status.

## Project: Trash Pickup Robot

An outdoor autonomous robot that picks up litter on the Rutgers campus. Users submit photos of trash through a companion Expo app; the photo's GPS is used to locate the item. The robot routes to each reported location, finds the trash visually, and collects it with an intake motor.

Two phones are in play:
- **Reporter phone** — any user's phone running the Expo app. Uploads photo + GPS.
- **Robot phone** — mounted on the robot. Posts GPS heartbeats and asks the backend for walking routes.

### Split-compute architecture (important)

The robot's compute is **distributed across two machines** communicating over local WiFi:

- **Brain machine** — a desktop with an **NVIDIA RTX 4080** (16 GB VRAM) that runs all heavy compute: YOLO obstacle detection, OWLv2 image-conditioned target finding, the nav control loop, and the state machine. Not physically on the robot — operates remotely over local WiFi. One machine, one process tree.
- **Pi 3B (on the robot)** — the edge node. Drives motors, reads ultrasonics, runs the intake motor, **and streams C270 webcam frames to the brain machine over WebSocket / MJPEG**. Has no logic of its own — just executes commands and forwards sensor data.

All heavy compute runs on the brain. The Pi is a thin I/O proxy. This keeps the Pi dumb and lets us iterate on the brain side without touching on-robot hardware. Previously we'd planned a second desktop (4070) for nav; we consolidated onto the 4080 because a single machine simplifies deployment, removes a WebSocket hop, and the 4080 has plenty of headroom for both perception models plus CPU-bound nav code.

A lightweight **relay** (Node/Express, under `relay/`) is the only shared backend. It stores reports, exposes the latest target, accepts robot heartbeats, and proxies **Apple Maps routing** for walking directions. Both the phones and the brain machine talk to it over HTTPS. No OSM graph, no custom path planner — routing is delegated to Apple Maps, and nav's job is to follow the returned waypoints.

## Hardware

| Component | Purpose |
|---|---|
| Brain desktop (RTX 4080, 16 GB VRAM) | Runs OWLv2 + Qwen3-VL + ApproachController. Owns motor control during SEARCHING / APPROACHING / VERIFYING. Not on the robot — operates remotely over local WiFi. |
| Raspberry Pi 3B (on robot) | Edge node. Drives two NeveRest motors via L298N H-bridge, reads quadrature encoders, streams C270 frames over MJPEG. WebSocket server on :8765 accepts drive commands from BOTH the phone (during NAVIGATING) AND the brain (during SEARCHING+). No business logic. |
| Robot phone (iPhone, mounted) | GPS + heading source AND nav-loop client. Walks Apple Maps waypoints → drive commands to the Pi during NAVIGATING. Posts GPS heartbeats to the brain so the brain knows when to take over (last waypoint reached). |
| Reporter phone (iPhone, handheld) | Runs the Expo app's Reporter tab: uploads trash photos + GPS to the relay. Not part of the robot. |
| Logitech C270 webcam | USB to the Pi. 720p fixed-focus. Frames streamed over WiFi to the brain machine. Used for visual final approach (SEARCHING / APPROACHING / VERIFYING). |
| NeveRest 60W motors (×2) | Drive motors. Signed PWM via L298N from the Pi. 4-pin quadrature encoders on each motor shaft (1680 counts per output-shaft revolution). |
| Ryobi 18V battery pack | Main power for motors. ~1 hour runtime. |
| 5V USB supply | Logic / Pi power. |
| PLA 3D printed chassis + scoop | Structural. The front scoop is the "intake" — there is **no separate intake motor**; collection happens by driving forward into the bottle. |

### Hardware constraints to remember
- **Network is a hard dependency.** The brain and the Pi talk over local WiFi. If WiFi drops, the Pi's watchdog kills the motors within 500ms. Demo area must have solid WiFi — campus WiFi or a dedicated phone hotspot.
- **WebSocket round-trip latency matters.** Expect ~50–300ms depending on WiFi. Fine for nav at 0.5 m/s; tight for sub-meter visual servoing. Keep the control loop on the brain, let the Pi just execute.
- **GPS is primary localization during NAVIGATING.** Phone uses Apple Maps waypoints + GPS to drive the Pi until it reaches the last waypoint, then yields to the brain.
- **iPhone compass is sensitive to motor magnetic fields.** Always mount on a stalk well above the chassis. Recalibrate (figure-8 motion) after any physical change.
- **The Pi has no logic.** Don't add behavior to the Pi. It drives motors, reads encoders, streams frames. Every decision lives on the phone (NAVIGATING) or the brain (SEARCHING+).
- **Two WS clients on :8765.** Phone and brain both connect. Whoever sent `drive` most recently wins for the next 500 ms (Pi watchdog). Coordination is implicit: the phone stops sending when its waypoint chain ends; the brain starts sending when its iPhone-GPS listener sees the robot inside the last-waypoint radius.
- **C270 fails in low light and rain.** Demo and test in daylight, dry conditions.
- **Brain is a single point of failure.** If the 4080 crashes, the robot halts (Pi watchdog zeros motors after 500ms). Keep the brain on wired power, not running other heavy workloads during a run.

## Architecture

```
[Reporter phone]                              [Apple Maps Server API]
      |                                                 ^
      | POST /reports                                   |
      v                                                 |
 ┌───────────────── Relay (Node/Express) ───────────────┘
 │   /reports (POST, GET latest)
 │   /robot/heartbeat (POST)
 │   /routes/apple  (POST — proxies Apple Maps)
 └──────────────────────────────────────────────────
      ^                ^                  ^
      | heartbeat      | route request    | task poll
      |                |                  |
[Robot phone]          |                  |
      |                |                  |
      v (GPS heartbeat to brain :8000)
 ┌─────────────────────────────────┐
 │   Brain desktop (RTX 4080)       │
 │  OWLv2 + Qwen3-VL + Approach FSM │
 │  Runs code under brain/         │
 └────┬──────────────────▲──────────┘
      │ motor cmds        │ frames
      │ (WebSocket JSON)  │ (MJPEG)
      ▼                   │
 ┌─────────────────────────────────┐
 │   Raspberry Pi 3B (on robot)     │
 │  motor controller + camera proxy │
 │  WS :8765, MJPEG :8080           │
 └──┬──────────────┬───────────────┘
    │              │
    ▼              ▼
[L298N H-bridge][C270 webcam]
    │     ▲
    ▼     │ encoder ticks
[Drive motors (×2) + 4-pin quadrature encoders]
```

**Two clients on Pi :8765**: the **phone** (during NAVIGATING — runs `useRobotNav` + Apple Maps in the Expo app) and the **brain** (during SEARCHING / APPROACHING / VERIFYING — runs OWLv2 + Qwen3-VL). Pi is an I/O proxy and arbitrates with its 500 ms watchdog: most-recent `drive` command wins.

The `brain/` folder holds everything that runs on the brain desktop (RTX 4080): perception (OWLv2 + Qwen3-VL + YOLOv8n) and approach control + I/O clients.

## Repo Layout

```
trash-robot/
├── CLAUDE.md                  # Symlink -> writeup/CLAUDE.md (so Claude Code auto-loads it)
├── writeup/                   # All project documentation
│   ├── CLAUDE.md              # This file
│   ├── idea.md                # Project idea / pitch
│   ├── constraints.md         # Hackathon constraints
│   ├── deliverables.md        # Deliverables checklist
│   ├── nav.md                 # Navigation design
│   └── trash-detection.md     # YOLO detector design
├── brain/                    # Code that runs on the brain desktop (RTX 4080).
│   ├── nav/                   # Navigation: localization, waypoint follower, control loop, avoidance
│   ├── perception/            # YOLO inference, visual servoing
│   ├── io/                    # iPhone listener, Pi bridge (WebSocket client), frame stream consumer
│   ├── state/                 # Shared state objects, logging
│   └── main.py                # State machine orchestrator
├── pi/
│   └── motor_controller/      # Python script on the Pi: motor PWM, ultrasonic reads, camera streaming, WebSocket server
├── app/                       # Expo / React Native mobile app ("Campus Cleanup Router")
│   ├── app/(tabs)/            # Reporter tab (photo + GPS upload) + Robot tab (heartbeats + route)
│   ├── services/routing-api.ts
│   └── ...
├── relay/                     # Node/Express backend (not yet written)
│   └── ...                    # /reports, /reports/latest, /robot/heartbeat, /routes/apple (MapKit proxy)
├── ml-training/
│   ├── data/                  # TACO + custom Rutgers photos
│   ├── notebooks/             # Training + EDA + sanity notebooks
│   ├── scripts/               # prepare_dataset.py, train.py, evaluate.py, prepare_drink_waste.py
│   └── models/                # Trained weights (.pt — runs directly on the RTX 4080)
├── tools/
│   ├── webcam_preview.py      # Live webcam preview (interactive or --save-dir headless)
│   ├── live_detect.py         # Live YOLO inference on webcam
│   ├── joystick.py            # (future) Manual WASD control for testing
│   └── replay.py              # (future) Replay logged sensor data into nav loop offline
└── tests/
    └── test_geo.py            # Unit tests for nav/geo.py
```

All project docs live in `writeup/`. The root `CLAUDE.md` is a symlink so Claude Code and humans find it by convention.

## Conventions

### Python (brain machine)
- Python 3.10+. Pin all deps in `requirements.txt`. No floating versions.
- Type hints on all function signatures. Use `from __future__ import annotations` at top of every file.
- Async where I/O bound (relay polling, phone listener, Pi WebSocket). Sync everywhere else.
- Logging: `logging` stdlib, JSONL format to `logs/<date>.jsonl`. Never `print()` in production paths.
- All sensor readings carry a timestamp. Reject stale data (>2s for GPS, >500ms for ultrasonics, >1s for frames).
- Units: SI everywhere internally (meters, m/s, radians for math, degrees only at I/O boundaries with the phone/relay). Document units in variable names where ambiguous (`distance_m`, `heading_deg`).

### Node / TypeScript (relay + app)
- Node 20+ for the relay. Express or Fastify — pick one, don't mix.
- App is Expo SDK 51+, TypeScript strict mode, Expo Router.
- Shared types between app and relay live in the app's `types/` directory. Keep request/response shapes in sync.
- Never commit `.env` or Apple Maps server credentials. Use `.env.example` as the schema.

### Coordinate conventions
- GPS: decimal degrees, WGS84. `(lat, lon)` tuple order, never `(lon, lat)`.
- Heading: degrees from true north, clockwise, range `[0, 360)`. Convert magnetic to true if needed.
- Bearing error: signed degrees in `[-180, 180]`. Negative = turn left, positive = turn right.
- Body frame: x-forward, y-left, z-up (ROS REP 103 convention) for any IMU work.

### Pi 3B (motor/sensor/camera proxy)
- Two services. **`pi.motor_controller`** = WebSocket on :8765, drives the L298N + reads quadrature encoders. **`pi.camera_streamer`** = MJPEG on :8080 from the C270. Both use `pigpio`/`opencv-python`. No business logic.
- Multi-client WebSocket on :8765. Phone connects during NAVIGATING; brain connects during SEARCHING+. Both can send `drive`; most-recent wins for the next 500 ms.
- Inbound JSON (from any client):
  - `{"cmd": "drive", "left": <int>, "right": <int>}` where pwm ∈ [-255, 255]. Signed: + = forward, − = reverse, 0 = coast.
  - `{"cmd": "stop"}` — zero both motors immediately.
  - `{"cmd": "reset_encoders"}` — zero cumulative tick counters.
- Outbound JSON to all connected clients (at 20 Hz):
  - `{"type": "state", "ts": <float>, "encoders": {"left": <int>, "right": <int>}, "motors": {"left_pwm": <int>, "right_pwm": <int>}, "watchdog_ok": <bool>}`
  - Encoders are signed cumulative ticks (1680/output-shaft revolution for NeveRest Classic 60 + 60:1). Brain converts to meters via `π × wheel_diameter / 1680`.
- Camera frames: **MJPEG over HTTP on port 8080** from `pi.camera_streamer`. The brain GETs `http://<pi-ip>:8080/stream.mjpg`. 480p/15fps.
- Watchdog: motors zero if no `drive`/`stop` received in 500 ms. WiFi drop = robot halts.

### Mobile app (Expo / React Native)
- Lives in `app/`. Two tabs: Reporter and Robot.
- All network calls go through the relay — the app never talks to the brain directly. `EXPO_PUBLIC_API_BASE_URL` points at the relay.
- If `EXPO_PUBLIC_API_BASE_URL` is unset, the app falls back to in-memory mock mode. Useful for same-device UI testing only.
- Reporter tab: `POST /reports` (multipart — photo file + `metadata` JSON blob).
- Robot tab: `POST /robot/heartbeat` on a timer + `POST /routes/apple` to fetch a walking route.
- Heartbeat schema (must stay in sync with `relay/` and `brain/io/iphone_listener.py`):
  ```json
  {"location": {"latitude": 40.5, "longitude": -74.4,
                "accuracy": 4.8, "timestamp": "2026-04-18T16:32:00.000Z"},
   "sentAt": "2026-04-18T16:32:00.000Z"}
  ```

### Git
- Branch per milestone: `milestone-N-description`.
- Commit messages: imperative mood, scope prefix. `nav: tune KP_TURN for outdoor`, `perception: switch to tracked-object smoothing`.
- Tag working states: `v0.1-open-field-nav`, `v0.2-with-avoidance`, etc. Lets you bisect when things break.
- Never commit secrets, API keys, or model files >100MB (use Git LFS or release artifacts).

## State Machine

Source of truth for high-level robot behavior. The FSM is **distributed across two devices** — phone owns NAVIGATING, brain owns the vision-driven phases. Handoff happens via the phone's GPS heartbeat to the brain (`brain/io/iphone_listener.py`): when the brain sees the phone GPS inside the last-waypoint radius, it takes over the WS to the Pi.

```
IDLE
  └─(latest report fetched from relay)─> PLANNING                         [phone]

PLANNING
  ├─(Apple Maps route received)────> NAVIGATING                            [phone]
  └─(no route / relay unreachable)─> REPORTING (failure)

NAVIGATING                                                                 [phone]
  ├─(within 3m of final waypoint)─> SEARCHING                              [→ brain]
  ├─(stuck >10s)──────────────────> REPORTING (failure)
  └─(GPS lost >10s)───────────────> REPORTING (failure)

SEARCHING                                                                  [brain]
  ├─(target detected)─────────> APPROACHING
  └─(360° scan, nothing found)─> REPORTING (failure)

APPROACHING                                                                [brain]
  ├─(target leaves bottom of frame OR bbox fills frame)─> VERIFYING
  └─(lost sight >3s)──────────────────────────────────────> SEARCHING

VERIFYING                                                                  [brain]
  ├─(target no longer detected)─> REPORTING (success)
  └─(target still visible)──────> SEARCHING (retry)

REPORTING
  └─(POST to relay complete)──> IDLE
```

There is **no INTAKING state**. The robot has a passive front scoop, no intake motor — collection is implicit in driving forward during APPROACHING. VERIFYING confirms success (target no longer in frame ≈ inside the scoop or driven past).

Every state transition is logged. Every state has a max-duration timeout that drops to REPORTING (failure) if exceeded. An additional **LINK_LOST** failure mode: if the WebSocket to the Pi drops for >2s, any state that's commanding motors transitions to REPORTING (failure).

## Key Modules and Their Contracts

### `brain/io/iphone_listener.py`
- Source of the robot's current GPS + heading. The robot phone posts `{location, sentAt}` directly to a FastAPI endpoint the brain machine exposes on port 8000 over local WiFi (lower latency than polling the relay).
- Maintains a thread-safe `LatestSensorState` singleton.
- `LatestSensorState.get() -> SensorReading | None` returns the most recent reading, or None if stale (>2s).

### `brain/io/pi_bridge.py`
- WebSocket client to Pi :8765. Async-internal (own thread + asyncio loop), sync-facing API. Auto-reconnect.
- `PiBridge.set_motors(left: int, right: int)` — pwm ∈ [-255, 255]. Fire-and-forget JSON `drive` cmd.
- `PiBridge.stop_motors()` — fire-and-forget JSON `stop` cmd.
- `PiBridge.reset_encoders()` — fire-and-forget JSON `reset_encoders` cmd.
- `PiBridge.get_state() -> RobotState | None` — most recent `state` push (encoders, motor PWMs, watchdog_ok), or None if stale (>200 ms — Pi pushes at 20 Hz).
- `is_connected` is observable. `link_timeout_s` (default 2 s) is for higher-level code that wants to fail the run on a long link drop.

### `brain/io/webcam.py`
- Async capture. On the brain desktop, opens a local webcam (builtin or USB) for development.
- **For the prototype with Pi on the robot, this module is replaced by a frame consumer that reads from `http://<pi-ip>:8080/stream.mjpg` instead.** Same `Frame` dataclass, different source.

### `brain/nav/geo.py`
- Pure functions, no state, fully unit-tested.
- `haversine(lat1, lon1, lat2, lon2) -> float` returns meters.
- `bearing(lat1, lon1, lat2, lon2) -> float` returns degrees [0, 360).
- `heading_error(target_bearing, current_heading) -> float` returns degrees [-180, 180].

### `brain/nav/waypoint_follower.py`
- Consumes the Apple Maps route returned by the relay's `/routes/apple`.
- `load_route(route)` takes `{distanceMeters, durationSeconds, polyline, steps[]}` and converts to an ordered list of `LatLon` waypoints.
- `current_target() -> LatLon` returns the active waypoint; advances when within `WAYPOINT_ADVANCE_M`.
- No path planning. Apple Maps is the planner. This module just walks the waypoint list.

### `brain/nav/control_loop.py`
- Runs at 10Hz **on the brain machine**. Reads state, ultrasonics (pushed from Pi), current waypoint. Sends motor commands back down to the Pi over WebSocket.
- Layered: reactive avoidance overrides goal-seeking when ultrasonics trigger.
- All control gains (`KP_TURN`, `MAX_FWD`, `ARRIVAL_THRESHOLD_M`, etc.) live at the top of the file as constants.

### `brain/perception/detector.py`
- Loads YOLOv8n weights (`models/trash_v1.pt`) at startup. On the RTX 4080 brain, `.pt` weights load directly via Ultralytics and run at 100+ FPS.
- Async detection thread pulls webcam frames (from the Pi's MJPEG stream, or a local webcam during development), runs inference, pushes results to `LatestDetections`.
- `LatestDetections.get(class_filter: str | None, min_conf: float) -> list[Detection]`.
- **Role:** during NAVIGATING, this provides general-purpose detection for Job 2 obstacle avoidance (person, bicycle, car, etc.). During SEARCHING/APPROACHING/VERIFYING the target finder (below) takes over as the primary CV source.
- Don't add inference to the control loop thread.

### `brain/perception/target_finder.py`
- Loads **OWLv2** (`google/owlv2-base-patch16-ensemble` from HuggingFace) — image-conditioned open-vocabulary detector, ~155M params, ~300 MB fp16, ~25–30 FPS at 768×768 on an RTX 4080.
- Entry point accepts a **reference image** (the reporter's trash photo, cropped) at task-start time. Runs the image encoder once and caches the resulting query embedding for the lifetime of the task.
- Per-frame API: `TargetFinder.detect(frame: np.ndarray) -> list[Detection]` returning bounding boxes scored by cosine similarity to the reference embedding.
- **Role:** primary CV source during SEARCHING, APPROACHING, and VERIFYING. Output shape matches `Detection` so it's a drop-in for the visual servoing controller in `perception/servo.py`.
- Demo assumption: single target in scene, no lookalikes — we just take the highest-scoring box above `TARGET_MIN_SIM`. See [nav.md](nav.md) for the full flow and failure modes.

### `pi/motor_controller/` (on the Pi)
- Python script: opens WebSocket server on 8765, MJPEG server on 8080.
- Reads ultrasonics at 20Hz, pushes over WebSocket.
- Accepts motor/intake JSON commands.
- Reads C270 frames, serves as MJPEG.
- Watchdog thread: if no drive/intake command received in 500ms, zero the motors.

### `relay/` (Node/Express, not yet written)
- `POST /reports` — multipart form (`photo` file + `metadata` JSON). Returns the stored report with an `id` and hosted `photoUrl`.
- `GET /reports/latest` — the most recent unassigned report.
- `POST /robot/heartbeat` — robot phone posts `{location, sentAt}` on a timer.
- `POST /routes/apple` — body: `{origin, destination, travelMode: "walking"}`. Relay calls Apple Maps Server API and returns a normalized `{route: {distanceMeters, durationSeconds, polyline, steps[]}}`.

## Tuning Constants (Current Values)

These live in code but are reproduced here so you know where to look. If you change them, update both.

| Constant | File | Current | Notes |
|---|---|---|---|
| `STOP_AREA_FRAC` | `brain/control/loop.py` | 0.15 | Trigger STOP when target bbox area / frame area exceeds this. |
| `ALIGN_TOLERANCE` | `brain/control/loop.py` | 0.15 | |err_frac| under this → drive FORWARD instead of turning. |
| `SEARCH_FRAMES` | `brain/control/loop.py` | 15 | Rotation ticks queued per VLM scout call. |
| `ACTION_TO_PWM` | `brain/control/action_to_pwm.py` | (see file) | Discrete Action → (left, right) PWM. Tune on the real robot. |
| `TARGET_MIN_SIM` | `brain/perception/target_finder.py` | 0.3 | OWLv2 image-similarity threshold. Lower if reference and live view differ in lighting/scale. |
| `STATE_STALENESS_S` | `brain/io/pi_bridge.py` | 0.2 | Encoder/state push max age. Pi pushes at 20 Hz so 200 ms covers WiFi hiccups. |
| `PI_LINK_TIMEOUT_S` | `brain/io/pi_bridge.py` | 2.0 | Higher-level "fail the run" hint if the WS has been down this long. |
| `WATCHDOG_TIMEOUT_S` | `pi/motor_controller/config.py` | 0.5 | Pi zeros motors if no `drive`/`stop` cmd in this long. |
| `TELEMETRY_HZ` | `pi/motor_controller/config.py` | 20 | Rate of `state` broadcast from Pi to all clients. |
| `COUNTS_PER_OUTPUT_REV` | `pi/motor_controller/config.py` | 1680 | NeveRest Classic 60: 7 CPR × 4X × 60:1 gearbox. Brain converts ticks → meters using this. |
| `GPS_STALENESS_S` | `brain/io/iphone_listener.py` | 2.0 | Reject GPS readings older than this. |
| `DEDUP_RADIUS_M` | `relay/` (TBD) | 5.0 | Reject submissions within this distance of an existing pending report. |

## Testing

- Unit tests for `brain/nav/geo.py` are mandatory. Use known lat/lon pairs from Google Maps as ground truth.
- Integration tests use the replay tool: feed logged sensor data into the nav loop offline, assert expected motor commands.
- **Smoke-test the WebSocket link** before every field session: `python tools/ping_pi.py <pi-ip>` should round-trip < 200ms.
- Field testing protocol: always verify the iPhone is streaming GPS and the Pi is streaming frames + ultrasonics before powering motors.
- Never field-test without the Pi watchdog. Motors must stop on main loop hang or link loss.

## Known Gotchas

- **WiFi latency variance.** A single slow packet → a 500ms stall → the Pi's watchdog kills the motors mid-maneuver. Expected behavior, but budget retries into demos.
- **Bandwidth ceiling for camera frames.** 720p@30fps MJPEG is ~15 Mbps — borderline on congested campus WiFi. Drop to 480p@15fps if you see frame drops.
- **iOS silently kills background HTTP.** The iPhone app needs the background mode entitlement and a periodic foreground keepalive or it dies after a few minutes with the screen locked.
- **GPS multipath near buildings.** iPhone reports `h_accuracy_m` jumping to 30-60m near tall buildings. Trust the accuracy field, not the position.
- **Compass offset after physical robot changes.** Any time the iPhone mount is moved or motor placement changes, recalibrate.
- **NeveRest motors draw significant current under load.** If the H-bridge browns out, the Pi might reset → WebSocket reconnects → robot resumes. Current budget against battery output.
- **Relay + brain are single points of failure.** If either is down, nothing works.
- **Apple Maps routes follow pedestrian paths, not campus shortcuts.** If a route sends the robot across a grass quad, the waypoint list won't include the quad.
- **Apple Maps MapKit requires a trusted environment.** Server-side MapKit JS needs a valid Apple Developer token; it lives in the relay's `.env`. Never commit it.
- **OWLv2 domain shift.** The reporter photo is typically taken 30cm away in good light; the live C270 view is 1–3m away in variable light. Cosine similarity drops noticeably. If misses are frequent, lower `TARGET_MIN_SIM` rather than switching models. Test-time augmentation (horizontal flip of the reference) helps marginally.
- **OWLv2 small-object recall.** At 3m, a bottle is ~20 pixels tall on a C270. OWLv2-base handles this but not great. Mitigation: drive slowly on approach and re-query continuously, the bbox grows as the robot closes in.

## How to Run (development — Mac as brain)

Start the relay (phones and brain depend on it):
```bash
cd relay
npm install
npm start                                # listens on :4000
```

Start the Expo app (reporter + robot phone):
```bash
cd app
cp .env.example .env                     # point EXPO_PUBLIC_API_BASE_URL at the relay
npx expo start --clear
```

On the Pi (on the robot, WiFi-connected):
```bash
cd pi/motor_controller
python3 main.py                          # opens WS :8765 and MJPEG :8080
```

On the brain desktop (RTX 4080, same WiFi as the Pi):
```bash
# weights live in repo: models/trash_v1.pt (YOLOv8n for obstacle detection)
# OWLv2 weights are pulled automatically from HuggingFace on first run (~300 MB)
source venv/bin/activate
python -m brain.io.iphone_listener &    # FastAPI on :8000 for iPhone heartbeats
python -m brain.main --pi-ip <pi-ip> --yolo-weights models/trash_v1.pt
```

For a standalone webcam smoke-test (no Pi, no robot):
```bash
python tools/live_detect.py --weights models/trash_v1.pt
```

For offline replay:
```bash
python tools/replay.py logs/2026-04-18T14-00-00.jsonl
```

## When Modifying This Project

- **Don't widen the Pi's responsibilities.** If you find yourself adding logic to the Pi script, that logic belongs on the brain machine.
- **Don't bypass the state machine.** New behaviors are new states or new transitions, not ad-hoc threads firing motor commands.
- **Don't trust GPS without checking accuracy.** Every GPS read should be paired with an `h_accuracy_m` check.
- **Don't add inference to the control loop thread.** Perception runs in its own thread/process, control loop reads cached results.
- **Don't change the relay contract in one place.** The heartbeat, report, and route schemas are shared across `app/`, `relay/`, and `brain/io/iphone_listener.py`. Update all three in the same commit.
- **Don't add a custom path planner.** Apple Maps via the relay is the planner. If it gives a bad route, sanity-check and tweak *inputs* (origin, snapping); don't reinvent routing.
- **When tuning control gains, change one constant at a time** and log the effect.
- **Don't block the brain on the Pi link.** All sends should be fire-and-forget; reads from the Pi should return stale-safe defaults when no data has arrived recently.

## Open Questions / TODO

(Update this section as the project evolves. Don't let it go stale.)

- [x] Pi motor controller (`pi/motor_controller/`) — shipped, encoder-based, watchdog-protected.
- [x] Pi camera streamer (`pi/camera_streamer/`) — shipped.
- [x] Brain-side `pi_bridge.py` + `pi_frame_source.py` — shipped, integration-tested.
- [x] iPhone → brain direct-WiFi listener (`brain/io/iphone_listener.py`) — shipped.
- [x] WebSocket JSON schema pinned (see § Pi 3B above and `pi/motor_controller/ws_server.py`).
- [ ] **Phone-side `useRobotNav` + `nav-loop.ts` in the Expo app** — owns NAVIGATING. Speaks the same WS protocol the brain does.
- [ ] **Phone↔brain handoff coordination.** Implicit today (phone stops sending when its waypoints end; brain starts when iphone_listener sees GPS at last waypoint). Decide if explicit signaling is needed (e.g. phone POSTs `/handoff` to brain).
- [ ] OWLv2 + Qwen3-VL **GPU validation** on the 4080 — still scaffolded only.
- [ ] **Full state machine orchestrator** in `brain/main.py`. Currently runs only the approach loop.
- [ ] Relay (`relay/`) — Node/Express. Endpoints: `POST /reports`, `GET /reports/latest`, `POST /robot/heartbeat`, `POST /routes/apple`. Contract in [app/README.md](../app/README.md).
- [ ] Apple Maps server API token not yet provisioned.
- [ ] Reporter-photo cropping pipeline: brain crops at task-start time using YOLOv8n, falls back to full photo if no trash class found. Confirm vs. having Expo app crop.
- [ ] No battery monitoring yet. No charging dock / return-to-base behavior.
- [ ] Relay is single-instance, no auth on `/reports`. Anyone on the network can queue tasks.
- [ ] Frame codec: MJPEG 480p@15fps is in use. Reconsider H.264 / WebRTC if bandwidth becomes an issue at 720p.
