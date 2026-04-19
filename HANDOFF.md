# HANDOFF.md — picking up the trash-robot brain build

**For the next Claude / next session.** Start by reading:
1. [writeup/CLAUDE.md](writeup/CLAUDE.md) — architecture + conventions
2. [NEXT.md](NEXT.md) — running status + repo map
3. This file — action plan from the current commit forward

The user's persistent memory is at `~/.claude/projects/-Users-neilgandhi-Documents-Projects-RU-IEEE-Hackathon/memory/` — it auto-loads. Don't re-ask decisions already recorded there.

---

## 1. Where things stand

A Rutgers hackathon trash-pickup robot: reporter phone uploads a photo+GPS, robot routes to the location via Apple Maps, then uses vision to locate + approach + collect the specific trash item.

**The whole brain + Pi code path is now written** (65 unit tests pass, no GPU needed). What's missing is validation + wiring + the phone-side nav loop, not the brain/Pi backbone.

**What's shipped and verified:**
- `brain/nav/geo.py` — GPS math
- `brain/control/loop.py` — `ApproachController.step(frame) → Action` hybrid orchestrator
- `brain/control/action_to_pwm.py` — Action → (left, right) PWM table
- `brain/perception/{detector,servo,types}.py` — YOLO + continuous servo + shared types
- `brain/io/{webcam,pi_bridge,pi_frame_source,iphone_listener}.py` — all I/O plumbing
- `brain/main.py` — approach-phase glue loop (not the full FSM — see § Remaining work below)
- `pi/camera_streamer/` — MJPEG server on :8080
- `pi/motor_controller/` — WebSocket server on :8765 with L298N driver + quadrature encoders. Auto-falls-back to mock backends. 500 ms watchdog. Multi-client (phone + brain).
- `tools/test_target_finder.py`, `tools/test_vlm_scout.py`, `tools/test_approach.py` — GPU smoke tests

**What's scaffolded but never actually run on a GPU:**
- `brain/perception/target_finder.py` — OWLv2 (`google/owlv2-base-patch16-ensemble`)
- `brain/perception/vlm_scout.py` — Qwen3-VL-8B (`Qwen/Qwen3-VL-8B-Instruct`) @ 4-bit

**What doesn't exist yet:**
- Full state machine wrapping `ApproachController` (IDLE → PLANNING → … → REPORTING)
- Relay backend (`relay/`) — Node/Express, different stack
- Phone-side nav loop (`useRobotNav` + `nav-loop.ts` in the Expo app) — owns NAVIGATING, drives the Pi over WS during waypoint following.
- Physical robot wiring (L298N H-bridge ↔ Pi GPIO, encoders ↔ Pi GPIO, iPhone mount)

---

## 2. Architecture recap (don't re-decide)

- **Brain**: single desktop with RTX 4080 (16 GB VRAM). Runs everything that isn't motors.
- **Pi 3B**: dumb I/O proxy on the robot. WS :8765 for `drive`/`stop`/`reset_encoders` + 20 Hz `state` push (encoders, motor PWMs, watchdog_ok). MJPEG :8080 for C270. No logic.
- **Phone owns NAVIGATING; brain owns SEARCHING+APPROACHING+VERIFYING.** Both are WS clients on Pi :8765. Pi's 500 ms watchdog naturally arbitrates. No separate intake motor — passive front scoop, drive-to-collect.
- **No Jetson, ever.** Dropped.
- **Hybrid perception**: OWLv2 every frame (fast, ~25 FPS) + Qwen3-VL as scout when OWLv2 is empty (slow, ~1 Hz).
- **Demo scene assumption**: one target trash item, no visual lookalikes. No disambiguation logic needed.
- **Control output**: discrete `Action` enum — `FORWARD | LEFT | RIGHT | STOP | SEARCH_LEFT | SEARCH_RIGHT`.

See also: [memory/project_scope.md], [memory/demo_scene_constraints.md].

---

## 3. Do these in order

### Step 1 — GPU smoke test OWLv2 (~15 min on the 4080)

```bash
python -m venv venv && source venv/bin/activate
pip install -r requirements.txt
# save any photo of a bottle/can as ~/ref.jpg
python tools/test_target_finder.py --reference ~/ref.jpg
```

Hold the reference object to the webcam. Expected: green tracking box with score >0.5 at 20+ FPS.

**Likely failure modes:**
- Import errors → compare `target_finder.py` against current HF docs at https://huggingface.co/docs/transformers/model_doc/owlv2
- MPS / CPU device auto-detect might misfire → force with `--torch-device cuda`
- First run downloads ~300 MB

### Step 2 — GPU smoke test Qwen3-VL (~30 min)

```bash
python tools/test_vlm_scout.py \
    --reference ~/ref_crop.jpg \
    --context   ~/wider_scene.jpg \
    --live      ~/current_view.jpg \
    --trials 5
```

