"""Fine-tune YOLOv8n on the trash dataset defined by data.yaml."""
from __future__ import annotations

import argparse
from pathlib import Path

import torch
from ultralytics import YOLO

ROOT = Path(__file__).resolve().parent.parent


def pick_device() -> str | int:
    if torch.cuda.is_available():
        return 0
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--weights", default="yolov8n.pt", help="starting weights (COCO default)")
    ap.add_argument("--epochs", type=int, default=100)
    ap.add_argument("--imgsz", type=int, default=640)
    ap.add_argument("--batch", type=int, default=16)
    ap.add_argument("--name", default="trash_v1")
    ap.add_argument("--device", default=None, help="cuda index, 'mps', or 'cpu'. Default: auto.")
    args = ap.parse_args()

    device = args.device if args.device is not None else pick_device()
    print(f"device: {device}")

    model = YOLO(args.weights)
    model.train(
        data=str(ROOT / "data.yaml"),
        epochs=args.epochs,
        imgsz=args.imgsz,
        batch=args.batch,
        patience=20,
        project=str(ROOT / "runs" / "train"),
        name=args.name,
        device=device,
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
