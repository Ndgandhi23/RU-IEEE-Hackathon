# connector/

Pulls frames from the Pi's MJPEG camera stream and feeds them into the same
YOLO classifier that `demo.py` has always used. Replaces the old path of
opening a local webcam directly.

```
Pi (USB webcam) ──MJPEG:8080──> connector.pi_stream.MjpegClient
                                           │
                                           ▼
                    brain.perception.detector.Detector  (YOLO)
                                           │
                                           ▼
                           preview window + logs + optional frame dumps
```

The Pi side lives in [`pi/camera_streamer/`](../pi/camera_streamer/README.md).
Both sides can run on the **same laptop** for dev — the Pi simulator just
publishes the laptop's webcam at `http://127.0.0.1:8080/stream.mjpg` and the
connector reads from that URL. Nothing else changes.

## Files

| File | Purpose |
|---|---|
| `pi_stream.py`       | `MjpegClient` — multipart MJPEG parser with auto-reconnect. Exposes per-frame `X-Frame-Index`, `X-Timestamp`, and JPEG byte size. |
| `gate.py`            | Gate implementations. The classifier only consumes frames while the gate is open (i.e. the robot has arrived at the task destination). |
| `run_classifier.py`  | Entry point. Wires `MjpegClient` → `Gate` → `Detector` → preview + logs. |
| `__init__.py`        | Re-exports `MjpegClient` / `StreamFrame`. |

## Gating: don't stream until we've arrived

The camera is only useful in the `SEARCHING` / `APPROACHING` states of the
state machine in [`writeup/CLAUDE.md`](../writeup/CLAUDE.md). Before the
robot reaches the final Apple Maps waypoint, opening an MJPEG connection
would just waste WiFi and CPU. So the connector is **gated**: it won't open
the MJPEG socket to the Pi until the gate says the robot has arrived.

The Pi stays dumb throughout — it always captures to RAM, but my
`mjpeg_server.py` only JPEG-encodes on demand, so an idle Pi with no
subscribers costs essentially zero bandwidth.

Three gate drivers:

| `--gate`  | Behavior | Use for |
|---|---|---|
| `manual` *(default)* | Open while `./arrived.flag` (or `--manual-gate-file`) exists on disk. | Dev / testing. |
| `relay`   | Poll `GET <relay>/robot/packet` and open when `haversine(packet.current, packet.task.destination) ≤ --arrival-threshold-m`. | Production, with the real relay + nav wired up. |
| `always`  | Never gate — stream constantly. | Pure stream debugging (legacy behavior). |

`--arrival-threshold-m` defaults to `3.0`, matching `ARRIVAL_THRESHOLD_M` in
`CLAUDE.md > Tuning Constants`.

While the gate is closed, the preview window (if enabled) shows a dark
placeholder with the current gate status so you can see at a glance *why*
the stream is idle.

## Quickstart (dev loop on one laptop)

Everything from the repo root.

**Terminal 1** — run the Pi camera-streamer against your laptop's webcam:

```bash
python -m pi.camera_streamer
# "mjpeg server listening on http://0.0.0.0:8080/stream.mjpg (lan ip: 192.168.x.x)"
```

Sanity-check in a browser: open <http://127.0.0.1:8080/> — you should see a
live `<img>` of the webcam. Also try `curl http://127.0.0.1:8080/healthz`.

**Terminal 2** — run the classifier against that stream:

```bash
python demo.py
# equivalent to:
python -m connector.run_classifier --weights models/trash_v1.pt
```

A window titled `pi stream (q quit, s save)` opens. With the default
`--gate manual`, it shows a **dark "gate closed" placeholder** until you
signal arrival — that's the feature we just wired up.

**Terminal 3** — toggle the gate to simulate "robot arrived":

```powershell
# Windows / PowerShell
type nul > arrived.flag      # OPEN: classifier starts consuming frames
del arrived.flag             # CLOSE: classifier disconnects, Pi keeps capturing but no encode
```

