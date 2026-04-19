# HANDOFF.md — picking up the trash-robot brain build

**For the next Claude / next session.** Start by reading:
1. [writeup/CLAUDE.md](writeup/CLAUDE.md) — architecture + conventions
2. [NEXT.md](NEXT.md) — running status + repo map
3. This file — action plan from commit `f57bb48` forward

The user's persistent memory is at `~/.claude/projects/-Users-neilgandhi-Documents-Projects-RU-IEEE-Hackathon/memory/` — it auto-loads. Don't re-ask decisions already recorded there.

---

## 1. Where things stand

A Rutgers hackathon trash-pickup robot: reporter phone uploads a photo+GPS, robot routes to the location via Apple Maps, then uses vision to locate + approach + collect the specific trash item.

**What's shipped and verified (40 unit tests pass, no GPU needed):**
- `brain/nav/geo.py` — GPS math (haversine, bearing, heading_error)
- `brain/perception/servo.py` — continuous visual-servo decision (kept but currently unused by the main pipeline)
- `brain/control/loop.py` — `ApproachController.step(frame) → Action` discrete decision loop (hybrid orchestrator)
- `brain/perception/types.py` — shared `Detection` dataclass
- `brain/perception/detector.py` — YOLOv8n wrapper for obstacle detection
- `models/trash_v1.pt` — trained YOLOv8n weights (bottle/can mAP ~0.98)
- Expo app with Reporter + Robot tabs

**What's scaffolded but never actually run:**
- `brain/perception/target_finder.py` — OWLv2 (`google/owlv2-base-patch16`)
- `brain/perception/vlm_scout.py` — Qwen3-VL-8B (`Qwen/Qwen3-VL-8B-Instruct`) @ 4-bit
- `tools/test_target_finder.py` — webcam + OWLv2 smoke test (exists, not run)

**What doesn't exist yet:**
- Anything on the Pi (`pi/motor_controller/`)
- Pi WebSocket client on the brain (`brain/io/pi_bridge.py`)
- `Action` → PWM translator
- iPhone GPS listener (`brain/io/iphone_listener.py`)
- State machine orchestrator (`brain/main.py`)
- Relay backend (`relay/`)

---

## 2. Architecture recap (don't re-decide)

- **Brain**: single desktop with RTX 4080 (16 GB VRAM). Runs everything that isn't motors.
- **Pi 3B**: dumb I/O proxy on the robot. WebSocket :8765 for commands/ultrasonics, MJPEG :8080 for C270 frames. No logic.
- **No Jetson, ever.** Dropped.
- **Hybrid perception**: OWLv2 every frame (fast, ~25 FPS) + Qwen3-VL as scout when OWLv2 is empty (slow, ~1 Hz).
- **Demo scene assumption**: one target trash item, no visual lookalikes. No disambiguation logic needed.
- **Control output**: discrete `Action` enum — `FORWARD | LEFT | RIGHT | STOP | SEARCH_LEFT | SEARCH_RIGHT`.

See also: [memory/project_scope.md], [memory/demo_scene_constraints.md].

---

## 3. Do these in order

### Step 1 — install + smoke-test OWLv2 on the 4080 (~15 min)

```bash
python -m venv venv && source venv/bin/activate
pip install -r requirements.txt
# ^ transformers is pinned to git HEAD for Qwen3-VL; first install may take several min
# save any photo of a bottle/can as ~/ref.jpg
python tools/test_target_finder.py --reference ~/ref.jpg
```

Hold the reference object to the webcam. Expected: green tracking box with score >0.5 at 20+ FPS.

**Likely failure modes:**
- Import errors → compare `target_finder.py` against current HF docs at https://huggingface.co/docs/transformers/model_doc/owlv2
- MPS / CPU device auto-detect might misfire → force with `--torch-device cuda`
- First run downloads ~300 MB

### Step 2 — write + run `tools/test_vlm_scout.py` (~30 min)

**This tool doesn't exist yet. Write it.** Mirror the structure of `tools/test_target_finder.py` but for the VLM:
- CLI args: `--reference PATH --context PATH --live PATH` (three image paths)
- Loads `VLMScout()`, calls `scout(live_img, reference_img, context_img)`, prints the returned `ScoutResult` + timing.
- Optional `--trials N` to measure avg latency.

This is the **highest-risk piece in the stack**. First time Qwen3-VL loads. Things likely to break:
- `transformers @ git+main` may have drifted since commit `f57bb48` — pin to a specific working commit SHA once you find one
- `bitsandbytes==0.44.1` may need bumping for newer CUDA. Fallback: skip 4-bit (`load_in_4bit=False`) and use 8-bit (`load_in_8bit=True` via BitsAndBytesConfig) if VRAM is tight
- Model may return prose wrapping the JSON. `_parse_response` handles this via regex + keyword fallbacks, but inspect real outputs and tune the prompt if direction inference is unreliable
- Expect first-call cold start of ~10 sec, steady-state ~500–1500ms per call

### Step 3 — write + run `tools/test_approach.py` (~45 min)

