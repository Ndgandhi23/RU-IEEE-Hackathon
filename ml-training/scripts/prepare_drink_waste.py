"""Download the Kaggle 'arkadiyhacks/drinking-waste-classification' dataset and append to our YOLO splits.

Requires kaggle CLI auth: either ~/.kaggle/kaggle.json or KAGGLE_USERNAME + KAGGLE_KEY env.

The dataset ships 4 classes (index order defined by the dataset):
  0: ACan         -> our class 2 (can)
  1: Glass bottle -> DROPPED (no glass per CLAUDE.md)
  2: HDPE-M       -> our class 0 (bottle)
  3: PET          -> our class 0 (bottle)
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

SOURCE_CLASSES: list[str] = ["ACan", "Glass bottle", "HDPE-M", "PET"]
CLASS_MAP: dict[int, int | None] = {0: 2, 1: None, 2: 0, 3: 0}

TRAIN_FRAC, VAL_FRAC = 0.7, 0.2
SEED = 42


def ensure_downloaded() -> Path:
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    has_images = any(p.suffix.lower() in (".jpg", ".jpeg", ".png") for p in RAW_DIR.rglob("*") if p.is_file())
    if has_images:
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


def print_tree(root: Path, max_depth: int = 3) -> None:
    print(f"\ntree of {root} (depth={max_depth}):")
    for p in sorted(root.rglob("*")):
        depth = len(p.relative_to(root).parts)
        if depth > max_depth:
            continue
        indent = "  " * (depth - 1)
        print(f"{indent}{p.name}{'/' if p.is_dir() else ''}")


def find_image_label_pairs(root: Path) -> list[tuple[Path, Path]]:
    """Pair each image with its label (.txt with same stem, same dir first, else anywhere under root)."""
    txts_by_stem: dict[str, list[Path]] = {}
    for txt in root.rglob("*.txt"):
        txts_by_stem.setdefault(txt.stem, []).append(txt)

    pairs: list[tuple[Path, Path]] = []
    for img in root.rglob("*"):
        if not img.is_file() or img.suffix.lower() not in (".jpg", ".jpeg", ".png"):
            continue
        sibling = img.with_suffix(".txt")
        if sibling.exists():
            pairs.append((img, sibling))
            continue
        candidates = txts_by_stem.get(img.stem, [])
        if candidates:
            pairs.append((img, candidates[0]))
    return pairs


def remap_label(src_label: Path) -> str:
    out = []
    for line in src_label.read_text().splitlines():
        parts = line.strip().split()
        if len(parts) != 5:
            continue
        try:
            src_cls = int(parts[0])
        except ValueError:
            continue
        dst = CLASS_MAP.get(src_cls)
        if dst is None:
            continue
        out.append(f"{dst} {parts[1]} {parts[2]} {parts[3]} {parts[4]}")
    return "\n".join(out) + ("\n" if out else "")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args()

    ensure_downloaded()
    print(f"source classes (hardcoded): {SOURCE_CLASSES}")
    print(f"remap: {CLASS_MAP}  (None = dropped)")

    pairs = find_image_label_pairs(RAW_DIR)
    print(f"found {len(pairs)} image+label pairs")
    if not pairs:
        print_tree(RAW_DIR, max_depth=3)
        raise SystemExit("no image+label pairs found — inspect tree above and update the script")

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
            label_text = remap_label(lbl)
            if not label_text.strip():
                continue
            stem = f"dw_{img.stem}"
            shutil.copy2(img, img_dir / f"{stem}{img.suffix}")
            (lbl_dir / f"{stem}.txt").write_text(label_text)
            kept += 1
        total = sum(1 for _ in (DATA_DIR / "images" / split).iterdir())
        print(f"{split}: {total} images total")

    print(f"\nappended {kept} drink-waste images with remapped labels")


if __name__ == "__main__":
    main()
