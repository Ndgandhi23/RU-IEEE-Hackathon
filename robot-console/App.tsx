import { StatusBar } from 'expo-status-bar';
import * as Location from 'expo-location';
import { startTransition, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';

import { PiLink, type PiStatus, type PiTelemetry } from './pi-link';
import { useRobotNav, type NavRoute } from './nav-loop';

// ===========================================================================
// Types
// ===========================================================================

type Coordinates = {
  latitude: number;
  longitude: number;
  accuracy?: number | null;
  heading?: number | null;
  headingAccuracy?: number | null;
  timestamp: string;
};

type NavigationWaypoint = {
  latitude: number;
  longitude: number;
};

type RobotNavigationStep = {
  index: number;
  instruction: string | null;
  distanceMeters: number | null;
  expectedTravelTimeSeconds: number | null;
  waypoints: NavigationWaypoint[];
};

type RobotNavigation = {
  provider: 'apple-maps';
  transportType: string;
  distanceMeters: number | null;
  expectedTravelTimeSeconds: number | null;
  waypointCount: number;
  waypoints: NavigationWaypoint[];
  steps: RobotNavigationStep[];
};

type RobotTask = {
  id: string;
  createdAt: string;
  destination: Coordinates;
  navigation: RobotNavigation | null;
};

type RobotPacket = {
  status: 'idle' | 'assigned';
  current: Coordinates | null;
  queue: {
    pendingCount: number;
  };
  task: RobotTask | null;
};

type LogCategory = 'gps' | 'relay' | 'pi' | 'nav' | 'system';
type LogEntry = { ts: string; category: LogCategory; message: string };
type TabKey = 'gps' | 'task' | 'pi' | 'nav' | 'logs';

type RelayIO = (
  phase: 'request' | 'response' | 'error',
  message: string
) => void;

// ===========================================================================
// Constants
// ===========================================================================

const API_BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL?.replace(/\/$/, '') ?? '';
const PI_WS_URL = process.env.EXPO_PUBLIC_PI_WS_URL?.replace(/\/$/, '') ?? '';
const INITIAL_HEADING_TIMEOUT_MS = 3000;
const IDLE_ASSIGNMENT_PING_MS = 8000;
// While assigned, throttle outbound heartbeats so the relay can re-route
// with fresh GPS but we don't hammer it on every compass twitch.
const ASSIGNED_HEARTBEAT_MIN_INTERVAL_MS = 1500;
const MAX_LOGS = 250;

const emptyPacket: RobotPacket = {
  status: 'idle',
  current: null,
  task: null,
  queue: {
    pendingCount: 0,
  },
};

const TABS: { key: TabKey; label: string }[] = [
  { key: 'gps', label: 'GPS' },
  { key: 'task', label: 'Task' },
  { key: 'pi', label: 'Pi' },
  { key: 'nav', label: 'Nav' },
  { key: 'logs', label: 'Logs' },
];

const LOG_COLORS: Record<LogCategory, string> = {
  gps: '#1C6DD0',
  relay: '#1E7B52',
  pi: '#B35C00',
  nav: '#6B3EA8',
  system: '#4A5250',
};

// ===========================================================================
// App
// ===========================================================================

export default function App() {
  const [packet, setPacket] = useState<RobotPacket>(emptyPacket);
  const [locationBusy, setLocationBusy] = useState(false);
  const [completeBusy, setCompleteBusy] = useState(false);
  const [trackingEnabled, setTrackingEnabled] = useState(false);
  const [tab, setTab] = useState<TabKey>('gps');
  const [logs, setLogs] = useState<LogEntry[]>([]);

  const watchRef = useRef<Location.LocationSubscription | null>(null);
  const headingRef = useRef<Location.LocationSubscription | null>(null);
  const currentLocationRef = useRef<Coordinates | null>(null);
  const idlePingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastAssignedHeartbeatAtRef = useRef(0);

  // --- Pi WebSocket wiring -------------------------------------------------
  const piLinkRef = useRef<PiLink | null>(null);
  if (!piLinkRef.current) {
    piLinkRef.current = new PiLink();
  }
  const piLink = piLinkRef.current;

  const [piStatus, setPiStatus] = useState<PiStatus>('idle');
  const [piWantsConnect, setPiWantsConnect] = useState(false);
  const [motorsEnabled, setMotorsEnabled] = useState(false);
  const [piTelemetry, setPiTelemetry] = useState<PiTelemetry | null>(null);

  // --- Logging -------------------------------------------------------------
  // Single ring-buffered log store, tagged by category. Each tab renders its
  // own filtered view; the Logs tab shows everything interleaved.

  function pushLog(category: LogCategory, message: string) {
    const ts = new Date().toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    console.log(`[${category}] ${ts} ${message}`);
    setLogs((current) => {
      const next: LogEntry[] = [...current, { ts, category, message }];
      return next.length > MAX_LOGS ? next.slice(-MAX_LOGS) : next;
    });
  }

  const pushGps = (m: string) => pushLog('gps', m);
  const pushRelay = (m: string) => pushLog('relay', m);
  const pushPi = (m: string) => pushLog('pi', m);
  const pushSystem = (m: string) => pushLog('system', m);

  function recordRelayIO(
    source: string
  ): RelayIO {
    return (phase, message) => {
      if (phase === 'error') {
        pushRelay(`✖ ${source}: ${message}`);
      } else if (phase === 'request') {
        pushRelay(`→ ${source}: ${message}`);
      } else {
        pushRelay(`← ${source}: ${message}`);
      }
    };
  }

  // --- Pi link bookkeeping -------------------------------------------------

  useEffect(() => {
    const unsubscribe = piLink.subscribe((event) => {
      if (event.kind === 'status') {
        setPiStatus(event.status);
        pushPi(`status -> ${event.status}${event.detail ? ` (${event.detail})` : ''}`);
      } else if (event.kind === 'log') {
        pushPi(event.message);
      } else if (event.kind === 'telemetry') {
        setPiTelemetry(event.telemetry);
      }
    });
    return () => {
      unsubscribe();
      piLink.disconnect('unmount');
    };
    // piLink is stable for the lifetime of the component.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (piWantsConnect) {
      if (!PI_WS_URL) {
        Alert.alert(
          'Pi URL missing',
          'Set EXPO_PUBLIC_PI_WS_URL in robot-console/.env (e.g. ws://192.168.1.50:8765).'
        );
        setPiWantsConnect(false);
        return;
      }
      piLink.connect(PI_WS_URL);
    } else {
      piLink.disconnect('toggle-off');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [piWantsConnect]);

  useEffect(() => {
    if (!motorsEnabled && piStatus === 'open') {
      piLink.sendStop();
      pushPi('motors disabled -> sent stop');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [motorsEnabled, piStatus]);

  // --- Nav loop ------------------------------------------------------------

  const pose = useMemo(
    () => ({
      location: packet.current
        ? { latitude: packet.current.latitude, longitude: packet.current.longitude }
        : null,
      headingDeg: packet.current?.heading ?? null,
    }),
    [packet.current]
  );

  // Memoize the adapted task so we don't hand `useRobotNav` a fresh object
  // on every render (which would retrigger its reset effect nonstop).
  const taskForNav = useMemo(() => {
    if (!packet.task) return null;
    return {
      id: packet.task.id,
      navigation: adaptNavigation(packet.task.navigation),
      destination: {
        latitude: packet.task.destination.latitude,
        longitude: packet.task.destination.longitude,
      },
    };
  }, [packet.task]);

  const nav = useRobotNav({
    task: taskForNav,
    pose,
    piLink,
    enabled: motorsEnabled && piStatus === 'open',
    onLog: (m) => pushLog('nav', m),
  });

  // --- Lifecycle -----------------------------------------------------------

  useEffect(() => {
    pushSystem(
      `boot: relay=${API_BASE_URL || '(unset)'} piWs=${PI_WS_URL || '(unset)'}`
    );
    return () => {
      stopTracking();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Relay helpers (bound to current pushLog) ----------------------------

  async function syncPacket(showError = true, source = 'manual-sync') {
    if (!API_BASE_URL) {
      if (showError) {
        Alert.alert('Relay missing', 'Set EXPO_PUBLIC_API_BASE_URL in robot-console/.env first.');
      }
      pushRelay(`${source}: skipped — relay URL missing`);
      return;
    }

    try {
      if (currentLocationRef.current) {
        const nextPacket = await sendRobotHeartbeat(
          currentLocationRef.current,
          recordRelayIO(source)
        );
        currentLocationRef.current = nextPacket.current ?? currentLocationRef.current;
        setPacket(nextPacket);
        syncIdlePing(nextPacket.status);
        return;
      }

      const nextPacket = await fetchRobotPacket(recordRelayIO(source));
      currentLocationRef.current = nextPacket.current;
      setPacket(nextPacket);
      syncIdlePing(nextPacket.status);
    } catch (error) {
      if (showError) {
        Alert.alert(
          'Robot queue unavailable',
          error instanceof Error ? error.message : 'Could not sync the robot packet.'
        );
      }
    }
  }

  async function publishRobotLocation(location: Coordinates, source = 'publish') {
    if (!API_BASE_URL) {
      pushRelay(`${source}: skipped — relay URL missing`);
      Alert.alert('Relay missing', 'Set EXPO_PUBLIC_API_BASE_URL in robot-console/.env first.');
      return emptyPacket;
    }

    pushGps(
      `${source}: lat=${location.latitude.toFixed(6)} lon=${location.longitude.toFixed(6)} hdg=${location.heading?.toFixed(1) ?? 'null'}`
    );
    currentLocationRef.current = location;
    startTransition(() => {
      setPacket((currentPacket) => ({
        ...currentPacket,
        current: location,
      }));
    });

    const nextPacket = await sendRobotHeartbeat(location, recordRelayIO(source));
    currentLocationRef.current = nextPacket.current ?? location;
    setPacket(nextPacket);
    syncIdlePing(nextPacket.status);
    return nextPacket;
  }

  // --- GPS tracking --------------------------------------------------------

  async function startTracking() {
    if (watchRef.current) {
      pushGps('tracking: already running');
      return;
    }

    try {
      setLocationBusy(true);
      pushGps('tracking: requesting foreground permission');
      const permission = await Location.requestForegroundPermissionsAsync();
      pushGps(`tracking: permission status = ${permission.status}`);
      if (!permission.granted) {
        Alert.alert(
          'Location permission needed',
          'Allow location access before enabling continuous tracking.'
        );
        return;
      }

      pushGps('tracking: requesting initial position');
      const currentPosition = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      pushGps(
        `tracking: initial position lat=${currentPosition.coords.latitude.toFixed(6)} lon=${currentPosition.coords.longitude.toFixed(6)}`
      );
      pushGps('tracking: requesting initial heading');
      const currentHeading = await getInitialHeadingSnapshot(pushGps);
      const initialPacket = await publishRobotLocation(
        normalizeCoordinates(
          currentPosition.coords,
          currentPosition.timestamp,
          currentHeading
        ),
        'tracking-start'
      );

      pushGps('tracking: starting watchPositionAsync');
      watchRef.current = await Location.watchPositionAsync(
        {
          accuracy: Location.Accuracy.Balanced,
          timeInterval: 2000,
          distanceInterval: 2,
        },
        (position) => {
          const nextLocation = normalizeCoordinates(
            position.coords,
            position.timestamp,
            currentLocationRef.current
          );
          currentLocationRef.current = nextLocation;
          setPacket((currentPacket) => ({
            ...currentPacket,
            current: nextLocation,
          }));

          // Push the fresh GPS to the relay on a throttle so Apple Maps
          // gets to re-route from where we actually are (recovers from
          // overshoots automatically).
          const now = Date.now();
          const since = now - lastAssignedHeartbeatAtRef.current;
          if (since >= ASSIGNED_HEARTBEAT_MIN_INTERVAL_MS) {
            lastAssignedHeartbeatAtRef.current = now;
            void publishRobotLocation(nextLocation, 'gps-watch').catch(() => {});
          }
        }
      );
      pushGps('tracking: watchPositionAsync attached');

      pushGps('tracking: starting watchHeadingAsync');
      headingRef.current = await Location.watchHeadingAsync((heading) => {
        const headingSnapshot = normalizeHeading(heading);
        const currentLocation = currentLocationRef.current;
        if (!currentLocation) return;

        const nextLocation: Coordinates = {
          ...currentLocation,
          heading: headingSnapshot.heading,
          headingAccuracy: headingSnapshot.headingAccuracy,
        };

        currentLocationRef.current = nextLocation;
        setPacket((currentPacket) => ({
          ...currentPacket,
          current: nextLocation,
        }));
      });
      pushGps('tracking: watchHeadingAsync attached');

      setTrackingEnabled(true);
      syncIdlePing(initialPacket.status, true);
      pushSystem('tracking: enabled');
    } catch (error) {
      pushGps(
        `tracking: failed - ${error instanceof Error ? error.message : 'unknown error'}`
      );
      Alert.alert(
        'Tracking unavailable',
        error instanceof Error ? error.message : 'Could not start robot tracking.'
      );
    } finally {
      setLocationBusy(false);
    }
  }

  function stopTracking() {
    stopIdlePing();
    watchRef.current?.remove();
    watchRef.current = null;
    headingRef.current?.remove();
    headingRef.current = null;
    setTrackingEnabled(false);
    pushSystem('tracking: stopped');
  }

  function startIdlePing() {
    if (idlePingRef.current) return;
    pushRelay('idle-ping: starting assignment check loop (8s)');
    idlePingRef.current = setInterval(() => {
      if (!currentLocationRef.current) {
        pushRelay('idle-ping: skipped — no current location yet');
        return;
      }
      void syncPacket(false, 'idle-ping');
    }, IDLE_ASSIGNMENT_PING_MS);
  }

  function stopIdlePing() {
    if (!idlePingRef.current) return;
    clearInterval(idlePingRef.current);
    idlePingRef.current = null;
    pushRelay('idle-ping: loop stopped');
  }

  function syncIdlePing(status: RobotPacket['status'], forceStart = false) {
    if (!trackingEnabled && !forceStart) return;
    if (status === 'idle') {
      startIdlePing();
      return;
    }
    stopIdlePing();
  }

  async function handleCompleteTask() {
    if (!packet.task?.id) return;

    try {
      setCompleteBusy(true);
      const nextPacket = await completeRobotTask(
        packet.task.id,
        currentLocationRef.current,
        recordRelayIO('complete-task')
      );
      currentLocationRef.current = nextPacket.current;
      setPacket(nextPacket);
      syncIdlePing(nextPacket.status);
    } catch (error) {
      Alert.alert(
        'Task completion failed',
        error instanceof Error ? error.message : 'Could not complete the current robot task.'
      );
    } finally {
      setCompleteBusy(false);
    }
  }

  // --- Derived log views ---------------------------------------------------

  const logsByCategory = useMemo(() => {
    const groups: Record<LogCategory, LogEntry[]> = {
      gps: [],
      relay: [],
      pi: [],
      nav: [],
      system: [],
    };
    for (const entry of logs) {
      groups[entry.category].push(entry);
    }
    return groups;
  }, [logs]);

  // ===========================================================================
  // Render
  // ===========================================================================

  return (
    <View style={styles.screen}>
      <View style={styles.headerStrip}>
        <Text style={styles.headerBadge}>ROBOT CONSOLE</Text>
        <View style={styles.headerPills}>
          <Text style={[styles.pill, API_BASE_URL ? styles.pillOk : styles.pillWarn]}>
            {API_BASE_URL ? `relay ok` : 'no relay'}
          </Text>
          <Text style={[styles.pill, trackingEnabled ? styles.pillOk : styles.pillMuted]}>
            {trackingEnabled ? 'gps on' : 'gps off'}
          </Text>
          <Text
            style={[
              styles.pill,
              piStatus === 'open'
                ? styles.pillOk
                : piStatus === 'connecting'
                  ? styles.pillWarn
                  : styles.pillMuted,
            ]}
          >
            {`pi ${piStatus}`}
          </Text>
          <Text
            style={[
              styles.pill,
              motorsEnabled && piStatus === 'open'
                ? styles.pillDanger
                : styles.pillMuted,
            ]}
          >
            {motorsEnabled && piStatus === 'open' ? 'motors LIVE' : 'motors off'}
          </Text>
          <Text
            style={[
              styles.pill,
              packet.status === 'assigned' ? styles.pillOk : styles.pillMuted,
            ]}
          >
            {packet.status === 'assigned'
              ? `task ${packet.task?.id?.slice(0, 6) ?? '?'}`
              : 'idle'}
          </Text>
          {nav.decision.arrived ? (
            <Text style={[styles.pill, styles.pillOk]}>ARRIVED</Text>
          ) : null}
        </View>
      </View>

      <View style={styles.tabBar}>
        {TABS.map((t) => (
          <Pressable
            key={t.key}
            onPress={() => setTab(t.key)}
            style={[styles.tabBtn, tab === t.key && styles.tabBtnActive]}
          >
            <Text
              style={[styles.tabLabel, tab === t.key && styles.tabLabelActive]}
            >
              {t.label}
            </Text>
          </Pressable>
        ))}
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        {tab === 'gps' && (
          <GpsTab
            packet={packet}
            trackingEnabled={trackingEnabled}
            locationBusy={locationBusy}
            onStart={startTracking}
            onStop={stopTracking}
            logs={logsByCategory.gps}
          />
        )}

        {tab === 'task' && (
          <TaskTab
            packet={packet}
            completeBusy={completeBusy}
            onComplete={handleCompleteTask}
            onResync={() => void syncPacket(true, 'manual-resync')}
            logs={logsByCategory.relay}
          />
        )}

        {tab === 'pi' && (
          <PiTab
            piLink={piLink}
            piStatus={piStatus}
            piTelemetry={piTelemetry}
            piWantsConnect={piWantsConnect}
            motorsEnabled={motorsEnabled}
            onToggleConnect={() => setPiWantsConnect((v) => !v)}
            onToggleMotors={setMotorsEnabled}
            onManualStop={() => {
              piLink.sendStop();
              pushPi('manual STOP');
            }}
            onResetEncoders={() => {
              piLink.sendResetEncoders();
              pushPi('encoder reset');
            }}
            logs={logsByCategory.pi}
          />
        )}

        {tab === 'nav' && (
          <NavTab
            nav={nav}
            motorsLive={motorsEnabled && piStatus === 'open'}
            rawNavigation={packet.task?.navigation ?? null}
            logs={logsByCategory.nav}
          />
        )}

        {tab === 'logs' && <LogsTab logs={logs} onClear={() => setLogs([])} />}
      </ScrollView>
      <StatusBar style="light" />
    </View>
  );
}

// ===========================================================================
// Tabs
// ===========================================================================

function GpsTab({
  packet,
  trackingEnabled,
  locationBusy,
  onStart,
  onStop,
  logs,
}: {
  packet: RobotPacket;
  trackingEnabled: boolean;
  locationBusy: boolean;
  onStart: () => void;
  onStop: () => void;
  logs: LogEntry[];
}) {
  return (
    <>
      <Card
        title="Auto mode"
        subtitle="Grabs foreground location + heading and streams heartbeats. The relay uses those heartbeats to (re)compute Apple Maps routes."
      >
        <View style={styles.buttonColumn}>
          <ActionButton
            label={
              trackingEnabled
                ? 'Stop auto mode'
                : locationBusy
                  ? 'Starting...'
                  : 'Start auto mode'
            }
            onPress={trackingEnabled ? onStop : onStart}
            variant={trackingEnabled ? 'danger' : 'primary'}
            disabled={locationBusy}
          />
        </View>
        <DataRow label="Auto mode" value={trackingEnabled ? 'Active' : 'Idle'} />
      </Card>

      <Card title="Current pose" subtitle="Last fix reported by the phone.">
        {packet.current ? (
          <View style={styles.dataBlock}>
            <DataRow label="Latitude" value={formatCoordinate(packet.current.latitude)} />
            <DataRow label="Longitude" value={formatCoordinate(packet.current.longitude)} />
            <DataRow
              label="Accuracy"
              value={
                packet.current.accuracy != null
                  ? `${packet.current.accuracy.toFixed(1)} m`
                  : 'Unknown'
              }
            />
            <DataRow
              label="Heading"
              value={
                packet.current.heading != null
                  ? `${packet.current.heading.toFixed(1)}°`
                  : 'No heading yet'
              }
            />
            <DataRow
              label="Heading accuracy"
              value={
                packet.current.headingAccuracy != null
                  ? `${packet.current.headingAccuracy.toFixed(1)}°`
                  : 'Unknown'
              }
            />
            <DataRow label="Timestamp" value={formatTimestamp(packet.current.timestamp)} />
          </View>
        ) : (
          <Text style={styles.helperText}>No location captured yet.</Text>
        )}
      </Card>

      <LogCard title="GPS log" logs={logs} placeholder="No GPS events yet" />
    </>
  );
}

function TaskTab({
  packet,
  completeBusy,
  onComplete,
  onResync,
  logs,
}: {
  packet: RobotPacket;
  completeBusy: boolean;
  onComplete: () => void;
  onResync: () => void;
  logs: LogEntry[];
}) {
  return (
    <>
      <Card
        title="Queue"
        subtitle="The relay picks the nearest pending report for the robot on every heartbeat."
      >
        <DataRow label="Status" value={packet.status} />
        <DataRow label="Pending reports" value={String(packet.queue.pendingCount)} />
        <DataRow label="Active task id" value={packet.task?.id ?? 'None'} />
        <View style={styles.buttonColumn}>
          <ActionButton
            label={completeBusy ? 'Completing…' : 'Complete current task'}
            onPress={onComplete}
            variant="primary"
            disabled={!packet.task?.id || completeBusy}
          />
          <ActionButton
            label="Resync packet"
            onPress={onResync}
            variant="secondary"
          />
        </View>
      </Card>

      {packet.task ? (
        <Card title="Assigned target" subtitle="Reporter GPS + walking route from Apple Maps.">
          <DataRow label="Target lat" value={formatCoordinate(packet.task.destination.latitude)} />
          <DataRow label="Target lon" value={formatCoordinate(packet.task.destination.longitude)} />
          <DataRow label="Reported at" value={formatTimestamp(packet.task.destination.timestamp)} />
          <DataRow
            label="Route distance"
            value={formatMeters(packet.task.navigation?.distanceMeters)}
          />
          <DataRow
            label="Route ETA"
            value={formatSeconds(packet.task.navigation?.expectedTravelTimeSeconds)}
          />
          <DataRow
            label="Waypoint count"
            value={String(packet.task.navigation?.waypointCount ?? 0)}
          />
          <DataRow
            label="Step count"
            value={String(packet.task.navigation?.steps.length ?? 0)}
          />
        </Card>
      ) : (
        <Card title="Assigned target" subtitle="No task yet.">
          <Text style={styles.helperText}>
            Submit a report from the app. Once the relay assigns it, the route will appear here.
          </Text>
        </Card>
      )}

      <Card
        title="Raw packet JSON"
        subtitle="Exactly what /robot/packet and /robot/heartbeat return."
      >
        <Text style={styles.jsonBlock}>{JSON.stringify(packet, null, 2)}</Text>
      </Card>

      <LogCard title="Relay I/O log" logs={logs} placeholder="No relay traffic yet" />
    </>
  );
}

function PiTab({
  piLink,
  piStatus,
  piTelemetry,
  piWantsConnect,
  motorsEnabled,
  onToggleConnect,
  onToggleMotors,
  onManualStop,
  onResetEncoders,
  logs,
}: {
  piLink: PiLink;
  piStatus: PiStatus;
  piTelemetry: PiTelemetry | null;
  piWantsConnect: boolean;
  motorsEnabled: boolean;
  onToggleConnect: () => void;
  onToggleMotors: (v: boolean) => void;
  onManualStop: () => void;
  onResetEncoders: () => void;
  logs: LogEntry[];
}) {
  const msSince = piLink.msSinceLastSend();
  return (
    <>
      <Card
        title="Pi WebSocket link"
        subtitle="Connects to the Pi's motor_controller at ws://<pi>:8765. Telemetry pushes every ~50ms."
      >
        <View style={styles.buttonColumn}>
          <ActionButton
            label={
              piStatus === 'open'
                ? 'Disconnect'
                : piStatus === 'connecting' || piWantsConnect
                  ? 'Connecting…'
                  : 'Connect'
            }
            onPress={onToggleConnect}
            variant={piStatus === 'open' ? 'danger' : 'primary'}
            disabled={!PI_WS_URL}
          />
          <ActionButton
            label="Send STOP"
            onPress={onManualStop}
            variant="secondary"
            disabled={piStatus !== 'open'}
          />
          <ActionButton
            label="Reset encoders"
            onPress={onResetEncoders}
            variant="secondary"
            disabled={piStatus !== 'open'}
          />
        </View>
        <DataRow label="Socket" value={piStatus} />
        <DataRow label="Pi URL" value={PI_WS_URL || 'unset'} />
        <DataRow
          label="Last cmd sent"
          value={
            msSince === Number.POSITIVE_INFINITY
              ? 'Never'
              : `${Math.round(msSince)} ms ago`
          }
        />
      </Card>

      <Card
        title="Motor safety"
        subtitle="Until you flip this, nav commands are computed but never sent to the driver."
      >
        <View style={styles.switchRow}>
          <View style={styles.switchLabels}>
            <Text style={styles.switchLabel}>Enable motors</Text>
            <Text style={styles.switchHelp}>
              Requires an open socket. Disabling sends an immediate stop. The Pi's 500ms
              watchdog will halt motors on its own if commands stop flowing.
            </Text>
          </View>
          <Switch
            value={motorsEnabled}
            onValueChange={onToggleMotors}
            disabled={piStatus !== 'open'}
          />
        </View>
      </Card>

      <Card title="Telemetry" subtitle="Pushed from the Pi at ~20Hz.">
        {piTelemetry ? (
          <View style={styles.dataBlock}>
            <DataRow
              label="Encoder counts"
              value={`L=${piTelemetry.encoders.left}  R=${piTelemetry.encoders.right}`}
            />
            <DataRow
              label="Motor PWM"
              value={`L=${piTelemetry.motors.left}  R=${piTelemetry.motors.right}`}
            />
            <DataRow
              label="Watchdog"
              value={piTelemetry.watchdog_ok ? 'OK' : 'TRIPPED (motors halted)'}
            />
            <DataRow label="Pi clock" value={`${piTelemetry.ts.toFixed(2)} s`} />
          </View>
        ) : (
          <Text style={styles.helperText}>No telemetry yet — open the socket and wait a moment.</Text>
        )}
      </Card>

      <LogCard title="Pi link log" logs={logs} placeholder="No Pi events yet" />
    </>
  );
}

function NavTab({
  nav,
  motorsLive,
  rawNavigation,
  logs,
}: {
  nav: ReturnType<typeof useRobotNav>;
  motorsLive: boolean;
  rawNavigation: RobotNavigation | null;
  logs: LogEntry[];
}) {
  const totalWaypoints = nav.route?.waypoints.length ?? 0;
  const totalSteps = nav.route?.steps.length ?? 0;
  const wpLabel = nav.route
    ? `${Math.min(nav.decision.waypointIndex + 1, totalWaypoints)} / ${totalWaypoints}`
    : '—';
  const stepLabel = nav.route ? `${nav.decision.stepIndex + 1} / ${totalSteps}` : '—';

  const diagnostic = buildNavDiagnostic(rawNavigation, nav);

  return (
    <>
      <Card
        title="Loop status"
        subtitle="Derives motor commands from GPS + compass and the Apple Maps step list."
      >
        <DataRow label="Motor gating" value={motorsLive ? 'LIVE (sending)' : 'dry-run (computed only)'} />
        <DataRow
          label="Route source"
          value={
            nav.route == null
              ? '—'
              : nav.routeSynthetic
                ? 'straight-line fallback (no Apple steps)'
                : 'Apple Maps step list'
          }
        />
        <DataRow
          label="Arrived"
          value={nav.decision.arrived ? 'YES — search phase' : 'No'}
        />
        <DataRow label="Step" value={stepLabel} />
        <DataRow
          label="Instruction"
          value={nav.decision.stepInstruction ?? (nav.route ? '(no turn text)' : '—')}
        />
        <DataRow label="Waypoint" value={wpLabel} />
        {diagnostic ? (
          <View style={styles.diagnosticBox}>
            <Text style={styles.diagnosticTitle}>⚠ {diagnostic.title}</Text>
            <Text style={styles.diagnosticBody}>{diagnostic.body}</Text>
          </View>
        ) : null}
      </Card>

      <Card title="Vector to next waypoint" subtitle="">
        <DataRow
          label="Distance"
          value={formatMeters(nav.decision.distanceToTargetM ?? null)}
        />
        <DataRow
          label="Bearing"
          value={nav.decision.bearingDeg != null ? `${nav.decision.bearingDeg.toFixed(0)}°` : '—'}
        />
        <DataRow
          label="Heading error"
          value={
            nav.decision.headingErrorDeg != null
              ? `${nav.decision.headingErrorDeg.toFixed(0)}°`
              : '— (no compass)'
          }
        />
      </Card>

      <Card title="Proposed motor command" subtitle="Only sent when motors are LIVE.">
        <DataRow label="Mode" value={nav.decision.command.mode} />
        <DataRow
          label="PWM"
          value={`L=${nav.decision.command.left}  R=${nav.decision.command.right}`}
        />
        <Text style={styles.jsonLabel}>Reason</Text>
        <Text style={styles.jsonBlock}>{nav.decision.reason}</Text>
      </Card>

      <Card
        title="Apple step list"
        subtitle="Every turn the relay got back from Apple Maps. The active step is highlighted."
      >
        {rawNavigation ? (
          <>
            <DataRow label="Provider" value={rawNavigation.provider} />
            <DataRow label="Transport" value={rawNavigation.transportType} />
            <DataRow
              label="Total distance"
              value={formatMeters(rawNavigation.distanceMeters)}
            />
            <DataRow
              label="Total ETA"
              value={formatSeconds(rawNavigation.expectedTravelTimeSeconds)}
            />
            <DataRow
              label="Steps"
              value={`${rawNavigation.steps.length} (${rawNavigation.steps.reduce((n, s) => n + s.waypoints.length, 0)} step waypoints)`}
            />
            <DataRow
              label="Top-level waypoints"
              value={`${rawNavigation.waypointCount} reported / ${rawNavigation.waypoints.length} present`}
            />
            {rawNavigation.steps.length === 0 ? (
              <Text style={styles.helperText}>
                Apple Maps returned no turn-by-turn steps. This is normal for very
                short trips (e.g. the report is in the same plaza and Apple's
                answer is essentially "walk straight"). The nav loop has switched
                to a straight-line fallback toward the report GPS — distance and
                bearing above are accurate. If you expected turns here, hit{' '}
                <Text style={styles.mono}>/health?appleRouteProbe=1</Text> on the
                relay to confirm the route body isn't malformed.
              </Text>
            ) : (
              <View style={styles.stepList}>
                {rawNavigation.steps.map((step) => {
                  const active = step.index === nav.decision.stepIndex;
                  return (
                    <View
                      key={step.index}
                      style={[styles.stepRow, active && styles.stepRowActive]}
                    >
                      <Text style={styles.stepIndex}>
                        {active ? '▶' : ' '} {step.index + 1}.
                      </Text>
                      <View style={styles.stepBody}>
                        <Text style={[styles.stepInstruction, active && styles.stepActiveText]}>
                          {step.instruction ?? '(no turn text)'}
                        </Text>
                        <Text style={styles.stepMeta}>
                          {formatMeters(step.distanceMeters)} ·{' '}
                          {formatSeconds(step.expectedTravelTimeSeconds)} ·{' '}
                          {step.waypoints.length} wp
                        </Text>
                      </View>
                    </View>
                  );
                })}
              </View>
            )}
          </>
        ) : (
          <Text style={styles.helperText}>
            No navigation object in the current packet. Either no task is assigned, or
            the relay couldn't fetch an Apple Maps route (auth not configured, no
            network, etc.).
          </Text>
        )}
      </Card>

      <Card
        title="Raw navigation JSON"
        subtitle="Exactly what's inside packet.task.navigation."
      >
        <Text style={styles.jsonBlock}>
          {rawNavigation ? JSON.stringify(rawNavigation, null, 2) : 'null'}
        </Text>
      </Card>

      <LogCard title="Nav log" logs={logs} placeholder="No nav events yet" />
    </>
  );
}

function buildNavDiagnostic(
  rawNavigation: RobotNavigation | null,
  nav: ReturnType<typeof useRobotNav>
): { title: string; body: string } | null {
  if (!nav.route) {
    if (!rawNavigation) {
      return {
        title: 'No route from relay',
        body:
          'No Apple Maps route is attached to the current task. Either no report is assigned, or the relay could not reach Apple Maps. Check the relay logs for [apple] errors and /health?appleRouteProbe=1.',
      };
    }
    return null;
  }

  if (nav.routeSynthetic) {
    return {
      title: 'Straight-line fallback in use',
      body:
        'Apple Maps returned no usable waypoints for this trip (usually because the report is very close — a short walk with no turns). The nav loop is navigating directly toward the report GPS using distance + bearing. Expect "Arrived" to fire as soon as you\'re within ~3 m.',
    };
  }

  return null;
}

function LogsTab({ logs, onClear }: { logs: LogEntry[]; onClear: () => void }) {
  return (
    <Card
      title="All logs"
      subtitle="Everything the console has logged since boot, color-coded by source. Newest at the bottom."
    >
      <View style={styles.buttonColumn}>
        <ActionButton label="Clear logs" onPress={onClear} variant="secondary" />
      </View>
      <DataRow label="Entries" value={`${logs.length} / ${MAX_LOGS}`} />
      <View style={styles.logBlock}>
        {logs.length === 0 ? (
          <Text style={styles.helperText}>No events yet.</Text>
        ) : (
          logs.map((entry, i) => (
            <Text key={i} style={styles.logLine}>
              <Text style={styles.logTs}>{entry.ts}  </Text>
              <Text style={[styles.logCat, { color: LOG_COLORS[entry.category] }]}>
                {`[${entry.category}] `}
              </Text>
              <Text style={styles.logMsg}>{entry.message}</Text>
            </Text>
          ))
        )}
      </View>
    </Card>
  );
}

// ===========================================================================
// Log card (shared per-tab log renderer)
// ===========================================================================

function LogCard({
  title,
  logs,
  placeholder,
}: {
  title: string;
  logs: LogEntry[];
  placeholder: string;
}) {
  return (
    <Card title={title} subtitle="Newest entries at the bottom.">
      <View style={styles.logBlock}>
        {logs.length === 0 ? (
          <Text style={styles.helperText}>{placeholder}</Text>
        ) : (
          logs.map((entry, i) => (
            <Text key={i} style={styles.logLine}>
              <Text style={styles.logTs}>{entry.ts}  </Text>
              <Text style={styles.logMsg}>{entry.message}</Text>
            </Text>
          ))
        )}
      </View>
    </Card>
  );
}

// ===========================================================================
// HTTP helpers (all accept an optional onIO for request-level debug logging)
// ===========================================================================

async function sendRobotHeartbeat(
  location: Coordinates,
  onIO?: RelayIO
): Promise<RobotPacket> {
  const body = {
    location,
    sentAt: new Date().toISOString(),
  };
  onIO?.(
    'request',
    `POST /robot/heartbeat lat=${location.latitude.toFixed(6)} lon=${location.longitude.toFixed(6)}`
  );
  try {
    const response = await fetch(`${requireRelayBaseUrl()}/robot/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const msg = `heartbeat ${response.status}`;
      onIO?.('error', msg);
      throw new Error(msg);
    }
    const payload = (await response.json()) as { packet: RobotPacket };
    onIO?.(
      'response',
      `packet status=${payload.packet.status} task=${payload.packet.task?.id ?? 'none'} pending=${payload.packet.queue.pendingCount}`
    );
    return payload.packet;
  } catch (error) {
    if (!(error instanceof Error && error.message.startsWith('heartbeat '))) {
      onIO?.(
        'error',
        `heartbeat network: ${error instanceof Error ? error.message : 'unknown'}`
      );
    }
    throw error;
  }
}

async function fetchRobotPacket(onIO?: RelayIO): Promise<RobotPacket> {
  onIO?.('request', 'GET /robot/packet');
  try {
    const response = await fetch(`${requireRelayBaseUrl()}/robot/packet`);
    if (!response.ok) {
      const msg = `packet ${response.status}`;
      onIO?.('error', msg);
      throw new Error(msg);
    }
    const payload = (await response.json()) as { packet: RobotPacket };
    onIO?.(
      'response',
      `packet status=${payload.packet.status} task=${payload.packet.task?.id ?? 'none'}`
    );
    return payload.packet;
  } catch (error) {
    if (!(error instanceof Error && error.message.startsWith('packet '))) {
      onIO?.(
        'error',
        `packet network: ${error instanceof Error ? error.message : 'unknown'}`
      );
    }
    throw error;
  }
}

async function completeRobotTask(
  taskId: string,
  location: Coordinates | null,
  onIO?: RelayIO
): Promise<RobotPacket> {
  onIO?.('request', `POST /robot/task/complete taskId=${taskId}`);
  try {
    const response = await fetch(`${requireRelayBaseUrl()}/robot/task/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        taskId,
        location,
        sentAt: new Date().toISOString(),
      }),
    });
    if (!response.ok) {
      const msg = `complete ${response.status}`;
      onIO?.('error', msg);
      throw new Error(msg);
    }
    const payload = (await response.json()) as { packet: RobotPacket };
    onIO?.(
      'response',
      `next task=${payload.packet.task?.id ?? 'none'} pending=${payload.packet.queue.pendingCount}`
    );
    return payload.packet;
  } catch (error) {
    if (!(error instanceof Error && error.message.startsWith('complete '))) {
      onIO?.(
        'error',
        `complete network: ${error instanceof Error ? error.message : 'unknown'}`
      );
    }
    throw error;
  }
}

function requireRelayBaseUrl() {
  if (!API_BASE_URL) {
    throw new Error('EXPO_PUBLIC_API_BASE_URL is not configured.');
  }
  return API_BASE_URL;
}

async function getInitialHeadingSnapshot(
  push: (message: string) => void
): Promise<Pick<Coordinates, 'heading' | 'headingAccuracy'> | null> {
  try {
    const heading = await Promise.race<Location.LocationHeadingObject | null>([
      Location.getHeadingAsync(),
      new Promise<null>((resolve) => {
        setTimeout(() => resolve(null), INITIAL_HEADING_TIMEOUT_MS);
      }),
    ]);

    if (!heading) {
      push(
        `tracking: initial heading timed out after ${INITIAL_HEADING_TIMEOUT_MS}ms; continuing with GPS only`
      );
      return null;
    }

    push(
      `tracking: initial heading true=${heading.trueHeading?.toFixed(1)} magnetic=${heading.magHeading?.toFixed(1)} acc=${heading.accuracy}`
    );
    return normalizeHeading(heading);
  } catch (error) {
    push(
      `tracking: initial heading failed - ${error instanceof Error ? error.message : 'unknown error'}`
    );
    return null;
  }
}

function normalizeCoordinates(
  coords: Location.LocationObjectCoords,
  timestamp: number,
  headingSource?: Pick<Coordinates, 'heading' | 'headingAccuracy'> | null
): Coordinates {
  return {
    latitude: coords.latitude,
    longitude: coords.longitude,
    accuracy: coords.accuracy,
    heading:
      coords.heading != null && coords.heading >= 0
        ? coords.heading
        : headingSource?.heading ?? null,
    headingAccuracy: headingSource?.headingAccuracy ?? null,
    timestamp: new Date(timestamp).toISOString(),
  };
}

function adaptNavigation(nav: RobotNavigation | null): NavRoute | null {
  if (!nav) return null;
  return {
    distanceMeters: nav.distanceMeters,
    expectedTravelTimeSeconds: nav.expectedTravelTimeSeconds,
    waypoints: nav.waypoints.map((w) => ({ latitude: w.latitude, longitude: w.longitude })),
    steps: nav.steps.map((s) => ({
      index: s.index,
      instruction: s.instruction,
      distanceMeters: s.distanceMeters,
      expectedTravelTimeSeconds: s.expectedTravelTimeSeconds,
      waypoints: s.waypoints.map((w) => ({ latitude: w.latitude, longitude: w.longitude })),
    })),
  };
}

function normalizeHeading(heading: Location.LocationHeadingObject): Pick<
  Coordinates,
  'heading' | 'headingAccuracy'
> {
  return {
    heading:
      heading.trueHeading >= 0
        ? heading.trueHeading
        : heading.magHeading >= 0
          ? heading.magHeading
          : null,
    headingAccuracy: heading.accuracy >= 0 ? heading.accuracy : null,
  };
}

function formatCoordinate(value: number) {
  return value.toFixed(6);
}

function formatTimestamp(isoString: string) {
  const date = new Date(isoString);
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  })}`;
}

function formatMeters(value: number | null | undefined) {
  if (value == null) return 'Unavailable';
  return `${value.toFixed(1)} m`;
}

function formatSeconds(value: number | null | undefined) {
  if (value == null) return 'Unavailable';
  if (value < 60) return `${Math.round(value)} s`;
  return `${(value / 60).toFixed(1)} min`;
}

// ===========================================================================
// Tiny reusable UI atoms
// ===========================================================================

function Card({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>{title}</Text>
      {subtitle ? <Text style={styles.cardSubtitle}>{subtitle}</Text> : null}
      <View style={styles.cardBody}>{children}</View>
    </View>
  );
}

function DataRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

function ActionButton({
  label,
  onPress,
  disabled,
  variant,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  variant: 'primary' | 'secondary' | 'danger';
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.button,
        variant === 'primary' && styles.buttonPrimary,
        variant === 'secondary' && styles.buttonSecondary,
        variant === 'danger' && styles.buttonDanger,
        (disabled || pressed) && styles.buttonDisabled,
      ]}
    >
      <Text style={[styles.buttonLabel, variant === 'secondary' && styles.buttonLabelDark]}>{label}</Text>
    </Pressable>
  );
}

// ===========================================================================
// Styles
// ===========================================================================

const styles = StyleSheet.create({
  screen: {
    backgroundColor: '#0E1614',
    flex: 1,
  },
  headerStrip: {
    backgroundColor: '#123A35',
    paddingBottom: 10,
    paddingHorizontal: 16,
    paddingTop: 52,
  },
  headerBadge: {
    color: '#F7E6BF',
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0.6,
  },
  headerPills: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 8,
  },
  tabBar: {
    backgroundColor: '#0E1614',
    borderBottomColor: '#1C2A27',
    borderBottomWidth: 1,
    flexDirection: 'row',
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  tabBtn: {
    alignItems: 'center',
    borderRadius: 10,
    flex: 1,
    paddingHorizontal: 4,
    paddingVertical: 10,
  },
  tabBtnActive: {
    backgroundColor: '#167C69',
  },
  tabLabel: {
    color: '#8FA29A',
    fontSize: 13,
    fontWeight: '700',
  },
  tabLabelActive: {
    color: '#FFFFFF',
  },
  content: {
    gap: 14,
    padding: 14,
    paddingBottom: 40,
  },
  pill: {
    borderRadius: 999,
    fontSize: 11,
    fontWeight: '700',
    overflow: 'hidden',
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  pillOk: {
    backgroundColor: '#E5F5EC',
    color: '#1E7B52',
  },
  pillWarn: {
    backgroundColor: '#FFF0E0',
    color: '#9A4A00',
  },
  pillDanger: {
    backgroundColor: '#FDDCD4',
    color: '#B84D3A',
  },
  pillMuted: {
    backgroundColor: '#1C2A27',
    color: '#8FA29A',
  },
  card: {
    backgroundColor: '#F7F4EC',
    borderColor: '#DDD7C8',
    borderRadius: 18,
    borderWidth: 1,
    gap: 8,
    padding: 16,
  },
  cardTitle: {
    color: '#13231F',
    fontSize: 18,
    fontWeight: '800',
  },
  cardSubtitle: {
    color: '#5F6D67',
    fontSize: 13,
    lineHeight: 18,
  },
  cardBody: {
    gap: 10,
    marginTop: 4,
  },
  buttonColumn: {
    gap: 8,
  },
  button: {
    alignItems: 'center',
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  buttonPrimary: {
    backgroundColor: '#167C69',
  },
  buttonSecondary: {
    backgroundColor: '#DCE8E1',
  },
  buttonDanger: {
    backgroundColor: '#B84D3A',
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  buttonLabel: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
  },
  buttonLabelDark: {
    color: '#13231F',
  },
  dataBlock: {
    gap: 8,
  },
  row: {
    borderBottomColor: '#E4DED0',
    borderBottomWidth: 1,
    gap: 2,
    paddingBottom: 8,
  },
  rowLabel: {
    color: '#5F6D67',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
  },
  rowValue: {
    color: '#13231F',
    fontSize: 14,
    fontWeight: '600',
  },
  helperText: {
    color: '#5F6D67',
    fontSize: 13,
    lineHeight: 18,
  },
  switchRow: {
    alignItems: 'center',
    backgroundColor: '#ECE6D8',
    borderRadius: 14,
    flexDirection: 'row',
    gap: 12,
    padding: 12,
  },
  switchLabels: {
    flex: 1,
    gap: 3,
  },
  switchLabel: {
    color: '#13231F',
    fontSize: 14,
    fontWeight: '700',
  },
  switchHelp: {
    color: '#5F6D67',
    fontSize: 11,
    lineHeight: 15,
  },
  jsonLabel: {
    color: '#13231F',
    fontSize: 12,
    fontWeight: '800',
  },
  jsonBlock: {
    backgroundColor: '#ECE6D8',
    borderRadius: 12,
    color: '#13231F',
    fontFamily: 'monospace',
    fontSize: 11,
    lineHeight: 16,
    padding: 10,
  },
  logBlock: {
    backgroundColor: '#ECE6D8',
    borderRadius: 12,
    gap: 2,
    padding: 10,
  },
  logLine: {
    color: '#13231F',
    fontFamily: 'monospace',
    fontSize: 11,
    lineHeight: 15,
  },
  logTs: {
    color: '#8A7E5F',
  },
  logCat: {
    fontWeight: '800',
  },
  logMsg: {
    color: '#13231F',
  },
  diagnosticBox: {
    backgroundColor: '#FFF0E0',
    borderColor: '#E0B884',
    borderRadius: 12,
    borderWidth: 1,
    gap: 4,
    padding: 10,
  },
  diagnosticTitle: {
    color: '#7A4A00',
    fontSize: 13,
    fontWeight: '800',
  },
  diagnosticBody: {
    color: '#5F3A00',
    fontSize: 12,
    lineHeight: 17,
  },
  mono: {
    fontFamily: 'monospace',
  },
  stepList: {
    backgroundColor: '#ECE6D8',
    borderRadius: 12,
    gap: 4,
    padding: 8,
  },
  stepRow: {
    borderRadius: 8,
    flexDirection: 'row',
    gap: 8,
    padding: 8,
  },
  stepRowActive: {
    backgroundColor: '#F6E3A8',
  },
  stepIndex: {
    color: '#5F6D67',
    fontFamily: 'monospace',
    fontSize: 12,
    fontWeight: '800',
    paddingTop: 1,
    width: 28,
  },
  stepBody: {
    flex: 1,
    gap: 2,
  },
  stepInstruction: {
    color: '#13231F',
    fontSize: 13,
    fontWeight: '600',
  },
  stepActiveText: {
    fontWeight: '800',
  },
  stepMeta: {
    color: '#5F6D67',
    fontFamily: 'monospace',
    fontSize: 11,
  },
});
