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

### Navigation scaffolding (brain-side)
- [brain/nav/geo.py](brain/nav/geo.py) — pure-math GPS utilities (haversine, bearing, heading_error). 15 unit tests, all passing.
- [brain/io/webcam.py](brain/io/webcam.py) — async USB webcam capture, thread-safe latest-frame access.
- [brain/perception/detector.py](brain/perception/detector.py) — YOLO wrapper with typed `Detection` dataclass. Works with `.pt`, `.onnx`, `.engine`.
- [tools/live_detect.py](tools/live_detect.py) — webcam → detector → boxes drawn. Has interactive mode (cv2 window) and headless `--save-dir` mode.
- [tools/webcam_preview.py](tools/webcam_preview.py) — same, no detector.

### Dataset pipeline
- [ml-training/scripts/prepare_dataset.py](ml-training/scripts/prepare_dataset.py) — downloads + converts TACO.
- [ml-training/scripts/prepare_drink_waste.py](ml-training/scripts/prepare_drink_waste.py) — Kaggle Drink Waste, remapped to our 5 classes (glass bottles dropped).
- [ml-training/notebooks/train.ipynb](ml-training/notebooks/train.ipynb) — Colab training pipeline, end-to-end (clone → install → prep → train → save to Drive).
- [ml-training/notebooks/eda.ipynb](ml-training/notebooks/eda.ipynb) — 17-section deep EDA (integrity, duplicates, class distribution, bbox size, co-occurrence, gallery).
- [ml-training/notebooks/sanity.ipynb](ml-training/notebooks/sanity.ipynb) — side-by-side ground truth vs prediction on random test images.

---

## One-command live demo

```bash
# on any Mac with a builtin webcam
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt
python demo.py
```

Point the webcam at a water bottle or soda can → green/blue box with class name + confidence. Press `q` to quit, `s` to snapshot to `/tmp/`.

---

## Architecture (summary — full details in writeup/CLAUDE.md)

**Two machines:**
- **Brain desktop** (RTX 4080, 16 GB VRAM) — runs everything that isn't motor I/O: YOLOv8n obstacle detection, OWLv2 image-conditioned target finder, nav state machine, control loop, FastAPI listener for iPhone GPS. Code lives under `brain/`.
- **Pi 3B on the robot** — drives motors, reads ultrasonics, streams C270 webcam frames. **Talks to brain over local WiFi: WebSocket on :8765 for commands/sensors, MJPEG on :8080 for frames.** No business logic on the Pi.
- **Relay** (Node/Express, `relay/`) — shared backend for phones + brain. Not yet written.

We previously considered splitting perception (4080) and nav (4070) across two desktops. Consolidated onto the single 4080 because: lower latency (no WebSocket hop between perception and control loop), simpler deploy (one process tree, one log source), and the 4080 has ~12 GB of VRAM headroom after loading both YOLOv8n and OWLv2-base.

---

## What's next (ordered by priority)

### 1. Verify the YOLO model works on real-world frames (~30 min)
Run `python demo.py`, hold up a bottle and a can, confirm detection works. If `bottle` confidence is reliably >0.8 under your lighting, the model is good. If not, flag it — we may need imgsz or conf tuning.

### 2. OWLv2 target finder — **scaffolded, not yet validated on GPU**
[brain/perception/target_finder.py](brain/perception/target_finder.py) — image-conditioned detector. Wraps `google/owlv2-base-patch16-ensemble` via HuggingFace `transformers`. API:
- `load_reference(crop: np.ndarray | Path | str)` — set the reference image
- `detect(frame: np.ndarray) -> list[Detection]` — run image-guided detection, return boxes sorted by similarity (descending)
- Threshold via `TARGET_MIN_SIM` (start 0.3). Reuses `Detection` dataclass from `detector.py`.

Smoke test with webcam + a reference image:
```bash
pip install -r requirements.txt   # transformers + Pillow added
python tools/test_target_finder.py --reference path/to/query.jpg
# first run downloads OWLv2 weights (~300 MB) to HF cache
```

Auto-picks device: cuda → mps → cpu. On the 4080 brain, expect 25+ FPS. On a Mac without CUDA/MPS, ~1–2 FPS (fine for validation, not for running the loop).

### 3. Pi-side motor controller + streaming (new code, ~2 hr)
Create `pi/motor_controller/main.py` on the Pi:
- WebSocket server on :8765
  - Accepts `{"cmd":"drive","left":<int>,"right":<int>}` (pwm ∈ [-255, 255])
  - Accepts `{"cmd":"intake","pwm":<int>}` (pwm ∈ [0, 255])
  - Emits `{"type":"ultrasonics","front_cm":N,"left_cm":N,"right_cm":N,"ts":<float>}` at 20Hz
  - Watchdog: zero motors if no drive/intake in 500ms
- MJPEG server on :8080 from C270 at 480p@15fps
- Uses `pigpio` or `RPi.GPIO` for PWM + ultrasonics, `opencv-python` for camera

This requires physical wiring: H-bridge ↔ Pi GPIO, ultrasonics ↔ Pi GPIO, C270 ↔ Pi USB.

