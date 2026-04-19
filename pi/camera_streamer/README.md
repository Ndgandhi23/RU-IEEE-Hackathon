# pi/camera_streamer

Camera capture and MJPEG transmission on the Raspberry Pi.

This is the **transmit** side of the Pi camera proxy described in
[`writeup/CLAUDE.md`](../../writeup/CLAUDE.md). The brain machine (Mac today,
Jetson Orin Nano later) connects to this stream and feeds frames into the
same YOLO `Detector` used by `demo.py`.

```
┌────────────────┐   USB    ┌──────────────────────────┐   HTTP/MJPEG   ┌──────────────────┐
│ Logitech C270  ├─────────>│  Raspberry Pi 3B         ├───────────────>│  Brain machine    │
│ 720p webcam    │          │  pi.camera_streamer       │   :8080/       │  jetson/perception │
└────────────────┘          │  (webcam + MJPEG server) │   stream.mjpg  │  Detector (YOLO)  │
                            └──────────────────────────┘                └──────────────────┘
```

The Pi does **no inference, no business logic** — it just captures frames in
a grabber thread and serves them as multipart MJPEG. Per the project rules,
every decision lives on the brain.

## Files

| File | Purpose |
|---|---|
| `webcam.py`        | Async USB capture. Background thread, always holds the freshest frame. |
| `mjpeg_server.py`  | Threaded HTTP server. Shared JPEG-encode cache fans out to N subscribers. |
| `__main__.py`      | CLI entry point: wires webcam + server together. |
| `requirements.txt` | Minimal Pi-side deps (no torch / no ultralytics — inference runs on the brain). |

## Endpoints

| Path | Content-Type | Use |
|---|---|---|
| `/`              | `text/html`              | Tiny status page with a live `<img>` preview. |
| `/stream.mjpg`   | `multipart/x-mixed-replace` | Main MJPEG stream. This is what the brain consumes. |
| `/frame.jpg`     | `image/jpeg`             | Latest single frame. Handy for `curl` smoke-tests. |
| `/healthz`       | `application/json`       | `{"ok": true, "frames": N, "age_s": F}`. |

Per-frame MJPEG parts include `X-Frame-Index` and `X-Timestamp` headers so
the brain can detect freezes and log capture latency.

## Running on the Pi

Install deps (system-wide `apt` Python is usually fine on Pi OS — or use a venv):

```bash
sudo apt install -y python3-opencv        # easiest: ships ffmpeg/V4L2 backends
# or, if you prefer pip:
pip install -r pi/camera_streamer/requirements.txt
```

Launch, from the **repo root** (so the `pi` package is importable):

```bash
python3 -m pi.camera_streamer             # serves http://<pi-ip>:8080/stream.mjpg
python3 -m pi.camera_streamer --device 1  # different USB cam
python3 -m pi.camera_streamer --width 1280 --height 720 --fps 30 --quality 75
```

Flags:

```
--device N       V4L2 index (default 0 = /dev/video0)
--width  W       capture width  (default 640)
--height H       capture height (default 480)
--fps    F       requested FPS  (default 15)
--host   IP      bind address   (default 0.0.0.0)
--port   P       HTTP port      (default 8080)
--quality Q      JPEG quality   (default 80, range 1-100)
-v               DEBUG logs
```

Defaults (640×480 @ 15fps, quality 80) match the MJPEG bandwidth budget
called out in `CLAUDE.md > Known Gotchas` (720p MJPEG is ~15 Mbps and
borderline on campus WiFi).

## Smoke-testing from the brain machine

Single frame:

```bash
curl -o test.jpg http://<pi-ip>:8080/frame.jpg
```

Liveness:

```bash
curl -s http://<pi-ip>:8080/healthz
# {"ok":true,"frames":812,"age_s":0.071}
```

Browser preview: visit `http://<pi-ip>:8080/` and you'll see the live stream.

## Feeding the stream into the same classifier `demo.py` uses

The classifier is `jetson.perception.detector.Detector`, which just needs BGR
`np.ndarray` frames. OpenCV reads MJPEG-over-HTTP natively:

```python
import cv2
from jetson.perception.detector import Detector

detector = Detector("models/trash_v1.pt")
cap = cv2.VideoCapture("http://<pi-ip>:8080/stream.mjpg")

while True:
    ok, frame = cap.read()
    if not ok:
        continue
    for det in detector.detect(frame):
        print(det.class_name, det.confidence, det.xyxy)
```

On the brain side, a module like `jetson/io/pi_frame_source.py` will wrap that
in the same `Frame` dataclass contract the existing `jetson/io/webcam.py`
exposes, so `tools/live_detect.py` and `demo.py` can swap local cam ↔ Pi
stream behind a single `--source` flag. That module is out of scope here —
this folder is the transmit half only.

## Autostart (systemd, optional)

```ini
# /etc/systemd/system/pi-camera-streamer.service
[Unit]
Description=Pi camera streamer (MJPEG to brain)
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=/home/pi/trash-robot
ExecStart=/usr/bin/python3 -m pi.camera_streamer
Restart=on-failure
User=pi

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now pi-camera-streamer.service
journalctl -u pi-camera-streamer -f
```
