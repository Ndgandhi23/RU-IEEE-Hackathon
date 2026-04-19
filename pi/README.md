# Raspberry Pi Setup Guide

This is the single setup guide for bringing the Raspberry Pi online in the current project.

The Pi runs exactly two services:

- `pi.motor_controller`: receives left/right drive commands over WebSocket and drives the motors.
- `pi.camera_streamer`: serves frames as MJPEG for the laptop-side classifier, either from a USB camera or from uploaded image files.

The Pi does **not** call Apple Maps itself. The control chain is:

1. `robot-console` on the robot phone sends GPS heartbeats to the relay.
2. The relay fetches or refreshes the Apple Maps walking route.
3. `robot-console` turns that route into waypoint-following left/right motor commands.
4. The phone sends those commands to the Pi at `ws://<pi-ip>:8765`.
5. The Pi executes them and sends encoder and motor state back.
6. When the robot reaches the destination area, the laptop-side classifier opens the Pi camera stream.

## What Runs Where

Runs on the Pi:

- `python3 -m pi.motor_controller`
- `python3 -m pi.camera_streamer --device 0`

or, if you want to push still images from a phone/app instead of using a Pi webcam:

- `python3 -m pi.camera_streamer --source upload`

Runs on the laptop:

- `relay`
- `demo.py`

Runs on the phones:

- `app` on the reporter phone
- `robot-console` on the robot phone

## Hardware Assumption

This guide assumes the L298N enable pins are already handled in hardware:

- `ENA` and `ENB` are strapped high, or their jumpers are left installed.
- The Pi does **not** PWM the enable pins.
- The software controls speed and turning by PWM-ing the active direction pin.

That matches the current code in [pi/motor_controller/l298n.py](/C:/Users/loorj/Documents/RIEEE%20Hackathon/pi/motor_controller/l298n.py:1).

## Exact Wiring

Use BCM numbering in the code and the physical header pin numbers below when wiring the Pi.

### Motor Driver

Wire only the four L298N direction pins from the Pi:

| Function | BCM GPIO | Pi header pin | L298N pin |
| --- | --- | --- | --- |
| Left motor IN1 | `17` | pin `11` | `IN1` |
| Left motor IN2 | `27` | pin `13` | `IN2` |
| Right motor IN3 | `22` | pin `15` | `IN3` |
| Right motor IN4 | `23` | pin `16` | `IN4` |

Do not wire Pi PWM lines to `ENA` or `ENB` for this setup.

Leave the L298N channel enables high in hardware:

- if your board has jumpers on `ENA` and `ENB`, leave them installed
- if your board does not, tie `ENA` and `ENB` to the board's 5V enable logic as appropriate for that module

### Encoders

The code expects these encoder inputs:

| Encoder signal | BCM GPIO | Pi header pin |
| --- | --- | --- |
| Left A | `5` | pin `29` |
| Left B | `6` | pin `31` |
| Right A | `19` | pin `35` |
| Right B | `26` | pin `37` |

Power:

| Signal | Pi header pin |
| --- | --- |
| `3.3V` | pin `1` or `17` |
| `GND` | pin `6` or any other ground pin |

### Shared Ground

These grounds must be tied together:

- Pi ground
- encoder ground
- L298N ground
- motor battery ground

Without a shared ground, the encoder signals will be unreliable and motor control may behave unpredictably.

### Power Notes

- Power the encoders from `3.3V`, not `5V`, unless you add proper level shifting.
- Do **not** power the motor supply from the Pi's `5V` rail.
- Power the L298N motor supply from the robot battery or an appropriate regulator for the motor voltage.

## Software Prerequisites On The Pi

Assumptions:

- Raspberry Pi OS
- Python 3 installed
- the repo already copied onto the Pi
- the Pi is on the same network as the laptop and robot phone

From the Pi:

```bash
sudo apt update
sudo apt install -y pigpio python3-pigpio python3-opencv python3-pip curl
sudo systemctl enable --now pigpiod
```

Optional but useful for camera debugging:

```bash
sudo apt install -y v4l-utils
```

## Install Python Dependencies

From the repo root on the Pi:

```bash
cd /path/to/RIEEE\ Hackathon
python3 -m pip install -r pi/motor_controller/requirements.txt
python3 -m pip install -r pi/camera_streamer/requirements.txt
```

If you use a virtualenv, activate it first and run the same commands.

## Find The Pi IP Address

Run:

```bash
hostname -I
```

Use the Pi's Wi-Fi IP from that output. In the rest of this guide, that value is `<pi-ip>`.

## Verify pigpiod Before Starting The Motor Controller

Check status:

```bash
systemctl status pigpiod --no-pager
```

You want to see it as active. If it is not active:

```bash
sudo systemctl restart pigpiod
systemctl status pigpiod --no-pager
```

## Start The Pi Motor Controller

From the repo root on the Pi:

```bash
python3 -m pi.motor_controller -v
```

Expected result:

- it binds `ws://0.0.0.0:8765`
- it uses the real pigpio backends
- it does not fall back to mock mode

If you see a message about mock backends, stop there and fix `pigpiod` or `pigpio` before continuing.

## Start The Pi Camera Streamer

Open a second shell on the Pi, go to the repo root, then run:

```bash
python3 -m pi.camera_streamer --device 0 --host 0.0.0.0 -v
```

Expected result:

- it binds on port `8080`
- it serves `http://<pi-ip>:8080/stream.mjpg`

If `--device 0` does not work, find the camera device:

```bash
ls /dev/video*
```

If `v4l-utils` is installed:

```bash
v4l2-ctl --list-devices
```

Then retry `pi.camera_streamer` with the correct device index.

If you want the app to send fresh image files to the Pi instead of using a USB
camera, run upload mode instead:

```bash
python3 -m pi.camera_streamer --source upload --host 0.0.0.0 -v
```

In upload mode:

- the Pi does not need `/dev/video0`
- the laptop classifier still reads `http://<pi-ip>:8080/stream.mjpg`
- the app or any client posts images to `http://<pi-ip>:8080/upload`

## Verify The Camera Stream

From the laptop or any machine on the same network:

```bash
curl http://<pi-ip>:8080/healthz
curl -o test.jpg http://<pi-ip>:8080/frame.jpg
```

You should get:

- JSON from `/healthz`
- a real JPEG file from `/frame.jpg`

You can also open this in a browser:

```text
http://<pi-ip>:8080/
```

If you are using upload mode, publish a test image from any machine on the same
network:

```bash
curl -X POST -F "photo=@test.jpg" http://<pi-ip>:8080/upload
curl -o test.jpg http://<pi-ip>:8080/frame.jpg
```

Expected result:

- `POST /upload` returns `201` with JSON metadata about the accepted frame
- `GET /frame.jpg` returns the same uploaded image
- `GET /healthz` changes to `{"ok":true,...}` after the first successful upload

## Configure The Laptop And Phone

### Robot Phone

In [robot-console/.env](/C:/Users/loorj/Documents/RIEEE%20Hackathon/robot-console/.env:1) on the laptop, set:

```env
EXPO_PUBLIC_API_BASE_URL=http://<relay-laptop-ip>:4000
EXPO_PUBLIC_PI_WS_URL=ws://<pi-ip>:8765
```

Restart Expo after editing that file.

### Reporter Phone

In [app/.env](/C:/Users/loorj/Documents/RIEEE%20Hackathon/app/.env:1) on the laptop, set:

```env
EXPO_PUBLIC_API_BASE_URL=http://<relay-laptop-ip>:4000
```

Restart Expo after editing that file too.

## Safe First Movement Test

Do this **before** you let Apple Maps drive the robot.

### Optional: Manual Drive Script

If you want to talk to `pi.motor_controller` without launching Expo, use the
manual driver script:

```bash
python3 -m pi.manual_drive --host <pi-ip> --telemetry
```

That script sends the exact same JSON commands as `robot-console`. Useful
commands inside the prompt:

```text
forward 120
left 150
right 150
drive 120 80
stop
reset
status
quit
```

You can also send one-shot commands:

```bash
python3 -m pi.manual_drive --host <pi-ip> drive 120 120 --duration 1.0
python3 -m pi.manual_drive --host <pi-ip> stop
python3 -m pi.manual_drive --host <pi-ip> reset
```

### Step 1: Connect The Robot Phone To The Pi

On the robot phone in `robot-console`:

1. Open the `Pi` tab.
2. Confirm the displayed Pi URL is `ws://<pi-ip>:8765`.
3. Turn `Connect` on.

Expected result:

- Pi status becomes `open`
- telemetry begins updating
- encoder values and motor PWM fields appear

If it does not open:

- verify the Pi IP
- verify `pi.motor_controller` is still running
- verify the phone and Pi are on the same network

### Step 2: Keep Motors Disabled

Do **not** enable motors yet in the app.

With motors disabled:

- the nav loop still computes commands
- the app still shows proposed left/right output
- nothing should be sent to the motors

This is the correct first test mode.

### Step 3: Manual Motor Smoke Test With Wheels Off The Ground

Lift the robot so the drive wheels are off the ground, then from a laptop shell run:

```python
import asyncio
import json
import websockets

async def main():
    async with websockets.connect("ws://<pi-ip>:8765") as ws:
        await ws.send(json.dumps({"cmd": "drive", "left": 120, "right": 120}))
        await asyncio.sleep(1.0)
        await ws.send(json.dumps({"cmd": "stop"}))
        await asyncio.sleep(0.5)
        await ws.send(json.dumps({"cmd": "drive", "left": 120, "right": -120}))
        await asyncio.sleep(1.0)
        await ws.send(json.dumps({"cmd": "stop"}))

asyncio.run(main())
```

Expected result:

- first command: both wheels move in the same direction
- second command: robot spins in place

If motion is wrong:

- wrong direction on one wheel: swap the motor leads for that side, or swap that side's `IN` mapping
- wrong spin direction: check left/right motor wiring
- encoder signs wrong: swap encoder `A` and `B` for that side in `pi/motor_controller/config.py`

Do not change both motor polarity and encoder polarity at the same time or you will hide the real issue.

## Full Navigation Test

Once the Pi socket and camera are verified:

1. Start `relay` on the laptop.
2. Start the reporter app on phone A.
3. Start `robot-console` on phone B.
4. On phone B, start GPS tracking.
5. On phone B, keep motors disabled at first.
6. Submit a report from phone A.
7. Confirm phone B receives a task and route.
8. Watch the `Nav` tab and confirm the proposed motor command changes as you rotate and move the phone.
9. Only after that, lift the robot or clear space and enable motors.

## How Turning Actually Works

Turning logic lives in `robot-console/nav-loop.ts`, not on the Pi.

Current logic:

- if heading error is large, spin in place
- if heading error is small, drive forward with differential trim
- advance the waypoint when close enough
- send `stop` at the final waypoint

Current tuning:

- waypoint advance radius: `4 m`
- final arrival radius: `3 m`
- spin threshold: `35 deg`
- forward base PWM: `130`
- spin PWM: `150`

That means:

- yes, the Pi is ready to receive Apple Maps-derived commands
- yes, the robot can turn based on those commands
- no, this is not yet a fully closed-loop encoder-based navigation controller

It is a GPS + compass waypoint follower with encoder telemetry for debugging.

## Exact Start Order For A Real Run

Use this order every time:

1. On the Pi: start `pigpiod`
2. On the Pi: start `python3 -m pi.motor_controller -v`
3. On the Pi: start `python3 -m pi.camera_streamer --device 0 --host 0.0.0.0 -v`
4. On the laptop: start `relay`
5. On the laptop: start `robot-console`
6. On the laptop: start `app`
7. On the robot phone: connect to the Pi and start GPS tracking
8. On the reporter phone: submit a report
9. On the laptop: start `demo.py` against `http://<pi-ip>:8080/stream.mjpg`

If you are not using a Pi webcam, replace step 3 with:

3. On the Pi: start `python3 -m pi.camera_streamer --source upload --host 0.0.0.0 -v`

## Troubleshooting

### Pi socket never opens

Check:

- `python3 -m pi.motor_controller -v` is still running
- `EXPO_PUBLIC_PI_WS_URL` is set correctly
- the Pi IP did not change
- the phone and Pi are on the same network

### Motor controller says it is using mock backends

Check:

- `pigpiod` is running
- `python3-pigpio` is installed

### Camera stream does not open

Check:

- `/healthz` works
- the correct `--device` index is being used
- another process is not already holding the camera

If you are using upload mode and `/healthz` stays false:

- verify you posted to `http://<pi-ip>:8080/upload`
- verify the request field name is `photo`, `file`, or `frame`
- verify the uploaded body is a real JPEG/PNG/WebP image

### Robot gets a task but does not turn correctly

Check:

- compass heading is present on the phone
- motor polarity is correct
- left/right motor wiring is not swapped
- encoder A/B channels are not reversed

## Related Files

- [pi/motor_controller/README.md](/C:/Users/loorj/Documents/RIEEE%20Hackathon/pi/motor_controller/README.md:1)
- [pi/camera_streamer/README.md](/C:/Users/loorj/Documents/RIEEE%20Hackathon/pi/camera_streamer/README.md:1)
- [app/services/pi-camera-api.ts](/C:/Users/loorj/Documents/RIEEE%20Hackathon/app/services/pi-camera-api.ts:1)
- [robot-console/nav-loop.ts](/C:/Users/loorj/Documents/RIEEE%20Hackathon/robot-console/nav-loop.ts:1)
- [robot-console/pi-link.ts](/C:/Users/loorj/Documents/RIEEE%20Hackathon/robot-console/pi-link.ts:1)