**Doesn't exist yet. Write it.** End-to-end brain validation with no hardware:
- Args: `--reference PATH --context PATH` (reporter photo + its wider context shot)
- Loads `TargetFinder` + `VLMScout` + `ApproachController`
- Webcam loop: each frame → `controller.step(frame)` → overlay the `Action` on screen
- Color-code: green FORWARD, yellow LEFT/RIGHT, red STOP, magenta SEARCH_*

Validates the full decision pipeline on real frames. If this works, the brain logic is done — all that remains is wiring to motors.

### Step 4 — Pi motor controller (blocks on physical wiring)

See NEXT.md §3. Key points:
- WebSocket server on :8765 accepting `{"cmd":"drive","left":int,"right":int}` + `{"cmd":"intake","pwm":int}`
- MJPEG server on :8080 streaming C270 at 480p@15fps
- 20 Hz ultrasonic push: `{"type":"ultrasonics","front_cm":N,"left_cm":N,"right_cm":N,"ts":float}`
- Watchdog: zero motors on 500ms silence

### Step 5 — brain-side Pi bridge (~30 min)

Write `brain/io/pi_bridge.py` — async WebSocket client:
- `set_motors(left: int, right: int)` — fire and forget
- `set_intake(pwm: int)` — fire and forget
- `get_ultrasonics() -> Ultrasonics | None` — latest or None if stale >500ms
- Auto-reconnect on drop

Also write a frame consumer (fork of `brain/io/webcam.py`) that reads from `http://<pi-ip>:8080/stream.mjpg` instead of `cv2.VideoCapture`.

### Step 6 — `Action` → PWM translator + main loop (~30 min)

Tiny module, tune on the real robot:

```python
# brain/control/action_to_pwm.py
ACTION_TO_PWM: dict[Action, tuple[int, int]] = {
    Action.FORWARD:      (+150, +150),
    Action.LEFT:         (-100, +100),
    Action.RIGHT:        (+100, -100),
    Action.STOP:         (0, 0),
    Action.SEARCH_LEFT:  (-80,  +80),
    Action.SEARCH_RIGHT: (+80,  -80),
}
```

Then the main loop in `brain/main.py`:
```python
controller = ApproachController(target_finder, vlm_scout, ref_photo, ctx_photo)
while True:
    frame = pi_frame_consumer.get()
    action = controller.step(frame.image)
    pi_bridge.set_motors(*ACTION_TO_PWM[action])
```

### Step 7 onwards — full mission

- iPhone GPS listener (FastAPI on :8000)
- Relay (Node/Express: /reports, /robot/heartbeat, /routes/apple)
- State machine wrapping ApproachController (IDLE → PLANNING → NAVIGATING → [ApproachController takes over] → INTAKING → VERIFYING → REPORTING)

See NEXT.md and writeup/CLAUDE.md for contracts.

---

## 4. Known gotchas / watch-outs

- **`transformers @ git+main` is floating** — pin to a specific commit SHA after step 2 succeeds, update `requirements.txt`.
- **The OWLv2 + Qwen3-VL wrapper code has NEVER been run.** First real load will probably surface at least one API issue. Fix forward, don't assume the scaffolded code is correct.
- **Qwen3-VL 8B is actually 9B params** per the model card. Barely fits on 4080 at 4-bit (~5 GB). fp16 will OOM.
- **servo.py and control/loop.py both exist.** `servo.py` is continuous (turn_rad_s, fwd_m_s), `control/loop.py` is discrete Actions. We're using `control/loop.py` for the demo. Keep servo.py — it's tested and useful if we ever want smooth control.
- **The C270 fails in low light + rain.** Demo outdoors in daylight.
- **iPhone compass wanders near motor magnetic fields** — calibrate after any physical change.

---

## 5. Key files by topic

| Topic | File |
|---|---|
| Architecture + conventions | [writeup/CLAUDE.md](writeup/CLAUDE.md) |
| Running status | [NEXT.md](NEXT.md) |
| Nav design + CV jobs | [writeup/nav.md](writeup/nav.md) |
| YOLO training | [ml-training/TRAINING.md](ml-training/TRAINING.md) |
| Control loop (what the robot does each tick) | [brain/control/loop.py](brain/control/loop.py) |
| OWLv2 wrapper | [brain/perception/target_finder.py](brain/perception/target_finder.py) |
| Qwen3-VL wrapper | [brain/perception/vlm_scout.py](brain/perception/vlm_scout.py) |
| Continuous servo (currently unused) | [brain/perception/servo.py](brain/perception/servo.py) |
| Tests | [tests/test_loop.py](tests/test_loop.py), [tests/test_servo.py](tests/test_servo.py), [tests/test_geo.py](tests/test_geo.py) |
| Webcam smoke test | [tools/test_target_finder.py](tools/test_target_finder.py) |

---

## 6. First action for the next session

**Pick one:**
- On the 4080 → Step 1 (install + OWLv2 smoke test). Report back what you see.
- Not on the 4080 → Step 2 (write `tools/test_vlm_scout.py`) so it's ready when you are.
- Need to unblock the robot side in parallel → Step 4 (Pi motor controller).
