"""FastAPI listener for iPhone GPS heartbeats.

The robot's mounted iPhone posts `{location, sentAt}` directly to the brain
machine over local WiFi — lower latency than polling the relay, and the
relay is still the system-of-record for the same heartbeat if the phone
posts there too (writeup/CLAUDE.md § Mobile app).

Schema must stay in sync with `app/` and `relay/`:

    POST /robot/heartbeat
    {
      "location": {
        "latitude":  40.5,
        "longitude": -74.4,
        "accuracy":  4.8,
        "timestamp": "2026-04-18T16:32:00.000Z"
      },
      "sentAt": "2026-04-18T16:32:00.000Z"
    }

Run:
    python -m brain.io.iphone_listener --host 0.0.0.0 --port 8000

From inside the brain process:
    from brain.io.iphone_listener import latest_state
    reading = latest_state.get()   # SensorReading | None (None if stale >2s)
"""
from __future__ import annotations

import argparse
import logging
import threading
import time
from dataclasses import dataclass
from datetime import datetime

from fastapi import FastAPI
from pydantic import BaseModel

log = logging.getLogger(__name__)

GPS_STALENESS_S = 2.0  # matches writeup/CLAUDE.md § Tuning Constants


# ---------- wire schema (keep in sync with app/ + relay/) ----------

class LocationWire(BaseModel):
    latitude: float
    longitude: float
    accuracy: float
    timestamp: datetime


class HeartbeatWire(BaseModel):
    location: LocationWire
    sentAt: datetime


# ---------- internal representation ----------

@dataclass(frozen=True)
class SensorReading:
    latitude: float
    longitude: float
    h_accuracy_m: float
    phone_timestamp: datetime
    received_at: float  # time.monotonic()


class LatestSensorState:
    """Thread-safe one-slot cache of the latest GPS reading.

    Staleness is checked on `get()` — if the most recent reading is older
    than `staleness_s`, we return None. Callers shouldn't act on stale GPS.
    """

    def __init__(self, staleness_s: float = GPS_STALENESS_S) -> None:
        self._lock = threading.Lock()
        self._latest: SensorReading | None = None
        self._staleness_s = staleness_s

    def update(self, reading: SensorReading) -> None:
        with self._lock:
            self._latest = reading

    def get(self) -> SensorReading | None:
        with self._lock:
            r = self._latest
        if r is None:
            return None
        if time.monotonic() - r.received_at > self._staleness_s:
            return None
        return r

    def reset(self) -> None:
        """For tests."""
        with self._lock:
            self._latest = None


# Module-level singleton. The rest of the brain imports this directly.
latest_state = LatestSensorState()


# ---------- FastAPI app ----------

def create_app(state: LatestSensorState | None = None) -> FastAPI:
    """Build a FastAPI app bound to `state`. Separated from the singleton so
    tests can spin up an isolated app + state without touching module globals."""
    app = FastAPI(title="brain/iphone_listener")
    bound = state if state is not None else latest_state

    @app.post("/robot/heartbeat")
    async def heartbeat(hb: HeartbeatWire) -> dict:
        reading = SensorReading(
            latitude=hb.location.latitude,
            longitude=hb.location.longitude,
            h_accuracy_m=hb.location.accuracy,
            phone_timestamp=hb.location.timestamp,
            received_at=time.monotonic(),
        )
        bound.update(reading)
        return {"ok": True}

    @app.get("/healthz")
    async def healthz() -> dict:
        r = bound.get()
        if r is None:
            return {"ok": False, "reason": "no fresh heartbeat"}
        return {
            "ok": True,
            "lat": r.latitude,
            "lon": r.longitude,
            "accuracy_m": r.h_accuracy_m,
            "age_s": round(time.monotonic() - r.received_at, 3),
        }

    return app


app = create_app()


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(prog="python -m brain.io.iphone_listener")
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    import uvicorn  # lazy import: tests don't need it

    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
