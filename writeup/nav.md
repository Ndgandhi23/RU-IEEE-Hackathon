# Navigation Design

How the robot gets from "task received" to "trash inside the intake." Read [CLAUDE.md](CLAUDE.md) first for system context.

## Ownership

This doc is the **backend / CV scope** — what runs on the **brain machine** (the developer laptop/Mac for the hackathon prototype; a Jetson Orin Nano in a future self-contained deployment). The code lives under `jetson/` in the repo — that folder name is historical, not a deployment location. See [CLAUDE.md](CLAUDE.md) for the split-compute architecture: brain on laptop, Pi on robot as an I/O proxy, WebSocket + MJPEG between them.

**Out of scope (someone else owns):** getting iPhone sensor data onto the brain machine. By the time this code runs, the robot's current GPS and heading are available via `LatestSensorState` — the iPhone posts heartbeats directly to the brain over local WiFi, or polls through the relay. Either way, we just consume a `SensorReading` struct.

**In scope (this doc):**
1. Consume local robot pose data (GPS, heading, orientation) arriving from upstream.
2. Process the live webcam feed.
3. **Confirm the robot is on course** — visual cross-check during GPS-driven nav.
4. **Detect objects in the path** — camera-based obstacle detection, complementing ultrasonics.
5. **Switch to camera as primary nav signal** only when close to the reporter's GPS-tagged image coords (final approach).

The CV network is a cross-cutting concern that runs throughout nav, with escalating authority as the robot nears the target.

## What nav has to do

Given (arriving from upstream — we consume, not produce):
1. **GPS coords** — robot's current `(lat, lon, h_accuracy_m)`, updated at ~10Hz, posted by the robot iPhone to the brain machine over local WiFi.
2. **Orientation** — robot's current `heading_deg` (true north, clockwise) and any IMU data from the same iPhone.
3. **Walk path** — ordered list of `(lat, lon)` waypoints from Apple Maps via the relay's `POST /routes/apple`.
4. **Target photo** — reporter's image of the trash. Primary use is the GPS tag it carries.
5. **Camera** — live C270 webcam feed. Physically connected to the Pi; streamed to the brain over MJPEG on WiFi (prototype) or attached directly to the brain (future Jetson deployment).

Produce:
- Drive command `{"cmd":"drive","left":<int>,"right":<int>}` over WebSocket to the Pi at 10Hz.
- Intake command `{"cmd":"intake","pwm":<int>}` over WebSocket when intaking.

Nav is **not** one model. It's three layers plus a cross-cutting CV network, each simple and boring:
- **Outer loop**: waypoint follower (GPS + heading → bearing error → differential drive).
- **Middle layer**: reactive obstacle avoidance (ultrasonics + CV-detected obstacles override the outer loop).
- **Final approach**: visual servoing (YOLO bbox → center + close).
- **CV network (cross-cutting)**: runs in every state. During NAVIGATING, confirms course + flags obstacles. During SEARCHING/APPROACHING/VERIFYING, is the primary nav signal. See "CV network — three jobs" below.

No Kalman filter, no RL, no end-to-end learned policy. The hackathon budget doesn't justify them and the classical stack gets you 80% of the demo.

## Inputs and outputs per state

| State | Reads | CV role | Writes | Exit condition |
|---|---|---|---|---|
| **NAVIGATING** | GPS, heading, current waypoint, ultrasonics, camera | course confirmation + obstacle detection (advisory) | `M` drive PWM | within 3m of **final** waypoint |
| **SEARCHING** | Camera → YOLO detections | **primary** — find target | `M` (rotate in place) | trash detected with conf > `MIN_DETECTION_CONF` |
| **APPROACHING** | Camera → YOLO bbox, ultrasonics | **primary** — visual servo | `M` visual servo | bbox fills `APPROACH_BOX_FILL` of frame |
| **INTAKING** | Timer, ultrasonics | idle | `I` intake PWM, `M` forward crawl | fixed duration elapsed |
| **VERIFYING** | Camera → YOLO detections | **primary** — confirm pickup | `M` stop | target no longer detected |

GPS coords are the outer loop's signal. The target photo's GPS *only* determines where Apple Maps routes us — it is not matched against the live camera.

## CV network — three jobs

The CV network runs continuously at whatever rate YOLO supports (target 15 FPS at 640x480 per CLAUDE.md). Its outputs feed into the control loop via `LatestDetections` + a new `LatestCourseState` singleton. Three distinct jobs, all running in the same inference pass:

### Job 1 — Course confirmation (during NAVIGATING)

Are we actually on a walkable path pointing in roughly the right direction? Cheap sanity check on top of GPS.

