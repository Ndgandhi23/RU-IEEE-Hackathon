"""MJPEG-over-HTTP server. The brain machine consumes this to feed YOLO.

Endpoints
---------
  GET /               -> tiny HTML page with a live <img> of the stream (for eyeballs)
  GET /stream.mjpg    -> multipart/x-mixed-replace MJPEG stream (for code, per CLAUDE.md)
  GET /frame.jpg      -> single JPEG of the latest frame (useful for curl smoke-tests)
  GET /healthz        -> JSON liveness probe: {"ok": true, "frames": <int>, "age_s": <float>}
  POST /upload        -> accept a fresh image file and publish it as the latest frame

Design notes
------------
We encode the latest frame to JPEG exactly once per grabber tick (via a shared
"encoded frame" cache, guarded by a lock) and then fan the bytes out to every
connected client. Encoding per-client would pin a Pi 3B core at 100% with even
two subscribers.

We intentionally use the stdlib's `http.server` + `ThreadingHTTPServer`. It's
not pretty, but it's zero-install on Raspberry Pi OS, and MJPEG is a trivially
dumb format: HTTP headers, then a loop of `--boundary\r\nContent-Type: image/jpeg\r\n...`.
No framework needed.
"""
from __future__ import annotations

import json
import logging
import socket
import threading
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import cv2
import numpy as np

from .webcam import Frame, FrameBuffer

log = logging.getLogger(__name__)

_BOUNDARY = "frameboundary"

_INDEX_HTML = b"""<!doctype html>
<html><head><title>pi camera stream</title>
<style>body{margin:0;background:#111;color:#eee;font-family:sans-serif;text-align:center}
img{max-width:100vw;max-height:90vh;display:block;margin:0 auto}
p{margin:8px;font-size:14px;color:#999}</style></head>
<body><img src="/stream.mjpg" alt="live stream"/>
<p>MJPEG stream at <code>/stream.mjpg</code> &middot; single frame at <code>/frame.jpg</code></p>
</body></html>
"""


class _FrameEncoder:
    """Caches the most recent JPEG bytes so N subscribers share one encode."""

    def __init__(self, cam: FrameBuffer, jpeg_quality: int = 80) -> None:
        self._cam = cam
        self._q = int(jpeg_quality)
        self._lock = threading.Lock()
        self._cached_index = -1
        self._cached_bytes: bytes | None = None

    def encode(self, frame: Frame) -> bytes:
        with self._lock:
            if self._cached_index == frame.index and self._cached_bytes is not None:
                return self._cached_bytes
        ok, buf = cv2.imencode(
            ".jpg",
            frame.image,
            [int(cv2.IMWRITE_JPEG_QUALITY), self._q],
        )
        if not ok:
            raise RuntimeError("cv2.imencode failed")
        data = buf.tobytes()
        with self._lock:
            self._cached_index = frame.index
            self._cached_bytes = data
        return data


