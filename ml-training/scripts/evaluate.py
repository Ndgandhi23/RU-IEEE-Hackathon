"""Evaluate a trained YOLO model on the test split. Reports mAP and per-class metrics."""
from __future__ import annotations

import argparse
import os
from pathlib import Path

os.environ.setdefault("WANDB_MODE", "disabled")

import yaml
from ultralytics import YOLO

ROOT = Path(__file__).resolve().parent.parent


def absolute_data_yaml() -> Path:
    cfg = yaml.safe_load((ROOT / "data.yaml").read_text())
    cfg["path"] = str(ROOT / "data")
    out = ROOT / "data_abs.yaml"
    out.write_text(yaml.safe_dump(cfg, sort_keys=False))
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("weights", help="path to .pt weights (e.g. runs/train/trash_v1/weights/best.pt)")
    ap.add_argument("--split", default="test", choices=["val", "test"])
    ap.add_argument("--imgsz", type=int, default=640)
    args = ap.parse_args()

    data_yaml = absolute_data_yaml()
    model = YOLO(args.weights)
    metrics = model.val(
        data=str(data_yaml),
        split=args.split,
        imgsz=args.imgsz,
        project=str(ROOT / "runs" / "eval"),
        name=Path(args.weights).parent.parent.name,
    )

    names = model.names
    print(f"\n=== {args.split} results ===")
    print(f"mAP@0.5:      {metrics.box.map50:.3f}")
    print(f"mAP@0.5:0.95: {metrics.box.map:.3f}")
    print(f"\nper-class:")
    print(f"  {'class':<12} {'P':>6} {'R':>6} {'mAP50':>7}")
    for i, cls_idx in enumerate(metrics.box.ap_class_index):
        name = names[int(cls_idx)]
        p = metrics.box.p[i]
        r = metrics.box.r[i]
        ap50 = metrics.box.ap50[i]
        print(f"  {name:<12} {p:>6.3f} {r:>6.3f} {ap50:>7.3f}")


if __name__ == "__main__":
    main()
