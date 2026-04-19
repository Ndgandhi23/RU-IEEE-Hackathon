"""MJPEG-over-HTTP client. Reads the Pi camera_streamer output and yields frames.

Why a hand-rolled parser instead of `cv2.VideoCapture(url)`?
  - We want the per-frame `X-Frame-Index` and `X-Timestamp` headers the Pi
    sets — they let us report capture-to-receive latency and spot drops.
  - cv2.VideoCapture silently eats those headers.
  - Manual parsing also lets us log raw JPEG sizes for bandwidth debugging.

The parser is intentionally small. MJPEG over HTTP is:

    Content-Type: multipart/x-mixed-replace; boundary=<b>
    --<b>\\r\\n
    Content-Type: image/jpeg\\r\\n
    Content-Length: N\\r\\n
    (optional extra headers)\\r\\n
    \\r\\n
    <N bytes of JPEG>
    \\r\\n
    --<b>\\r\\n
    ... repeat ...
"""
from __future__ import annotations

import logging
import time
from collections.abc import Iterator
from dataclasses import dataclass

import cv2
import numpy as np
import requests

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class StreamFrame:
    image: np.ndarray
    """BGR decoded frame — pass directly to `Detector.detect()`."""

    jpeg: bytes
    """Raw JPEG bytes as received. Use for faithful debug saves (no re-encode)."""

    index: int
    """Pi-side capture index from X-Frame-Index. -1 if header missing."""

    pi_timestamp: float
    """Pi monotonic capture time from X-Timestamp. 0.0 if header missing.

    Note: this is the Pi's `time.monotonic()`, not a wall clock — it's only
    comparable against other frames from the same stream session.
    """

    recv_timestamp: float
    """Receiver wall-clock time (`time.time()`) when the frame was assembled."""

    size_bytes: int
    """Length of the JPEG payload, before decode."""


class MjpegClient:
    """Iterate frames from a multipart MJPEG endpoint. Reconnects on drop."""

    def __init__(
        self,
        url: str,
        connect_timeout_s: float = 5.0,
        read_timeout_s: float = 5.0,
        max_backoff_s: float = 10.0,
    ) -> None:
        self._url = url
        self._connect_timeout = connect_timeout_s
        self._read_timeout = read_timeout_s
        self._max_backoff = max_backoff_s

    def frames(self) -> Iterator[StreamFrame]:
        """Infinite iterator of frames. Internally reconnects with backoff."""
        backoff = 0.5
        while True:
            try:
                log.info("connecting to %s", self._url)
                with requests.get(
                    self._url,
                    stream=True,
                    timeout=(self._connect_timeout, self._read_timeout),
                    headers={"Accept": "multipart/x-mixed-replace"},
                ) as resp:
                    resp.raise_for_status()
                    boundary = _extract_boundary(resp.headers.get("Content-Type", ""))
                    if boundary is None:
                        raise RuntimeError(
                            f"no multipart boundary in Content-Type: {resp.headers.get('Content-Type')!r}"
                        )
                    log.info("connected, boundary=%s", boundary)
                    yield from self._iter_parts(resp.raw, boundary.encode("ascii"))
                    log.warning("stream closed cleanly — reconnecting")
                    backoff = 0.5
            except (requests.RequestException, RuntimeError, OSError) as e:
                log.warning("stream error: %s — reconnecting in %.1fs", e, backoff)
                time.sleep(backoff)
                backoff = min(backoff * 2.0, self._max_backoff)

    def _iter_parts(self, raw, boundary: bytes) -> Iterator[StreamFrame]:
        sep_line = b"--" + boundary
        buf = b""
        read = raw.read  # local alias — this is urllib3's HTTPResponse

        while True:
            # 1) Skip bytes until the next boundary line.
            while True:
                idx = buf.find(sep_line)
                if idx >= 0:
                    buf = buf[idx + len(sep_line):]
                    if buf.startswith(b"\r\n"):
                        buf = buf[2:]
                    break
                chunk = read(4096)
                if not chunk:
                    return
                buf += chunk

            # 2) Read part headers until CRLFCRLF.
            while b"\r\n\r\n" not in buf:
                chunk = read(4096)
                if not chunk:
                    return
                buf += chunk
            header_bytes, buf = buf.split(b"\r\n\r\n", 1)
            headers = _parse_headers(header_bytes)

            length_s = headers.get("content-length")
            if not length_s:
                # Scanning for the next boundary without a length is possible
                # but fragile. The Pi always sets it; treat absence as an error
                # and resync at the next boundary.
                log.warning("missing Content-Length in part — resyncing")
                continue
            try:
                n = int(length_s)
            except ValueError:
                log.warning("bad Content-Length %r — resyncing", length_s)
                continue

            # 3) Read N body bytes.
            while len(buf) < n:
                need = n - len(buf)
                chunk = read(min(need, 65536))
                if not chunk:
                    return
                buf += chunk
            jpeg = bytes(buf[:n])
            buf = buf[n:]
            if buf.startswith(b"\r\n"):
                buf = buf[2:]

            img = cv2.imdecode(np.frombuffer(jpeg, dtype=np.uint8), cv2.IMREAD_COLOR)
            if img is None:
                log.warning("cv2.imdecode failed on %d-byte payload — skipping", n)
                continue

            yield StreamFrame(
                image=img,
                jpeg=jpeg,
                index=_safe_int(headers.get("x-frame-index"), -1),
                pi_timestamp=_safe_float(headers.get("x-timestamp"), 0.0),
                recv_timestamp=time.time(),
                size_bytes=n,
            )


def _extract_boundary(content_type: str) -> str | None:
    """Parse `multipart/x-mixed-replace; boundary=foo` -> `foo`."""
    for part in content_type.split(";"):
        part = part.strip()
        if part.lower().startswith("boundary="):
            val = part.split("=", 1)[1].strip()
            if len(val) >= 2 and val[0] == '"' and val[-1] == '"':
                val = val[1:-1]
            return val
    return None


def _parse_headers(raw: bytes) -> dict[str, str]:
    out: dict[str, str] = {}
    for line in raw.split(b"\r\n"):
        line = line.strip()
        if not line or b":" not in line:
            continue
        k, _, v = line.partition(b":")
        try:
            out[k.strip().lower().decode("ascii")] = v.strip().decode("ascii")
        except UnicodeDecodeError:
            pass
    return out


def _safe_int(s: str | None, default: int) -> int:
    if s is None:
        return default
    try:
        return int(s)
    except ValueError:
        return default


def _safe_float(s: str | None, default: float) -> float:
    if s is None:
        return default
    try:
        return float(s)
    except ValueError:
        return default


__all__ = ["MjpegClient", "StreamFrame"]
