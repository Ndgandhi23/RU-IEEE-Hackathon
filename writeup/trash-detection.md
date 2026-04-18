# Trash Detection

How we build the trash detector that the robot's camera uses during SEARCHING / APPROACHING / VERIFYING. This is Job 3 of the CV network defined in [nav.md](nav.md); obstacle detection and course confirmation are separate jobs documented there.

## Scope

Input: a 640×480 RGB frame from the C270 webcam.
Output: list of `Detection(class, confidence, bbox)` where `class` is trash (possibly further broken down) and `bbox` is `(x1, y1, x2, y2)` in pixel coords.

Non-goals:
- Classifying trash *type* for sorting (recyclable vs. compost). Irrelevant — we intake everything.
- Semantic segmentation of trash. A bbox is enough for visual servoing.
- Running on the phone. The robot phone is a sensor, not a compute node.

Target performance on the **brain machine** (Mac laptop for the hackathon prototype; Jetson Orin Nano in a future self-contained deployment):
- **15+ FPS** at 640×480. On a Mac M-series this is easy with `.pt`. On the Jetson, requires TensorRT FP16 export (`.engine`).
- **Recall ≥ 0.85** at confidence 0.5 on a held-out Rutgers test set.
- **Precision ≥ 0.7** at the same threshold. Missing trash (low recall) is worse than a brief false-positive chase (low precision); we tune to favor recall.

## Model choice: YOLO11 (Ultralytics)

Recommending **YOLO11n** (nano) as the starting point, with the option to move to YOLO11s (small) if accuracy isn't there.

Why:
- Well-documented, easy training pipeline in Python, trivial ONNX/TensorRT export.
- Pretrained weights on COCO available — transfer learning headstart.
- Single-stage detector. Fast. Runs at 30+ FPS on Jetson Orin Nano in FP16.
- Ultralytics CLI makes fine-tuning a one-liner.

What we're *not* doing and why:
- **Mask R-CNN / two-stage detectors** — too slow for 15 FPS on Orin Nano, and we don't need masks.
- **Custom architecture** — zero upside for a hackathon. Prebaked nets are better than anything we'd train from scratch.
- **Vision-language models (CLIP, GroundingDINO)** — interesting but slow at inference. Skip.
- **Anchor-free recent architectures (DETR, RT-DETR)** — YOLO11 is anchor-free and already faster; no reason to switch unless YOLO underperforms.

## Class set decision

Two options. Pick one and stick with it for MVP.

**Option A (recommended — binary):** one class, `trash`. Any litter-ish object gets a bbox. Fast to label, minimal class-confusion errors, robot doesn't care about type.

**Option B (multi-class):** `bottle`, `can`, `wrapper`, `paper`, `cigarette`, `other`. Richer but ~5× more labeling effort and domain-shift issues when a new trash type shows up.

The robot's behavior is identical either way (drive toward bbox, intake). **Start with A.** Revisit if we find the model confusing trash with landscape objects and need the extra semantic signal.

## Dataset pipeline

Expect this to be the actual bottleneck. Model training is easy; getting good data is hard.

### 1. TACO (Trash Annotations in Context)