### 4. Brain-side Pi bridge (new code, ~30 min)
[brain/io/pi_bridge.py](brain/io/pi_bridge.py) — WebSocket client to Pi, with:
- `set_motors(left, right)` — fire and forget
- `set_intake(pwm)` — fire and forget
- `get_ultrasonics()` — returns latest or None if stale >500ms
- Auto-reconnect on drop

Also a frame consumer (fork of `brain/io/webcam.py` that pulls from MJPEG URL instead of cv2.VideoCapture).

### 5. iPhone GPS listener (new code, ~30 min)
[brain/io/iphone_listener.py](brain/io/iphone_listener.py) — FastAPI endpoint on :8000 that the robot iPhone POSTs `{"location":{...},"sentAt":...}` to. Maintains `LatestSensorState` singleton. Heartbeat schema in writeup/CLAUDE.md.

### 6. State machine skeleton (~45 min)
[brain/main.py](brain/main.py) — IDLE → PLANNING → NAVIGATING → SEARCHING → APPROACHING → INTAKING → VERIFYING → REPORTING per the state diagram in writeup/CLAUDE.md. Stub each state; wire `pi_bridge` + `iphone_listener` + `detector` + `target_finder` into the shared state.

### 7. Relay backend (~2 hr, can be parallel to nav work)
`relay/` — Node/Express. Endpoints: `POST /reports`, `GET /reports/latest`, `POST /robot/heartbeat`, `POST /routes/apple` (proxies Apple Maps MapKit JS). Contract lives in [app/README.md](app/README.md). Needs an Apple Developer MapKit token in `.env`.

### Deferred (don't work on until the above is running)
- Waypoint follower (needs relay + Apple Maps first)
- Data v2 for wrapper/cup/paper (nice-to-have; current model is plenty for bottle/can demo)
- VLM-based tiebreaker for ambiguous target scenes (demo has a single target — not needed)

---

## Known blockers / decisions

- **Motors not yet wired** to Pi. Blocks item 2.
- **iPhone mount not built.** Blocks item 4.
- **Apple Developer MapKit token not provisioned.** Blocks item 6's route planning. Can mock a route for testing.
- **Weak classes** (cup/wrapper/paper) are the first v2 problem. For the hackathon demo, just filter to bottle+can detections at inference time if a wrapper false positive is worse than a miss.

---

## Repo structure (quick map)

```
RU-IEEE-Hackathon/
├── NEXT.md                  # this file — current state of play
├── CLAUDE.md                # → writeup/CLAUDE.md (full architecture)
├── demo.py                  # one-command live webcam demo
├── requirements.txt         # brain-side deps
├── models/
│   └── trash_v1.pt          # trained YOLO weights (~6MB, in git)
├── writeup/                 # all design docs
│   ├── CLAUDE.md            # architecture + conventions
│   ├── nav.md               # nav design
│   ├── trash-detection.md   # YOLO design
│   └── ...
├── brain/                  # code that runs on the BRAIN DESKTOP (RTX 4080)
│   ├── nav/geo.py           # ✓ built
│   ├── io/webcam.py         # ✓ built
│   ├── perception/detector.py       # ✓ built (YOLOv8n for obstacles / general)
│   ├── perception/target_finder.py  # ✓ scaffolded (OWLv2 image-conditioned target finder) — needs GPU validation
│   ├── io/pi_bridge.py      # TODO
│   ├── io/iphone_listener.py # TODO
│   └── main.py              # TODO (state machine)
├── pi/motor_controller/     # TODO (runs on the Pi)
├── relay/                   # TODO (Node/Express backend)
├── app/                     # ✓ Expo app exists (Reporter + Robot tabs)
├── ml-training/             # training pipeline (Colab-driven)
│   ├── notebooks/
│   │   ├── train.ipynb      # ✓ model shipped: runs/.../trash_v1.pt
│   │   ├── eda.ipynb        # ✓ deep EDA
│   │   └── sanity.ipynb     # ✓ preds vs ground truth
│   └── scripts/
├── tools/
│   ├── live_detect.py       # ✓ webcam → YOLO → boxes
│   └── webcam_preview.py    # ✓ webcam → display
└── tests/
    └── test_geo.py          # ✓ 15 tests passing
```

✓ = shipped. TODO = next up.

---

## For the next Claude session

Your most likely assignments when the user returns:
- "run the demo" → `python demo.py`
- "build the target finder" → item 2 above (OWLv2)
- "build the Pi side" → item 3 above
- "build the brain's Pi client" → item 4 above
- "wire it all into a state machine" → items 4 + 5 + 6 together
- "fix the cup/wrapper detection" → v2 data collection, see writeup/trash-detection.md

**Don't** re-train the YOLO model unless the user explicitly asks — the current weights are good for bottle+can as the obstacle/general detector.
**Don't** work on TensorRT export — the brain is an RTX 4080, `.pt` weights are plenty fast.
**Don't** expand Pi responsibilities beyond motor/sensor/camera proxy.
**Don't** rebuild OWLv2 from scratch or fine-tune it — it's used off-the-shelf from HuggingFace; only swap models if field testing exposes a problem.

Update this file (`NEXT.md`) whenever the priority list shifts.
