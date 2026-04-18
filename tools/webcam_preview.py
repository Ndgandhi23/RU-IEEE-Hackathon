"""Live webcam preview. Run on Mac (builtin cam) or Jetson (C270 via USB).

Usage:
    python tools/webcam_preview.py              # device 0
    python tools/webcam_preview.py --device 1   # pick another camera
"""
from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

import cv2

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from jetson.io.webcam import Webcam


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--device", type=int, default=0)
    ap.add_argument("--width", type=int, default=1280)
    ap.add_argument("--height", type=int, default=720)
    args = ap.parse_args()

    with Webcam(device=args.device, width=args.width, height=args.height) as cam:
        last_idx = -1
        fps_window = []
        t_prev = time.monotonic()
        while True:
            frame = cam.get()
            if frame is None or frame.index == last_idx:
                if cv2.waitKey(1) & 0xFF == ord("q"):
                    break
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
                break

    cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