class _Handler(BaseHTTPRequestHandler):
    # Overridden at server construction time.
    cam: FrameBuffer = None  # type: ignore[assignment]
    encoder: _FrameEncoder = None  # type: ignore[assignment]
    get_frame_timeout_s: float = 2.0
    upload_enabled: bool = False

    def log_message(self, fmt: str, *args: object) -> None:  # noqa: D401
        # Silence BaseHTTPRequestHandler's default stderr noise; use our logger.
        log.debug("%s - %s", self.address_string(), fmt % args)

    def do_GET(self) -> None:  # noqa: N802 (http.server API)
        path = self.path.split("?", 1)[0]
        if path == "/" or path == "/index.html":
            self._send_index()
        elif path == "/stream.mjpg":
            self._send_mjpeg()
        elif path == "/frame.jpg":
            self._send_single_jpeg()
        elif path == "/healthz":
            self._send_health()
        else:
            self.send_error(HTTPStatus.NOT_FOUND)

    def do_POST(self) -> None:  # noqa: N802 (http.server API)
        path = self.path.split("?", 1)[0]
        if path == "/upload" and self.upload_enabled:
            self._accept_upload()
            return
        self.send_error(HTTPStatus.NOT_FOUND)

    def do_OPTIONS(self) -> None:  # noqa: N802 (http.server API)
        path = self.path.split("?", 1)[0]
        if path == "/upload" and self.upload_enabled:
            self.send_response(HTTPStatus.NO_CONTENT)
            self._send_upload_cors_headers()
            self.end_headers()
            return
        self.send_error(HTTPStatus.NOT_FOUND)

    def _send_index(self) -> None:
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(_INDEX_HTML)))
        self.end_headers()
        self.wfile.write(_INDEX_HTML)

    def _wait_frame(self, after_index: int) -> Frame | None:
        return self.cam.wait_next(after_index=after_index, timeout_s=self.get_frame_timeout_s)

    def _send_single_jpeg(self) -> None:
        frame = self.cam.get(max_age_s=2.0)
        if frame is None:
            frame = self._wait_frame(after_index=-1)
        if frame is None:
            self.send_error(HTTPStatus.SERVICE_UNAVAILABLE, "no frame yet")
            return
        data = self.encoder.encode(frame)
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "image/jpeg")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _send_health(self) -> None:
        frame = self.cam.get()
        if frame is None:
            body = b'{"ok":false,"frames":0}'
            status = HTTPStatus.SERVICE_UNAVAILABLE
        else:
            age = time.monotonic() - frame.timestamp
            body = f'{{"ok":true,"frames":{frame.index + 1},"age_s":{age:.3f}}}'.encode()
            status = HTTPStatus.OK
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_upload_cors_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _send_upload_error(self, status: HTTPStatus, message: str) -> None:
        body = json.dumps({"ok": False, "error": message}).encode("utf-8")
        self.send_response(status)
        self._send_upload_cors_headers()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_upload_bytes(self) -> tuple[bytes | None, str | None]:
        content_type = self.headers.get("Content-Type", "")
        if content_type.lower().startswith("multipart/form-data"):
            try:
                length = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                return None, "invalid Content-Length"
            if length <= 0:
                return None, "request body was empty"
            body = self.rfile.read(length)
            return _extract_multipart_upload(
                body=body,
                content_type=content_type,
                accepted_field_names={"photo", "file", "frame"},
            )

        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return None, "invalid Content-Length"
        if length <= 0:
            return None, "request body was empty"
        return self.rfile.read(length), None

    def _accept_upload(self) -> None:
        data, error = self._read_upload_bytes()
        if error is not None or data is None:
            self._send_upload_error(HTTPStatus.BAD_REQUEST, error or "invalid upload")
            return

        image = cv2.imdecode(np.frombuffer(data, dtype=np.uint8), cv2.IMREAD_COLOR)
        if image is None:
            self._send_upload_error(HTTPStatus.BAD_REQUEST, "body was not a decodable image")
            return

        frame = self.cam.push_image(image)
        body = json.dumps(
            {
                "ok": True,
                "frame": {
                    "index": frame.index,
                    "width": int(image.shape[1]),
                    "height": int(image.shape[0]),
                },
            }
        ).encode("utf-8")
        self.send_response(HTTPStatus.CREATED)
        self._send_upload_cors_headers()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_mjpeg(self) -> None:
        # Headers the brain (and every browser) expects for multipart MJPEG.
        self.send_response(HTTPStatus.OK)
        self.send_header("Age", "0")
        self.send_header("Cache-Control", "no-cache, private")
        self.send_header("Pragma", "no-cache")
        self.send_header("Connection", "close")
        self.send_header(
            "Content-Type",
            f"multipart/x-mixed-replace; boundary={_BOUNDARY}",
        )
        self.end_headers()

        last_sent_index = -1
        client = self.address_string()
        log.info("mjpeg client connected: %s", client)
        try:
            while True:
                frame = self._wait_frame(after_index=last_sent_index)
                if frame is None:
                    # Grabber stalled — don't write an incomplete multipart
                    # part (OpenCV's parser rejects those). Just loop; the
                    # wait uses a bounded timeout so we re-check often, and
                    # the next real write will surface any client disconnect.
                    continue

                last_sent_index = frame.index
                jpeg = self.encoder.encode(frame)
                header = (
                    f"--{_BOUNDARY}\r\n"
                    f"Content-Type: image/jpeg\r\n"
                    f"Content-Length: {len(jpeg)}\r\n"
                    f"X-Frame-Index: {frame.index}\r\n"
                    f"X-Timestamp: {frame.timestamp:.6f}\r\n"
                    f"\r\n"
                ).encode("ascii")
                self.wfile.write(header)
                self.wfile.write(jpeg)
                self.wfile.write(b"\r\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, TimeoutError):
            pass
        except OSError as e:
            log.debug("mjpeg socket error for %s: %s", client, e)
        finally:
            log.info("mjpeg client disconnected: %s", client)


def _pick_handler_class(
    cam: FrameBuffer,
    encoder: _FrameEncoder,
    upload_enabled: bool,
) -> type[_Handler]:
    # Subclass so each server gets its own cam/encoder bindings without
    # touching global state — makes the server safe to instantiate twice
    # in a test process.
    return type(
        "BoundHandler",
        (_Handler,),
        {"cam": cam, "encoder": encoder, "upload_enabled": upload_enabled},
    )


class MjpegServer:
    def __init__(
        self,
        cam: FrameBuffer,
        host: str = "0.0.0.0",
        port: int = 8080,
        jpeg_quality: int = 80,
        upload_enabled: bool = False,
    ) -> None:
        self._cam = cam
        self._host = host
        self._port = port
        self._encoder = _FrameEncoder(cam, jpeg_quality=jpeg_quality)
        self._upload_enabled = upload_enabled
        self._server: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        handler_cls = _pick_handler_class(self._cam, self._encoder, self._upload_enabled)
        self._server = ThreadingHTTPServer((self._host, self._port), handler_cls)
        # ThreadingHTTPServer's request threads default to non-daemon on older
        # Pythons; force daemon so Ctrl-C doesn't hang on an open stream.
        self._server.daemon_threads = True
        lan_ip = _best_guess_lan_ip()
        if self._upload_enabled:
            log.info(
                "mjpeg server listening on http://%s:%d/stream.mjpg and accepting uploads at http://%s:%d/upload (lan ip: %s)",
                self._host,
                self._port,
                self._host,
                self._port,
                lan_ip,
            )
        else:
            log.info(
                "mjpeg server listening on http://%s:%d/stream.mjpg (lan ip: %s)",
                self._host,
                self._port,
                lan_ip,
            )
        self._thread = threading.Thread(
            target=self._server.serve_forever,
            name="mjpeg-server",
            daemon=True,
        )
        self._thread.start()

    def stop(self) -> None:
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()
            self._server = None
        if self._thread is not None:
            self._thread.join(timeout=2.0)
            self._thread = None

    def __enter__(self) -> "MjpegServer":
        self.start()
        return self

    def __exit__(self, *exc) -> None:
        self.stop()


def _best_guess_lan_ip() -> str:
    """Return an IP the brain machine can reach us on. Not authoritative — just
    a friendly hint in the startup log so you don't have to `ip addr` on the Pi.
    """
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        # UDP connect() doesn't send a packet; it just picks an egress iface.
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def _extract_multipart_upload(
    body: bytes,
    content_type: str,
    accepted_field_names: set[str],
) -> tuple[bytes | None, str | None]:
    boundary = _extract_multipart_boundary(content_type)
    if boundary is None:
        return None, "missing multipart boundary"

    marker = b"--" + boundary
    for part in body.split(marker):
        part = part.strip()
        if not part or part == b"--":
            continue
        if b"\r\n\r\n" not in part:
            continue
        header_bytes, payload = part.split(b"\r\n\r\n", 1)
        headers = _parse_part_headers(header_bytes)
        disposition = headers.get("content-disposition", "")
        field_name = _extract_disposition_param(disposition, "name")
        if field_name not in accepted_field_names:
            continue
        if payload.endswith(b"\r\n"):
            payload = payload[:-2]
        if not payload:
            return None, "uploaded file was empty"
        return payload, None

    return None, "missing multipart file field (expected photo, file, or frame)"


def _extract_multipart_boundary(content_type: str) -> bytes | None:
    for chunk in content_type.split(";"):
        chunk = chunk.strip()
        if not chunk.lower().startswith("boundary="):
            continue
        value = chunk.split("=", 1)[1].strip()
        if len(value) >= 2 and value[0] == '"' and value[-1] == '"':
            value = value[1:-1]
        return value.encode("utf-8")
    return None


def _parse_part_headers(raw: bytes) -> dict[str, str]:
    headers: dict[str, str] = {}
    for line in raw.split(b"\r\n"):
        if b":" not in line:
            continue
        key, value = line.split(b":", 1)
        try:
            headers[key.strip().lower().decode("ascii")] = value.strip().decode("utf-8")
        except UnicodeDecodeError:
            continue
    return headers


def _extract_disposition_param(disposition: str, key: str) -> str | None:
    for chunk in disposition.split(";"):
        chunk = chunk.strip()
        if "=" not in chunk:
            continue
        param_key, value = chunk.split("=", 1)
        if param_key.strip().lower() != key.lower():
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == '"' and value[-1] == '"':
            value = value[1:-1]
        return value
    return None


__all__ = ["MjpegServer"]
