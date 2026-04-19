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

DEFAULT_MODEL = "google/owlv2-base-patch16-ensemble"
TARGET_MIN_SIM = 0.3
NMS_THRESHOLD = 0.3


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

        order = np.argsort(-scores)
        return [
            Detection(
                class_id=0,
                class_name="target",
                confidence=float(scores[i]),
                xyxy=(
                    int(boxes[i][0]),
                    int(boxes[i][1]),
                    int(boxes[i][2]),
                    int(boxes[i][3]),
                ),
            )
            for i in order
        ]
