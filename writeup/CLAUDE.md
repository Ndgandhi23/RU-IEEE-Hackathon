# CLAUDE.md

This file gives AI coding assistants the context needed to work on this repo. Read it before making changes.

## Project: Trash Pickup Robot

An outdoor autonomous robot that picks up litter on the Rutgers campus. Users submit photos of trash through a companion Expo app; the photo's GPS is used to locate the item. The robot routes to each reported location, finds the trash visually, and collects it with an intake motor.

Two phones are in play:
- **Reporter phone** — any user's phone running the Expo app. Uploads photo + GPS.
- **Robot phone** — mounted on the robot. Posts GPS heartbeats and asks the backend for walking routes.

A lightweight **relay** (Node/Express, under `relay/`) is the only server. It stores reports, exposes the latest target, accepts robot heartbeats, and proxies **Apple Maps routing** for walking directions. There is no OSM graph and no custom path planner on the Jetson — routing is delegated to Apple Maps via the relay, and nav's job is to follow the returned waypoints.

## Hardware

| Component | Purpose |
|---|---|
| Jetson Orin Nano | Main compute. Runs nav loop, YOLO inference, sensor fusion. Follows waypoints from Apple Maps — no custom planner. |
| Raspberry Pi 3B | Dumb I/O slave. Drives motors via H-bridge, reads ultrasonics, runs intake motor. Talks to Jetson over USB serial. |
| Robot phone (iPhone, mounted) | GPS + heading source. Runs the Expo app's Robot tab: posts heartbeats and route requests to the relay. |
| Reporter phone (iPhone, handheld) | Runs the Expo app's Reporter tab: uploads trash photos + GPS to the relay. Not part of the robot. |
| Logitech C270 webcam | USB to Jetson. 720p fixed-focus. Used for visual final approach and intake verification. Not used for navigation. |
| NeveRest 60W motors | Drive motors. PWM via H-bridge from the Pi. |
| DC motor (intake) | Front intake sweeper/auger. PWM via H-bridge from the Pi. Runs during the INTAKING state. |
| Ultrasonic sensors (HC-SR04 x3+) | Front-left, front-center, front-right. Reactive obstacle avoidance only. |
| Ryobi 18V battery pack | Main power. ~1 hour runtime. |
| 5V USB supply | Logic / Pi power. |
| PLA 3D printed chassis + intake funnel | Structural. |

### Hardware constraints to remember
- **No camera is used for navigation.** The webcam is only active during the visual servoing phase (last ~3m to target). Treat GPS as primary localization.
- **iPhone compass is sensitive to motor magnetic fields.** Always mount on a stalk well above the chassis. Recalibrate (figure-8 motion) after any physical change.
- **The Pi has no logic.** Don't add behavior to the Pi. It executes motor commands (drive + intake) and reports sensor readings. Everything else lives on the Jetson.
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
[Robot phone]  <--- local WiFi --->  [Jetson Orin Nano] <--USB serial--> [Raspberry Pi 3B] --PWM--> [Drive + Intake motors]
                                           |                                     |
                                           |                                 [Ultrasonics]
                                           |
                                      [USB Webcam]
                                           |
                                           v
                                      [YOLO inference]
