"""Download the Kaggle 'drinking-waste-classification' dataset and append to our YOLO splits.

Requires kaggle CLI auth: either ~/.kaggle/kaggle.json or KAGGLE_USERNAME + KAGGLE_KEY env.

Class remap (source -> our canonical):
  Aluminium can  -> 2 (can)
  Plastic bottle -> 0 (bottle)
  PET bottle     -> 0 (bottle)
  HDPE bottle    -> 0 (bottle)
  Glass bottle   -> SKIPPED (no glass per CLAUDE.md)
"""
from __future__ import annotations

import argparse
import random
import shutil
import subprocess
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
RAW_DIR = DATA_DIR / "drink_waste"
KAGGLE_SLUG = "arkadiyhacks/drinking-waste-classification"

SOURCE_NAME_TO_CLASS: dict[str, int] = {
    "aluminiumcan": 2,
    "acan": 2,
    "aluminium_can": 2,
    "plasticbottle": 0,
    "pbottle": 0,
    "plastic_bottle": 0,
    "pet": 0,
    "petbottle": 0,
    "hdpe": 0,
    "hdpe-m": 0,
    "hdpem": 0,
    "milkbottle": 0,
    # glass bottles intentionally absent -> dropped
}

TRAIN_FRAC, VAL_FRAC = 0.7, 0.2
SEED = 42


def ensure_downloaded() -> Path:
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    if any(RAW_DIR.rglob("*.jpg")) or any(RAW_DIR.rglob("*.JPG")) or any(RAW_DIR.rglob("*.png")):
        print(f"{RAW_DIR} already has images, skipping download")
        return RAW_DIR
    print(f"downloading {KAGGLE_SLUG} ...")
    subprocess.run(
        ["kaggle", "datasets", "download", "-d", KAGGLE_SLUG, "-p", str(RAW_DIR), "--unzip"],
        check=True,
    )
    for zf in RAW_DIR.glob("*.zip"):
        with zipfile.ZipFile(zf) as z:
            z.extractall(RAW_DIR)
        zf.unlink()
    return RAW_DIR


def read_classes_file(root: Path) -> dict[int, int] | None:
    """Find classes.txt / _classes.txt / obj.names and return source_idx -> our_class (or None to drop)."""
    candidates = list(root.rglob("classes.txt")) + list(root.rglob("_classes.txt")) + list(root.rglob("obj.names"))
    if not candidates:
        return None
    names = [n.strip() for n in candidates[0].read_text().splitlines() if n.strip()]
    mapping: dict[int, int] = {}
    for i, name in enumerate(names):
        key = name.lower().replace(" ", "").replace("_", "").replace("-", "")
        if key in SOURCE_NAME_TO_CLASS:
            mapping[i] = SOURCE_NAME_TO_CLASS[key]
        elif "glass" in key:
            continue  # explicitly skip glass
        else:
            # Best-effort substring match.
            for src, dst in SOURCE_NAME_TO_CLASS.items():
                if src in key or key in src:
                    mapping[i] = dst
                    break
    print(f"source classes: {names}")
    print(f"remap: {mapping}  (indices missing = dropped)")
    return mapping


def find_image_label_pairs(root: Path) -> list[tuple[Path, Path]]:
    """Walk root, pair each image with its sibling .txt (YOLO format)."""
    pairs = []
    for img in root.rglob("*"):
        if img.suffix.lower() not in (".jpg", ".jpeg", ".png"):
            continue
        lbl = img.with_suffix(".txt")
        if not lbl.exists():
            # try same stem, different dir
            hits = list(root.rglob(f"{img.stem}.txt"))
            if not hits:
                continue
            lbl = hits[0]
        pairs.append((img, lbl))
    return pairs


def remap_label(src_label: Path, class_map: dict[int, int]) -> str:
    out_lines = []
    for line in src_label.read_text().splitlines():
        parts = line.strip().split()
        if len(parts) != 5:
            continue
        try:
            src_cls = int(parts[0])
        except ValueError:
            continue
        if src_cls not in class_map:
            continue
        dst_cls = class_map[src_cls]
        out_lines.append(f"{dst_cls} {parts[1]} {parts[2]} {parts[3]} {parts[4]}")
    return "\n".join(out_lines) + ("\n" if out_lines else "")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args()

    ensure_downloaded()
    class_map = read_classes_file(RAW_DIR)
    if class_map is None:
        raise SystemExit(
            "Could not find a classes.txt / obj.names. Inspect data/drink_waste/ and update SOURCE_NAME_TO_CLASS."
        )

    pairs = find_image_label_pairs(RAW_DIR)
    print(f"found {len(pairs)} image+label pairs")

    random.Random(SEED).shuffle(pairs)
    if args.limit > 0:
        pairs = pairs[: args.limit]
        print(f"limit={args.limit}: using {len(pairs)} pairs")

    n = len(pairs)
    n_train, n_val = int(n * TRAIN_FRAC), int(n * VAL_FRAC)
    splits = {
        "train": pairs[:n_train],
        "val": pairs[n_train : n_train + n_val],
        "test": pairs[n_train + n_val :],
    }

    kept = 0
    for split, items in splits.items():
        img_dir = DATA_DIR / "images" / split
        lbl_dir = DATA_DIR / "labels" / split
        img_dir.mkdir(parents=True, exist_ok=True)
        lbl_dir.mkdir(parents=True, exist_ok=True)
        for img, lbl in items:
            label_text = remap_label(lbl, class_map)
            if not label_text.strip():
                continue  # no labels of our classes survived the remap
            stem = f"dw_{img.stem}"
            shutil.copy2(img, img_dir / f"{stem}{img.suffix}")
            (lbl_dir / f"{stem}.txt").write_text(label_text)
            kept += 1
        print(f"{split}: {sum(1 for _ in (DATA_DIR / 'images' / split).iterdir())} images total")

    print(f"\nappended {kept} drink-waste images with remapped labels")


if __name__ == "__main__":
    main()
