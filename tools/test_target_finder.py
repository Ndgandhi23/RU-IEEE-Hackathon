"""Live OWLv2 target finder: webcam frames + a reference image → boxes.

Usage:
    python tools/test_target_finder.py --reference path/to/query.jpg
    python tools/test_target_finder.py --reference query.jpg --device 1 --min-sim 0.2
    python tools/test_target_finder.py --reference query.jpg --save-dir /tmp/out --frames 20

First run downloads the OWLv2 weights (~300 MB) from HuggingFace into the
transformers cache.

Press 'q' to quit, 's' to save the current annotated frame.
"""
from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

import math

import cv2

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from brain.io.webcam import Webcam
from brain.perception.servo import ServoCommand, no_target, servo_from_detection
from brain.perception.target_finder import TargetFinder
from brain.perception.types import Detection

_TOP_COLOR = (0, 200, 0)      # green  — best match
_OTHER_COLOR = (200, 150, 0)  # blue   — additional matches
_ARROW_COLOR = (0, 255, 255)  # yellow — servo decision
_DONE_COLOR = (0, 0, 255)     # red    — done flag


def draw_servo_decision(frame, cmd: ServoCommand, frame_w: int, frame_h: int) -> None:
    """Draw an arrow from the frame center representing the servo decision.

    Arrow direction encodes turn (horizontal component, ±MAX_TURN_RAD_S → ±1).
    Arrow length encodes forward speed.
    """
    from brain.perception.servo import MAX_FWD_M_S, MAX_TURN_RAD_S

    cx, cy = frame_w // 2, frame_h - 60
    # Map (turn, fwd) to a 2D screen vector.
    turn_norm = max(-1.0, min(1.0, cmd.turn_rad_s / MAX_TURN_RAD_S))
    fwd_norm = max(0.0, min(1.0, cmd.fwd_m_s / MAX_FWD_M_S))
    # Arrow angle from "straight up" scaled by turn. 45° at full turn.
    angle = math.radians(turn_norm * 45.0)
    length = int(40 + 120 * fwd_norm)  # 40px min, +120 for full speed
    tip_x = int(cx + length * math.sin(angle))
    tip_y = int(cy - length * math.cos(angle))

    color = _DONE_COLOR if cmd.done else _ARROW_COLOR
    cv2.arrowedLine(frame, (cx, cy), (tip_x, tip_y), color, 4, tipLength=0.25)

    # Label alongside the arrow tail.
    label1 = f"fwd {cmd.fwd_m_s:.2f} m/s"
    label2 = f"turn {cmd.turn_rad_s:+.2f} rad/s"
    label3 = "DONE" if cmd.done else ""
    cv2.putText(frame, label1, (cx + 30, cy - 10), cv2.FONT_HERSHEY_SIMPLEX, 0.6, color, 2)
    cv2.putText(frame, label2, (cx + 30, cy + 15), cv2.FONT_HERSHEY_SIMPLEX, 0.6, color, 2)
    if label3:
        cv2.putText(frame, label3, (cx - 50, cy + 40), cv2.FONT_HERSHEY_SIMPLEX, 0.8, color, 3)


def draw(frame, detections: list[Detection], cmd: ServoCommand, fps: float) -> None:
    h, w = frame.shape[:2]
    for rank, d in enumerate(detections):
        x1, y1, x2, y2 = d.xyxy
        color = _TOP_COLOR if rank == 0 else _OTHER_COLOR
        thickness = 3 if rank == 0 else 2
        cv2.rectangle(frame, (x1, y1), (x2, y2), color, thickness)
        label = f"target {d.confidence:.2f}"
        (tw, th), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.6, 2)
        cv2.rectangle(frame, (x1, y1 - th - 8), (x1 + tw + 4, y1), color, -1)
        cv2.putText(frame, label, (x1 + 2, y1 - 4), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 0), 2)

    draw_servo_decision(frame, cmd, w, h)

    top = f"best {detections[0].confidence:.2f}" if detections else "no match"
    cv2.putText(
        frame,
        f"{fps:.1f} fps  {len(detections)} det  {top}",
        (10, 30),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.8,
        (0, 255, 0),
        2,
    )


