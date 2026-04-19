// Minimal WebSocket client for the Pi's motor_controller server (`:8765`).
//
// Protocol mirrors `pi/motor_controller/ws_server.py`:
//
//   Commands (phone -> Pi):
//     { "cmd": "drive", "left": -255..255, "right": -255..255 }
//     { "cmd": "stop" }
//     { "cmd": "reset_encoders" }
//
//   Telemetry (Pi -> phone, ~20Hz):
//     { "type": "state", "ts": ..., "encoders": { "left": n, "right": n },
//       "motors": { "left_pwm": pwm, "right_pwm": pwm }, "watchdog_ok": bool }
//
// The client normalizes the raw Pi state into a UI-friendly `PiTelemetry`
// shape so the rest of the app doesn't depend on the wire-format field names.
// The client auto-reconnects with a capped exponential backoff. If the socket
// drops mid-drive, the Pi's 500ms watchdog halts the motors on its own.

export type PiTelemetry = {
  type: 'telemetry';
  ts: number;
  encoders: { left: number; right: number };
  motors: { left: number; right: number };
  watchdog_ok: boolean;
};

type PiStateMessage = {
  type: 'state';
  ts: number;
  encoders: { left: number; right: number };
  motors: { left_pwm: number; right_pwm: number };
  watchdog_ok: boolean;
};

export type PiStatus =
  | 'idle'
  | 'connecting'
  | 'open'
  | 'closed'
  | 'error';

export type PiLinkEvent =
  | { kind: 'status'; status: PiStatus; detail?: string }
  | { kind: 'telemetry'; telemetry: PiTelemetry }
  | { kind: 'log'; message: string };

export type PiLinkListener = (event: PiLinkEvent) => void;

const BACKOFF_MIN_MS = 500;
const BACKOFF_MAX_MS = 5_000;

export class PiLink {
  private url: string | null = null;
  private socket: WebSocket | null = null;
  private status: PiStatus = 'idle';
  private wantOpen = false;
  private backoffMs = BACKOFF_MIN_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private listeners: Set<PiLinkListener> = new Set();
  private lastSentAt = 0;

  getStatus(): PiStatus {
    return this.status;
  }

  subscribe(listener: PiLinkListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  connect(url: string) {
    this.url = url;
    this.wantOpen = true;
    this.log(`connect requested -> ${url}`);
    this.openSocket();
  }

  disconnect(reason = 'manual-disconnect') {
    this.wantOpen = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        // ignored
      }
      this.socket = null;
    }
    this.setStatus('idle', reason);
  }

  sendDrive(left: number, right: number): boolean {
    return this.send({
      cmd: 'drive',
      left: clampPwm(left),
      right: clampPwm(right),
    });
  }

  sendStop(): boolean {
    return this.send({ cmd: 'stop' });
  }

  sendResetEncoders(): boolean {
    return this.send({ cmd: 'reset_encoders' });
  }

  /** Milliseconds since the last outbound command was sent. */
  msSinceLastSend(): number {
    if (!this.lastSentAt) return Number.POSITIVE_INFINITY;
    return Date.now() - this.lastSentAt;
  }

  private send(payload: Record<string, unknown>): boolean {
    if (!this.socket || this.socket.readyState !== 1) {
      return false;
    }
    try {
      this.socket.send(JSON.stringify(payload));
      this.lastSentAt = Date.now();
      return true;
    } catch (error) {
      this.log(`send failed: ${errorMessage(error)}`);
      return false;
    }
  }

  private openSocket() {
    if (!this.url || !this.wantOpen) return;
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        // ignored
      }
      this.socket = null;
    }
    this.setStatus('connecting', `opening ${this.url}`);

    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch (error) {
      this.log(`WebSocket ctor failed: ${errorMessage(error)}`);
      this.scheduleReconnect();
      return;
    }

    this.socket = ws;

    ws.onopen = () => {
      this.backoffMs = BACKOFF_MIN_MS;
      this.setStatus('open', 'handshake complete');
    };

    ws.onmessage = (event) => {
      const data = typeof event.data === 'string' ? event.data : String(event.data);
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        this.log(`non-JSON message ignored: ${data.slice(0, 80)}`);
        return;
      }

      if (isPiStateMessage(parsed)) {
        this.emit({
          kind: 'telemetry',
          telemetry: {
            type: 'telemetry',
            ts: parsed.ts,
            encoders: parsed.encoders,
            motors: {
              left: parsed.motors.left_pwm,
              right: parsed.motors.right_pwm,
            },
            watchdog_ok: parsed.watchdog_ok,
          },
        });
      }
    };

    ws.onerror = (event) => {
      // React Native WebSocket error events are opaque; just log the fact.
      this.log(`socket error: ${(event as unknown as { message?: string })?.message ?? 'unknown'}`);
      this.setStatus('error', 'socket error');
    };

    ws.onclose = (event) => {
      this.socket = null;
      const detail = `closed (code=${event.code})`;
      this.setStatus('closed', detail);
      if (this.wantOpen) {
        this.scheduleReconnect();
      }
    };
  }

  private scheduleReconnect() {
    if (!this.wantOpen) return;
    if (this.reconnectTimer) return;
    const delay = this.backoffMs;
    this.log(`reconnect in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, delay);
    this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS);
  }

  private setStatus(status: PiStatus, detail?: string) {
    this.status = status;
    this.emit({ kind: 'status', status, detail });
  }

  private log(message: string) {
    this.emit({ kind: 'log', message });
  }

  private emit(event: PiLinkEvent) {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // keep other listeners alive
      }
    }
  }
}

function clampPwm(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value > 255) return 255;
  if (value < -255) return -255;
  return Math.round(value);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function isPiStateMessage(value: unknown): value is PiStateMessage {
  if (!value || typeof value !== 'object') return false;
  const msg = value as Partial<PiStateMessage>;
  return (
    msg.type === 'state' &&
    typeof msg.ts === 'number' &&
    typeof msg.watchdog_ok === 'boolean' &&
    typeof msg.encoders?.left === 'number' &&
    typeof msg.encoders?.right === 'number' &&
    typeof msg.motors?.left_pwm === 'number' &&
    typeof msg.motors?.right_pwm === 'number'
  );
}
