# robot-console

Standalone Expo app that runs on the phone bolted to the robot. It is both
the GPS source **and** the navigation orchestrator for the hackathon build:

- Pushes GPS + compass heartbeats to the relay so Apple Maps can (re)compute
  the walking route from wherever the robot currently is.
- Holds the active report / task packet and tracks the current waypoint
  cursor across the flattened Apple Maps step list.
- Maintains a WebSocket link to the Pi's `motor_controller` (`:8765`) and
  turns waypoint deltas into `drive` / `stop` commands.
- Surfaces every decision it makes in on-screen debug panels so you can
  watch the whole loop during a live test run.

The laptop still runs the classifier (`demo.py` → `connector/run_classifier.py`).
With `--gate relay`, the connector polls the relay and automatically opens
its inference gate once the robot's current GPS is within arrival distance
of `task.destination`. No extra handoff is needed between the phone and the
laptop.

## Files

- `App.tsx` — single-screen UI, GPS watchers, heartbeats, wiring for all of
  the below.
- `nav-math.ts` — pure `haversine`, `bearing`, `headingError` helpers.
- `pi-link.ts` — reconnecting WebSocket client for the Pi motor controller.
- `nav-loop.ts` — the `useRobotNav` hook: waypoint-cursor state machine +
  command generator.

## Environment

Copy `.env.example` to `.env` and set:

```
EXPO_PUBLIC_API_BASE_URL=http://<laptop-relay>:4000
```

The app derives **`ws://<same-host-as-relay>:8765`** for the Pi WebSocket unless
you set **`EXPO_PUBLIC_PI_WS_URL`** (use that when the motor controller runs on
a different machine than the relay). Leave **Connect** off on the Pi tab until
you want motors; relay + Nav work without opening the socket.

## Full-loop test run

1. **Relay.** `cd relay && node server.js`. Confirm `http://<laptop>:4000/health`
   shows `reportCount: 0` and `appleMapsConfigured: true`.
2. **App.** `cd app && npx expo start`. Open on the reporter phone, make
   sure fake markers are gone (they are — `MOCK_MAP_DATA_ENABLED = false`),
   then submit a real report with a photo and a real GPS fix.
3. **Robot Pi (motor controller).** On the Pi:
   ```
   sudo pigpiod
   python -m pi.motor_controller
   ```
4. **Robot Pi (camera streamer).** In a second Pi shell:
   ```
   python -m pi.camera_streamer --device /dev/video0
   ```
5. **Robot console (phone).** `cd robot-console && npx expo start`. Open on
   the robot's phone.
   1. Hit **Start robot auto mode** — this grants location/compass and
      starts streaming heartbeats to the relay. As soon as a pending
      report exists, the relay replies with an assigned task + Apple
      Maps steps.
   2. Hit **Connect Pi** — the WebSocket opens and telemetry should
      start flowing every ~50ms. Encoder counts show up live.
   3. Flip **Enable motors** when the robot is clear. Until you flip
      this, the nav loop runs in dry-run mode and you can watch the
      proposed `L=… R=…` command update as you move the phone.
6. **Classifier.** On the laptop:
   ```
   python demo.py --gate relay --relay-url http://<laptop>:4000 --show
   ```
   The gate reports `closed (navigating)` while the robot is still en
   route and auto-opens once the relay packet shows the robot is within
   arrival distance of the destination. YOLO then starts consuming the
   Pi MJPEG stream.
7. **Completion.** Tap **Complete current task** on the robot console to
   mark the report cleaned; the relay will hand the robot the next
   pending task. If no pending reports remain, the robot drops back to
   `idle` and motors stop.

## How the loop makes it self-correct

The relay re-computes the Apple Maps route from the robot's **current**
GPS on every heartbeat. That means if the robot overshoots a turn or
drifts off the planned polyline, the next heartbeat's response carries
a *new* waypoint list that starts from where the robot actually is.

`useRobotNav` notices the waypoint list changed (via length + first/last
coord signature) and resets its cursor to 0 — so the next command aims
at waypoint 0 of the re-route, not the stale next waypoint. No explicit
"replan" button, no "are we lost" detector; it just keeps folding the
latest route into the next tick.

## Safety defaults

- **Motors start disabled.** Every new session requires explicitly
  flipping the **Enable motors** switch; the Pi socket may be open
  without motors being live.
- **Arrival stops the motors.** Reaching the final waypoint immediately
  sends `stop`, regardless of the motor-enable switch.
- **Pi watchdog stops the motors.** If the phone stops sending commands
  for more than 500 ms, the Pi halts on its own (`pi/motor_controller`
  implements this server-side).
- **Manual STOP / Reset encoders** buttons are always available while
  the socket is open.
