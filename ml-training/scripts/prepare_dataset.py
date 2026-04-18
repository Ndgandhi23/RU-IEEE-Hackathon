"""Download TACO and convert to YOLO format under data/{images,labels}/{train,val,test}."""
from __future__ import annotations

import argparse
import json
import random
import shutil
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import requests
from tqdm import tqdm

ANNOTATIONS_URL = "https://raw.githubusercontent.com/pedropro/TACO/master/data/annotations.json"

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
TACO_DIR = DATA_DIR / "taco"

SUPERCAT_TO_CLASS: dict[str, int] = {
    "Bottle": 0,
    "Cup": 1,
    "Can": 2,
    "Plastic bag & wrapper": 3,
    "Paper": 4,
    "Paper bag": 4,
    "Carton": 4,
}

EXCLUDED_NAME_SUBSTRINGS = ("glass", "cap", "lid", "straw")

TRAIN_FRAC, VAL_FRAC = 0.7, 0.2
SEED = 42


def download_file(url: str, dest: Path) -> bool:
    if dest.exists() and dest.stat().st_size > 0:
        return True
    dest.parent.mkdir(parents=True, exist_ok=True)
    try:
        r = requests.get(url, timeout=30)
        r.raise_for_status()
        dest.write_bytes(r.content)
        return True
    except Exception:
        return False


def download_images(images: list[dict]) -> list[dict]:
    ok: list[dict] = []
    with ThreadPoolExecutor(max_workers=16) as ex:
        futures = {}
        for img in images:
            url = img.get("flickr_640_url") or img.get("flickr_url")
            if not url:
                continue
            dest = TACO_DIR / "images" / img["file_name"]
            futures[ex.submit(download_file, url, dest)] = img
        for fut in tqdm(as_completed(futures), total=len(futures), desc="downloading TACO"):
            if fut.result():
                ok.append(futures[fut])
    return ok


def coco_to_yolo(bbox: list[float], img_w: int, img_h: int) -> tuple[float, float, float, float]:
    x, y, w, h = bbox
    return (x + w / 2) / img_w, (y + h / 2) / img_h, w / img_w, h / img_h


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0, help="cap images (0 = no cap). Useful for smoke tests.")
    args = ap.parse_args()

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    TACO_DIR.mkdir(parents=True, exist_ok=True)

    ann_path = TACO_DIR / "annotations.json"
    if not ann_path.exists():
        print("downloading annotations.json...")
        r = requests.get(ANNOTATIONS_URL, timeout=60)
        r.raise_for_status()
        ann_path.write_bytes(r.content)

    annotations = json.loads(ann_path.read_text())

    cat_map: dict[int, int] = {}
    for cat in annotations["categories"]:
        name_lower = cat["name"].lower()
        if any(sub in name_lower for sub in EXCLUDED_NAME_SUBSTRINGS):
            continue
        supercat = cat.get("supercategory", "")
        if supercat in SUPERCAT_TO_CLASS:
            cat_map[cat["id"]] = SUPERCAT_TO_CLASS[supercat]

    kept_anns = [a for a in annotations["annotations"] if a["category_id"] in cat_map]
    kept_image_ids = {a["image_id"] for a in kept_anns}
    kept_images = [i for i in annotations["images"] if i["id"] in kept_image_ids]

    print(f"TACO: {len(annotations['images'])} total, {len(kept_images)} with our classes, {len(kept_anns)} boxes")

    if args.limit > 0:
        random.Random(SEED).shuffle(kept_images)
        kept_images = kept_images[: args.limit]
        kept_ids = {i["id"] for i in kept_images}
        kept_anns = [a for a in kept_anns if a["image_id"] in kept_ids]
        print(f"limit={args.limit}: using {len(kept_images)} images")

    kept_images = download_images(kept_images)
    downloaded_ids = {i["id"] for i in kept_images}
    kept_anns = [a for a in kept_anns if a["image_id"] in downloaded_ids]

    random.Random(SEED).shuffle(kept_images)
    n = len(kept_images)
    n_train, n_val = int(n * TRAIN_FRAC), int(n * VAL_FRAC)
    splits = {
        "train": kept_images[:n_train],
        "val": kept_images[n_train : n_train + n_val],
        "test": kept_images[n_train + n_val :],
    }

    anns_by_image: dict[int, list[dict]] = {}
    for a in kept_anns:
        anns_by_image.setdefault(a["image_id"], []).append(a)

    for split, imgs in splits.items():
        img_dir = DATA_DIR / "images" / split
        lbl_dir = DATA_DIR / "labels" / split
        img_dir.mkdir(parents=True, exist_ok=True)
        lbl_dir.mkdir(parents=True, exist_ok=True)
        for img in imgs:
            src = TACO_DIR / "images" / img["file_name"]
            if not src.exists():
                continue
            flat = img["file_name"].replace("/", "_")
            stem, ext = Path(flat).stem, Path(flat).suffix
            shutil.copy2(src, img_dir / f"{stem}{ext}")
            lines = []
            for a in anns_by_image.get(img["id"], []):
                cls = cat_map[a["category_id"]]
                cx, cy, w, h = coco_to_yolo(a["bbox"], img["width"], img["height"])
                if w <= 0 or h <= 0:
                    continue
                lines.append(f"{cls} {cx:.6f} {cy:.6f} {w:.6f} {h:.6f}")
            (lbl_dir / f"{stem}.txt").write_text("\n".join(lines) + ("\n" if lines else ""))
        print(f"{split}: {len(imgs)} images")

    print(f"\ndataset ready at {DATA_DIR}")
    print("next: python scripts/train.py")


if __name__ == "__main__":
    main()
