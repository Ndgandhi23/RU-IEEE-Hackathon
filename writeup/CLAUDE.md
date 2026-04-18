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

- **Brain machine** — a developer laptop (Mac, for the hackathon prototype) that runs YOLO inference, nav logic, and the state machine. Not physically on the robot for the prototype. In a future deployment, this role is taken over by a Jetson Orin Nano mounted on the robot, running the same code unchanged.
- **Pi 3B (on the robot)** — the edge node. Drives motors, reads ultrasonics, runs the intake motor, **and streams C270 webcam frames to the brain machine over WebSocket / MJPEG**. Has no logic of its own — just executes commands and forwards sensor data.

All heavy compute (YOLO, nav math, state machine) runs on the brain. The Pi is a thin I/O proxy. This keeps the Pi dumb and lets us iterate on the brain side (fast laptop dev loop) without touching on-robot hardware.

A lightweight **relay** (Node/Express, under `relay/`) is the only shared backend. It stores reports, exposes the latest target, accepts robot heartbeats, and proxies **Apple Maps routing** for walking directions. Both the phones and the brain machine talk to it over HTTPS. No OSM graph, no custom path planner — routing is delegated to Apple Maps, and nav's job is to follow the returned waypoints.

## Hardware

| Component | Purpose |
|---|---|
| Brain laptop (MacBook for hackathon) | Runs YOLO, nav loop, state machine. Receives camera frames + ultrasonics from the Pi over WiFi; sends motor commands back. Not on the robot — operates remotely over local WiFi. |
| Raspberry Pi 3B (on robot) | Edge node. Drives motors via H-bridge, reads ultrasonics, runs intake motor, streams webcam frames and sensor data to the brain machine over WebSocket / MJPEG. No business logic. |
| Jetson Orin Nano (optional, future) | Upgrade path. Once the prototype works end-to-end over WiFi, the Jetson takes the brain's role for a self-contained robot. Runs the same Python code. TensorRT-exported model for faster inference. |
| Robot phone (iPhone, mounted) | GPS + heading source. Posts heartbeats directly to the brain machine over local WiFi, OR through the relay. |
| Reporter phone (iPhone, handheld) | Runs the Expo app's Reporter tab: uploads trash photos + GPS to the relay. Not part of the robot. |
| Logitech C270 webcam | USB to the Pi. 720p fixed-focus. Frames streamed over WiFi to the brain machine. Used for visual final approach + obstacle detection. |
| NeveRest 60W motors | Drive motors. PWM via H-bridge from the Pi. |
| DC motor (intake) | Front intake sweeper/auger. PWM via H-bridge from the Pi. Runs during the INTAKING state. |
| Ultrasonic sensors (HC-SR04 x3+) | Front-left, front-center, front-right. Reactive obstacle avoidance only. |
| Ryobi 18V battery pack | Main power for motors. ~1 hour runtime. |
| 5V USB supply | Logic / Pi power. |
| PLA 3D printed chassis + intake funnel | Structural. |

### Hardware constraints to remember
- **Network is a hard dependency.** The brain and the Pi talk over local WiFi. If WiFi drops, the Pi's watchdog kills the motors within 500ms. Demo area must have solid WiFi — campus WiFi or a dedicated phone hotspot.
- **WebSocket round-trip latency matters.** Expect ~50–300ms depending on WiFi. Fine for nav at 0.5 m/s; tight for sub-meter visual servoing. Keep the control loop on the brain, let the Pi just execute.
- **GPS is primary localization.** The camera runs continuously during nav (course confirmation + obstacle detection — advisory), but only becomes the *primary* nav signal during final approach (last ~3m). See [nav.md](nav.md) for the CV network's three jobs.
- **iPhone compass is sensitive to motor magnetic fields.** Always mount on a stalk well above the chassis. Recalibrate (figure-8 motion) after any physical change.
- **The Pi has no logic.** Don't add behavior to the Pi. It drives motors, reads sensors, streams frames. Every decision lives on the brain machine.
- **C270 fails in low light and rain.** Demo and test in daylight, dry conditions.

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
      v (GPS heartbeat over local WiFi, HTTP)
 ┌─────────────────────────────────┐
 │       Brain machine (Mac)        │
 │  YOLO + nav + state machine      │
 │  Runs code under jetson/         │
 └────┬──────────────────▲──────────┘
      │ motor cmds        │ frames + ultrasonics
      │ (WebSocket JSON)  │ (MJPEG / WebSocket)
      ▼                   │
 ┌─────────────────────────────────┐
 │   Raspberry Pi 3B (on robot)     │
 │  motor controller + camera proxy │
 └──┬─────┬────────────┬────────────┘
    │     │            │
    ▼     ▼            ▼
