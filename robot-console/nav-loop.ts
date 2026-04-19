// React hook that turns the relay's robot packet into motor commands.
//
// Responsibilities:
//   1. Maintain the "current waypoint" cursor across the flattened list of
//      step waypoints for the active task.
//   2. On each GPS/heading update, compute distance + bearing to the
//      current waypoint and derive a simple left/right PWM command:
//        - big heading error           -> spin in place (differential)
//        - small heading error, >Xm    -> drive forward, nudge with kP
//        - inside WAYPOINT_ADVANCE_M   -> advance cursor
//        - cursor past last waypoint   -> "ARRIVED" (stop motors)
//   3. When a new task arrives or the relay returns a re-routed waypoint
//      list, reset the cursor to 0. The relay always recomputes from the
//      robot's current GPS so waypoint 0 of the new route is near us.
//   4. Publish a readable debug trace of every decision so the operator
//      can watch the loop live from the robot console UI.
//
// The hook NEVER sends commands on its own unless `enabled` is true. When
// disabled it still computes every value so the UI can show what *would*
// happen — this is the recommended default for initial bring-up so the
// robot doesn't drive away on a jittery compass reading.

import { useEffect, useMemo, useRef, useState } from 'react';

import {
  bearingDegrees,
  haversineMeters,
  headingErrorDegrees,
  type LatLon,
} from './nav-math';
import type { PiLink } from './pi-link';

// --- tuning knobs ----------------------------------------------------------

/** Radius around a waypoint at which it's considered reached. */
const WAYPOINT_ADVANCE_M = 4;
/** Radius around the final destination at which we declare ARRIVED. */
const FINAL_ARRIVAL_M = 3;
/** |heading error| above which we stop forward motion and spin in place. */
const SPIN_THRESHOLD_DEG = 35;
/** Proportional gain on heading error while driving forward (PWM / deg). */
const HEADING_KP = 2.0;
/** Baseline PWM while driving forward toward a waypoint. */
const FWD_BASE_PWM = 130;
/** PWM magnitude while spinning in place to reduce heading error. */
const SPIN_PWM = 150;
/** PWM clamp (matches Pi's L298N range). */
const PWM_MAX = 255;
/** Minimum time between two outbound drive commands, in ms. */
const COMMAND_MIN_INTERVAL_MS = 120;

// --- types -----------------------------------------------------------------

export type NavStep = {
  index: number;
  instruction: string | null;
  distanceMeters: number | null;
  expectedTravelTimeSeconds: number | null;
  waypoints: LatLon[];
};

export type NavRoute = {
  steps: NavStep[];
  waypoints: LatLon[]; // flattened
  distanceMeters: number | null;
  expectedTravelTimeSeconds: number | null;
};

export type NavPose = {
  location: LatLon | null;
  headingDeg: number | null;
};

export type NavCommand = {
  left: number;
  right: number;
  mode: 'stop' | 'forward' | 'spin-left' | 'spin-right' | 'nudge';
};

export type NavDecision = {
  /** True once we're within FINAL_ARRIVAL_M of the last waypoint. */
  arrived: boolean;
  /** Index of the flattened waypoint we're currently driving toward. */
  waypointIndex: number;
  /** Which step (from Apple Maps) that waypoint belongs to. */
  stepIndex: number;
  /** Apple-Maps-style turn instruction for the active step, if any. */
  stepInstruction: string | null;
  /** Target waypoint, or null if no active route. */
  target: LatLon | null;
  /** Meters to the current target waypoint (null if no target). */
  distanceToTargetM: number | null;
  /**
   * Total remaining route distance. Prefers Apple Maps' `distanceMeters`
   * (walkway-snapped, refreshed every ~15s by the relay) and falls back to
   * on-device haversine from pose to the final waypoint when Apple's number
   * is missing.
   */
  distanceRemainingM: number | null;
  /** Source of `distanceRemainingM`: 'apple' when from Apple Maps, else 'haversine'. */
  distanceRemainingSource: 'apple' | 'haversine' | null;
  /** Bearing from robot to target, degrees from North (null if no target). */
  bearingDeg: number | null;
  /** Signed heading error in degrees (null if no heading). */
  headingErrorDeg: number | null;
  /** Motor command that would be sent (sent iff the loop is `enabled`). */
  command: NavCommand;
  /** Reason string explaining why this command was produced. */
  reason: string;
};

export type NavState = {
  taskId: string | null;
  route: NavRoute | null;
  /**
   * True when `route` was synthesized from `task.destination` because Apple
   * Maps returned no usable steps/waypoints. UI should surface this so the
   * operator knows they're navigating by straight-line bearing, not turns.
   */
  routeSynthetic: boolean;
  decision: NavDecision;
  debug: string[];
};

