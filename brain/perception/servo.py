"""Visual servoing — decides turn/forward intent from a target detection.

Given a bounding box of the target in the current camera frame, outputs a
`ServoCommand` (turn rate, forward speed, and a `done` flag for when the target
is close and centered enough to trigger INTAKING).

Pure function; no motor commands are sent here. The APPROACHING state calls
this each frame and hands the result to the Pi bridge.

Logic follows nav.md §5: proportional control on horizontal bbox error for
turning; forward speed tapers as the target fills the frame; done when bbox
fills > APPROACH_BOX_FILL and |err_frac| < ALIGNMENT_TOLERANCE.
"""
from __future__ import annotations

from dataclasses import dataclass

from brain.perception.types import Detection

# --- Control gains ---------------------------------------------------------
# Proportional gain mapping normalized horizontal error (err_frac ∈ [-1, 1])
# to turn rate in rad/s. Tune in the field.
KP_VISUAL_TURN = 1.0

# Hard envelope on outputs. Also in brain/nav/control_loop.py for GPS nav;
# duplicated here so visual servoing can be tuned independently.
MAX_FWD_M_S = 0.5
MAX_TURN_RAD_S = 1.0

# --- Transition thresholds -------------------------------------------------
# Stop driving forward (and allow "done") once the target bbox height fills
# this fraction of the frame.
APPROACH_BOX_FILL = 0.4

# Max |err_frac| allowed for a "centered" target.
ALIGNMENT_TOLERANCE = 0.1


@dataclass(frozen=True)
class ServoCommand:
    """Per-frame decision during APPROACHING."""
    fwd_m_s: float      # forward speed, >= 0
    turn_rad_s: float   # signed turn rate (+ = right / clockwise from above)
    done: bool          # target is centered and close → INTAKING


def servo_from_detection(
    det: Detection,
    frame_width: int,
    frame_height: int,
    kp_turn: float = KP_VISUAL_TURN,
    max_fwd: float = MAX_FWD_M_S,
    max_turn: float = MAX_TURN_RAD_S,
    approach_box_fill: float = APPROACH_BOX_FILL,
    alignment_tolerance: float = ALIGNMENT_TOLERANCE,
) -> ServoCommand:
    """Decide turn/forward intent from the current target detection.

    err_frac is the horizontal offset of the bbox center from the frame center,
    normalized so ±1 = edge of frame. turn is proportional to err_frac, clipped.
    fwd tapers linearly from max_fwd/2 (far, small bbox) to 0 (bbox_fill == 1).
    done fires when the target is both centered (|err_frac| small) and close
    (bbox fills enough of the frame).
    """
    x1, y1, x2, y2 = det.xyxy
    bbox_cx = (x1 + x2) / 2.0
    bbox_h = max(0, y2 - y1)
    half_w = frame_width / 2.0

    err_frac = (bbox_cx - half_w) / half_w  # ~[-1, 1]
    bbox_fill = bbox_h / frame_height

    turn = kp_turn * err_frac
    turn = max(-max_turn, min(max_turn, turn))

    fwd = max_fwd * 0.5 * max(0.0, 1.0 - bbox_fill)

    done = bbox_fill > approach_box_fill and abs(err_frac) < alignment_tolerance
    return ServoCommand(fwd_m_s=fwd, turn_rad_s=turn, done=done)


def no_target() -> ServoCommand:
    """Decision when no target is detected this frame: stop and do nothing.

    Useful as a safe default when the caller has no Detection to pass.
    """
    return ServoCommand(fwd_m_s=0.0, turn_rad_s=0.0, done=False)