[H-bridge][Ultrasonics][C270 webcam]
    │
    ▼
[Drive + Intake motors]
```

The Pi is an I/O proxy. The brain does all decision-making. The relay coordinates tasks across devices. Apple Maps is the path planner.

**The `jetson/` folder name is historical** — the code in it runs on the brain machine (Mac for prototype). We kept the name to match CLAUDE.md's original layout. When the physical Jetson is added later, the same code runs there unchanged.

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
├── jetson/                    # Code that runs on the BRAIN MACHINE (Mac now, Jetson later).
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
│   └── models/                # Exported weights (.pt now; .engine later for Jetson)
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
- Single Python script. Uses `pigpio` (or `RPi.GPIO`) for PWM + ultrasonic reads, `opencv-python` for the camera, `websockets` or `aiohttp` for the brain link. No business logic.
- **Transport: WebSocket to the brain machine** (not USB serial as originally specced). The Pi opens a WebSocket server on port 8765 on boot; the brain connects.
- Inbound JSON from brain:
  - `{"cmd": "drive", "left": <int>, "right": <int>}` where pwm ∈ [-255, 255].
  - `{"cmd": "intake", "pwm": <int>}` where pwm ∈ [0, 255]. One direction only — the intake is a sweeper/auger, not reversible.
- Outbound JSON to brain (at 20Hz):
  - `{"type": "ultrasonics", "front_cm": N, "left_cm": N, "right_cm": N, "ts": <float>}`
- Camera frames: **MJPEG over HTTP on port 8080**, served alongside the WebSocket. The brain GETs `http://<pi-ip>:8080/stream.mjpg`. Frames at 480p/15fps to fit WiFi bandwidth.
- Watchdog: all motors (drive + intake) stop if no `drive` or `intake` message received in 500ms. WiFi drop = robot halts.

### Mobile app (Expo / React Native)
- Lives in `app/`. Two tabs: Reporter and Robot.
- All network calls go through the relay — the app never talks to the brain directly. `EXPO_PUBLIC_API_BASE_URL` points at the relay.
- If `EXPO_PUBLIC_API_BASE_URL` is unset, the app falls back to in-memory mock mode. Useful for same-device UI testing only.
- Reporter tab: `POST /reports` (multipart — photo file + `metadata` JSON blob).
- Robot tab: `POST /robot/heartbeat` on a timer + `POST /routes/apple` to fetch a walking route.
- Heartbeat schema (must stay in sync with `relay/` and `jetson/io/iphone_listener.py`):
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

The brain's `main.py` runs this state machine. Treat it as the source of truth for high-level robot behavior. Runs on the brain machine (Mac now), not on the Pi.

```
IDLE
  └─(latest report fetched from relay)─> PLANNING

PLANNING
  ├─(Apple Maps route received)────> NAVIGATING
  └─(no route / relay unreachable)─> REPORTING (failure)

NAVIGATING
  ├─(within 3m of final waypoint)─> SEARCHING
  ├─(stuck >10s)──────────────────> REPORTING (failure)
  └─(GPS lost >10s)───────────────> REPORTING (failure)

SEARCHING
  ├─(target detected)─────────> APPROACHING
  └─(360° scan, nothing found)─> REPORTING (failure)

APPROACHING
  ├─(target centered, close)──> INTAKING
  └─(lost sight >3s)──────────> SEARCHING

INTAKING
  └─(intake run complete)─────> VERIFYING

VERIFYING
  ├─(target no longer detected)─> REPORTING (success)
  └─(target still visible)──────> SEARCHING (retry)

REPORTING
  └─(POST to relay complete)──> IDLE
```

