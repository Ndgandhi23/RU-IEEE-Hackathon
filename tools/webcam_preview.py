"""Webcam preview. Run on Mac (builtin cam) or Jetson (C270 via USB).

Two modes:
- Interactive (default): live preview window, requires a display (`cv2.imshow`).
- Headless (--save-dir): save N frames to disk, no display needed. Useful over SSH.

Examples:
    python tools/webcam_preview.py                           # live preview
    python tools/webcam_preview.py --device 1                # pick another camera
    python tools/webcam_preview.py --save-dir /tmp/frames --frames 10    # headless
"""
from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

import cv2

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from jetson.io.webcam import Webcam


def run_interactive(cam: Webcam) -> None:
    last_idx = -1
    fps_window: list[float] = []
    t_prev = time.monotonic()
    while True:
        frame = cam.get()
        if frame is None or frame.index == last_idx:
            if cv2.waitKey(1) & 0xFF == ord("q"):
                return
            continue
        last_idx = frame.index
        now = time.monotonic()
        fps_window.append(now - t_prev)
        t_prev = now
        if len(fps_window) > 30:
            fps_window.pop(0)
        fps = len(fps_window) / sum(fps_window) if fps_window else 0

        img = frame.image.copy()
        cv2.putText(img, f"{fps:.1f} fps  #{frame.index}", (10, 30),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 255, 0), 2)
        cv2.imshow("webcam (q to quit)", img)
        if cv2.waitKey(1) & 0xFF == ord("q"):
            return


def run_headless(cam: Webcam, save_dir: Path, frames: int, interval_s: float) -> None:
    save_dir.mkdir(parents=True, exist_ok=True)
    print(f"saving {frames} frames to {save_dir}", flush=True)
    saved = 0
    last_idx = -1
    while saved < frames:
        frame = cam.get()
        if frame is None or frame.index == last_idx:
            time.sleep(0.02)
            continue
        last_idx = frame.index
        out = save_dir / f"frame_{saved:03d}.jpg"
        cv2.imwrite(str(out), frame.image)
        print(f"  {out.name}  #{frame.index}  {frame.image.shape[1]}x{frame.image.shape[0]}", flush=True)
        saved += 1
        if interval_s > 0 and saved < frames:
            time.sleep(interval_s)
    print("done", flush=True)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--device", type=int, default=0)
    ap.add_argument("--width", type=int, default=1280)
    ap.add_argument("--height", type=int, default=720)
    ap.add_argument("--save-dir", type=Path, default=None,
                    help="headless: write frames here instead of opening a window")
    ap.add_argument("--frames", type=int, default=10, help="headless: number of frames to save")
    ap.add_argument("--interval", type=float, default=0.5,
                    help="headless: seconds between saved frames")
    args = ap.parse_args()

    with Webcam(device=args.device, width=args.width, height=args.height) as cam:
        # Give the camera a moment to warm up.
        time.sleep(0.5)
        if args.save_dir is not None:
            run_headless(cam, args.save_dir, args.frames, args.interval)
        else:
            run_interactive(cam)

    cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
