"""Capture the 3 reference images for the GPU-validation pipeline.

Run once on a machine with a webcam (typically the Mac, before flying the
photos to the 4080). Walks through three guided shots — ref / ctx / live —
and writes them to `references/` so a `git push` is enough to deliver
them to the 4080.

Controls inside the preview window:
    SPACE  capture the current shot
    n      skip the current shot (useful if you want to recapture later)
    q      quit
"""
from __future__ import annotations

import sys
from pathlib import Path

import cv2

REPO_ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = REPO_ROOT / "references"

# (filename, on-screen label, hint about composition)
SHOTS = [
    ("ref.jpg",  "REF",  "Tight crop of the bottle, ~30 cm, plain background"),
    ("ctx.jpg",  "CTX",  "Wider — same bottle + landmarks (bench / floor / chair)"),
    ("live.jpg", "LIVE", "Robot's-eye view: bottle from ~2 m, low angle"),
]


def main() -> int:
    OUT_DIR.mkdir(exist_ok=True)

    cap = cv2.VideoCapture(0)
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1280)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 720)
    if not cap.isOpened():
        print("could not open webcam (device 0)", file=sys.stderr)
        return 1

    idx = 0
    while idx < len(SHOTS):
        name, tag, hint = SHOTS[idx]
        ok, frame = cap.read()
        if not ok:
            continue

        annotated = frame.copy()
        h, w = annotated.shape[:2]
        cv2.rectangle(annotated, (0, 0), (w, 70), (0, 0, 0), -1)
        cv2.putText(annotated, f"[{tag}]  {hint}", (12, 30),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.75, (0, 255, 255), 2)
        cv2.putText(annotated, f"{idx + 1} / {len(SHOTS)}   "
                               f"SPACE = capture   n = skip   q = quit",
                    (12, 58), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (200, 200, 200), 1)
        cv2.imshow("capture references", annotated)

        key = cv2.waitKey(1) & 0xFF
        if key == ord("q"):
            break
        if key == ord(" "):
            out = OUT_DIR / name
            cv2.imwrite(str(out), frame)
            print(f"saved {out}")
            idx += 1
        elif key == ord("n"):
            print(f"skipped {name}")
            idx += 1

    cap.release()
    cv2.destroyAllWindows()

    captured = [s[0] for s in SHOTS if (OUT_DIR / s[0]).exists()]
    print(f"\ncaptured {len(captured)} / {len(SHOTS)} into {OUT_DIR}")
    if len(captured) == len(SHOTS):
        print("\nnext:")
        print("  git add references/")
        print("  git commit -m 'fixtures: gpu validation reference images'")
        print("  git push")
        print("\non the 4080 (after git pull):")
        print("  python tools/test_target_finder.py --reference references/ref.jpg")
        print("  python tools/test_vlm_scout.py --reference references/ref.jpg "
              "--context references/ctx.jpg --live references/live.jpg --trials 5")
        print("  python tools/test_approach.py --reference references/ref.jpg "
              "--context references/ctx.jpg")
    return 0


if __name__ == "__main__":
    sys.exit(main())