Every state transition is logged. Every state has a max-duration timeout that drops to REPORTING (failure) if exceeded. An additional **LINK_LOST** failure mode: if the WebSocket to the Pi drops for >2s, any state that's commanding motors transitions to REPORTING (failure).

## Key Modules and Their Contracts

### `jetson/io/iphone_listener.py`
- Source of the robot's current GPS + heading. The robot phone posts `{location, sentAt}` directly to a FastAPI endpoint the brain machine exposes on port 8000 over local WiFi (lower latency than polling the relay).
- Maintains a thread-safe `LatestSensorState` singleton.
- `LatestSensorState.get() -> SensorReading | None` returns the most recent reading, or None if stale (>2s).

### `jetson/io/pi_bridge.py`
- WebSocket client to the Pi's port 8765. Reconnects automatically on disconnect.
- `PiBridge.set_motors(left: int, right: int)` — pwm ∈ [-255, 255]. Non-blocking; queues the JSON message.
- `PiBridge.set_intake(pwm: int)` — pwm ∈ [0, 255]. Non-blocking.
- `PiBridge.get_ultrasonics() -> Ultrasonics` — returns latest reading from the Pi's push stream, or None if stale (>500ms).
- Connection state (`is_connected`) is observable; loop exits cleanly when the Pi is unreachable.

### `jetson/io/webcam.py`
- Async capture. On the brain machine (Mac), opens a local webcam (builtin cam or direct USB). On future Jetson deployment, opens the on-robot C270.
- **For the prototype with Pi on the robot, this module is replaced by a frame consumer that reads from `http://<pi-ip>:8080/stream.mjpg` instead.** Same `Frame` dataclass, different source.

### `jetson/nav/geo.py`
- Pure functions, no state, fully unit-tested.
- `haversine(lat1, lon1, lat2, lon2) -> float` returns meters.
- `bearing(lat1, lon1, lat2, lon2) -> float` returns degrees [0, 360).
- `heading_error(target_bearing, current_heading) -> float` returns degrees [-180, 180].

### `jetson/nav/waypoint_follower.py`
- Consumes the Apple Maps route returned by the relay's `/routes/apple`.
- `load_route(route)` takes `{distanceMeters, durationSeconds, polyline, steps[]}` and converts to an ordered list of `LatLon` waypoints.
- `current_target() -> LatLon` returns the active waypoint; advances when within `WAYPOINT_ADVANCE_M`.
- No path planning. Apple Maps is the planner. This module just walks the waypoint list.

### `jetson/nav/control_loop.py`
- Runs at 10Hz **on the brain machine**. Reads state, ultrasonics (pushed from Pi), current waypoint. Sends motor commands back down to the Pi over WebSocket.
- Layered: reactive avoidance overrides goal-seeking when ultrasonics trigger.
- All control gains (`KP_TURN`, `MAX_FWD`, `ARRIVAL_THRESHOLD_M`, etc.) live at the top of the file as constants.

