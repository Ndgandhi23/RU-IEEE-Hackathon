"""When should the classifier actually consume frames?

The camera is only useful once the robot has reached the final waypoint of an
Apple Maps route (state machine: NAVIGATING -> SEARCHING). Before that, we
shouldn't even open the MJPEG socket — it wastes WiFi bandwidth and burns
cycles running YOLO on un-useful frames.

This module is the brain-side gate. It doesn't touch the Pi (the Pi stays
dumb per writeup/CLAUDE.md: always captures, encodes only on-demand, has no
idea what "arrived" means). The connector asks a `Gate` implementation
"should I be streaming right now?" and opens / closes the MJPEG connection
accordingly.

Three implementations:

- `RelayArrivalGate` — the real one. Polls `GET <relay>/robot/packet`, reads
  `packet.current` (latest robot heartbeat) and `packet.task.destination`,
  and opens when the haversine distance is within threshold.
- `ManualFileGate`  — open while a flag file exists on disk. For local dev,
  because the nav state machine isn't written yet.
- `AlwaysOpenGate`  — legacy behavior; useful for smoke-testing the stream
  itself without involving nav.
"""
from __future__ import annotations

import logging
import sys
import threading
from abc import ABC, abstractmethod
from pathlib import Path

import requests

# Make sure the repo root is importable so `brain.*` resolves when this
# module is used via `python -m connector.run_classifier`.
_REPO_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from brain.nav.geo import haversine  # noqa: E402

log = logging.getLogger(__name__)


class Gate(ABC):
    """Minimal 'is the camera allowed to stream?' contract."""

    @abstractmethod
    def is_open(self) -> bool: ...

    @abstractmethod
    def reason(self) -> str:
        """Short human-readable status, for logging."""

    def start(self) -> None:  # pragma: no cover - default no-op
        """Optional: launch any background poller."""

    def stop(self) -> None:  # pragma: no cover - default no-op
        """Optional: stop background poller."""


class AlwaysOpenGate(Gate):
    def is_open(self) -> bool:
        return True

    def reason(self) -> str:
        return "always open"


class ManualFileGate(Gate):
    """Gate opens while `path` exists. Touch it to 'arrive', delete to 'leave'.

    Windows:   `type nul > arrived.flag`   /   `del arrived.flag`
    POSIX:     `touch arrived.flag`        /   `rm  arrived.flag`
    """

    def __init__(self, path: Path) -> None:
        self._path = Path(path)

    def is_open(self) -> bool:
        return self._path.exists()

    def reason(self) -> str:
        state = "present" if self._path.exists() else "missing"
        return f"flag file {state}: {self._path}"


class RelayArrivalGate(Gate):
    """Opens once the robot is within `arrival_threshold_m` of the current task.

    Polls `GET <relay>/robot/packet` which returns:
        {
          "packet": {
            "status": "assigned" | "idle",
            "current":  {latitude, longitude, ...},
            "task":     {destination: {latitude, longitude}, navigation: ...}
          }
        }
    """

    def __init__(
        self,
        relay_url: str,
        # 10m is a reasonable "we're in the area, start looking for trash"
        # radius on consumer phone GPS (accuracy typically 5-8m, worse indoors).
        # Nav loop's own FINAL_ARRIVAL_M is tighter (3m) for the actual
        # "stop the motors" trigger — that's intentional.
        arrival_threshold_m: float = 10.0,
        poll_interval_s: float = 1.0,
        request_timeout_s: float = 3.0,
    ) -> None:
        self._base = relay_url.rstrip("/")
        self._threshold_m = arrival_threshold_m
        self._interval_s = poll_interval_s
        self._timeout_s = request_timeout_s
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._lock = threading.Lock()
        self._open = False
        self._reason = "waiting for first poll"

    def start(self) -> None:
        if self._thread is not None:
            return
        self._stop.clear()
        self._thread = threading.Thread(
            target=self._run, name="relay-arrival-gate", daemon=True
        )
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=2.0)
            self._thread = None

    def is_open(self) -> bool:
        with self._lock:
            return self._open

    def reason(self) -> str:
        with self._lock:
            return self._reason

    def _set(self, is_open: bool, reason: str) -> None:
        with self._lock:
            changed = is_open != self._open
            self._open = is_open
            self._reason = reason
        if changed:
            log.info("gate %s: %s", "OPEN" if is_open else "CLOSED", reason)

    def _run(self) -> None:
        url = f"{self._base}/robot/packet"
        while not self._stop.is_set():
            try:
                resp = requests.get(url, timeout=self._timeout_s)
                resp.raise_for_status()
                packet = (resp.json() or {}).get("packet") or {}
                self._evaluate(packet)
            except requests.RequestException as e:
                self._set(False, f"relay poll error: {e}")
            except ValueError as e:  # JSON decode
                self._set(False, f"relay poll bad json: {e}")
            self._stop.wait(self._interval_s)

    def _evaluate(self, packet: dict) -> None:
        status = packet.get("status")
        if status != "assigned":
            self._set(False, f"no active task (status={status!r})")
            return

        current = packet.get("current")
        task = packet.get("task") or {}
        dest = task.get("destination")

        cur_ll = _coerce_latlon(current)
        dst_ll = _coerce_latlon(dest)
        if cur_ll is None:
            self._set(False, "no robot heartbeat (packet.current missing)")
            return
        if dst_ll is None:
            self._set(False, "no task destination")
            return

        task_id = task.get("id", "?")

        # Primary source of truth: Apple Maps' total route distance. It's
        # walkway-snapped on both ends, so it doesn't drift when the report
        # was submitted with a stale/low-accuracy phone GPS fix. When it's
        # available we use it directly; haversine is the fallback.
        nav = task.get("navigation") or {}
        apple_dist = nav.get("distanceMeters") if isinstance(nav, dict) else None
        have_apple = isinstance(apple_dist, (int, float))

        haversine_m = haversine(cur_ll[0], cur_ll[1], dst_ll[0], dst_ll[1])

        if have_apple:
            dist_m = float(apple_dist)
            source = "apple"
            extra = f" (haversine={haversine_m:.1f}m)"
        else:
            dist_m = haversine_m
            source = "haversine"
            extra = ""

        if dist_m <= self._threshold_m:
            self._set(
                True,
                f"arrived: task={task_id} dist={dist_m:.1f}m ≤ {self._threshold_m:.1f}m "
                f"[{source}]{extra}",
            )
        else:
            self._set(
                False,
                f"en route: task={task_id} dist={dist_m:.1f}m > {self._threshold_m:.1f}m "
                f"[{source}]{extra}",
            )


def _coerce_latlon(d: object) -> tuple[float, float] | None:
    if not isinstance(d, dict):
        return None
    lat = d.get("latitude")
    lon = d.get("longitude")
    if not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)):
        return None
    return float(lat), float(lon)


__all__ = [
    "Gate",
    "AlwaysOpenGate",
    "ManualFileGate",
    "RelayArrivalGate",
]
