"""Live ML demo for Butters: reference photo in, live webcam feed out with overlays.

Run one command. A window pops up showing your laptop webcam with the model's
bounding boxes, the current action, and the reference photo pinned in the
corner so the audience sees what the robot is "looking for." Move the laptop
around; the overlay reacts as if you were the robot.

Usage:
    python tools/demo_ml.py
    python tools/demo_ml.py --reference references/ref.jpg
    python tools/demo_ml.py --no-4bit        # if bnb/CUDA is unhappy

Press "q" to quit, "s" to save the current annotated frame to /tmp.
"""
from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from brain.control.loop import Action, ApproachController
from brain.io.webcam import Webcam
from brain.perception.types import Detection
from brain.perception.yolo_finder import YoloFinder


class _StubVLMScout:
    """Drop-in VLM stub so the demo runs on a laptop without loading Qwen3-VL.

    The real scout only runs during the SEARCHING phase to decide whether to
    pan left or right when YOLO sees nothing. For a laptop demo where the user
    is waving the camera at real objects, YOLO carries the show; we just need
    something callable that returns a valid direction.
    """

    def __init__(self) -> None:
        from brain.perception.vlm_scout import ScoutResult

        self._result_cls = ScoutResult
        self._toggle = False

    def scout(self, frame, reference_photo, reporter_photo):
        self._toggle = not self._toggle
        direction = "right" if self._toggle else "left"
        return self._result_cls(direction=direction, rationale="stub (yolo-only mode)")

REPO = Path(__file__).resolve().parent.parent
DEFAULT_REF = REPO / "references" / "ref.jpg"
DEFAULT_CTX = REPO / "references" / "ctx.jpg"

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

_ACTION_HINT: dict[Action, str] = {
    Action.FORWARD: "move laptop forward",
    Action.LEFT: "rotate laptop left",
    Action.RIGHT: "rotate laptop right",
    Action.STOP: "hold still",
    Action.SEARCH_LEFT: "scanning left",
    Action.SEARCH_RIGHT: "scanning right",
    Action.SCOOP_FORWARD: "scoop forward",
    Action.BACKUP: "back up",
}


def _fit_thumb(img: np.ndarray, max_side: int) -> np.ndarray:
    h, w = img.shape[:2]
    scale = max_side / max(h, w)
    if scale >= 1.0:
        return img
    return cv2.resize(img, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)


