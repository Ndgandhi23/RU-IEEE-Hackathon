"""Single-shot VLM scout test: three images in, one direction out.

Usage:
    python tools/test_vlm_scout.py \
        --reference path/to/ref_crop.jpg \
        --context   path/to/wider_photo.jpg \
        --live      path/to/current_view.jpg

    # measure steady-state latency over 5 calls (first call is cold start)
    python tools/test_vlm_scout.py --reference r.jpg --context c.jpg --live l.jpg --trials 5

    # if 4-bit fails to load on this CUDA/bnb combo, try without quantization
    # (will likely OOM on a 4080 — see HANDOFF.md step 2 gotchas for the 8-bit path)
    python tools/test_vlm_scout.py --reference r.jpg --context c.jpg --live l.jpg --no-4bit

First run downloads ~5 GB of Qwen3-VL weights into the transformers cache.
Cold start ~10s, steady-state ~500-1500ms per call on an RTX 4080.

Companion to tools/test_target_finder.py — same role, different model
(slow VLM scout vs. fast OWLv2 detector).
"""
from __future__ import annotations

import argparse
import statistics
import sys
import time
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from brain.perception.vlm_scout import DEFAULT_MODEL, ScoutResult, VLMScout


def load_bgr(path: Path) -> np.ndarray:
    img = cv2.imread(str(path))
    if img is None:
        print(f"failed to read image: {path}", file=sys.stderr)
        sys.exit(1)
    return img


def run_trial(
    scout: VLMScout, live: np.ndarray, reference: Path, context: Path
) -> tuple[ScoutResult, float]:
    t0 = time.monotonic()
    result = scout.scout(live, reference, context)
    elapsed = time.monotonic() - t0
    return result, elapsed


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--reference", type=Path, required=True,
                    help="tight crop of the target trash item (the reporter's photo, cropped)")
    ap.add_argument("--context", type=Path, required=True,
                    help="wider photo from the reporter showing trash + surroundings")
    ap.add_argument("--live", type=Path, required=True,
                    help="current robot forward-facing view (mock for this test)")
    ap.add_argument("--model", default=DEFAULT_MODEL, help="HuggingFace model id")
    ap.add_argument("--no-4bit", action="store_true",
                    help="disable 4-bit quantization (likely OOMs on a 4080)")
    ap.add_argument("--trials", type=int, default=1,
                    help="number of scout calls; first is cold-start, rest are steady-state")
    ap.add_argument("--max-new-tokens", type=int, default=128)
    args = ap.parse_args()
    # PowerShell doesn't expand ~ when passing args to subprocesses; do it here.
    args.reference = args.reference.expanduser()
    args.context = args.context.expanduser()
    args.live = args.live.expanduser()

    for label, p in (("reference", args.reference), ("context", args.context), ("live", args.live)):
        if not p.exists():
            print(f"{label} image not found: {p}", file=sys.stderr)
            sys.exit(1)

    # Live frame goes in as a BGR ndarray to exercise the same conversion the
    # real pipeline uses (webcam -> cv2 -> _to_pil). Reference and context stay
    # as paths since that's how the real pipeline passes them too.
    live_bgr = load_bgr(args.live)

    print(f"loading VLMScout: {args.model} (4bit={'no' if args.no_4bit else 'yes'})")
    t_load = time.monotonic()
    scout = VLMScout(
        model_name=args.model,
        load_in_4bit=not args.no_4bit,
        max_new_tokens=args.max_new_tokens,
    )
    print(f"model loaded in {time.monotonic() - t_load:.1f}s")

    timings: list[float] = []
    for i in range(args.trials):
        result, elapsed = run_trial(scout, live_bgr, args.reference, args.context)
        timings.append(elapsed)
        tag = "cold" if i == 0 else "warm"
        print(f"  trial {i+1}/{args.trials} [{tag}] {elapsed*1000:.0f}ms"
              f"  direction={result.direction}  rationale={result.rationale!r}")

    if args.trials > 1:
        warm = timings[1:] if len(timings) > 1 else timings
        print(
            f"\nlatency  cold={timings[0]*1000:.0f}ms  "
            f"warm_mean={statistics.mean(warm)*1000:.0f}ms  "
            f"warm_median={statistics.median(warm)*1000:.0f}ms  "
            f"warm_max={max(warm)*1000:.0f}ms"
        )


if __name__ == "__main__":
    main()
