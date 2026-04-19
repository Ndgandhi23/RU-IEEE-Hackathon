"""Pin map + constants for the Pi motor controller.

All pin numbers are BCM GPIO numbers (what pigpio expects). Override in
environment variables at startup (see `__main__.py`) or by editing this file
to match your wiring.

Default choices:
- ENA / ENB are on GPIO 12 and 13, which are hardware-PWM-capable on the Pi.
  Hardware PWM is glitch-free and doesn't consume CPU, which matters when
  the rest of the Pi is busy serving MJPEG + running the encoder callbacks.
- Direction pins (IN1..IN4) are plain digital outputs.
- Encoder pins avoid the default I2C (2, 3), SPI (8, 9, 10, 11), and serial
  (14, 15) pins so those buses remain free if we ever add an IMU / LCD / etc.

Hardware notes:
- The encoders are 4-pin hall-effect quadrature encoders (V+, GND, A, B).
  Power them from the Pi's 3.3V rail (pin 1 or 17 on the header) and tie
  GND to a Pi GND pin. At 3.3V supply the A/B outputs are 3.3V logic, so
  NO level shifter is needed — wire them straight into the A/B GPIOs
  below. Internal pull-ups are enabled in encoder.py, which also covers
  open-collector hall sensors.
  (If you ever substitute a 5V-only encoder, THEN you need a level
  shifter on A/B — 5V direct into a Pi GPIO will damage the pin.)
- L298N logic uses 5V. Its IN pins are happy being driven by the Pi's 3.3V
  outputs (they're TTL-compatible). Use the L298N's on-board 5V regulator
  or a separate UBEC for the motor supply — never share motor +V with the
  Pi's 5V rail or the motor spikes will reboot the Pi.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class MotorPins:
    in1: int     # L298N IN (direction pin 1)
    in2: int     # L298N IN (direction pin 2)
    enable: int  # L298N ENA/ENB (PWM speed)


@dataclass(frozen=True)
class EncoderPins:
    a: int       # encoder channel A
    b: int       # encoder channel B


# --- Sensible defaults (edit for your wiring) ---------------------------------

LEFT_MOTOR = MotorPins(in1=17, in2=27, enable=12)
RIGHT_MOTOR = MotorPins(in1=22, in2=23, enable=13)

LEFT_ENCODER = EncoderPins(a=5, b=6)
RIGHT_ENCODER = EncoderPins(a=19, b=26)

# --- PWM + protocol tunables -------------------------------------------------

PWM_FREQUENCY_HZ = 1000   # 1 kHz: quiet-ish and well within L298N's tolerance
PWM_RANGE = 255           # matches JSON protocol: pwm ∈ [-255, 255]

WATCHDOG_TIMEOUT_S = 0.5  # CLAUDE.md: motors halt if no drive cmd in 500ms
TELEMETRY_HZ = 20         # CLAUDE.md: 20 Hz state push

WS_HOST = "0.0.0.0"
WS_PORT = 8765

# --- Encoder specs (for reference / brain-side conversions) ------------------
#
# 4-pin hall-effect quadrature encoder on the motor shaft, behind an N:1
# gearbox. Counts per output-shaft revolution =
#     base CPR * 4 (quadrature decoding) * gearbox ratio
#
# Defaults below match a NeveRest Classic 60 (7 CPR, 60:1 gearbox = 1680).
# Override for whatever encoder+gearbox combo you actually have.
#
# Distance per tick = pi * wheel_diameter_m / COUNTS_PER_OUTPUT_REV.
# The brain does this math; the Pi just streams raw tick counts.

ENCODER_BASE_CPR = 7      # pulses per motor-shaft revolution, single channel
GEARBOX_RATIO = 60        # motor-shaft revolutions per output-shaft revolution
COUNTS_PER_OUTPUT_REV = ENCODER_BASE_CPR * 4 * GEARBOX_RATIO
