"""Fine-tune YOLOv8n on the trash dataset defined by data.yaml."""
from __future__ import annotations

import argparse
import os
from pathlib import Path

# Disable Ultralytics' wandb callback (it rejects absolute paths as project names).
os.environ.setdefault("WANDB_MODE", "disabled")

import torch
import yaml
from ultralytics import YOLO

ROOT = Path(__file__).resolve().parent.parent


def pick_device() -> str | int:
    if torch.cuda.is_available():
        return 0
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def absolute_data_yaml() -> Path:
    """Write a copy of data.yaml with `path` as an absolute path.
    Ultralytics otherwise prepends its own datasets_dir to relative paths."""
    cfg = yaml.safe_load((ROOT / "data.yaml").read_text())
    cfg["path"] = str(ROOT / "data")
    out = ROOT / "data_abs.yaml"
    out.write_text(yaml.safe_dump(cfg, sort_keys=False))
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--weights", default="yolov8n.pt", help="starting weights (COCO default)")
    ap.add_argument("--epochs", type=int, default=100)
    ap.add_argument("--imgsz", type=int, default=640)
    ap.add_argument("--batch", type=int, default=16)
    ap.add_argument("--name", default="trash_v1")
    ap.add_argument("--device", default=None, help="cuda index, 'mps', or 'cpu'. Default: auto.")
    ap.add_argument("--cache", default="ram", help="'ram', 'disk', or 'false'. Default: ram (fast, needs memory).")
    args = ap.parse_args()

    device = args.device if args.device is not None else pick_device()
    print(f"device: {device}")

    cache_val: bool | str = False if args.cache.lower() == "false" else args.cache
    data_yaml = absolute_data_yaml()
    model = YOLO(args.weights)
    model.train(
        data=str(data_yaml),
        epochs=args.epochs,
        imgsz=args.imgsz,
        batch=args.batch,
        patience=20,
        project=str(ROOT / "runs" / "train"),
        name=args.name,
        device=device,
        cache=cache_val,
        augment=True,
        hsv_h=0.015,
        hsv_s=0.7,
        hsv_v=0.4,
        degrees=0,
        flipud=0,
        fliplr=0.5,
        mosaic=1.0,
    )


if __name__ == "__main__":
    main()