def run_interactive(cam: Webcam, finder: TargetFinder) -> None:
    last_idx = -1
    fps_window: list[float] = []
    t_prev = time.monotonic()
    saved = 0
    while True:
        frame_pkt = cam.get()
        if frame_pkt is None or frame_pkt.index == last_idx:
            if cv2.waitKey(1) & 0xFF == ord("q"):
                return
            continue
        last_idx = frame_pkt.index
        img = frame_pkt.image.copy()

        detections = finder.detect(img)
        h, w = img.shape[:2]
        cmd = servo_from_detection(detections[0], w, h) if detections else no_target()

        now = time.monotonic()
        fps_window.append(now - t_prev)
        t_prev = now
        if len(fps_window) > 30:
            fps_window.pop(0)
        fps = len(fps_window) / sum(fps_window) if fps_window else 0

        draw(img, detections, cmd, fps)
        cv2.imshow("target finder (q quit, s save)", img)
        key = cv2.waitKey(1) & 0xFF
        if key == ord("q"):
            return
        if key == ord("s"):
            out = Path(f"/tmp/target_finder_{saved:03d}.jpg")
            cv2.imwrite(str(out), img)
            print(f"saved {out}")
            saved += 1


def run_headless(
    cam: Webcam, finder: TargetFinder, save_dir: Path, frames: int, interval_s: float
) -> None:
    save_dir.mkdir(parents=True, exist_ok=True)
    print(f"saving {frames} annotated frames to {save_dir}", flush=True)
    saved = 0
    last_idx = -1
    while saved < frames:
        frame_pkt = cam.get()
        if frame_pkt is None or frame_pkt.index == last_idx:
            time.sleep(0.02)
            continue
        last_idx = frame_pkt.index
        img = frame_pkt.image.copy()
        detections = finder.detect(img)
        h, w = img.shape[:2]
        cmd = servo_from_detection(detections[0], w, h) if detections else no_target()
        draw(img, detections, cmd, 0.0)
        out = save_dir / f"target_{saved:03d}.jpg"
        cv2.imwrite(str(out), img)
        summary = (
            ", ".join(f"{d.confidence:.2f}" for d in detections) or "no match"
        )
        decision = (
            f"fwd={cmd.fwd_m_s:.2f} turn={cmd.turn_rad_s:+.2f}"
            + (" DONE" if cmd.done else "")
        )
        print(f"  {out.name}: {summary} | {decision}", flush=True)
        saved += 1
        if interval_s > 0 and saved < frames:
            time.sleep(interval_s)
    print("done", flush=True)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--reference", type=Path, required=True, help="path to the reference image (the trash to find)")
    ap.add_argument("--device", type=int, default=0, help="webcam index")
    ap.add_argument("--width", type=int, default=1280)
    ap.add_argument("--height", type=int, default=720)
    ap.add_argument("--min-sim", type=float, default=0.3, help="OWLv2 similarity threshold")
    ap.add_argument("--model", default="google/owlv2-base-patch16-ensemble", help="HuggingFace model id")
    ap.add_argument("--torch-device", default=None,
                    help="force torch device (cuda/mps/cpu); default auto-detect")
    ap.add_argument("--save-dir", type=Path, default=None,
                    help="headless: write annotated frames here instead of opening a window")
    ap.add_argument("--frames", type=int, default=10, help="headless: number of frames to save")
    ap.add_argument("--interval", type=float, default=0.5, help="headless: seconds between saved frames")
    args = ap.parse_args()
    # PowerShell doesn't expand ~ when passing args to subprocesses; do it here.
    args.reference = args.reference.expanduser()

    if not args.reference.exists():
        print(f"reference image not found: {args.reference}", file=sys.stderr)
        sys.exit(1)

    print(f"loading OWLv2: {args.model}")
    finder = TargetFinder(model_name=args.model, device=args.torch_device, min_sim=args.min_sim)
    print(f"torch device: {finder.device}")
    finder.load_reference(args.reference)
    print(f"reference loaded: {args.reference}")

    with Webcam(device=args.device, width=args.width, height=args.height) as cam:
        time.sleep(0.5)  # camera warmup
        if args.save_dir is not None:
            run_headless(cam, finder, args.save_dir, args.frames, args.interval)
        else:
            run_interactive(cam, finder)

    cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
