# NEXT.md — where this project is right now

If you are Claude on a fresh machine: **read this first, then [writeup/CLAUDE.md](writeup/CLAUDE.md) for full architecture.** This doc is the running "state of play." Update it as things change.

Date of this snapshot: **2026-04-18**.

---

## What works right now

### Trash detector (YOLOv8n)
- Trained on Colab (TACO + Kaggle Drink Waste), 100 epochs at imgsz=960.
- Weights in repo: [models/trash_v1.pt](models/trash_v1.pt).
- Test-split performance (held out, honest):
  - `bottle` **mAP@0.5 = 0.984** — production-ready
  - `can`    **mAP@0.5 = 0.983** — production-ready
  - `wrapper` mAP@0.5 = 0.309 — weak (data-starved)
  - `cup`     mAP@0.5 = 0.191 — weak (data-starved)
  - `paper`   mAP@0.5 = 0.090 — bad
  - Overall: 0.511
- For the Rutgers pickup use case, bottle + can is most of what matters. Weak classes can be improved in v2 with ~200–400 extra Rutgers images per class.

### Brain-side modules (all shipped, 65 unit tests passing)
- [brain/nav/geo.py](brain/nav/geo.py) — GPS math (haversine, bearing, heading_error). 15 tests.
- [brain/io/webcam.py](brain/io/webcam.py) — async USB webcam capture.
- [brain/io/pi_bridge.py](brain/io/pi_bridge.py) — WebSocket client to the Pi. Sync-facing, async-under-the-hood. Auto-reconnect, stale-safe encoder/state push, command clamping. Speaks `drive`/`stop`/`reset_encoders` out, parses `state {encoders, motors, watchdog_ok}` in. 9 integration tests against a real localhost WS server.
- [brain/io/pi_frame_source.py](brain/io/pi_frame_source.py) — MJPEG consumer for the Pi's camera stream. Drop-in Frame-API replacement for webcam.Webcam.
- [brain/io/iphone_listener.py](brain/io/iphone_listener.py) — FastAPI listener on :8000 for iPhone GPS heartbeats. `LatestSensorState` singleton + stale checks. The brain uses this to detect "phone reached last waypoint, my turn" for the NAVIGATING → SEARCHING handoff. 9 tests.
- [brain/perception/detector.py](brain/perception/detector.py) — YOLOv8n wrapper (kept for reporter-photo cropping; not in the live approach loop).
- [brain/perception/servo.py](brain/perception/servo.py) — continuous servo decision. 12 tests. Currently unused by the discrete-action approach loop; kept for future smooth-control needs.
- [brain/perception/target_finder.py](brain/perception/target_finder.py) — OWLv2 image-conditioned detector. **Scaffolded, not GPU-validated yet.**
- [brain/perception/vlm_scout.py](brain/perception/vlm_scout.py) — Qwen3-VL-8B @ 4-bit scout. **Scaffolded, not GPU-validated yet.**
- [brain/control/loop.py](brain/control/loop.py) — `ApproachController.step(frame) → Action`. 13 tests.
- [brain/control/action_to_pwm.py](brain/control/action_to_pwm.py) — Action → (left, right) PWM table. 7 tests.
- [brain/main.py](brain/main.py) — approach-phase glue loop. Wires PiFrameSource → ApproachController → PiBridge. **Not the full FSM yet** — wraps SEARCHING + APPROACHING + VERIFYING; doesn't yet coordinate handoff with the phone.

### Pi-side modules (code shipped, awaiting hardware)
- [pi/camera_streamer/](pi/camera_streamer/) — MJPEG server on :8080 from the C270. Already working.
- [pi/motor_controller/](pi/motor_controller/) — WebSocket server on :8765 with L298N driver + quadrature encoder reader. Accepts `drive` / `stop` / `reset_encoders` from any client; broadcasts `state {encoders, motors, watchdog_ok}` at 20 Hz to all. 500 ms watchdog. Auto-falls-back to mock backends when pigpio is unavailable. **Phone and brain are both expected clients** — phone during NAVIGATING (Apple Maps waypoint following), brain during SEARCHING + APPROACHING + VERIFYING (vision-driven).

