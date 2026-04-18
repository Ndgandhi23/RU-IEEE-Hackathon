# TRAINING.md

Workflow doc for the trash detection model. Lives in `ml-training/`. Read before training a new model or modifying the dataset.

## What this trains

A YOLOv8n object detector that finds litter in outdoor camera frames. Same weights are used in two places:

- **On the robot** (Jetson): `jetson/perception/detector.py` loads the TensorRT engine for real-time inference during the SEARCHING/APPROACHING/VERIFYING states.
- **On the server**: `server/ml/classifier.py` loads the .pt or .onnx for upload validation and trash classification.

Single source of truth. Don't train two separate models for these two jobs.

## Class List (Canonical)

Defined in `classes.yaml`. **Every change here cascades through the codebase.** Update `data.yaml`, retrain the model, re-export TensorRT, update the Jetson and server code that filters by class.

Current classes:

| ID | Name | Notes |
|---|---|---|
| 0 | bottle | Plastic bottles, water/soda. Most common, highest priority. |
| 1 | cup | Paper coffee cups, plastic cups. |
| 2 | can | Aluminum cans. Not in COCO — requires fine-tuning. |
| 3 | wrapper | Chip bags, candy wrappers. Not in COCO. |
| 4 | paper | Crumpled paper, flyers. Not in COCO. |

**Excluded on purpose:**
- Glass anything — safety hazard, gripper can't safely handle.
- Cigarette butts — too small for reliable monocular detection at distance.
- Anything > 30cm — won't fit gripper.
- Anything < 3cm — too small at typical detection distance.

If you change this list, update:
1. `classes.yaml`
2. `data.yaml` (regenerate from classes.yaml)
3. `CLAUDE.md` model section
4. `jetson/perception/detector.py` class filter constants
5. `server/ml/classifier.py` class mapping

## Strategy: Why Fine-Tune at All

Pretrained YOLOv8 (COCO) detects `bottle` and `cup` out of the box but misses `can`, `wrapper`, `paper`. It also performs poorly on damaged/crushed/lying-on-the-ground variants of bottles and cups because COCO doesn't have many examples in those contexts.

We fine-tune to:
1. Add the missing classes (can, wrapper, paper).
2. Improve recall on the existing classes in our actual deployment context (Rutgers walkways, camera at ~30cm height, varied lighting).

**If you're doing a quick demo and only need bottles + cups, skip training entirely** and use pretrained `yolov8n.pt` directly. Filter by COCO class IDs 39 (bottle) and 41 (cup). Document that decision in commit log.

## Directory Layout

```
ml-training/
├── README.md
├── TRAINING.md                       # this file
├── classes.yaml                      # canonical class list
├── data.yaml                         # YOLO dataset config (generated from classes.yaml)
├── requirements.txt                  # heavy training deps, separate from Jetson runtime
├── data/                             # GITIGNORED — see "Getting the Data" below
│   ├── README.md                     # describes how to obtain/regenerate
│   ├── images/{train,val,test}/
│   └── labels/{train,val,test}/      # YOLO format .txt files
├── scripts/
│   ├── download_taco.py              # pulls TACO dataset
│   ├── taco_to_yolo.py               # converts TACO COCO format → YOLO + class remap
│   ├── prepare_dataset.py            # combines TACO + Rutgers, splits train/val/test
│   ├── train.py                      # entry point for training
│   ├── evaluate.py                   # eval on test set + per-class metrics
│   ├── visualize_failures.py         # render the worst N predictions for review
│   └── export_tensorrt.py            # runs ON THE JETSON, .pt → .engine
├── notebooks/
│   ├── eda.ipynb                     # dataset exploration
│   └── error_analysis.ipynb          # post-eval failure diving
├── runs/                             # GITIGNORED — Ultralytics output
└── models/
    ├── README.md                     # which model is which
    ├── MODEL_LOG.md                  # human log of training runs and decisions
    └── *.pt, *.engine                # GIT LFS tracked
```

## Environment Setup

Training is heavy. Use a separate venv from the Jetson runtime.

