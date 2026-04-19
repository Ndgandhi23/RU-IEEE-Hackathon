"""One-command live demo.

Usage:
    python demo.py                                        # pulls http://127.0.0.1:8080/stream.mjpg
    python demo.py --url http://<pi-ip>:8080/stream.mjpg  # real Pi
    python demo.py --weights foo.pt                       # different weights
    python demo.py --save-dir debug_frames                # dump received frames for debugging

No local webcam is opened. Frames come from the Pi (or the Pi simulator
running on this machine — see pi/camera_streamer). Wraps
connector/run_classifier.py with sensible defaults.
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DEFAULT_WEIGHTS = ROOT / "models" / "trash_v1.pt"


def main() -> None:
    args = sys.argv[1:]
    if "--weights" not in args:
        if not DEFAULT_WEIGHTS.exists():
            print(f"error: {DEFAULT_WEIGHTS} missing. Download trash_v1_best.pt from the training run's Drive folder and save it as models/trash_v1.pt.", file=sys.stderr)
            sys.exit(1)
        args = ["--weights", str(DEFAULT_WEIGHTS), *args]
    subprocess.run(
        [sys.executable, "-m", "connector.run_classifier", *args],
        check=True,
        cwd=str(ROOT),
    )


if __name__ == "__main__":
    main()