Approach (simplest first):
- Run a lightweight **drivable-surface segmentation** (small U-Net, or use YOLO-seg with a "path/sidewalk" class). Output: binary mask of walkable pixels in the frame.
- Compute the centroid of the mask in the bottom third of the frame.
- If the centroid is offset from frame center beyond `COURSE_CONFIRM_TOL_FRAC`, emit a `course_drift` signal (advisory). Control loop may nudge steering or just log.
- If the mask area drops below `COURSE_MIN_MASK_FRAC` for >1s (we've driven off the path / into grass), raise a `course_lost` flag.

This is advisory, not authoritative — GPS is still primary during NAVIGATING. Course signals let the system catch "GPS says we're on track but we're actually driving into a hedge" failures.

**Stretch:** compare current frame against a stored reference view near each waypoint (pre-recorded during a `gps_logger.py` walk). Don't build this first — segmentation-only version is enough.

### Job 2 — Obstacle detection (during NAVIGATING)

Complement to ultrasonics. Ultrasonics see anything within ~60cm in a narrow cone; the camera sees farther and can classify what it's seeing.

Approach:
- Same YOLO pass. Class list includes `person`, `bicycle`, `car`, `dog`, plus `trash` for the later final-approach job.
- For each detection, compute `ground_contact_y` = bottom edge of bbox in pixels. Map to approximate distance using a fixed-focal-length ground-plane assumption (camera height + tilt are known constants).
- If any obstacle's estimated distance < `CAMERA_STOP_DIST_M` **and** its bbox overlaps the drivable-surface mask (Job 1), emit a `camera_obstacle` signal.
- Control loop treats `camera_obstacle` the same as an ultrasonic trigger — reactive avoidance kicks in.

Two sensor sources both voting on "stop / go around" is fine. Don't try to fuse them probabilistically — either one tripping is enough.

**Gotcha:** the C270 has no depth. The ground-plane distance estimate is only valid for objects touching the ground. A hanging branch won't be estimated correctly. Keep `CAMERA_STOP_DIST_M` conservative (e.g., 2.5m) and rely on ultrasonics for low/close things.

### Job 3 — Visual nav (SEARCHING / APPROACHING / VERIFYING)

Same as before — YOLO `trash` detections drive the control loop directly. Only runs as primary nav when the GPS distance to the final waypoint is < `ARRIVAL_THRESHOLD_M`.

### Single inference pass

One YOLO forward pass per frame outputs all three jobs: segmentation mask, detection list with class+bbox, and a derived per-detection distance estimate. Don't run three separate models — tax the brain once per frame.

Module layout:
- [jetson/perception/detector.py](../jetson/perception/detector.py) — owns the inference loop, publishes to shared state.
- [jetson/perception/course.py](../jetson/perception/course.py) — Job 1 (mask → course signals).
- [jetson/perception/obstacles.py](../jetson/perception/obstacles.py) — Job 2 (detections + mask → obstacle signals).
- [jetson/perception/servo.py](../jetson/perception/servo.py) — Job 3 (detections → motor commands during APPROACHING).

## Core design

### 1. Waypoint follower (NAVIGATING)

At 10Hz:

```
pose = LatestSensorState.get()      # robot phone GPS + heading
if pose is None or pose.h_accuracy_m > GPS_ACCURACY_REJECT_M:
    stop_motors(); return
target = waypoint_follower.current_target()
dist_m = haversine(pose.lat, pose.lon, target.lat, target.lon)
if dist_m < WAYPOINT_ADVANCE_M:
    waypoint_follower.advance()
    return
bearing_to_target = bearing(pose.lat, pose.lon, target.lat, target.lon)
err_deg          = heading_error(bearing_to_target, pose.heading_deg)  # signed [-180, 180]
turn_rate        = clip(KP_TURN * err_deg, -MAX_TURN, MAX_TURN)        # rad/s
fwd_speed        = MAX_FWD * max(0, cos(radians(err_deg)))             # taper when pointing wrong way
left, right      = diff_drive(fwd_speed, turn_rate)                    # pwm ∈ [-255, 255]
pi.set_motors(left, right)
```

That's it. Three pure functions from [jetson/nav/geo.py](../jetson/nav/geo.py) (`haversine`, `bearing`, `heading_error`) plus one proportional controller. No PID integral term until you observe actual drift.

**Why taper forward speed with `cos(err)`?** If the robot is pointing 90° off, driving forward wastes time. `cos(err)` is 1 pointing-at-target, 0 perpendicular, negative beyond 90° (clamp to 0). This lets it turn-in-place when way off, drive-and-turn when close to aligned.

### 2. Reactive obstacle avoidance (two sensor sources)

Layered on top — subsumption style, avoidance overrides goal-seeking. Either ultrasonics or CV can trigger it:

```
us = pi.get_ultrasonics()                         # front, left, right cm
cam_obs = LatestCourseState.get_obstacle()        # from perception/obstacles.py

stop_triggered = (us.front_cm < OBSTACLE_STOP_CM) or (cam_obs and cam_obs.dist_m < CAMERA_STOP_DIST_M)

if stop_triggered:
    # Back up briefly, then turn toward whichever side has more room.
    # Prefer ultrasonic side readings — camera side detection is less reliable.
    if us.left_cm > us.right_cm:
        set_motors(-80, -80) for 300ms; set_motors(-150, +150) for 500ms
    else:
        ...
    return  # skip waypoint-follower output this tick
```

Either trigger is enough. No probabilistic fusion — sensor independence is the point.

No path re-planning — Apple Maps handles geometric routing, we only react locally. If we get stuck (no forward motion for >10s while `NAVIGATING`), drop to `REPORTING (failure)` per the state machine in CLAUDE.md.

### 3. Switch to visual search at 3m

GPS accuracy (`h_accuracy_m`) is typically 3–10m outdoors. Below ~3m, GPS can't find the trash — every step of GPS drift is a full meter of pointing error. So at `ARRIVAL_THRESHOLD_M`, stop trusting GPS and start trusting the camera.

```
dist_to_final = haversine(pose, final_waypoint)
if dist_to_final < ARRIVAL_THRESHOLD_M:
    transition_to(SEARCHING)
```

### 4. SEARCHING

Rotate in place at `MAX_TURN * 0.5` rad/s. Each frame, run YOLO (already running async, see CLAUDE.md perception section). Take the largest/highest-confidence detection of class `"trash"` (or whatever the trained model uses).

- Detection found → `APPROACHING`
- Full 360° swept with nothing → `REPORTING (failure)`

### 5. APPROACHING (visual servoing)

Now we're controlling on pixels, not GPS. Let `bbox_cx` be the bbox center x, `frame_cx` be the frame center.

```
pixel_err = bbox_cx - frame_cx     # signed pixels
err_frac  = pixel_err / (frame_width / 2)   # normalize to [-1, 1]
turn_rate = KP_VISUAL_TURN * err_frac
bbox_fill = bbox_h / frame_height
fwd_speed = MAX_FWD * 0.5 * (1 - bbox_fill)   # slow as target fills frame
if bbox_fill > APPROACH_BOX_FILL and abs(err_frac) < 0.1:
    transition_to(INTAKING)
```

Lost sight for >3s → bounce back to `SEARCHING`.

## The target photo — what do we do with it?

**Minimum (recommended for hackathon):** the photo's only job is to give a GPS tag. The Jetson never loads the photo. YOLO detects "any trash-like object" near the destination. If there are multiple candidates, pick the closest to the GPS waypoint (re-projected into image space using heading).

**Stretch (don't do this first):** run CLIP on the reporter photo at report time, store the embedding in the relay, and at pickup time run CLIP on each YOLO crop to pick the closest match. Gives robustness in cluttered scenes. Adds a model, a relay column, and a failure mode. Skip until the GPS-only version works end-to-end.

## What kind of "model" is this?

The word "model" here is overloaded. In this system:

- **Control model** — classical reactive, no ML. Three state variables (pose, waypoint, ultrasonic envelope), one proportional controller, one subsumption layer. Lives in [jetson/nav/](../jetson/nav/).
- **Perception model** — YOLO (pretrained + fine-tuned on TACO + Rutgers photos). Lives in [jetson/perception/](../jetson/perception/). Trained once, loaded at Jetson boot.
- **World model** — implicit. We don't build a map. We trust Apple Maps for global routing and the ultrasonics for local reactivity. No SLAM.

If you were expecting an end-to-end learned nav policy: no. Hackathon constraints rule that out. The hybrid classical + perception-model approach is both faster to build and easier to debug when something goes wrong at 2am.

## Open decisions

1. **Pose-to-brain wire format** — minimum required: `{ts, lat, lon, h_accuracy_m, heading_deg}`. IMU (accel/gyro) is a nice-to-have. Transport is HTTP POST from the iPhone directly to the brain's FastAPI endpoint on port 8000 (see CLAUDE.md).
2. **Heading quality** — iPhone compass is noisy and sensitive to motors (see CLAUDE.md hardware constraints). Add a sanity check: reject heading that jumps >90° between 100ms samples.
3. **Apple Maps polyline decoding** — Apple returns encoded polylines. Need a decoder in [jetson/nav/waypoint_follower.py](../jetson/nav/waypoint_follower.py). Use a tested library port, don't roll your own.
4. **Waypoint density** — Apple Maps returns coarse waypoints at turn points. We may want to interpolate intermediate points every N meters so the control loop has a nearer target to chase. Start without; add if the robot oscillates.
5. **Drivable-surface model** — for Job 1 (course confirmation), are we training our own segmentation head on Rutgers sidewalks, or using a pretrained model (e.g., Mask2Former, SAM with a "sidewalk" prompt, or YOLO-seg fine-tuned)? Pretrained + fine-tune on a small Rutgers dataset is the realistic path.
6. **CV confidence thresholds for obstacles** — false positives (YOLO spuriously flagging a shadow as "person") will stall the robot. Needs field tuning. Start with `min_conf = 0.6` and raise if flaky.
7. **Failure on pose staleness** — if pose data goes stale (>2s), stop within 2s. Same rule as GPS.

## Staged build plan

Each stage should be demo-able standalone before moving on.

| # | Goal | New files | Test |
|---|---|---|---|
| 0 | Pure geo math | [jetson/nav/geo.py](../jetson/nav/geo.py) | Unit tests with Google-Maps-verified lat/lon pairs |
| 1 | Drive to a single GPS point in open field | [jetson/nav/control_loop.py](../jetson/nav/control_loop.py), localization stub | Hard-code a target lat/lon 20m away, robot drives to it |
| 2 | Accept a waypoint list, follow it | [jetson/nav/waypoint_follower.py](../jetson/nav/waypoint_follower.py) | Hand-write a 3-point waypoint list, robot traverses all 3 |
| 3 | Consume Apple Maps route payload | Extend waypoint_follower | Curl relay's `/routes/apple`, feed into nav |
| 4 | Reactive ultrasonic avoidance | [jetson/nav/avoidance.py](../jetson/nav/avoidance.py) | Place a box in path, robot goes around |
| 5 | YOLO inference loop on live camera | [jetson/perception/detector.py](../jetson/perception/detector.py) | Live detections at 15+ FPS, logged to JSONL |
| 6 | CV obstacle detection (Job 2) | [jetson/perception/obstacles.py](../jetson/perception/obstacles.py) | Walk in front of robot; camera triggers stop independent of ultrasonics |
| 7 | Course confirmation (Job 1) | [jetson/perception/course.py](../jetson/perception/course.py) | Drive onto grass; `course_lost` signal fires within 1s |
| 8 | Visual search + approach (Job 3) | [jetson/perception/servo.py](../jetson/perception/servo.py) | At 3m, robot finds YOLO detection and closes to 0.5m |
| 9 | End-to-end: report → route → drive → intake | Glue in [jetson/main.py](../jetson/main.py) | Reporter posts a photo; robot picks it up |

Stages 0–3 are a weekend. Stage 4 needs the Pi/ultrasonics wired up + WebSocket link to the brain. Stages 5–8 need the C270 streaming MJPEG from the Pi to the brain and sufficient labeled data; TensorRT export is only required for the future Jetson deployment — on the brain Mac, `.pt` weights load directly. Stage 9 depends on the iPhone streaming GPS to the brain and the relay being up.

## Testing without the robot

- **Offline replay**: log raw heartbeats + route payloads to JSONL, feed into the control loop, assert motor commands against a recorded trace. See [tools/replay.py](../tools/replay.py).
- **Simulated pose**: for stage 1–3, no iPhone needed. A synthetic `LatestSensorState` that advances a fake pose based on last motor command is enough to verify the control loop doesn't oscillate or stall.
- **Unit tests for `geo.py`** are mandatory (per CLAUDE.md). Known ground-truth pairs from Google Maps, not property-based — we want to catch sign errors in bearing.

## Why NOT

- **Why not SLAM / a learned world model?** No map needed. Apple Maps + reactive avoidance covers it.
- **Why not an end-to-end RL nav policy?** Data, training, sim-to-real — all impossible in a hackathon window.
- **Why not a Kalman filter for pose?** GPS + compass is sufficient outdoors; we don't have wheel encoders to fuse anyway. If the robot drifts noticeably between GPS updates, revisit.
- **Why not use the reporter photo as the visual target?** Adds another model (CLIP) and another failure mode. YOLO "any trash" + GPS proximity gets >90% of the demo for 10% of the effort.
- **Why not a full PID?** Without logging, you cannot tune D. Start with P, add I only if you see steady-state error, add D only if you see oscillation.