```bash
cd ml-training
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

`requirements.txt` pins:
```
ultralytics==8.3.0
torch==2.4.0
torchvision==0.19.0
roboflow
opencv-python
matplotlib
pandas
pyyaml
```

**Pin Ultralytics version.** Their API changes between minor versions and silently breaks training scripts.

### Where to train
- **Best:** workstation/laptop with NVIDIA GPU (RTX 30xx or better).
- **Acceptable:** Google Colab T4 (free tier — ~2 hours for 100 epochs on small dataset).
- **Don't:** train on the Jetson Orin Nano. It can run inference fast but training is slow and you'll cook the device.

## Getting the Data

Two sources combined.

### Source 1: TACO (Trash Annotations in Context)
Public dataset, ~1500 images, ~4800 annotated litter objects, 60 fine-grained classes in COCO format.

```bash
python scripts/download_taco.py             # pulls images + annotations.json
python scripts/taco_to_yolo.py              # converts to YOLO format, remaps to our 5 classes
```

The remap collapses TACO's 60 classes into our 5. Mappings live in `scripts/taco_to_yolo.py`. After remapping you'll have ~1000-1200 usable images (the rest had only excluded classes).

### Source 2: Rutgers custom data
Photos collected on actual campus walkways at robot camera height. **This is the highest-leverage data.** TACO alone gets you ~50% recall on Rutgers; adding 200-400 custom images pushes it to 70%+.

Collection protocol:
1. Phone or C270 at ~30-60cm height (matches robot mounting).
2. Place trash from class list in real settings: sidewalks, grass edges, near benches, flowerbeds.
3. Vary conditions: bright sun / overcast / dappled shade. Different surfaces. Different distances (1m, 2m, 3m). Some occlusion.
4. **Skip:** night, rain, dusk/dawn. We won't operate in those conditions.

Target: 200-400 images for v1, 500-800 for v2 after first iteration loop.

Annotation: Roboflow (free for small datasets, exports YOLO format) or CVAT. Bounding boxes only, no segmentation. Keep annotation guidelines consistent across annotators — review the first 20 boxes per annotator before committing to the rest.

### Combining sources
```bash
python scripts/prepare_dataset.py
```
This:
- Pulls TACO YOLO labels from `data/taco/`.
- Pulls Rutgers labels from `data/rutgers/`.
- Stratified 70/20/10 train/val/test split — both sources represented in each split proportionally.
- Writes final layout to `data/images/{train,val,test}/` and `data/labels/{train,val,test}/`.
- Validates: every image has a label file (even if empty), every label class is in `classes.yaml`.

**Don't** train on TACO and test only on Rutgers (or vice versa). Your test metrics will lie about real-world performance.

## Training

```bash
python scripts/train.py
```

`train.py` should be a thin wrapper around the Ultralytics CLI:

```python
from ultralytics import YOLO

