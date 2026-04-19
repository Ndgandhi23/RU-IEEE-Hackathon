"""VLM scout — queries Qwen3-VL-8B when OWLv2 can't find the target.

Given the current live frame + the reference crop + the reporter's original
photo, reasons about which way to rotate to find the target. Output is a
discrete direction (left or right), which the control loop uses to queue a
burst of rotation frames before handing control back to OWLv2.

Runs at ~1 Hz on a 4080 with 4-bit quantization. Only called from the control
loop's slow path, not every frame.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

import numpy as np
import torch
from PIL import Image
from transformers import (
    AutoProcessor,
    BitsAndBytesConfig,
    Qwen3VLForConditionalGeneration,
)

DEFAULT_MODEL = "Qwen/Qwen3-VL-8B-Instruct"

SYSTEM_PROMPT = """You are the vision module of a trash-pickup robot. The robot is
near the reported trash location but currently cannot see the target in its
camera view. Given three images, decide whether the robot should rotate LEFT or
RIGHT to find the target.

The three images are provided in this order:
1. REFERENCE — a tight crop of the target trash item
2. CONTEXT — the original wider photo the user uploaded, showing the trash in
   its surroundings (nearby landmarks: benches, trees, signs, curbs, etc.)
3. LIVE — the current forward-facing view from the robot

Reason about what landmarks are visible in the CONTEXT photo and whether any
of them appear in the LIVE view. If a landmark from CONTEXT appears on the
left of LIVE, the target is likely to the left (and vice versa).

Respond with strict JSON only. Do not include any prose outside the JSON.
Schema:
{"direction": "left" | "right", "rationale": "one sentence explanation"}
"""


@dataclass(frozen=True)
class ScoutResult:
    direction: Literal["left", "right"]
    rationale: str


class VLMScout:
    """Wraps Qwen3-VL-8B-Instruct at 4-bit. One call per slow-path invocation."""

    def __init__(
        self,
        model_name: str = DEFAULT_MODEL,
        load_in_4bit: bool = True,
        max_new_tokens: int = 128,
    ) -> None:
        self.max_new_tokens = max_new_tokens

        quant = (
            BitsAndBytesConfig(
                load_in_4bit=True,
                bnb_4bit_compute_dtype=torch.float16,
                bnb_4bit_quant_type="nf4",
            )
            if load_in_4bit
            else None
        )

        self.processor = AutoProcessor.from_pretrained(model_name)
        self.model = Qwen3VLForConditionalGeneration.from_pretrained(
            model_name,
            quantization_config=quant,
            dtype="auto",
            device_map="auto",
        ).eval()

    def scout(
        self,
        frame: np.ndarray,
        reference_photo: np.ndarray | Path | str,
        reporter_photo: np.ndarray | Path | str,
    ) -> ScoutResult:
        """Single-shot scout query. Blocks for ~500–1000ms on a 4080."""
        ref = _to_pil(reference_photo)
        ctx = _to_pil(reporter_photo)
        live = _to_pil(frame)

        messages = [
            {"role": "system", "content": SYSTEM_PROMPT},
            {
                "role": "user",
                "content": [
                    {"type": "image", "image": ref},
                    {"type": "image", "image": ctx},
                    {"type": "image", "image": live},
                    {"type": "text", "text": "Which direction should the robot rotate? JSON only."},
                ],
            },
        ]

        inputs = self.processor.apply_chat_template(
            messages,
            tokenize=True,
            add_generation_prompt=True,
            return_dict=True,
            return_tensors="pt",
        ).to(self.model.device)

        with torch.no_grad():
            output_ids = self.model.generate(
                **inputs,
                max_new_tokens=self.max_new_tokens,
                do_sample=False,
            )

        # Trim the prompt tokens from the output.
        prompt_len = inputs["input_ids"].shape[-1]
        generated = output_ids[0][prompt_len:]
        text = self.processor.decode(generated, skip_special_tokens=True)
        return _parse_response(text)


def _to_pil(img: np.ndarray | Path | str) -> Image.Image:
    if isinstance(img, np.ndarray):
        # OpenCV BGR → PIL RGB
        arr = img[:, :, ::-1] if img.ndim == 3 else img
        return Image.fromarray(arr)
    return Image.open(img).convert("RGB")


def _parse_response(text: str) -> ScoutResult:
    """Pull a {direction, rationale} JSON out of the VLM response.

    Tries strict JSON first, then extracts the first {...} block, then falls
    back to keyword inference. Always returns a valid ScoutResult — never
    raises on malformed output.
    """
    stripped = text.strip()
    data: dict | None = None
    try:
        data = json.loads(stripped)
    except json.JSONDecodeError:
        match = re.search(r"\{[^{}]*\}", stripped, re.DOTALL)
        if match:
            try:
                data = json.loads(match.group(0))
            except json.JSONDecodeError:
                data = None

    if data is None:
        lower = stripped.lower()
        if "left" in lower and "right" not in lower:
            return ScoutResult(direction="left", rationale="keyword fallback: left")
        if "right" in lower and "left" not in lower:
            return ScoutResult(direction="right", rationale="keyword fallback: right")
        return ScoutResult(direction="right", rationale="parse failure; default right")

    direction = str(data.get("direction", "right")).strip().lower()
    if direction not in ("left", "right"):
        direction = "right"
    rationale = str(data.get("rationale", ""))[:200]
    return ScoutResult(direction=direction, rationale=rationale)