### Tools
- [tools/live_detect.py](tools/live_detect.py), [tools/webcam_preview.py](tools/webcam_preview.py) — YOLO/webcam smoke tests.
- [tools/test_target_finder.py](tools/test_target_finder.py) — OWLv2 live webcam validation.
- [tools/test_vlm_scout.py](tools/test_vlm_scout.py) — Qwen3-VL three-image smoke test with cold/warm latency measurement.
- [tools/test_approach.py](tools/test_approach.py) — full hybrid pipeline on a webcam: OWLv2 + Qwen3-VL + ApproachController, Action overlaid on the frame. No hardware needed.

### Dataset pipeline
- [ml-training/scripts/prepare_dataset.py](ml-training/scripts/prepare_dataset.py) — TACO converter.
- [ml-training/scripts/prepare_drink_waste.py](ml-training/scripts/prepare_drink_waste.py) — Kaggle Drink Waste remapper.
- [ml-training/notebooks/](ml-training/notebooks/) — train.ipynb, eda.ipynb, sanity.ipynb.

---

## One-command live demo

```bash
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt
python demo.py                            # YOLO-only bottle/can demo
```

---

## Architecture (summary — full details in writeup/CLAUDE.md)

**Two machines:**
- **Brain desktop** (RTX 4080, 16 GB VRAM) — runs everything that isn't motor I/O: YOLOv8n obstacle detection, OWLv2 image-conditioned target finder, Qwen3-VL scout, nav control loop, FastAPI listener for iPhone GPS. Code lives under `brain/`.
- **Pi 3B on the robot** — drives motors via L298N (WS :8765), reads quadrature encoders, streams C270 frames (MJPEG :8080). No business logic. Multi-client WS — phone and brain both connect.
- **Phone (mounted, Expo app)** — owns NAVIGATING. Walks Apple Maps waypoints → drive cmds to Pi. Posts GPS heartbeats to brain so brain knows when to take over.
- **Relay** (Node/Express, `relay/`) — shared backend for phones + brain. **Not yet written.**

---

## What's next (ordered by priority)

### 1. GPU validation on the 4080 — **the critical path** (~1 hr)

Both perception models are scaffolded but have never actually loaded a real frame. Do these in order on the 4080:

```bash
pip install -r requirements.txt
python tools/test_target_finder.py --reference ~/ref.jpg
python tools/test_vlm_scout.py --reference r.jpg --context c.jpg --live l.jpg --trials 5
python tools/test_approach.py --reference r.jpg --context c.jpg
```

Known gotchas are recorded in [HANDOFF.md](HANDOFF.md) § 4 — `transformers @ git+main` may have drifted, `bitsandbytes` 4-bit may need a 8-bit fallback, Qwen3-VL can emit prose around the JSON.

### 2. End-to-end dress rehearsal, no robot hardware (~30 min)

Once GPU validation passes, the whole brain+Pi loop can be smoke-tested on a laptop:

```bash
# terminal 1
python -m pi.motor_controller --mock -v
# terminal 2 (on the 4080)
python -m brain.main --pi-ip 127.0.0.1 --webcam 0 \
    --reference r.jpg --context c.jpg
```

The brain connects to the mock Pi, runs the approach controller on its local webcam, and sends PWM. The mock logs every command — this validates PiBridge ↔ MotorServer end-to-end before any H-bridge exists.

### 3. Wire the physical robot (~few hrs, hardware task)

Pin map in [pi/motor_controller/README.md](pi/motor_controller/README.md). Once wired:

```bash
sudo systemctl enable --now pigpiod
python3 -m pi.motor_controller -v
```

Test with `python -m brain.main --pi-ip <pi-ip> ...` using the real Pi IP. Robot should drive.

### 4. Full state machine orchestrator (~2 hrs)

`brain/main.py` currently runs the approach phase only. Wrap `ApproachController` in the full IDLE → PLANNING → NAVIGATING → SEARCHING → APPROACHING → INTAKING → VERIFYING → REPORTING FSM from writeup/CLAUDE.md. Use the existing `iphone_listener` + (future) relay client to drive state transitions.

### 5. Relay backend (~2 hrs, Node/Express — different stack)

`relay/` — still empty. Endpoints: `POST /reports`, `GET /reports/latest`, `POST /robot/heartbeat`, `POST /routes/apple` (Apple Maps MapKit JS proxy). Contract lives in [app/README.md](app/README.md). Needs an Apple Developer MapKit token in `.env`.

