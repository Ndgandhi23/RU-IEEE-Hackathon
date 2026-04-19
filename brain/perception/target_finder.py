"""Image-conditioned target finder using OWLv2 (google/owlv2-base-patch16-ensemble).

Given a reference image (the reporter's trash photo, cropped) and a live frame from
the robot camera, returns bounding boxes in the live frame scored by visual
similarity to the reference.

Primary CV source during SEARCHING / APPROACHING / VERIFYING. YOLOv8n in
detector.py remains the obstacle detector during NAVIGATING.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import torch
from PIL import Image
from transformers import Owlv2ForObjectDetection, Owlv2Processor

from brain.perception.types import Detection

DEFAULT_MODEL = "google/owlv2-base-patch16"
TARGET_MIN_SIM = 0.3
NMS_THRESHOLD = 0.3
# Reject detections whose bbox covers more than this fraction of the frame.
# OWLv2 image-guided matching saturates on transparent/low-feature targets and
# returns full-frame bboxes at confidence 1.00 — those are texture matches, not
# real objects. Drop them so the next-best real detection surfaces, or so an
# empty list falls through to the VLM scout in ApproachController.
MAX_AREA_FRAC = 0.5


def _pick_device() -> str:
    if torch.cuda.is_available():
        return "cuda"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def _bgr_to_pil(frame: np.ndarray) -> Image.Image:
    return Image.fromarray(frame[:, :, ::-1])


class TargetFinder:
    """OWLv2 image-conditioned detector.

    Usage:
        finder = TargetFinder()
        finder.load_reference(crop_bgr)        # reporter photo, cropped
        while robot_active:
            dets = finder.detect(live_frame)   # list[Detection], sorted desc
    """

    def __init__(
        self,
        model_name: str = DEFAULT_MODEL,
        device: str | None = None,
        min_sim: float = TARGET_MIN_SIM,
    ) -> None:
        self.device = device or _pick_device()
        self.min_sim = min_sim
        self.processor = Owlv2Processor.from_pretrained(model_name)
        self.model = (
            Owlv2ForObjectDetection.from_pretrained(model_name).to(self.device).eval()
        )
        self._query: Image.Image | None = None

    def load_reference(self, crop: np.ndarray | Path | str) -> None:
        """Set the reference image. Accepts a BGR numpy array (cv2 convention) or a
        filesystem path. Replaces any previous reference."""
        if isinstance(crop, np.ndarray):
            self._query = _bgr_to_pil(crop)
        else:
            self._query = Image.open(crop).convert("RGB")

    def detect(self, frame: np.ndarray) -> list[Detection]:
        """Run image-guided detection on a single BGR frame. Returns detections
        sorted by similarity, descending. Empty list if no reference has been
        loaded or nothing clears min_sim."""
        if self._query is None:
            return []

        scene = _bgr_to_pil(frame)
        inputs = self.processor(
            images=scene, query_images=self._query, return_tensors="pt"
        ).to(self.device)

        with torch.no_grad():
            outputs = self.model.image_guided_detection(**inputs)

        target_sizes = torch.tensor([scene.size[::-1]], device=self.device)
        results = self.processor.post_process_image_guided_detection(
            outputs=outputs,
            threshold=self.min_sim,
            nms_threshold=NMS_THRESHOLD,
            target_sizes=target_sizes,
        )[0]

        scores = results["scores"].detach().cpu().numpy()
        boxes = results["boxes"].detach().cpu().numpy()
        if scores.size == 0:
            return []

        frame_h, frame_w = frame.shape[:2]
        frame_area = float(frame_h * frame_w)
        order = np.argsort(-scores)
        out: list[Detection] = []
        for i in order:
            x1, y1, x2, y2 = boxes[i]
            bbox_area = max(0.0, (x2 - x1)) * max(0.0, (y2 - y1))
            if frame_area > 0 and bbox_area / frame_area > MAX_AREA_FRAC:
                # OWLv2 saturation — bbox covers most of the frame. Skip.
                continue
            out.append(
                Detection(
                    class_id=0,
                    class_name="target",
                    confidence=float(scores[i]),
                    xyxy=(int(x1), int(y1), int(x2), int(y2)),
                )
            )
        return out