- ~1500 images of real-world litter, ~4800 annotations across 60 fine-grained classes.
- For Option A (binary), collapse all 60 classes to a single `trash` label.
- [http://tacodataset.org/](http://tacodataset.org/) — download via their script into [ml-training/data/taco/](../ml-training/data/taco/).
- Split: 80% train / 10% val / 10% test.

**Gotchas with TACO:**
- Many images are close-up phone photos, **not** the perspective of a ground-level robot camera. The model trained on TACO alone will have domain shift issues on the robot's view.
- Classes are very imbalanced (lots of cigarette butts, few of some categories). Binary collapse fixes this.

### 2. Custom Rutgers data

This is the important one. Without it, the model will fail on test day.

Plan:
- Walk around Rutgers campus with the robot phone (or any phone) at robot-camera height (~30cm off ground). Record video at the same resolution/FOV as the C270.
- Place some real litter on paths; photograph it from approaching angles.
- Sample frames every ~1s. Aim for **200–400 labeled images**.
- Label with **Roboflow** (fastest for a hackathon — free tier covers us) or **Label Studio** (self-hosted, free).
- Annotation policy: bbox tight around visible trash, occlusion allowed if ≥30% visible, ignore trash that is too small (< 20px on the long side).

**Don't skip the "approaching angles" part.** Most real inference happens with the robot pointing at the trash from 3–10m away, not looking straight down.

### 3. Augmentations

Ultralytics defaults are fine (mosaic, random affine, HSV jitter). Add:
- **Heavy brightness jitter** — Rutgers at 9am vs. 5pm is a different world.
- **Rain/wet surface augmentation** — grab an albumentations snippet if time permits. Low priority.
- **NO vertical flips.** Trash has a gravity direction; flipping upside-down produces nonsense training examples.

## Training pipeline

```bash
# Install
pip install ultralytics==8.3.*  # pin once we pick a version

# Baseline: pretrained YOLO11n, no fine-tuning
yolo predict model=yolo11n.pt source=some_trash_image.jpg
# (just to verify the tooling works)

# Fine-tune on TACO (binary)
yolo train model=yolo11n.pt data=ml-training/data/taco_binary.yaml \
           epochs=100 imgsz=640 batch=32 device=0 \
           project=runs/trash name=taco_finetune

# Fine-tune further on Rutgers data (transfer from above)
yolo train model=runs/trash/taco_finetune/weights/best.pt \
           data=ml-training/data/rutgers.yaml \
           epochs=50 imgsz=640 batch=16 device=0 \
           project=runs/trash name=rutgers_finetune
```

Training runs on Colab (A100/T4) per [ml-training/TRAINING.md](../ml-training/TRAINING.md), not on the brain machine. Inference runs on the brain machine at runtime (Mac for prototype, Jetson later).

### Hyperparameters to touch (and nothing else)

| Param | Default | Consider | Why |
|---|---|---|---|
| `epochs` | 100 | 100–200 | Watch val mAP curve flatten |
| `imgsz` | 640 | 640 | Matches inference resolution. Don't mismatch. |
| `batch` | 16 | 16–32 | Fit GPU memory |
| `lr0` | 0.01 | 0.001 for fine-tune | Lower LR on the Rutgers pass — we're refining, not learning from scratch |
| `mosaic` | 1.0 | Disable last 10 epochs | Mosaic hurts final convergence |
| `conf` (inference) | 0.25 | 0.5 | Higher threshold = fewer false positives |

Don't tune anchors, loss weights, or the architecture. That's a week of wasted effort.

## Evaluation

Two datasets matter:
1. **TACO test split** — sanity check that training worked. Not the real metric.
2. **Rutgers test split** — this is the metric. Specifically held-out Rutgers photos the model never saw.

Metrics:
- **mAP@50** — primary. Target: >0.7 on Rutgers.
- **Recall@conf=0.5** — secondary. We favor recall. Target: >0.85.
- **FPS on the brain machine** (Mac `.pt` or future Jetson `.engine`). Target: >15 at 640×480.

Failure modes to explicitly test:
- Trash partially occluded by grass.
- Multiple pieces of trash in one frame (does NMS pick the right one?).
- Trash in shadow vs. direct sunlight.
- Camera motion blur (robot moving, trash small).
- Common false-positive candidates: dead leaves, dark rocks, mulch. Add 20-30 "hard negatives" (Rutgers photos with NO trash) to the test set.

## Deployment

### On the brain machine (Mac — current prototype)

Load the trained `.pt` directly via Ultralytics. No export step required.

```python
from ultralytics import YOLO
model = YOLO("trash_v1_best.pt")
results = model.predict(frame)
```

`jetson/perception/detector.py` already does this — the folder name is historical, the code runs on the Mac for the prototype.

### On a future Jetson (self-contained robot)

Export to TensorRT once the `.pt` converges:

```bash
# Export to ONNX (can run anywhere)
yolo export model=best.pt format=onnx imgsz=640 opset=12

# On the Jetson: convert ONNX to TensorRT engine
/usr/src/tensorrt/bin/trtexec \
    --onnx=best.onnx \
    --saveEngine=ml-training/models/yolo_trash.engine \
    --fp16 \
    --workspace=4096
```

FP16 is the right tradeoff on Orin Nano — ~2× speedup vs FP32 with negligible accuracy loss. INT8 quantization gives another 2× but needs a calibration dataset; skip until needed.

**The same `detector.py` loads `.pt` or `.engine`** — Ultralytics handles both formats. No code change when we switch.

## Decisions to make before starting

1. **Binary vs. multi-class** → recommend binary (Option A).
2. **YOLO11n vs. YOLO11s** → start with `n`. If Jetson FPS is fine AND `n` underperforms, bump to `s`.
3. **Who collects Rutgers data and when** → needs to happen *before* the demo, not during. A half-day walk with a phone + 100 pieces of staged litter covers it.
4. **Where do the model weights live** → `ml-training/models/yolo_trash.engine` (per CLAUDE.md). The `.pt` stays in the training run folder; only the `.engine` ships to the robot. Don't commit .engine files >100MB.
5. **Labeling tool** → Roboflow (fast, web UI, free tier). Label Studio if we want to stay offline.

## Staged build plan

Each stage is a checkpoint. Don't move to the next until the current one passes its test.

| # | Goal | Artifact | Test |
|---|---|---|---|
| A | Ultralytics pipeline runs end-to-end | `runs/trash/hello/` | `yolo predict` on any image produces a visualization |
| B | Trained on TACO, binary | [ml-training/models/yolo_taco.pt](../ml-training/models/yolo_taco.pt) | mAP@50 >0.5 on TACO test split |
| C | ~200 labeled Rutgers photos in hand | [ml-training/data/rutgers/](../ml-training/data/rutgers/) | Roboflow export in YOLO format, train/val/test split |
| D | Fine-tuned on Rutgers | [ml-training/models/yolo_trash.pt](../ml-training/models/yolo_trash.pt) | mAP@50 >0.7 on Rutgers test split |
| E | Running on brain machine (Mac) with `.pt` | [jetson/perception/detector.py](../jetson/perception/detector.py) | Live webcam detection at 15+ FPS via `tools/live_detect.py` |
| F | Frames flowing from Pi MJPEG → brain detector | new frame-consumer in `jetson/io/` | Point Pi at a bottle from the room next door; detections show up on the Mac |
| G | Integrated into nav state machine | [jetson/main.py](../jetson/main.py) | In SEARCHING, YOLO detections trigger state transition to APPROACHING |
| H | (future) Exported to TensorRT for on-robot Jetson | [ml-training/models/yolo_trash.engine](../ml-training/models/yolo_trash.engine) | Benchmark shows 15+ FPS on Orin Nano |

Stages A–E are laptop work. F needs the Pi streaming camera frames. G needs the full link (iPhone + Pi + relay) up. H is deferred until we swap the brain role from Mac to Jetson.

## Why NOT

- **Why not train from scratch?** No dataset is big enough. Pretrained YOLO + fine-tune is strictly better.
- **Why not use GPT-4V / Gemini Vision?** Latency kills it. Needs round-trip to cloud and can't hit 15 FPS. Also cost.
- **Why not a segmentation model?** Bbox is enough for visual servoing. Segmentation is 2-5× slower to train and label.
- **Why not ensemble / TTA?** Slower inference. Our accuracy bottleneck is data, not modeling.
- **Why not hard-negative mining?** Adds complexity. Ultralytics defaults with varied Rutgers data + some intentional no-trash images handles it.
- **Why not active learning?** Requires a round-trip (deploy → collect → relabel → retrain). Hackathon timeline doesn't allow it.

## Open questions

- How much training compute do we have? If only CPU / laptop GPU, YOLO11n finishes in a few hours. YOLO11s needs an afternoon.
- Does anyone have an Nvidia GPU laptop or Colab Pro access? Colab free works but times out.
- Rutgers data collection — is there a specific test-day route or demo area? If yes, bias the training set toward that area's lighting/surfaces.
- Do we need a fallback if the model fails during demo (e.g., driving slowly through waypoint, giving up gracefully)? Scope in the state machine already — `SEARCHING → REPORTING (failure)` after a 360° scan finds nothing.
