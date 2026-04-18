"""One-command live demo.

Usage:
    python demo.py                    # opens default webcam, uses models/trash_v1.pt
    python demo.py --device 1         # different camera
    python demo.py --weights foo.pt   # different weights

Wraps tools/live_detect.py with sensible defaults so a fresh checkout can demo without arg-hunting.
"""
from __future__ import annotations

import os
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
    subprocess.run([sys.executable, str(ROOT / "tools" / "live_detect.py"), *args], check=True)


if __name__ == "__main__":
    main()