```bash
# macOS / Linux
touch arrived.flag
rm    arrived.flag
```

Once the gate opens, the HUD looks like:

```
 14.6 fps |   43.2 KB | pi_idx=812 | Δrecv=12ms | dets=2
```

Hit `q` to quit, `s` to save the current frame as JPEG.

### Bypass the gate for pure stream debug

To verify the Pi → connector plumbing with no nav in the loop (legacy behavior):

```bash
python demo.py --gate always
```

## Against a real Pi + real nav

Once the Pi is on WiFi running `python3 -m pi.camera_streamer`, and the relay
is running with a task assigned to the robot:

```bash
# Defaults: relay at http://127.0.0.1:4000, arrival threshold 3.0m
python demo.py --url http://<pi-ip>:8080/stream.mjpg --gate relay

# Custom relay / threshold:
python demo.py \
    --url http://<pi-ip>:8080/stream.mjpg \
    --gate relay --relay-url http://10.0.0.5:4000 \
    --arrival-threshold-m 5.0
```

The connector polls `GET <relay>/robot/packet` once per second, reads
`packet.current` (latest heartbeat) and `packet.task.destination`, and opens
the gate once the haversine distance drops under the threshold. Gate
transitions are logged:

```
INFO connector.gate: gate OPEN:   arrived: task=abc123 dist=2.3m ≤ 3.0m
INFO connector.gate: gate CLOSED: en route: task=abc123 dist=14.1m > 3.0m
```

## Debugging what the classifier is receiving

Dump every 5th raw JPEG (exactly the bytes the Pi sent — no re-encode) to a
folder, so you can inspect lighting, motion blur, and compression artifacts
offline:

```bash
python -m connector.run_classifier \
    --weights models/trash_v1.pt \
    --save-dir debug_frames \
    --save-every 5
```

Headless debugging (no GUI, just stats):

```bash
python -m connector.run_classifier --weights models/trash_v1.pt --no-display -v
```

Verbose mode prints:

- Every reconnect attempt and backoff
- Per-part `Content-Length` anomalies
- Per-log-interval: frame count, rolling FPS, average JPEG KB, Pi-side frame
  index, estimated receive latency (derived from the Pi's monotonic
  `X-Timestamp` drift vs. the local clock)

## Flags

```
--url URL                      Pi MJPEG URL       (default http://127.0.0.1:8080/stream.mjpg)
--weights PATH                 YOLO weights       (required unless launched via demo.py)
--conf FLOAT                   min confidence     (default 0.25)
--imgsz INT                    YOLO inference size (default 640)

--gate {manual,relay,always}   when to stream     (default manual)
--relay-url URL                relay base url     (default http://127.0.0.1:4000)
--arrival-threshold-m FLOAT    relay gate opens within this distance (default 3.0)
--manual-gate-file PATH        file whose existence means "arrived" (default ./arrived.flag)
--gate-poll-s FLOAT            relay gate poll interval (default 1.0)

--no-display                   headless mode
--save-dir PATH                dump raw JPEGs here
--save-every N                 save every Nth frame (default 15)
--log-every N                  stats line every N frames (default 30)
-v                    DEBUG logs
```

## Notes

- The MJPEG parser reconnects automatically with exponential backoff (0.5s →
  10s cap). If the Pi reboots mid-run, the classifier will recover on its
  own; frame indexes reset per-stream, but the HUD will show that.
- `--save-dir` writes the raw JPEG the Pi sent, not a re-encode. So byte-for-byte
  what the classifier saw is what lands on disk.
- `StreamFrame.image` is BGR `np.ndarray`, directly consumable by
  `Detector.detect()` or any OpenCV code.
- `demo.py` no longer opens the laptop webcam. If you want the old direct-cam
  path for smoke-testing the model in isolation, use
  `python tools/live_detect.py --weights models/trash_v1.pt` — that file
  wasn't touched.
