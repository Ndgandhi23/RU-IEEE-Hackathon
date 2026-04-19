"""End-to-end brain validation on a webcam: no Pi, no motors.

Wires YoloFinder (trash_v1.pt) + VLMScout (Qwen3-VL) + ApproachController
into the same decision loop the robot will use. Prints the discrete Action for
each frame, overlays the action + controller phase on the webcam preview, and
color-codes the frame border so you can eyeball what the controller is
deciding from across the room.

Usage:
    python tools/test_approach.py --reference ref_crop.jpg --context wider.jpg

    # disable 4-bit if bnb/CUDA is misbehaving on your box (may OOM on a 4080)
    python tools/test_approach.py --reference r.jpg --context c.jpg --no-4bit

    # headless: save N annotated frames and print each decision
    python tools/test_approach.py --reference r.jpg --context c.jpg \
        --save-dir /tmp/approach --frames 30 --interval 0.5

First run downloads Qwen3-VL-8B from HuggingFace.

Press "q" to quit, "s" to save the current annotated frame.
"""
from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

import cv2

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from brain.control.loop import Action, ApproachController
from brain.io.webcam import Webcam
from brain.perception.types import Detection
from brain.perception.vlm_scout import DEFAULT_MODEL as VLM_DEFAULT, VLMScout
from brain.perception.yolo_finder import YoloFinder

# BGR tuples
_COLOR_FORWARD = (0, 220, 0)
_COLOR_TURN = (0, 220, 220)
_COLOR_STOP = (0, 0, 220)
_COLOR_SEARCH = (220, 0, 220)
_COLOR_BBOX = (255, 255, 0)

_ACTION_COLOR: dict[Action, tuple[int, int, int]] = {
    Action.FORWARD: _COLOR_FORWARD,
    Action.LEFT: _COLOR_TURN,
    Action.RIGHT: _COLOR_TURN,
    Action.STOP: _COLOR_STOP,
    Action.SEARCH_LEFT: _COLOR_SEARCH,
    Action.SEARCH_RIGHT: _COLOR_SEARCH,
    Action.SCOOP_FORWARD: (255, 140, 0),
    Action.BACKUP: (120, 120, 255),
}


def draw(
    frame,
    phase: str,
    action: Action,
    top_detection: Detection | None,
    fps: float,
    yolo_ms: float,
) -> None:
    h, w = frame.shape[:2]
    color = _ACTION_COLOR[action]

    cv2.rectangle(frame, (0, 0), (w - 1, h - 1), color, 12)

    if top_detection is not None:
        x1, y1, x2, y2 = top_detection.xyxy
        cv2.rectangle(frame, (x1, y1), (x2, y2), _COLOR_BBOX, 2)
        label = f"{top_detection.class_name} {top_detection.confidence:.2f}"
        (tw, th), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.55, 2)
        cv2.rectangle(frame, (x1, y1 - th - 6), (x1 + tw + 4, y1), _COLOR_BBOX, -1)
        cv2.putText(
            frame,
            label,
            (x1 + 2, y1 - 3),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.55,
            (0, 0, 0),
            2,
        )

    text = action.name
    (tw, th), _ = cv2.getTextSize(text, cv2.FONT_HERSHEY_SIMPLEX, 1.4, 3)
    tx = (w - tw) // 2
    ty = th + 28
    cv2.rectangle(frame, (tx - 12, ty - th - 12), (tx + tw + 12, ty + 12), (0, 0, 0), -1)
    cv2.putText(frame, text, (tx, ty), cv2.FONT_HERSHEY_SIMPLEX, 1.4, color, 3)

    cv2.putText(
        frame,
        f"phase: {phase}",
        (10, 32),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.7,
        color,
        2,
    )

    hud = f"{fps:.1f} fps  yolo {yolo_ms:.0f}ms"
    cv2.putText(frame, hud, (10, h - 14), cv2.FONT_HERSHEY_SIMPLEX, 0.6, color, 2)


