# CLAUDE.md

This file gives AI coding assistants the context needed to work on this repo. Read it before making changes.

## Project: Trash Pickup Robot

An outdoor autonomous robot that picks up litter on the Rutgers campus. Users submit photos of trash through a companion app; photo metadata (GPS, timestamp) is used to locate the item. The robot routes to each reported location, finds the trash visually, and collects it.

## Hardware

| Component | Purpose |
|---|---|
| Jetson Orin Nano | Main compute. Runs nav loop, YOLO inference, sensor fusion, planner. |
| Raspberry Pi 3B | Dumb I/O slave. Drives motors via H-bridge, reads ultrasonics, runs intake motor. Talks to Jetson over USB serial. |
| iPhone (mounted on robot) | GPS, compass, IMU. Streams CoreLocation + CoreMotion data to Jetson over WiFi. |
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
[iPhone] --WiFi POST--> [Jetson Orin Nano] <--USB serial--> [Raspberry Pi 3B] --PWM--> [Drive motors + Intake motor]
                              |                                  |
                              |                              [Ultrasonics]
                              |
                         [USB Webcam]
                              |
                              v
                         [YOLO inference]

[User phone app] --HTTP POST--> [Server (cloud or laptop)]
                                       |
                                  [SQLite task queue]
                                       ^
                                       |
                                  [Jetson polls for tasks]
```

The Jetson is the brain. Everything routes through it. The Pi and iPhone are sensors/actuators it owns. The server is a separate concern — it validates user submissions and queues tasks.

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
│   ├── nav/                   # Navigation: localization, planner, control loop, avoidance
│   ├── perception/            # YOLO inference, visual servoing
│   ├── io/                    # iPhone listener, Pi bridge, webcam capture
│   ├── state/                 # Shared state objects, logging
│   └── main.py                # State machine orchestrator
├── pi/
│   └── motor_controller/      # Python script: serial protocol, drive + intake PWM, ultrasonic reads
├── ios/
│   └── SensorStreamer/        # SwiftUI app: streams CoreLocation + CoreMotion to Jetson
├── server/
│   ├── api/                   # FastAPI: /submit, /tasks/next, /tasks/{id}/complete
│   ├── ml/                    # Stage 1 (binary trash classifier), Stage 2 (YOLO classifier)
│   └── db/                    # SQLite schema + access layer
├── ml-training/
│   ├── data/                  # TACO + custom Rutgers photos
│   ├── notebooks/             # Training experiments
│   └── models/                # Exported weights (.pt, .onnx, .engine)
├── maps/
│   ├── osm_extract.py         # Pulls Rutgers walkways from OpenStreetMap
│   └── rutgers_walkways.graphml  # Pre-built graph (committed, regenerate sparingly)
├── tools/
│   ├── joystick.py            # Manual WASD control for testing
│   ├── gps_logger.py          # Walk around with iPhone, log GPS track
│   └── replay.py              # Replay logged sensor data into nav loop offline
└── tests/
```

All project docs live in `writeup/`. The root `CLAUDE.md` is a symlink so Claude Code and humans find it by convention.

## Conventions

### Python (Jetson + server)
- Python 3.10. Pin all deps in `requirements.txt`. No floating versions.
- Type hints on all function signatures. Use `from __future__ import annotations` at top of every file.
- Async where I/O bound (FastAPI server, iPhone listener, Pi bridge). Sync everywhere else.
- Logging: `logging` stdlib, JSONL format to `/var/log/robot/<date>.jsonl`. Never `print()` in production paths.
- All sensor readings carry a timestamp. Reject stale data (>2s for GPS, >500ms for ultrasonics).
- Units: SI everywhere internally (meters, m/s, radians for math, degrees only at I/O boundaries with the iPhone). Document units in variable names where ambiguous (`distance_m`, `heading_deg`).

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

### iOS
- SwiftUI. Single-screen app. No persistence, no auth.
- POSTs to Jetson endpoint at 10Hz. Background mode enabled so it survives screen lock.
- JSON payload schema (do not change without updating `jetson/io/iphone_listener.py`):
  ```json
  {"ts": 1234567890.123, "lat": 40.5, "lon": -74.4,
   "heading_deg": 87.3, "h_accuracy_m": 4.2,
   "speed_mps": 0.8, "accel": [x,y,z], "gyro": [x,y,z]}
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
  └─(task received from server)─> PLANNING

PLANNING
  ├─(route built)──────────────> NAVIGATING
  └─(no route possible)────────> REPORTING (failure)

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
  └─(POST to server complete)─> IDLE
```

Every state transition is logged. Every state has a max-duration timeout that drops to REPORTING (failure) if exceeded.

## Key Modules and Their Contracts

### `jetson/io/iphone_listener.py`
- FastAPI server on port 8000.
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

### `jetson/nav/planner.py`
- Loads `maps/rutgers_walkways.graphml` at startup.
- `plan(start: LatLon, end: LatLon) -> list[LatLon]` returns waypoint sequence (intermediate nodes), or empty list if no route.
- Uses `networkx.shortest_path` with edge length as weight.

### `jetson/nav/control_loop.py`
- Runs at 10Hz. Reads state, ultrasonics, current waypoint. Outputs motor commands.
- Layered: reactive avoidance overrides goal-seeking when ultrasonics trigger.
- All control gains (`KP_TURN`, `MAX_FWD`, `ARRIVAL_THRESHOLD_M`, etc.) live at the top of the file as constants. Tune there.

### `jetson/perception/detector.py`
- Loads TensorRT engine at startup. Engine is in `ml-training/models/yolo_trash.engine`.
- Async detection thread pulls webcam frames, runs inference, pushes results to `LatestDetections`.
- `LatestDetections.get(class_filter: str | None, min_conf: float) -> list[Detection]`.
- Target: 15+ FPS at 640x480. Don't add inference to the main control loop thread.

### `server/api/`
- `POST /submit` — multipart form: image file + `lat` + `lon` + `timestamp`. Returns 201 on accept, 400 with reason on reject.
- `GET /tasks/next?lat=&lon=` — returns nearest pending task as JSON, or 204 if none.
- `POST /tasks/{id}/complete` — body: `{"status": "success" | "failure", "reason": "..."}`.

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
| `DEDUP_RADIUS_M` | `server/api/submit.py` | 5.0 | Reject submissions within this distance of an existing pending task of the same class. |

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
- **OSM Rutgers walkway data is incomplete.** Some interior campus paths are missing. Verify on the satellite view in `folium` before trusting a planned route. Manually edit the graph if needed.

## How to Run (development)

On the Jetson:
```bash
cd jetson
source venv/bin/activate
python -m io.iphone_listener &           # starts FastAPI on :8000
python -m main                           # starts state machine
```

On the iPhone: launch SensorStreamer app, enter Jetson IP, hit Start.

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
- **Don't change the iPhone JSON schema** without updating both the iOS app and `jetson/io/iphone_listener.py` in the same commit.
- **When tuning control gains, change one constant at a time** and log the effect. Multi-variable tuning without logs is how you lose three days.

## Open Questions / TODO

(Update this section as the project evolves. Don't let it go stale.)

- [ ] Intake run duration not tuned — `INTAKING` state currently runs the intake motor for a fixed duration, no success sensing beyond VERIFYING re-detection.
- [ ] No battery monitoring yet. Robot can run until the battery dies mid-task.
- [ ] No charging dock / return-to-base behavior.
- [ ] Server is single-instance, no auth on `/submit`. Anyone on the network can queue tasks.
- [ ] No handling for tasks that are persistently unreachable (e.g., trash inside a building).