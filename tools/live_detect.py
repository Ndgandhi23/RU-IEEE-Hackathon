"""Live trash detection: webcam frames through the trained YOLO model, boxes drawn on screen.

Usage:
    python tools/live_detect.py --weights path/to/trash_v1_best.pt
    python tools/live_detect.py --weights best.pt --device 1 --conf 0.35 --imgsz 640

Press 'q' to quit, 's' to save the current frame to /tmp/.
"""
from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

import cv2

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from brain.io.webcam import Webcam
from brain.perception.detector import Detection, Detector

# Per-class BGR colors, keyed on class id. Stable ordering across frames.
_COLORS = [
    (0, 200, 0),     # bottle  — green
    (0, 200, 255),   # cup     — yellow
    (255, 150, 0),   # can     — blue
    (255, 0, 200),   # wrapper — magenta
    (200, 200, 200), # paper   — light gray
]


def draw(frame, detections: list[Detection], fps: float) -> None:
    for d in detections:
        x1, y1, x2, y2 = d.xyxy
        color = _COLORS[d.class_id % len(_COLORS)]
        cv2.rectangle(frame, (x1, y1), (x2, y2), color, 2)
        label = f"{d.class_name} {d.confidence:.2f}"
        (tw, th), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.6, 2)
        cv2.rectangle(frame, (x1, y1 - th - 8), (x1 + tw + 4, y1), color, -1)
        cv2.putText(frame, label, (x1 + 2, y1 - 4), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 0), 2)
    cv2.putText(frame, f"{fps:.1f} fps  {len(detections)} det",
                (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 255, 0), 2)


def run_interactive(cam: Webcam, detector: Detector) -> None:
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

        detections = detector.detect(img)

        now = time.monotonic()
        fps_window.append(now - t_prev)
        t_prev = now
        if len(fps_window) > 30:
            fps_window.pop(0)
        fps = len(fps_window) / sum(fps_window) if fps_window else 0

        draw(img, detections, fps)
        cv2.imshow("live detect (q quit, s save)", img)
        key = cv2.waitKey(1) & 0xFF
        if key == ord("q"):
            return
        if key == ord("s"):
            out = Path(f"/tmp/live_detect_{saved:03d}.jpg")
            cv2.imwrite(str(out), img)
            print(f"saved {out}")
            saved += 1


def run_headless(cam: Webcam, detector: Detector, save_dir: Path, frames: int, interval_s: float) -> None:
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
        detections = detector.detect(img)
        draw(img, detections, 0.0)
        out = save_dir / f"detect_{saved:03d}.jpg"
        cv2.imwrite(str(out), img)
        summary = ", ".join(f"{d.class_name}({d.confidence:.2f})" for d in detections) or "no detections"
        print(f"  {out.name}: {summary}", flush=True)
        saved += 1
        if interval_s > 0 and saved < frames:
            time.sleep(interval_s)
    print("done", flush=True)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--weights", required=True, help="path to trained .pt / .onnx / .engine")
    ap.add_argument("--device", type=int, default=0, help="webcam index")
    ap.add_argument("--width", type=int, default=1280)
    ap.add_argument("--height", type=int, default=720)
    ap.add_argument("--conf", type=float, default=0.25)
    ap.add_argument("--imgsz", type=int, default=640, help="YOLO inference size")
    ap.add_argument("--save-dir", type=Path, default=None,
                    help="headless: write annotated frames here instead of opening a window")
    ap.add_argument("--frames", type=int, default=10, help="headless: number of frames to save")
    ap.add_argument("--interval", type=float, default=0.5,
                    help="headless: seconds between saved frames")
    args = ap.parse_args()

    print(f"loading model: {args.weights}")
    detector = Detector(args.weights, conf=args.conf, imgsz=args.imgsz)
    print(f"classes: {detector.names}")

    with Webcam(device=args.device, width=args.width, height=args.height) as cam:
        time.sleep(0.5)  # camera warmup
        if args.save_dir is not None:
            run_headless(cam, detector, args.save_dir, args.frames, args.interval)
        else:
            run_interactive(cam, detector)

    cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
