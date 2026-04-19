"""Per-frame diagnostic for the committed references/feed/ sequence.

Runs the current OWLv2 TargetFinder + ApproachController on every frame
in references/feed/ (sorted order). Prints one line per frame with:
Action, top detection confidence + bbox, bbox-area fraction of the frame,
total detection count.

Two ways to use it:

  1. From an existing notebook kernel where finder + controller are loaded:

         from tools.feed_diagnostic import run_diagnostic
         run_diagnostic(finder, controller)

  2. As a standalone script (loads everything fresh — slow cold start):

         python tools/feed_diagnostic.py
"""
from __future__ import annotations

import sys
from pathlib import Path

import cv2

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))


def run_diagnostic(finder, controller, feed_dir: Path = REPO / "references" / "feed") -> None:
    frames = sorted(feed_dir.glob("*.jpg"))
    print(f"found {len(frames)} frames at {feed_dir}\n")
    if not frames:
        print("no frames — add photos to references/feed/ and commit")
        return
    for p in frames:
        frame = cv2.imread(str(p))
        if frame is None:
            print(f"{p.name}: could not read")
            continue
        dets = finder.detect(frame)
        h, w = frame.shape[:2]
        action = controller.step(frame)
        if dets:
            d = dets[0]
            x1, y1, x2, y2 = d.xyxy
            frac = ((x2 - x1) * (y2 - y1)) / (w * h)
            print(f"{p.name}: {action.name:<14} "
                  f"top_conf={d.confidence:.2f}  bbox={d.xyxy}  "
                  f"frame={w}x{h}  frac={frac:.2%}  n_dets={len(dets)}")
        else:
            print(f"{p.name}: {action.name:<14} no detections")


def _main() -> None:
    from brain.control.loop import ApproachController
    from brain.perception.target_finder import TargetFinder
    from brain.perception.vlm_scout import VLMScout

    REF = REPO / "references" / "ref.jpg"
    CTX = REPO / "references" / "ctx.jpg"

    print("loading OWLv2...")
    finder = TargetFinder(model_name="google/owlv2-base-patch16-ensemble", min_sim=0.3)
    finder.load_reference(cv2.imread(str(REF)))

    print("loading Qwen3-VL (this is slow on first run)...")
    scout = VLMScout(load_in_4bit=True)

    controller = ApproachController(
        target_finder=finder,
        vlm_scout=scout,
        reference_photo=str(REF),
        reporter_photo=str(CTX),
    )

    run_diagnostic(finder, controller)


if __name__ == "__main__":
    _main()