def overlay(
    frame: np.ndarray,
    ref_thumb: np.ndarray,
    phase: str,
    action: Action,
    top_detection: Detection | None,
    fps: float,
) -> None:
    h, w = frame.shape[:2]
    color = _ACTION_COLOR[action]

    cv2.rectangle(frame, (0, 0), (w - 1, h - 1), color, 14)

    if top_detection is not None:
        x1, y1, x2, y2 = top_detection.xyxy
        cv2.rectangle(frame, (x1, y1), (x2, y2), _COLOR_BBOX, 3)
        label = f"{top_detection.class_name} {top_detection.confidence:.2f}"
        (tw, th), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.6, 2)
        cv2.rectangle(frame, (x1, y1 - th - 8), (x1 + tw + 6, y1), _COLOR_BBOX, -1)
        cv2.putText(
            frame,
            label,
            (x1 + 3, y1 - 4),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.6,
            (0, 0, 0),
            2,
        )

    # Big centered action label
    text = action.name
    (tw, th), _ = cv2.getTextSize(text, cv2.FONT_HERSHEY_SIMPLEX, 2.0, 4)
    tx = (w - tw) // 2
    ty = th + 40
    cv2.rectangle(frame, (tx - 18, ty - th - 18), (tx + tw + 18, ty + 18), (0, 0, 0), -1)
    cv2.putText(frame, text, (tx, ty), cv2.FONT_HERSHEY_SIMPLEX, 2.0, color, 4)

    # Hint under the action
    hint = _ACTION_HINT[action]
    (hw, hh), _ = cv2.getTextSize(hint, cv2.FONT_HERSHEY_SIMPLEX, 0.7, 2)
    hx = (w - hw) // 2
    hy = ty + hh + 22
    cv2.putText(frame, hint, (hx, hy), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 255), 2)

    # Phase and FPS
    cv2.putText(frame, f"phase: {phase}", (16, 40), cv2.FONT_HERSHEY_SIMPLEX, 0.8, color, 2)
    cv2.putText(frame, f"{fps:.1f} fps", (16, h - 18), cv2.FONT_HERSHEY_SIMPLEX, 0.7, color, 2)

    # Reference thumbnail, bottom-right
    th_h, th_w = ref_thumb.shape[:2]
    pad = 16
    x0 = w - th_w - pad
    y0 = h - th_h - pad
    cv2.rectangle(frame, (x0 - 4, y0 - 4), (x0 + th_w + 4, y0 + th_h + 4), (255, 255, 255), 2)
    frame[y0 : y0 + th_h, x0 : x0 + th_w] = ref_thumb
    cv2.putText(
        frame,
        "target",
        (x0, y0 - 10),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.6,
        (255, 255, 255),
        2,
    )


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--reference", type=Path, default=DEFAULT_REF, help="tight crop of the target")
    ap.add_argument("--context", type=Path, default=DEFAULT_CTX, help="wider reporter photo")
    ap.add_argument("--device", type=int, default=0, help="webcam index")
    ap.add_argument("--width", type=int, default=1280)
    ap.add_argument("--height", type=int, default=720)
    ap.add_argument(
        "--yolo-weights",
        type=Path,
        default=REPO / "models" / "trash_v1.pt",
        help="path to YOLO weights",
    )
    ap.add_argument("--min-conf", type=float, default=0.5, help="YOLO confidence floor")
    ap.add_argument(
        "--yolo-only",
        action="store_true",
        help="skip Qwen3-VL (use a stub). Needed on Macs — no CUDA/bitsandbytes.",
    )
    ap.add_argument("--vlm-model", default=None, help="HF model id; ignored with --yolo-only")
    ap.add_argument("--no-4bit", action="store_true", help="disable Qwen3-VL 4-bit quant")
    args = ap.parse_args()

    for label, path in (("reference", args.reference), ("context", args.context)):
        if not path.exists():
            print(f"{label} image not found: {path}", file=sys.stderr)
            sys.exit(1)

    ref_img = cv2.imread(str(args.reference))
    if ref_img is None:
        print(f"failed to load reference image: {args.reference}", file=sys.stderr)
        sys.exit(1)
    ref_thumb = _fit_thumb(ref_img, max_side=200)

    print(f"loading YOLO: {args.yolo_weights}")
    finder = YoloFinder(weights=args.yolo_weights, min_conf=args.min_conf)

    if args.yolo_only:
        print("yolo-only mode: skipping Qwen3-VL, using stub scout")
        scout = _StubVLMScout()
    else:
        from brain.perception.vlm_scout import DEFAULT_MODEL as VLM_DEFAULT, VLMScout

        model_name = args.vlm_model or VLM_DEFAULT
        print(f"loading VLMScout: {model_name} (4bit={'no' if args.no_4bit else 'yes'})")
        t_load = time.monotonic()
        scout = VLMScout(model_name=model_name, load_in_4bit=not args.no_4bit)
        print(f"  loaded in {time.monotonic() - t_load:.1f}s")

    controller = ApproachController(
        target_finder=finder,
        vlm_scout=scout,
        reference_photo=str(args.reference),
        reporter_photo=str(args.context),
    )

    window = "Butters ML demo (q quit, s save)"
    cv2.namedWindow(window, cv2.WINDOW_NORMAL)
    cv2.resizeWindow(window, args.width, args.height)

    saved = 0
    last_idx = -1
    fps_window: list[float] = []
    t_prev = time.monotonic()

    with Webcam(device=args.device, width=args.width, height=args.height) as cam:
        time.sleep(0.5)
        while True:
            frame_pkt = cam.get()
            if frame_pkt is None or frame_pkt.index == last_idx:
                if cv2.waitKey(1) & 0xFF == ord("q"):
                    break
                continue
            last_idx = frame_pkt.index
            img = frame_pkt.image.copy()

            detections = finder.detect(img)
            action = controller.step(frame_pkt.image)

            now = time.monotonic()
            fps_window.append(now - t_prev)
            t_prev = now
            if len(fps_window) > 30:
                fps_window.pop(0)
            fps = len(fps_window) / sum(fps_window) if fps_window else 0.0

            top = detections[0] if detections else None
            overlay(img, ref_thumb, controller.phase.value, action, top, fps)
            cv2.imshow(window, img)

            key = cv2.waitKey(1) & 0xFF
            if key == ord("q"):
                break
            if key == ord("s"):
                out = Path(f"/tmp/butters_demo_{saved:03d}.jpg")
                cv2.imwrite(str(out), img)
                print(f"saved {out}")
                saved += 1

    cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