export type UseRobotNavOptions = {
  /** Relay packet (from /robot/heartbeat or /robot/packet). */
  task: {
    id: string;
    navigation: NavRoute | null;
    /**
     * Final report location. Used as a single-waypoint fallback when Apple
     * Maps returns no steps/waypoints (e.g. for very short trips where
     * the whole route is "walk in a straight line").
     */
    destination?: LatLon | null;
  } | null;
  /** Latest robot pose from expo-location. */
  pose: NavPose;
  /** Pi WebSocket client. Commands only flow when `enabled` is true. */
  piLink: PiLink;
  /** Master enable — when false, compute everything but do NOT send drives. */
  enabled: boolean;
  /**
   * Debug override: when true, the loop never short-circuits on arrival.
   * It keeps computing vector / bearing / motor decisions against the
   * final waypoint even if you're sitting on top of it, so you can walk
   * the phone around and watch Apple Maps re-route live.
   *
   * NOTE: motors still obey `enabled`. Turning this on with motors LIVE
   * will make the robot actively chase the pin; leave motors in dry-run
   * while testing route refresh behavior.
   */
  forceNavigate?: boolean;
  /**
   * Demo override: when true, the loop reports `arrived=true` as soon as
   * a task + route are present, without waiting for GPS to converge on
   * the final waypoint. The Apple Maps route is still resolved and
   * rendered in the UI; this only short-circuits the arrival gate so the
   * brain-side autonomous ML loop can take over immediately.
   *
   * Mutually exclusive with `forceNavigate` — if both are set,
   * `demoAutoArrive` wins.
   */
  demoAutoArrive?: boolean;
  /** Optional debug log sink (ring buffer grows inside the hook too). */
  onLog?: (message: string) => void;
};

// --- hook ------------------------------------------------------------------