### `jetson/perception/detector.py`
- Loads YOLO weights at startup. On the brain machine, `.pt` weights load directly via Ultralytics (fast enough on Mac M-series or any laptop GPU). On a future Jetson, swap to a TensorRT `.engine` export for speed.
- Async detection thread pulls webcam frames (from Mac cam or Pi MJPEG stream), runs inference, pushes results to `LatestDetections`.
- `LatestDetections.get(class_filter: str | None, min_conf: float) -> list[Detection]`.
- Target: 15+ FPS at 640x480 on brain. Don't add inference to the control loop thread.

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
| `KP_TURN` | `nav/control_loop.py` | 0.02 | Radians per degree of error. Higher = more aggressive turns. Too high → oscillation. |
| `MAX_FWD` | `nav/control_loop.py` | 0.5 m/s | Outdoor max forward speed. |
| `MAX_TURN` | `nav/control_loop.py` | 1.0 rad/s | Outdoor max turn rate. |
| `ARRIVAL_THRESHOLD_M` | `nav/control_loop.py` | 3.0 | Switch from GPS nav to visual search at this distance. |
| `GPS_ACCURACY_REJECT_M` | `nav/localization.py` | 20.0 | Refuse to act on iPhone readings worse than this. |
| `GPS_STALENESS_S` | `nav/localization.py` | 2.0 | Reject GPS readings older than this. |
| `OBSTACLE_STOP_CM` | `nav/avoidance.py` | 60 | Front ultrasonic threshold for reactive avoidance. |
| `MIN_DETECTION_CONF` | `perception/servo.py` | 0.5 | YOLO confidence threshold during visual approach. |
| `APPROACH_BOX_FILL` | `perception/servo.py` | 0.4 | Stop driving when target bbox height fills this fraction of frame. |
| `WAYPOINT_ADVANCE_M` | `nav/waypoint_follower.py` | 2.0 | Switch to the next waypoint when within this distance. |
| `PI_LINK_TIMEOUT_S` | `io/pi_bridge.py` | 2.0 | Fail the run if WebSocket to Pi is silent for this long. |
| `DEDUP_RADIUS_M` | `relay/` (TBD) | 5.0 | Reject submissions within this distance of an existing pending report. |

## Testing

- Unit tests for `jetson/nav/geo.py` are mandatory. Use known lat/lon pairs from Google Maps as ground truth.
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
- **Ultralytics on Jetson (future).** When we do port to Jetson, expect pain. Pin versions per the JetPack compatibility matrix.

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

On your Mac (same WiFi as the Pi):
```bash
# download trained weights from Drive to ~/weights/trash_v1_best.pt
cd ml-training
source venv/bin/activate
cd ..
python -m jetson.io.iphone_listener &    # FastAPI on :8000 for iPhone heartbeats
python -m jetson.main --pi-ip <pi-ip> --weights ~/weights/trash_v1_best.pt
```

For a standalone webcam smoke-test (no Pi, no robot):
```bash
python tools/live_detect.py --weights ~/weights/trash_v1_best.pt
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
- **Don't change the relay contract in one place.** The heartbeat, report, and route schemas are shared across `app/`, `relay/`, and `jetson/io/iphone_listener.py`. Update all three in the same commit.
- **Don't add a custom path planner.** Apple Maps via the relay is the planner. If it gives a bad route, sanity-check and tweak *inputs* (origin, snapping); don't reinvent routing.
- **When tuning control gains, change one constant at a time** and log the effect.
- **Don't block the brain on the Pi link.** All sends should be fire-and-forget; reads from the Pi should return stale-safe defaults when no data has arrived recently.

## Open Questions / TODO

(Update this section as the project evolves. Don't let it go stale.)

- [ ] Relay does not exist yet (`relay/` folder is empty). Contract is specified in [app/README.md](../app/README.md).
- [ ] Pi motor controller + WebSocket server + MJPEG streamer not yet written (`pi/motor_controller/` folder is empty).
- [ ] iPhone → brain direct-WiFi listener not yet written.
- [ ] WebSocket JSON schema above is provisional. Pin it when `pi_bridge.py` and `pi/motor_controller/main.py` are written.
- [ ] Pick final frame resolution + codec: MJPEG 480p@15fps vs. H.264 stream (WebRTC). MJPEG is simpler; H.264 is better on bandwidth.
- [ ] Apple Maps server API token not yet provisioned. Relay will need Apple Developer credentials in its `.env`.
- [ ] Intake run duration not tuned — `INTAKING` state currently runs the intake motor for a fixed duration, no success sensing beyond VERIFYING re-detection.
- [ ] No battery monitoring yet. Robot can run until the battery dies mid-task.
- [ ] No charging dock / return-to-base behavior.
- [ ] Relay is single-instance, no auth on `/reports`. Anyone on the network can queue tasks.
- [ ] Future: port to Jetson Orin Nano, export YOLO to TensorRT `.engine`, replace Pi MJPEG stream with direct Jetson camera capture.