def run_interactive(cam: Webcam, controller: ApproachController, finder: YoloFinder) -> None:
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

        t0 = time.monotonic()
        detections = finder.detect(img)
        yolo_ms = (time.monotonic() - t0) * 1000
        action = controller.step(frame_pkt.image)

        now = time.monotonic()
        fps_window.append(now - t_prev)
        t_prev = now
        if len(fps_window) > 30:
            fps_window.pop(0)
        fps = len(fps_window) / sum(fps_window) if fps_window else 0

        top = detections[0] if detections else None
        draw(img, controller.phase.value, action, top, fps, yolo_ms)
        cv2.imshow("approach controller (q quit, s save)", img)
        conf_str = f"{top.confidence:.2f}" if top is not None else "none"
        print(
            f"  frame {last_idx}  phase={controller.phase.value}  "
            f"action={action.name}  top={conf_str}",
            flush=True,
        )

        key = cv2.waitKey(1) & 0xFF
        if key == ord("q"):
            return
        if key == ord("s"):
            out = Path(f"/tmp/approach_{saved:03d}.jpg")
            cv2.imwrite(str(out), img)
            print(f"saved {out}")
            saved += 1


def run_headless(
    cam: Webcam,
    controller: ApproachController,
    finder: YoloFinder,
    save_dir: Path,
    frames: int,
    interval_s: float,
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

        t0 = time.monotonic()
        detections = finder.detect(img)
        yolo_ms = (time.monotonic() - t0) * 1000
        action = controller.step(frame_pkt.image)
        top = detections[0] if detections else None

        draw(img, controller.phase.value, action, top, 0.0, yolo_ms)
        out = save_dir / f"approach_{saved:03d}.jpg"
        cv2.imwrite(str(out), img)
        conf = f"{top.confidence:.2f}" if top else "none"
        print(
            f"  {out.name}: phase={controller.phase.value} action={action.name} "
            f"top={conf} yolo={yolo_ms:.0f}ms",
            flush=True,
        )
        saved += 1
        if interval_s > 0 and saved < frames:
            time.sleep(interval_s)
    print("done", flush=True)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--reference", type=Path, required=True, help="tight crop of the target")
    ap.add_argument("--context", type=Path, required=True, help="wider reporter photo")
    ap.add_argument("--device", type=int, default=0, help="webcam index")
    ap.add_argument("--width", type=int, default=1280)
    ap.add_argument("--height", type=int, default=720)
    ap.add_argument("--min-sim", type=float, default=0.5, help="YOLO confidence floor")
    ap.add_argument(
        "--yolo-weights",
        type=Path,
        default=Path("models/trash_v1.pt"),
        help="path to YOLO weights",
    )
    ap.add_argument("--vlm-model", default=VLM_DEFAULT)
    ap.add_argument(
        "--no-4bit",
        action="store_true",
        help="disable Qwen3-VL 4-bit quant (likely OOMs on a 4080 at fp16)",
    )
    ap.add_argument(
        "--save-dir",
        type=Path,
        default=None,
        help="headless: write annotated frames here instead of opening a window",
    )
    ap.add_argument("--frames", type=int, default=10, help="headless: number of frames to save")
    ap.add_argument("--interval", type=float, default=0.5, help="headless: seconds between frames")
    args = ap.parse_args()

    args.reference = args.reference.expanduser()
    args.context = args.context.expanduser()

    for label, path in (("reference", args.reference), ("context", args.context)):
        if not path.exists():
            print(f"{label} image not found: {path}", file=sys.stderr)
            sys.exit(1)

    print(f"loading YOLO: {args.yolo_weights}")
    finder = YoloFinder(weights=args.yolo_weights, min_conf=args.min_sim)

    print(f"loading VLMScout: {args.vlm_model} (4bit={'no' if args.no_4bit else 'yes'})")
    t_load = time.monotonic()
    scout = VLMScout(model_name=args.vlm_model, load_in_4bit=not args.no_4bit)
    print(f"  model loaded in {time.monotonic() - t_load:.1f}s")

    controller = ApproachController(
        target_finder=finder,
        vlm_scout=scout,
        reference_photo=str(args.reference),
        reporter_photo=str(args.context),
    )

    with Webcam(device=args.device, width=args.width, height=args.height) as cam:
        time.sleep(0.5)
        if args.save_dir is not None:
            run_headless(cam, controller, finder, args.save_dir, args.frames, args.interval)
        else:
            run_interactive(cam, controller, finder)

    cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