### Deferred (don't work on until the above is running)
- Waypoint follower (blocked on relay + Apple Maps)
- Data v2 for wrapper/cup/paper (nice-to-have; bottle/can is plenty for demo)

---

## Known blockers / decisions

- **Motors not yet wired** to Pi. Blocks item 3 and the full robot demo — but items 1 and 2 unblock independently.
- **iPhone mount not built.** Blocks the GPS/heading primary localization. Item 4 can stub it.
- **Apple Developer MapKit token not provisioned.** Blocks item 5 and waypoint nav. Can mock a route for testing.
- **Weak YOLO classes** (cup/wrapper/paper) are the first v2 problem. For the hackathon demo, just filter to bottle+can detections at inference time if wrapper false positives bite.

---

## Repo structure (quick map)

```
RU-IEEE-Hackathon/
├── NEXT.md                         # this file — current state of play
├── HANDOFF.md                      # ordered action plan for the next session
├── CLAUDE.md                       # → writeup/CLAUDE.md (full architecture)
├── demo.py                         # one-command YOLO webcam demo
├── requirements.txt                # brain-side deps
├── models/trash_v1.pt              # trained YOLO weights (~6 MB)
├── writeup/                        # all design docs (CLAUDE.md, nav.md, …)
├── brain/                          # code that runs on the BRAIN DESKTOP (RTX 4080)
│   ├── nav/geo.py                  # ✓ built
│   ├── io/webcam.py                # ✓ built
│   ├── io/pi_bridge.py             # ✓ built
│   ├── io/pi_frame_source.py       # ✓ built
│   ├── io/iphone_listener.py       # ✓ built
│   ├── perception/detector.py      # ✓ built (YOLOv8n obstacles)
│   ├── perception/target_finder.py # ✓ scaffolded — needs GPU validation
│   ├── perception/vlm_scout.py     # ✓ scaffolded — needs GPU validation
│   ├── perception/servo.py         # ✓ built (continuous, currently unused by the hybrid loop)
│   ├── control/loop.py             # ✓ built (ApproachController)
│   ├── control/action_to_pwm.py    # ✓ built
│   └── main.py                     # ✓ built (approach-phase glue; full FSM still TODO)
├── pi/
│   ├── camera_streamer/            # ✓ MJPEG server on :8080
│   └── motor_controller/           # ✓ WebSocket server on :8765 (code ready, needs wired hardware)
├── relay/                          # TODO (Node/Express backend)
├── app/                            # ✓ Expo app exists (Reporter + Robot tabs)
├── ml-training/                    # training pipeline (Colab-driven)
├── tools/
│   ├── live_detect.py              # ✓ webcam → YOLO → boxes
│   ├── webcam_preview.py           # ✓ webcam → display
│   ├── test_target_finder.py       # ✓ OWLv2 live webcam
│   ├── test_vlm_scout.py           # ✓ Qwen3-VL three-image smoke
│   └── test_approach.py            # ✓ full hybrid pipeline on webcam (no hardware)
└── tests/                          # 65 passing
    ├── test_geo.py                 # 15
    ├── test_servo.py               # 12
    ├── test_loop.py                # 13
    ├── test_action_to_pwm.py       # 7
    ├── test_iphone_listener.py     # 9
    └── test_pi_bridge.py           # 9 (real-WS integration, new protocol)
```

✓ = shipped.

---

## For the next Claude session

Your most likely assignments when the user returns:
- **"run the GPU validation"** → item 1 above, three tools in sequence.
- **"dress rehearse the whole loop on my laptop"** → item 2 above.
- **"the robot is wired, let's go"** → item 3 above.
- **"wrap the approach loop in the full state machine"** → item 4 above.
- **"build the relay"** → item 5 above. Different stack (Node/TS); check Expo app's `README.md` for the contract.
- **"fix the cup/wrapper detection"** → v2 data collection, see writeup/trash-detection.md.

**Don't** re-train the YOLO model unless explicitly asked.
**Don't** rebuild OWLv2 or Qwen3-VL from scratch — used off-the-shelf from HuggingFace.
**Don't** work on TensorRT export — RTX 4080, `.pt` weights are fast enough.
**Don't** expand Pi responsibilities beyond motor/sensor/camera proxy.
**Don't** bypass the state machine (once it exists) — new behaviors are new states, not ad-hoc motor commands.

Update this file (`NEXT.md`) whenever the priority list shifts.