model = YOLO('yolov8n.pt')  # start from COCO weights
model.train(
    data='data.yaml',
    epochs=100,
    imgsz=640,
    batch=16,
    patience=20,             # early stop if no improvement
    project='runs/train',
    name='trash_v1',
    augment=True,
    # default augmentations are good; explicit only if overriding
    hsv_h=0.015, hsv_s=0.7, hsv_v=0.4,
    degrees=0,               # don't rotate — robot orientation matters
    flipud=0,                # don't vertical flip — trash has a "down"
    fliplr=0.5,              # horizontal flip is fine
    mosaic=1.0,              # huge for small datasets
)
```

Output: `runs/train/trash_v1/weights/best.pt` and `last.pt`.

## Evaluation

```bash
python scripts/evaluate.py runs/train/trash_v1/weights/best.pt
```

Reports:
- Overall mAP@0.5 and mAP@0.5:0.95
- Per-class precision, recall, mAP
- Confusion matrix
- Inference latency on this machine (sanity check, not deployment metric)

**Targets for v1:**
- Overall mAP@0.5 ≥ 0.65
- Per-class recall ≥ 0.70 on top-3 classes (bottle, cup, can)
- If below, problem is almost always data, not model. Don't reach for YOLOv8s/m yet.

**Hand-eyeball failures:**
```bash
python scripts/visualize_failures.py runs/train/trash_v1/weights/best.pt --n 50
```
Renders the 50 worst predictions side-by-side with ground truth as PNGs in `runs/train/trash_v1/failures/`. Spend 30 minutes looking at them. You'll learn more than from the loss curve.

Common failure patterns and what they mean:
- **Cigarette butts confused with sticks/leaves** → drop the class or get more data.
- **Bottles missed in shadow** → augmentation insufficient or training data lacks shaded examples.
- **Bbox too tight / too loose** → annotation guidelines drifted.
- **Wrappers detected as paper (or vice versa)** → these classes may need to merge.
- **Confidence high on background patches** → false positive problem; add hard negatives to training set.

## Iteration Loop

This is what actually moves the model forward. Architecture changes don't.

1. Train v1, evaluate, eyeball failures.
2. Collect 100-200 more Rutgers images **focused on the failure modes** identified.
3. Annotate. Add to `data/rutgers/`.
4. Re-run `prepare_dataset.py`.
5. Train v2 from v1 weights or from scratch (try both, pick winner).
6. Re-evaluate. Compare to v1.
7. Repeat until mAP plateaus across 2 rounds, or you hit your target.

Log each iteration in `models/MODEL_LOG.md`:
```markdown
## trash_v2 — 2026-04-22
- Base: trash_v1
- Added 150 Rutgers images focused on shaded sidewalks
- Dropped `cigarette_butt` class (too unreliable, low gripper compatibility)
- Result: mAP@0.5 0.71 (was 0.62), can recall 0.78 (was 0.55)
- Deployed: yes
```

## Exporting to TensorRT (for the Jetson)

**Run this ON THE JETSON.** TensorRT engines are tied to the specific GPU + JetPack version they're built on. An engine built on a desktop RTX won't load on the Orin Nano.

```bash
# on the Jetson
cd ml-training
python scripts/export_tensorrt.py models/trash_v2.pt
```

Which is roughly:
```python
from ultralytics import YOLO
model = YOLO('models/trash_v2.pt')
model.export(format='engine', half=True, device=0, imgsz=640)
# produces models/trash_v2.engine
```

**Verify performance:**
```python
import time
from ultralytics import YOLO
model = YOLO('models/trash_v2.engine')
for _ in range(10): model.predict('test.jpg', verbose=False)  # warmup
start = time.time()
for _ in range(100): model.predict('test.jpg', verbose=False)
print(f"FPS: {100/(time.time()-start):.1f}")
```

Targets on Orin Nano:
- 30+ FPS at 640x640 FP16: good
- 15-30 FPS: acceptable
- <15 FPS: drop input size to 416 or 320 and re-export

## Model Versioning

`models/` is Git LFS tracked for `*.pt` and `*.engine`. Setup once per clone:
```bash
git lfs install
git lfs track "ml-training/models/*.pt" "ml-training/models/*.engine"
```

Naming convention: `trash_v<N>.pt` and `trash_v<N>.engine`. Bump N for any retraining that gets deployed. Don't reuse names — old runs stay around for rollback.

`models/MODEL_LOG.md` is the human-readable history. Update on every commit to `models/`.

The Jetson and server code reference a fixed model version (e.g., `trash_v2.engine`) — they don't auto-pick the latest. Bumping the deployed version is a deliberate code change.

## What Not to Do

- **Don't try YOLOv9, v10, v11 yet.** v8n is mature, well-documented, has the best Jetson tooling.
- **Don't train multiple model sizes "to compare."** Train v8n. Done.
- **Don't add classes you can't physically pick up.** Bloats the model, creates UX problems (robot reports trash it can't grab).
- **Don't collect data in conditions you won't operate in.** No night, no rain.
- **Don't change the augmentation pipeline without a measured reason.** Ultralytics defaults are tuned for object detection.
- **Don't tune hyperparameters before tuning the dataset.** Data > hyperparams, always.
- **Don't train on the Jetson.** Slow, cooks the device, no benefit.
- **Don't commit raw images to git.** They go in `data/`, which is gitignored. Document in `data/README.md` how to obtain them.
- **Don't build TensorRT engines on your laptop.** They won't load on the Jetson.

## Risks

| Risk | Mitigation |
|---|---|
| TACO classes don't generalize to Rutgers | Custom Rutgers data is non-optional. If you skip it, expect ~50% recall in deployment. |
| Trash too small to detect at distance | Restrict APPROACHING phase to <2m range, where bbox is large enough. |
| Confidence drops with C270 fixed focus at close range (<30cm) | Lower conf threshold during APPROACHING (0.4) than SEARCHING (0.5). Use bbox size as stop signal, not conf. |
| Same model on robot + server gets out of sync | Pin model version in code. Bump deliberately. Both consume from `ml-training/models/`. |
| Annotation drift between annotators | Review first 20 boxes per annotator. Document edge cases in `data/README.md`. |
| Class imbalance (lots of bottles, few wrappers) | Check class distribution in `prepare_dataset.py`. If >5x imbalance, oversample minority class or use class weights. |

## How to Run (Summary)

First time:
```bash
cd ml-training
python -m venv venv && source venv/bin/activate
pip install -r requirements.txt
python scripts/download_taco.py
python scripts/taco_to_yolo.py
# ... collect + annotate Rutgers data, drop in data/rutgers/
python scripts/prepare_dataset.py
python scripts/train.py
python scripts/evaluate.py runs/train/trash_v1/weights/best.pt
python scripts/visualize_failures.py runs/train/trash_v1/weights/best.pt
# review failures, decide whether to iterate or ship
cp runs/train/trash_v1/weights/best.pt models/trash_v1.pt
git add models/trash_v1.pt && git commit -m "ml: trash detector v1, mAP 0.65"
```

On the Jetson, after pulling:
```bash
cd ml-training
python scripts/export_tensorrt.py models/trash_v1.pt
git add models/trash_v1.engine && git commit -m "ml: export trash_v1 to TensorRT"
git push
```

Then update the Jetson code to point at the new engine version.

## Open Questions / TODO

- [ ] Decide final class list. Currently planning 5 (bottle, cup, can, wrapper, paper) — confirm gripper handles all.
- [ ] Collect first 200 Rutgers images.
- [ ] Decide: skip TACO and use Rutgers-only, or combine? (Combine is safer; Rutgers-only is faster.)
- [ ] Establish annotation guidelines doc in `data/README.md` before annotating starts.
- [ ] Set up Git LFS in the repo.
- [ ] First training run target date: ___