export function useRobotNav(options: UseRobotNavOptions): NavState {
  const { task, pose, piLink, enabled, onLog } = options;
  const demoAutoArrive = options.demoAutoArrive ?? false;
  const forceNavigate = !demoAutoArrive && (options.forceNavigate ?? false);

  // Cursor state. Kept in a ref so frequent GPS updates don't churn React.
  const waypointIndexRef = useRef(0);
  const lastTaskSignatureRef = useRef<string>('');
  const lastRouteSignatureRef = useRef<string>('');
  const lastCommandAtRef = useRef(0);
  const debugBufferRef = useRef<string[]>([]);

  // Surface the decision + debug log to React so the UI updates.
  const [decision, setDecision] = useState<NavDecision>(() => idleDecision());
  const [debug, setDebug] = useState<string[]>([]);

  function pushDebug(message: string) {
    const line = `${timestamp()} ${message}`;
    debugBufferRef.current = [...debugBufferRef.current.slice(-39), line];
    setDebug(debugBufferRef.current);
    onLog?.(line);
  }

  /**
   * Resolve the route we'll navigate by.
   *
   * Preference order:
   *   1. Apple Maps route with a non-zero `distanceMeters` → use it as-is.
   *      The waypoints are vertices along the walkway polyline.
   *   2. Apple returned `distanceMeters == 0` → degenerate. Apple snapped
   *      both the origin and the destination onto the same walkway node,
   *      which can be tens of meters from the actual reporter pin. In that
   *      case the snap polyline is useless (or worse, misleading), so we
   *      fall back to a straight-line route to `task.destination`.
   *   3. No Apple waypoints at all → straight-line to `task.destination`.
   *   4. No task destination either → null (can't navigate).
   */
  function resolveRoute(): { route: NavRoute; synthetic: boolean } | null {
    if (!task) return null;
    const real = task.navigation;
    const dest = task.destination ?? null;

    // Apple's "already there" signal. Treat as degenerate and fall through
    // to the straight-line fallback so we steer toward the true reporter
    // pin instead of the snapped walkway node.
    const appleDegenerate = real != null && real.distanceMeters === 0;

    if (real && real.waypoints.length > 0 && !appleDegenerate) {
      return { route: real, synthetic: false };
    }

    if (!dest) return null;
    return {
      route: {
        waypoints: [dest],
        // Preserve Apple's numbers (including the 0) so downstream code can
        // still use them for the arrival gate.
        distanceMeters: real?.distanceMeters ?? null,
        expectedTravelTimeSeconds: real?.expectedTravelTimeSeconds ?? null,
        steps: [
          {
            index: 0,
            instruction: appleDegenerate
              ? 'Apple says you\'re already on the destination walkway — driving straight to the pin'
              : 'Head to the report location',
            distanceMeters: real?.distanceMeters ?? null,
            expectedTravelTimeSeconds: real?.expectedTravelTimeSeconds ?? null,
            waypoints: [dest],
          },
        ],
      },
      synthetic: true,
    };
  }

  // Reset cursor when the task changes or the effective route geometry does.
  useEffect(() => {
    const taskSig = task?.id ?? '';
    const resolved = resolveRoute();
    const routeSig = resolved ? routeSignature(resolved.route) : '';

    if (taskSig !== lastTaskSignatureRef.current) {
      waypointIndexRef.current = 0;
      lastTaskSignatureRef.current = taskSig;
      lastRouteSignatureRef.current = routeSig;
      pushDebug(taskSig ? `new task ${taskSig}: reset waypoint cursor to 0` : 'task cleared');
      return;
    }

    if (routeSig && routeSig !== lastRouteSignatureRef.current) {
      waypointIndexRef.current = 0;
      lastRouteSignatureRef.current = routeSig;
      pushDebug(
        resolved?.synthetic
          ? 'route has no Apple steps — using destination as single waypoint'
          : 'route re-computed by relay: reset waypoint cursor to 0'
      );
    }
    // pushDebug is stable enough; don't add it to deps to avoid loops.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task?.id, task?.navigation, task?.destination?.latitude, task?.destination?.longitude]);

  // Recompute a decision every time the pose or route changes.
  useEffect(() => {
    const resolved = resolveRoute();
    const route = resolved?.route ?? null;
    const waypoints = route?.waypoints ?? [];
    const cursor = Math.min(waypointIndexRef.current, waypoints.length);

    // No task, and no destination we can fall back to -> idle.
    if (!task || !route || waypoints.length === 0) {
      const next = idleDecision(
        !task ? 'no active task' : 'no waypoints and no destination'
      );
      setDecision(next);
      maybeStopMotors(piLink, enabled, lastCommandAtRef, pushDebug);
      return;
    }

    // DEMO: assume-already-arrived path. Keeps the Apple Maps route resolved
    // (so the UI still shows steps / waypoints / distance remaining) but
    // skips the whole drive-to-waypoint sequence. The brain-side autonomous
    // ML loop takes over from here.
    if (demoAutoArrive) {
      waypointIndexRef.current = waypoints.length;
      const next: NavDecision = {
        arrived: true,
        waypointIndex: waypoints.length,
        stepIndex: Math.max(0, route.steps.length - 1),
        stepInstruction: route.steps.at(-1)?.instruction ?? null,
        target: null,
        distanceToTargetM: 0,
        distanceRemainingM: 0,
        distanceRemainingSource: route.distanceMeters != null ? 'apple' : null,
        bearingDeg: null,
        headingErrorDeg: null,
        command: { left: 0, right: 0, mode: 'stop' },
        reason: 'DEMO auto-arrive — motors stopped, autonomous ML loop takes over',
      };
      setDecision(next);
      maybeStopMotors(piLink, enabled, lastCommandAtRef, pushDebug, true);
      return;
    }

    // No GPS yet -> idle but keep the route visible.
    if (!pose.location) {
      const next: NavDecision = {
        ...routedIdleDecision(route, cursor),
        reason: 'awaiting first GPS fix',
      };
      setDecision(next);
      maybeStopMotors(piLink, enabled, lastCommandAtRef, pushDebug);
      return;
    }

    // "Authoritative" distance for the arrival decision.
    // Apple Maps' total route distance is walkway-snapped on both ends and
    // therefore doesn't drift when the destination's stored lat/lon was
    // captured with a stale/low-accuracy GPS fix. Prefer it when present;
    // otherwise fall back to straight-line haversine to the final waypoint.
    const haversineToFinal = haversineMeters(
      pose.location,
      waypoints[waypoints.length - 1]
    );
    const distanceRemainingM =
      route.distanceMeters != null ? route.distanceMeters : haversineToFinal;
    const distanceRemainingSource: 'apple' | 'haversine' =
      route.distanceMeters != null ? 'apple' : 'haversine';

    // Advance the cursor across any waypoints we're already close to.
    // In `forceNavigate` debug mode, never advance past the final waypoint —
    // we want to keep steering toward the pin so the operator can walk the
    // phone around and watch the route refresh.
    let index = cursor;
    while (index < waypoints.length) {
      const wp = waypoints[index];
      const d = haversineMeters(pose.location, wp);
      const isFinal = index === waypoints.length - 1;
      const threshold = isFinal ? FINAL_ARRIVAL_M : WAYPOINT_ADVANCE_M;
      // For the FINAL waypoint, also accept Apple's total as a "close enough"
      // signal. This lets the robot declare arrival when Apple says we're on
      // the same walkway node as the destination, even if haversine is off
      // (e.g. reporter submitted with a stale GPS fix).
      const closeByApple =
        isFinal &&
        route.distanceMeters != null &&
        route.distanceMeters <= FINAL_ARRIVAL_M;
      if (isFinal && forceNavigate) break;
      if (d > threshold && !closeByApple) break;
      index += 1;
      const why = closeByApple
        ? `Apple distance ${route.distanceMeters?.toFixed(1)}m <= ${FINAL_ARRIVAL_M}m`
        : `${d.toFixed(1)}m <= ${threshold}m`;
      pushDebug(
        `waypoint ${index - 1} reached (${why}); advancing to ${index}/${waypoints.length}`
      );
    }
    // If force-navigate is on and the cursor is already past the final
    // waypoint (e.g. we'd previously arrived before the operator flipped
    // the switch), clamp it back to the final waypoint so we continue to
    // have a valid target. Without this clamp we'd fall through to
    // `waypoints[index]` being undefined and crash on `.latitude`.
    if (forceNavigate && index >= waypoints.length) {
      index = waypoints.length - 1;
      pushDebug(
        `force-navigate: clamping cursor back to final waypoint ${index + 1}/${waypoints.length}`
      );
    }
    waypointIndexRef.current = index;

    // Past the last waypoint -> arrived. Skipped when `forceNavigate` is on.
    if (index >= waypoints.length && !forceNavigate) {
      const next: NavDecision = {
        arrived: true,
        waypointIndex: waypoints.length,
        stepIndex: route.steps.length - 1,
        stepInstruction: route.steps.at(-1)?.instruction ?? null,
        target: null,
        distanceToTargetM: 0,
        distanceRemainingM:
          route.distanceMeters != null ? Math.min(route.distanceMeters, 0) : 0,
        distanceRemainingSource,
        bearingDeg: null,
        headingErrorDeg: null,
        command: { left: 0, right: 0, mode: 'stop' },
        reason:
          distanceRemainingSource === 'apple'
            ? `arrived (Apple route distance <= ${FINAL_ARRIVAL_M}m) — motors stopped, awaiting classifier`
            : 'arrived at destination — motors stopped, awaiting classifier',
      };
      setDecision(next);
      maybeStopMotors(piLink, enabled, lastCommandAtRef, pushDebug, true);
      return;
    }

    // Still navigating: compute target + command.
    const target = waypoints[index];
    const distanceToTargetM = haversineMeters(pose.location, target);
    const bearingDeg = bearingDegrees(pose.location, target);
    const headingErrorDeg =
      pose.headingDeg == null ? null : headingErrorDegrees(pose.headingDeg, bearingDeg);
    const stepIndex = findStepIndex(route.steps, index);
    const stepInstruction = route.steps[stepIndex]?.instruction ?? null;

    let command: NavCommand;
    let reason: string;

    if (headingErrorDeg == null) {
      command = { left: 0, right: 0, mode: 'stop' };
      reason = 'no compass heading yet — holding still';
    } else if (Math.abs(headingErrorDeg) > SPIN_THRESHOLD_DEG) {
      if (headingErrorDeg > 0) {
        command = { left: SPIN_PWM, right: -SPIN_PWM, mode: 'spin-right' };
        reason = `heading error ${headingErrorDeg.toFixed(0)}° > ${SPIN_THRESHOLD_DEG}° — spin right`;
      } else {
        command = { left: -SPIN_PWM, right: SPIN_PWM, mode: 'spin-left' };
        reason = `heading error ${headingErrorDeg.toFixed(0)}° < -${SPIN_THRESHOLD_DEG}° — spin left`;
      }
    } else {
      const trim = clamp(HEADING_KP * headingErrorDeg, -PWM_MAX, PWM_MAX);
      const left = clamp(FWD_BASE_PWM + trim, -PWM_MAX, PWM_MAX);
      const right = clamp(FWD_BASE_PWM - trim, -PWM_MAX, PWM_MAX);
      const mode: NavCommand['mode'] = Math.abs(headingErrorDeg) < 3 ? 'forward' : 'nudge';
      command = { left, right, mode };
      reason = `driving ${mode} (${distanceToTargetM.toFixed(1)}m to wp ${index + 1}/${waypoints.length}, err=${headingErrorDeg.toFixed(0)}°)`;
    }

    const next: NavDecision = {
      arrived: false,
      waypointIndex: index,
      stepIndex,
      stepInstruction,
      target,
      distanceToTargetM,
      distanceRemainingM,
      distanceRemainingSource,
      bearingDeg,
      headingErrorDeg,
      command,
      reason,
    };
    setDecision(next);

    maybeSendCommand(piLink, enabled, lastCommandAtRef, pushDebug, command, reason);
    // `piLink`, `enabled`, `pushDebug` are stable within a render; exclude to
    // prevent loops on every state emit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    task?.id,
    task?.navigation,
    task?.destination?.latitude,
    task?.destination?.longitude,
    pose.location?.latitude,
    pose.location?.longitude,
    pose.headingDeg,
    enabled,
    forceNavigate,
    demoAutoArrive,
  ]);

  const state: NavState = useMemo(() => {
    const resolved = resolveRoute();
    return {
      taskId: task?.id ?? null,
      route: resolved?.route ?? null,
      routeSynthetic: resolved?.synthetic ?? false,
      decision,
      debug,
    };
    // `resolveRoute` reads `task` only; safe to depend on task fields.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    task?.id,
    task?.navigation,
    task?.destination?.latitude,
    task?.destination?.longitude,
    decision,
    debug,
  ]);

  return state;
}

// --- helpers ---------------------------------------------------------------

function idleDecision(reason = 'idle'): NavDecision {
  return {
    arrived: false,
    waypointIndex: 0,
    stepIndex: 0,
    stepInstruction: null,
    target: null,
    distanceToTargetM: null,
    distanceRemainingM: null,
    distanceRemainingSource: null,
    bearingDeg: null,
    headingErrorDeg: null,
    command: { left: 0, right: 0, mode: 'stop' },
    reason,
  };
}

function routedIdleDecision(route: NavRoute, cursor: number): NavDecision {
  const waypoints = route.waypoints;
  const target = waypoints[cursor] ?? null;
  return {
    arrived: false,
    waypointIndex: cursor,
    stepIndex: findStepIndex(route.steps, cursor),
    stepInstruction: route.steps[findStepIndex(route.steps, cursor)]?.instruction ?? null,
    target,
    distanceToTargetM: null,
    distanceRemainingM: route.distanceMeters,
    distanceRemainingSource: route.distanceMeters != null ? 'apple' : null,
    bearingDeg: null,
    headingErrorDeg: null,
    command: { left: 0, right: 0, mode: 'stop' },
    reason: 'idle',
  };
}

function findStepIndex(steps: NavStep[], waypointIndex: number): number {
  let running = 0;
  for (let i = 0; i < steps.length; i += 1) {
    const count = steps[i].waypoints.length;
    if (waypointIndex < running + count) return i;
    running += count;
  }
  return Math.max(0, steps.length - 1);
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function routeSignature(route: NavRoute): string {
  const n = route.waypoints.length;
  if (n === 0) return '0';
  const first = route.waypoints[0];
  const last = route.waypoints[n - 1];
  return `${n}:${first.latitude.toFixed(6)},${first.longitude.toFixed(6)}:${last.latitude.toFixed(6)},${last.longitude.toFixed(6)}`;
}

function timestamp(): string {
  const d = new Date();
  return d.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function maybeSendCommand(
  piLink: PiLink,
  enabled: boolean,
  lastCommandAtRef: React.MutableRefObject<number>,
  pushDebug: (message: string) => void,
  command: NavCommand,
  reason: string
) {
  if (!enabled) return;
  if (piLink.getStatus() !== 'open') return;

  const now = Date.now();
  if (now - lastCommandAtRef.current < COMMAND_MIN_INTERVAL_MS) return;

  let ok = false;
  if (command.mode === 'stop') {
    ok = piLink.sendStop();
  } else {
    ok = piLink.sendDrive(command.left, command.right);
  }
  if (ok) {
    lastCommandAtRef.current = now;
    pushDebug(`pi <- ${command.mode} L=${command.left} R=${command.right}  (${reason})`);
  } else {
    pushDebug(`pi <- send dropped (${command.mode}); socket not ready`);
  }
}

function maybeStopMotors(
  piLink: PiLink,
  enabled: boolean,
  lastCommandAtRef: React.MutableRefObject<number>,
  pushDebug: (message: string) => void,
  force = false
) {
  if (!enabled && !force) return;
  if (piLink.getStatus() !== 'open') return;
  const now = Date.now();
  if (!force && now - lastCommandAtRef.current < COMMAND_MIN_INTERVAL_MS) return;
  if (piLink.sendStop()) {
    lastCommandAtRef.current = now;
    pushDebug('pi <- stop (idle/arrived)');
  }
}
