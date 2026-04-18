# models/

Deployed model weights live here. These are versioned and tracked in git (yolov8n is ~6MB; fine without LFS).

## Current

- `trash_v1.pt` — YOLOv8n, fine-tuned on TACO + Kaggle Drink Waste. 5 classes: bottle, cup, can, wrapper, paper.
  - **Test mAP@0.5 = 0.511** overall
  - `bottle` mAP@0.5 = **0.984** (production-ready)
  - `can` mAP@0.5 = **0.983** (production-ready)
  - `wrapper` mAP@0.5 = 0.309 (weak)
  - `cup` mAP@0.5 = 0.191 (weak)
  - `paper` mAP@0.5 = 0.090 (bad)
- Trained on Colab A100 + L4. Training + eval source: `ml-training/notebooks/train.ipynb`.

## To refresh after retraining

On Colab, the `train.ipynb` save cell writes the `.pt` to `/content/drive/MyDrive/trash-yolo/trash_v1_best.pt`. Download it to your Mac, rename to `trash_v1.pt`, drop in this directory, commit, push.

## File size rule

Do not commit anything >100MB here. If we bump to yolov8m/l/x, switch to Git LFS:
```bash
git lfs install
git lfs track "models/*.pt"
```