This is the **highest-risk piece in the stack**. First time Qwen3-VL loads. Things likely to break:
- `transformers @ git+main` may have drifted — pin to a specific working commit SHA once you find one, update `requirements.txt`
- `bitsandbytes==0.44.1` may need bumping for newer CUDA. Fallback: `--no-4bit` (will likely OOM at fp16 — for true fallback, switch to 8-bit by editing `vlm_scout.py`'s `BitsAndBytesConfig` to `load_in_8bit=True`)
- Model may return prose wrapping the JSON. `_parse_response` handles this via regex + keyword fallbacks, but inspect `ScoutResult.rationale` — if it says "keyword fallback" or "parse failure", the prompt needs tuning
- Expect first-call cold start of ~10 s, steady-state ~500–1500 ms per call

### Step 3 — end-to-end brain on a webcam (~15 min)

```bash
python tools/test_approach.py \
    --reference ~/ref_crop.jpg \
    --context   ~/wider_scene.jpg
```

Full decision pipeline: OWLv2 + Qwen3-VL + ApproachController overlaying the chosen `Action` on the webcam preview. If this works, the brain logic is done — all that remains is wiring to motors.

### Step 4 — dress-rehearse the whole loop with no hardware (~10 min)

```bash
# terminal 1 — fake Pi with mock backends
python -m pi.motor_controller --mock -v

# terminal 2 — real brain against the fake Pi + local webcam
python -m brain.main --pi-ip 127.0.0.1 --webcam 0 \
    --reference ~/ref_crop.jpg --context ~/wider_scene.jpg
```

The brain connects to the mock Pi, runs the approach controller on its local webcam, and sends PWM. `--mock -v` prints every drive command received. End-to-end validation of PiBridge ↔ MotorServer before any H-bridge exists.

### Step 5 — wire the robot (hardware task, no code)

Pin map in [pi/motor_controller/README.md](pi/motor_controller/README.md). Once wired, on the Pi:

```bash
sudo apt install -y python3-pigpio pigpio
sudo systemctl enable --now pigpiod
python3 -m pi.motor_controller -v
```

Then on the brain: `python -m brain.main --pi-ip <pi-ip> --reference ... --context ...`.

### Step 6 — full state machine (~2 hr)

`brain/main.py` is currently the approach-phase only. Wrap `ApproachController` in the full FSM from writeup/CLAUDE.md:

```
IDLE → PLANNING → NAVIGATING → SEARCHING → APPROACHING → INTAKING → VERIFYING → REPORTING → IDLE
```

NAVIGATING uses `iphone_listener` for GPS + a new waypoint follower (needs the relay's `/routes/apple` — see Step 7). SEARCHING/APPROACHING/VERIFYING delegate to the existing `ApproachController`.

### Step 7 — relay backend (~2 hr, Node/Express)

`relay/` is still empty. Endpoints: `POST /reports`, `GET /reports/latest`, `POST /robot/heartbeat`, `POST /routes/apple`. Contract in [app/README.md](app/README.md). Needs an Apple Developer MapKit token in `.env`. Different language/stack — natural split point with the Python work above.

---

## 4. Known gotchas / watch-outs

- **`transformers @ git+main` is floating** — pin to a specific commit SHA after step 2 succeeds, update `requirements.txt`.
- **The OWLv2 + Qwen3-VL wrapper code has NEVER been run on a GPU.** First real load will probably surface at least one API issue. Fix forward, don't assume the scaffolded code is correct.
- **Qwen3-VL 8B is actually 9B params** per the model card. Barely fits on 4080 at 4-bit (~5 GB). fp16 will OOM.
- **servo.py and control/loop.py both exist.** `servo.py` is continuous (turn_rad_s, fwd_m_s), `control/loop.py` is discrete Actions. We're using `control/loop.py` for the demo. Keep servo.py — it's tested and useful if we ever want smooth control.
- **The C270 fails in low light + rain.** Demo outdoors in daylight.
- **iPhone compass wanders near motor magnetic fields** — calibrate after any physical change.
- **MotorServer watchdog is safety-critical.** 500 ms of WS silence → all motors zero. Don't raise this timeout "temporarily" without thinking about what happens if the brain hangs.
- **PiBridge sends are fire-and-forget.** If the socket is down, `set_motors` is a no-op. That's intentional (the watchdog handles the safety case) but worth remembering when debugging "why aren't motors spinning".

---

## 5. Key files by topic

| Topic | File |
|---|---|
| Architecture + conventions | [writeup/CLAUDE.md](writeup/CLAUDE.md) |
| Running status | [NEXT.md](NEXT.md) |
| Nav design + CV jobs | [writeup/nav.md](writeup/nav.md) |
| YOLO training | [ml-training/TRAINING.md](ml-training/TRAINING.md) |
| Hybrid approach controller | [brain/control/loop.py](brain/control/loop.py) |
| OWLv2 wrapper | [brain/perception/target_finder.py](brain/perception/target_finder.py) |
| Qwen3-VL wrapper | [brain/perception/vlm_scout.py](brain/perception/vlm_scout.py) |
| Pi WebSocket client (brain side) | [brain/io/pi_bridge.py](brain/io/pi_bridge.py) |
| Pi MJPEG consumer (brain side) | [brain/io/pi_frame_source.py](brain/io/pi_frame_source.py) |
| iPhone GPS listener | [brain/io/iphone_listener.py](brain/io/iphone_listener.py) |
| Approach-phase entry point | [brain/main.py](brain/main.py) |
| Pi motor controller | [pi/motor_controller/](pi/motor_controller/) |
| GPU smoke tests | [tools/test_target_finder.py](tools/test_target_finder.py), [tools/test_vlm_scout.py](tools/test_vlm_scout.py), [tools/test_approach.py](tools/test_approach.py) |
| Tests | [tests/](tests/) — 65 passing |

---

## 6. First action for the next session

**Pick one:**
- On the 4080 → Step 1, then 2, then 3 (the GPU validation chain). Report back timings + whether JSON parsing is reliable.
- Robot is wired → Step 5, then run `brain.main` against the real Pi.
- Neither available but want to make progress → Step 6 (state machine) or Step 7 (relay, Node/TS).