```

The Jetson is the brain for *on-robot autonomy*. The relay is the brain for *task coordination*. The Pi and the robot phone are sensors/actuators. Apple Maps is the path planner — we don't write one.

**Open design decision:** how the Jetson gets the robot phone's GPS. Either (A) Jetson polls the relay for the latest heartbeat, or (B) the robot phone streams GPS directly to the Jetson over local WiFi. (B) is lower latency (<100ms vs 500ms+); (A) is simpler. Document the choice in `jetson/io/iphone_listener.py` when we pick.

## Repo Layout

```
trash-robot/
├── CLAUDE.md                  # Symlink -> writeup/CLAUDE.md (so Claude Code auto-loads it)
├── writeup/                   # All project documentation
│   ├── CLAUDE.md              # This file
│   ├── idea.md                # Project idea / pitch
│   ├── constraints.md         # Hackathon constraints
│   └── deliverables.md        # Deliverables checklist
├── jetson/                    # All code that runs on the Jetson Orin Nano
│   ├── nav/                   # Navigation: localization, waypoint follower, control loop, avoidance
│   ├── perception/            # YOLO inference, visual servoing
│   ├── io/                    # iPhone/relay listener, Pi bridge, webcam capture
│   ├── state/                 # Shared state objects, logging
│   └── main.py                # State machine orchestrator
├── pi/
│   └── motor_controller/      # Python script: serial protocol, drive + intake PWM, ultrasonic reads
├── app/                       # Expo / React Native mobile app ("Campus Cleanup Router")
│   ├── app/(tabs)/            # Reporter tab (photo + GPS upload) + Robot tab (heartbeats + route)
│   ├── services/routing-api.ts  # Client for the relay
│   └── ...
├── relay/                     # Node/Express backend (NOT YET WRITTEN)
│   └── ...                    # /reports, /reports/latest, /robot/heartbeat, /routes/apple (MapKit proxy)
├── ml-training/
│   ├── data/                  # TACO + custom Rutgers photos
│   ├── notebooks/             # Training experiments
│   └── models/                # Exported weights (.pt, .onnx, .engine)
├── tools/
│   ├── joystick.py            # Manual WASD control for testing
│   ├── gps_logger.py          # Walk around with iPhone, log GPS track
│   └── replay.py              # Replay logged sensor data into nav loop offline
└── tests/
```

All project docs live in `writeup/`. The root `CLAUDE.md` is a symlink so Claude Code and humans find it by convention.

## Conventions

### Python (Jetson)
- Python 3.10. Pin all deps in `requirements.txt`. No floating versions.
- Type hints on all function signatures. Use `from __future__ import annotations` at top of every file.
- Async where I/O bound (relay polling, phone listener, Pi bridge). Sync everywhere else.
- Logging: `logging` stdlib, JSONL format to `/var/log/robot/<date>.jsonl`. Never `print()` in production paths.
- All sensor readings carry a timestamp. Reject stale data (>2s for GPS, >500ms for ultrasonics).
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

### Pi 3B (motor/sensor controller)
- Single Python script. Uses `pigpio` (or `RPi.GPIO`) for PWM and ultrasonic reads. No business logic.
- Serial protocol is line-based, 115200 baud, ASCII (USB serial to Jetson). Don't switch to binary unless you have a measured reason.
- Inbound drive: `M,<left_pwm>,<right_pwm>\n` where pwm ∈ [-255, 255].
- Inbound intake: `I,<pwm>\n` where pwm ∈ [0, 255]. One direction only — the intake is a sweeper/auger, not reversible.
- Outbound: `U,<front_cm>,<left_cm>,<right_cm>\n` at 20Hz.
- Watchdog: all motors (drive + intake) stop if no `M` or `I` command received in 500ms.

### Mobile app (Expo / React Native)
- Lives in `app/`. Two tabs: Reporter and Robot.
- All network calls go through the relay — the app never talks to the Jetson directly. `EXPO_PUBLIC_API_BASE_URL` points at the relay.
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
- Commit messages: imperative mood, scope prefix. `nav: tune KP_TURN for outdoor`, `perception: export YOLO to TensorRT`.
- Tag working states: `v0.1-open-field-nav`, `v0.2-with-avoidance`, etc. Lets you bisect when things break.
- Never commit secrets, API keys, or `.engine` model files >100MB (use Git LFS or release artifacts).

## State Machine

The Jetson's `main.py` runs this state machine. Treat it as the source of truth for high-level robot behavior.

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

Every state transition is logged. Every state has a max-duration timeout that drops to REPORTING (failure) if exceeded.

## Key Modules and Their Contracts

### `jetson/io/iphone_listener.py`
- Source of the robot's current GPS + heading. Exact transport depends on the open design decision in Architecture:
  - (A) Poll the relay's `/robot/latest-location` (to be added) at ~5Hz, OR
  - (B) Bind a small FastAPI endpoint on port 8000 and have the robot phone POST heartbeats directly.
- Maintains a thread-safe `LatestSensorState` singleton.
- `LatestSensorState.get() -> SensorReading | None` returns the most recent reading, or None if stale (>2s).

### `jetson/io/pi_bridge.py`
- `PiBridge.set_motors(left: int, right: int)` — pwm ∈ [-255, 255]. Non-blocking.
- `PiBridge.set_intake(pwm: int)` — pwm ∈ [0, 255]. Non-blocking.
- `PiBridge.get_ultrasonics() -> Ultrasonics` — returns latest reading, blocks up to 100ms if none cached.
- Auto-reconnects on serial disconnect. Logs every reconnect.

### `jetson/nav/geo.py`
- Pure functions, no state, fully unit-tested.
- `haversine(lat1, lon1, lat2, lon2) -> float` returns meters.
- `bearing(lat1, lon1, lat2, lon2) -> float` returns degrees [0, 360).
- `heading_error(target_bearing, current_heading) -> float` returns degrees [-180, 180].

### `jetson/nav/waypoint_follower.py`
- Consumes the Apple Maps route returned by the relay's `/routes/apple`.
- `load_route(route: RoutePlan)` takes the normalized `{distanceMeters, durationSeconds, polyline, steps[]}` payload and converts it into an ordered list of `LatLon` waypoints.
- `current_target() -> LatLon` returns the active waypoint; advances when within `WAYPOINT_ADVANCE_M`.
- No path planning. Apple Maps is the planner. This module just walks the waypoint list.

### `jetson/nav/control_loop.py`
- Runs at 10Hz. Reads state, ultrasonics, current waypoint. Outputs motor commands.
- Layered: reactive avoidance overrides goal-seeking when ultrasonics trigger.
- All control gains (`KP_TURN`, `MAX_FWD`, `ARRIVAL_THRESHOLD_M`, etc.) live at the top of the file as constants. Tune there.

### `jetson/perception/detector.py`
- Loads TensorRT engine at startup. Engine is in `ml-training/models/yolo_trash.engine`.
- Async detection thread pulls webcam frames, runs inference, pushes results to `LatestDetections`.
- `LatestDetections.get(class_filter: str | None, min_conf: float) -> list[Detection]`.
- Target: 15+ FPS at 640x480. Don't add inference to the main control loop thread.

### `relay/` (Node/Express, not yet written)
Full contract lives in [app/README.md](../app/README.md). Summary:
- `POST /reports` — multipart form (`photo` file + `metadata` JSON). Returns the stored report with an `id` and hosted `photoUrl`.
- `GET /reports/latest` — the most recent unassigned report. Used by the Robot tab and the Jetson to pick up a task.
- `POST /robot/heartbeat` — robot phone posts `{location, sentAt}` on a timer.
- `POST /routes/apple` — body: `{origin, destination, travelMode: "walking"}`. Relay calls Apple Maps Server API (or native MapKit on a trusted environment) and returns a normalized `{route: {distanceMeters, durationSeconds, polyline, steps[]}}`.

Dedup, task completion, and a `GET /robot/latest-location` for the Jetson still need to be added. Track those in TODO.

## Tuning Constants (Current Values)

These live in code but are reproduced here so you know where to look. If you change them, update both.

| Constant | File | Current | Notes |
|---|---|---|---|
| `KP_TURN` | `nav/control_loop.py` | 0.02 | Radians per degree of error. Higher = more aggressive turns. Too high → oscillation. |
| `MAX_FWD` | `nav/control_loop.py` | 0.5 m/s | Outdoor max forward speed. Don't exceed without re-tuning everything. |
| `MAX_TURN` | `nav/control_loop.py` | 1.0 rad/s | Outdoor max turn rate. |
| `ARRIVAL_THRESHOLD_M` | `nav/control_loop.py` | 3.0 | Switch from GPS nav to visual search at this distance. GPS isn't accurate enough below this. |
| `GPS_ACCURACY_REJECT_M` | `nav/localization.py` | 20.0 | Refuse to act on iPhone readings worse than this. |
| `GPS_STALENESS_S` | `nav/localization.py` | 2.0 | Reject GPS readings older than this. |
| `OBSTACLE_STOP_CM` | `nav/avoidance.py` | 60 | Front ultrasonic threshold for reactive avoidance. |
| `MIN_DETECTION_CONF` | `perception/servo.py` | 0.5 | YOLO confidence threshold during visual approach. |
| `APPROACH_BOX_FILL` | `perception/servo.py` | 0.4 | Stop driving when target bbox height fills this fraction of frame. |
| `WAYPOINT_ADVANCE_M` | `nav/waypoint_follower.py` | 2.0 | Switch to the next Apple Maps waypoint when within this distance. |
| `DEDUP_RADIUS_M` | `relay/` (TBD) | 5.0 | Reject submissions within this distance of an existing pending report. |

## Testing

- Unit tests for `jetson/nav/geo.py` are mandatory. Use known lat/lon pairs from Google Maps as ground truth.
- Integration tests use the replay tool: feed logged sensor data into the nav loop offline, assert expected motor commands.
- Field testing protocol: always run `tools/gps_logger.py` first to verify the iPhone is streaming and GPS quality is acceptable in the test area before powering motors.
- Never field-test without the watchdog. Motors must stop on main loop hang.

## Known Gotchas

- **Ultralytics + JetPack version mismatches.** If `yolo` CLI errors on import, check the JetPack version against the Ultralytics compatibility matrix. Pinned versions are in `jetson/perception/requirements.txt`.
- **iOS silently kills background HTTP.** The streamer app needs the background mode entitlement and a periodic foreground "keepalive" or it dies after a few minutes with the screen locked.
- **GPS multipath near buildings.** iPhone reports `h_accuracy_m` jumping to 30-60m near tall buildings. Trust the accuracy field, not the position.
- **Compass offset after physical robot changes.** Any time the iPhone mount is moved or motor placement changes, recalibrate. Symptom: robot drives in consistently wrong direction by some fixed angle.
- **Pi USB serial port name changes** between reboots on Jetson (`/dev/ttyUSB0` vs `/dev/ttyACM0`). The bridge tries both. Don't hardcode.
- **NeveRest motors draw significant current under load.** If the H-bridge browns out, reactive avoidance can fail mid-maneuver. Verify current budget against battery output.
- **Relay is a single point of failure.** If the relay is down, nothing works — no tasks, no routes. The phones and Jetson must all reach it over WiFi/cellular. Demo range = network coverage.
- **Apple Maps routes follow pedestrian paths, not campus shortcuts.** If a route sends the robot across a grass quad, the waypoint list won't include the quad. Sanity-check routes before trusting them.
- **Apple Maps MapKit requires a trusted environment.** Server-side MapKit JS needs a valid Apple Developer token; this lives in the relay's `.env`. Never commit it.

## How to Run (development)

Start the relay first (phones and Jetson all depend on it):
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
Install the app on both phones. Reporter tab on one, Robot tab on the other.

On the Jetson:
```bash
cd jetson
source venv/bin/activate
python -m io.iphone_listener &           # polls relay (or listens on :8000) — see open decision above
python -m main                           # starts state machine
```

For manual control instead of autonomous:
```bash
python tools/joystick.py
```

For offline replay:
```bash
python tools/replay.py logs/2026-04-18T14-00-00.jsonl
```

## When Modifying This Project

- **Don't widen the Pi's responsibilities.** If you find yourself adding logic to the Pi script, that logic belongs on the Jetson.
- **Don't bypass the state machine.** New behaviors are new states or new transitions, not ad-hoc threads firing motor commands.
- **Don't trust GPS without checking accuracy.** Every GPS read should be paired with an `h_accuracy_m` check.
- **Don't add inference to the control loop thread.** Perception runs in its own thread/process, control loop reads cached results.
- **Don't change the relay contract in one place.** The heartbeat, report, and route schemas are shared across `app/`, `relay/`, and `jetson/io/iphone_listener.py`. Update all three in the same commit.
- **Don't add a custom path planner.** Apple Maps via the relay is the planner. If it gives a bad route, sanity-check and tweak *inputs* (origin, snapping); don't reinvent routing.
- **When tuning control gains, change one constant at a time** and log the effect. Multi-variable tuning without logs is how you lose three days.

## Open Questions / TODO

(Update this section as the project evolves. Don't let it go stale.)

- [ ] Relay does not exist yet (`relay/` folder is empty). Contract is specified in [app/README.md](../app/README.md).
- [ ] Open decision: how the Jetson gets robot GPS — poll relay vs. direct WiFi from robot phone. See Architecture section.
- [ ] Relay needs `GET /robot/latest-location` (for Jetson) and `POST /reports/{id}/complete` (for task done).
- [ ] Apple Maps server API token not yet provisioned. Relay will need Apple Developer credentials in its `.env`.
- [ ] Intake run duration not tuned — `INTAKING` state currently runs the intake motor for a fixed duration, no success sensing beyond VERIFYING re-detection.
- [ ] No battery monitoring yet. Robot can run until the battery dies mid-task.
- [ ] No charging dock / return-to-base behavior.
- [ ] Relay is single-instance, no auth on `/reports`. Anyone on the network can queue tasks.
- [ ] No handling for tasks that are persistently unreachable (e.g., trash inside a building).