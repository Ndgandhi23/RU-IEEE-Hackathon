import { StatusBar } from 'expo-status-bar';
import * as Location from 'expo-location';
import { startTransition, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Alert,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';

import { PiLink, type PiStatus, type PiTelemetry } from './pi-link';
import { useRobotNav, type NavRoute } from './nav-loop';
import { haversineMeters, bearingDegrees, type LatLon } from './nav-math';

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

/** Explicit override; if empty, we derive `ws://<relay-host>:8765` from `EXPO_PUBLIC_API_BASE_URL`. */
const PI_WS_URL_EXPLICIT = process.env.EXPO_PUBLIC_PI_WS_URL?.replace(/\/$/, '').trim() ?? '';

function derivePiWsUrlFromRelay(httpBase: string): string {
  if (!httpBase) return '';
  try {
    const u = new URL(httpBase.startsWith('http') ? httpBase : `http://${httpBase}`);
    return `ws://${u.hostname}:8765`;
  } catch {
    return '';
  }
}

const PI_WS_URL = PI_WS_URL_EXPLICIT || derivePiWsUrlFromRelay(API_BASE_URL);
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
  const [navForceMode, setNavForceMode] = useState(false);
  const [demoAutoArrive, setDemoAutoArrive] = useState(
    process.env.EXPO_PUBLIC_DEMO_AUTO_ARRIVE === '1'
  );
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
          'Set EXPO_PUBLIC_API_BASE_URL in robot-console/.env (Pi WebSocket is derived as ws://<relay-host>:8765), or set EXPO_PUBLIC_PI_WS_URL if the motor controller is on another host.'
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
    forceNavigate: navForceMode,
    demoAutoArrive,
    onLog: (m) => pushLog('nav', m),
  });

  // --- Lifecycle -----------------------------------------------------------

  useEffect(() => {
    const piNote =
      PI_WS_URL && !PI_WS_URL_EXPLICIT ? ' (derived from relay host)' : '';
    pushSystem(
      `boot: relay=${API_BASE_URL || '(unset)'} piWs=${PI_WS_URL || '(unset)'}${piNote}`
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
          // `High` gives GNSS-class fixes (accuracy usually <10m outdoors)
          // instead of the WiFi/cell-biased `Balanced` mode. We also drop
          // `distanceInterval` to 0 and `timeInterval` to 1s so the UI sees
          // fresh coordinates on every tick — otherwise iOS deduplicates
          // small movements and the lat/lon readout appears frozen even as
          // you walk around.
          accuracy: Location.Accuracy.High,
          timeInterval: 1000,
          distanceInterval: 0,
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
            pose={pose}
            destination={
              packet.task
                ? {
                    latitude: packet.task.destination.latitude,
                    longitude: packet.task.destination.longitude,
                  }
                : null
            }
            forceNavigate={navForceMode}
            onToggleForceNavigate={(v) => {
              setNavForceMode(v);
              pushSystem(`nav force-navigate ${v ? 'ON' : 'OFF'}`);
            }}
            demoAutoArrive={demoAutoArrive}
            onToggleDemoAutoArrive={(v) => {
              setDemoAutoArrive(v);
              if (v && navForceMode) setNavForceMode(false);
              pushSystem(`DEMO auto-arrive ${v ? 'ON' : 'OFF'}`);
            }}
            onForceRefresh={() => {
              const loc = currentLocationRef.current ?? packet.current;
              if (!loc) {
                pushSystem('force-refresh: no pose yet');
                Alert.alert('No GPS fix', 'Start GPS tracking before refreshing.');
                return;
              }
              pushSystem('force-refresh: manual heartbeat triggered');
              void publishRobotLocation(loc, 'manual-refresh').catch(() => {});
            }}
            rawCurrent={packet.current}
            onMapsLog={pushSystem}
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
  pose,
  destination,
  forceNavigate,
  onToggleForceNavigate,
  demoAutoArrive,
  onToggleDemoAutoArrive,
  onForceRefresh,
  rawCurrent,
  onMapsLog,
  logs,
}: {
  nav: ReturnType<typeof useRobotNav>;
  motorsLive: boolean;
  rawNavigation: RobotNavigation | null;
  pose: { location: LatLon | null; headingDeg: number | null };
  destination: LatLon | null;
  forceNavigate: boolean;
  onToggleForceNavigate: (v: boolean) => void;
  demoAutoArrive: boolean;
  onToggleDemoAutoArrive: (v: boolean) => void;
  onForceRefresh: () => void;
  rawCurrent: Coordinates | null;
  onMapsLog: (msg: string) => void;
  logs: LogEntry[];
}) {
  const openUrl = async (url: string, label: string) => {
    try {
      const can = await Linking.canOpenURL(url);
      if (!can && Platform.OS !== 'ios') {
        Alert.alert('Cannot open link', url);
        onMapsLog(`maps open refused: ${url}`);
        return;
      }
      await Linking.openURL(url);
      onMapsLog(`maps open ${label}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      Alert.alert('Failed to open Apple Maps', msg);
      onMapsLog(`maps open failed: ${msg}`);
    }
  };

  const dest = destination;
  const src = pose.location;
  const fmt = (p: LatLon) => `${p.latitude.toFixed(6)},${p.longitude.toFixed(6)}`;
  const routeUrl = src && dest
    ? `http://maps.apple.com/?saddr=${fmt(src)}&daddr=${fmt(dest)}&dirflg=w`
    : null;
  const pinUrl = dest
    ? `http://maps.apple.com/?ll=${fmt(dest)}&q=Report%20location&t=m`
    : null;
  const poseUrl = src
    ? `http://maps.apple.com/?ll=${fmt(src)}&q=Robot%20position&t=m`
    : null;
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
        title="Live robot pose"
        subtitle="What the phone sees right now from GNSS. Refreshes every GPS tick (~1 Hz). Max precision; compare against Apple Maps and the report coords."
      >
        <DataRow
          label="Latitude"
          value={rawCurrent ? rawCurrent.latitude.toFixed(8) : '—'}
        />
        <DataRow
          label="Longitude"
          value={rawCurrent ? rawCurrent.longitude.toFixed(8) : '—'}
        />
        <DataRow
          label="Accuracy"
          value={
            rawCurrent?.accuracy != null
              ? `±${rawCurrent.accuracy.toFixed(1)} m`
              : 'unknown'
          }
        />
        <DataRow
          label="Heading"
          value={
            rawCurrent?.heading != null
              ? `${rawCurrent.heading.toFixed(1)}° (±${rawCurrent.headingAccuracy?.toFixed(1) ?? '?'}°)`
              : 'no compass'
          }
        />
        <DataRow
          label="Timestamp"
          value={rawCurrent ? rawCurrent.timestamp : '—'}
        />
        {destination ? (
          <>
            <DataRow label="Report lat (frozen)" value={destination.latitude.toFixed(8)} />
            <DataRow label="Report lon (frozen)" value={destination.longitude.toFixed(8)} />
            <DataRow
              label="Δlat / Δlon"
              value={
                rawCurrent
                  ? `${(rawCurrent.latitude - destination.latitude).toExponential(3)} / ${(rawCurrent.longitude - destination.longitude).toExponential(3)}`
                  : '—'
              }
            />
          </>
        ) : null}
      </Card>

      <Card
        title="Debug controls"
        subtitle="Nav-only overrides. These do not change the relay or the gate on the classifier."
      >
        <View style={styles.switchRow}>
          <View style={styles.switchLabels}>
            <Text style={styles.switchLabel}>DEMO: assume already arrived</Text>
            <Text style={styles.switchHelp}>
              For live demos. Keeps the Apple Maps route visible but declares ARRIVED the moment a
              task lands, so the brain's autonomous ML loop can take over without waiting for GPS
              convergence. Motors stay stopped on the phone side — the brain drives via its own
              WebSocket. Flipping this ON also forces Force-navigate OFF.
            </Text>
          </View>
          <Switch value={demoAutoArrive} onValueChange={onToggleDemoAutoArrive} />
        </View>
        {demoAutoArrive ? (
          <View style={styles.diagnosticBox}>
            <Text style={styles.diagnosticTitle}>▶ DEMO auto-arrive is ON</Text>
            <Text style={styles.diagnosticBody}>
              Phone-side nav motors will not drive. Start `python -m brain.main` on the brain
              machine so the ML loop begins autonomous search + scoop the moment a task is assigned.
            </Text>
          </View>
        ) : null}

        <View style={styles.switchRow}>
          <View style={styles.switchLabels}>
            <Text style={styles.switchLabel}>Force navigate (ignore arrival)</Text>
            <Text style={styles.switchHelp}>
              When ON, the nav loop keeps computing vector/bearing/motor commands toward the final
              waypoint even after you're close enough to have "arrived." Walk the phone farther
              away and Apple Maps re-routes — you can watch the step list, waypoints and distance
              update live. Motors still respect the LIVE/dry-run toggle on the Pi tab; keep motors
              in dry-run while testing this so the robot doesn't chase you.
            </Text>
          </View>
          <Switch value={forceNavigate} onValueChange={onToggleForceNavigate} />
        </View>
        {forceNavigate ? (
          <View style={styles.diagnosticBox}>
            <Text style={styles.diagnosticTitle}>⚠ Force-navigate is ON</Text>
            <Text style={styles.diagnosticBody}>
              Arrival is disabled. The classifier gate on the brain machine still uses the relay's
              real pose + destination, so it will flip open on its own when you're actually close —
              that behavior is unaffected.
            </Text>
          </View>
        ) : null}

        <Pressable
          style={({ pressed }) => [
            styles.mapsButton,
            styles.mapsButtonSecondary,
            pressed && styles.mapsButtonPressed,
          ]}
          onPress={onForceRefresh}
        >
          <Text style={styles.mapsButtonText}>Force refresh Apple route now</Text>
        </Pressable>
        <Text style={styles.helperText}>
          Sends an immediate heartbeat with the current pose. The relay only re-fetches Apple when
          its cache is &gt;15 s old or you've drifted &gt;5 m from the cached origin, so a fresh route
          is most likely after you've actually walked somewhere new. Watch the relay's `[apple]`
          logs to see a `cache miss` vs `cache hit`.
        </Text>
      </Card>

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
                ? rawNavigation && rawNavigation.distanceMeters === 0
                  ? 'straight-line (Apple distance=0, snap polyline ignored)'
                  : 'straight-line fallback (no Apple steps)'
                : 'Apple Maps step list'
          }
        />
        <DataRow
          label="Arrived"
          value={nav.decision.arrived ? 'YES — search phase' : 'No'}
        />
        <DataRow
          label="Distance remaining"
          value={
            nav.decision.distanceRemainingM != null
              ? `${nav.decision.distanceRemainingM.toFixed(1)} m (${nav.decision.distanceRemainingSource ?? '—'})`
              : '—'
          }
        />
        <DataRow
          label="Haversine to final wp"
          value={
            pose.location && nav.route && nav.route.waypoints.length > 0
              ? `${haversineMeters(pose.location, nav.route.waypoints[nav.route.waypoints.length - 1]).toFixed(1)} m (live)`
              : '—'
          }
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
        title="Open in Apple Maps"
        subtitle="Hand off to the Maps app on this phone. Uses current robot GPS as the starting point and the report location as the destination."
      >
        <DataRow
          label="From (robot)"
          value={src ? `${src.latitude.toFixed(6)}, ${src.longitude.toFixed(6)}` : 'No GPS yet'}
        />
        <DataRow
          label="To (report)"
          value={dest ? `${dest.latitude.toFixed(6)}, ${dest.longitude.toFixed(6)}` : 'No task'}
        />

        <Pressable
          style={({ pressed }) => [
            styles.mapsButton,
            !routeUrl && styles.mapsButtonDisabled,
            pressed && routeUrl && styles.mapsButtonPressed,
          ]}
          disabled={!routeUrl}
          onPress={() => routeUrl && openUrl(routeUrl, 'walking route')}
        >
          <Text style={[styles.mapsButtonText, !routeUrl && styles.mapsButtonTextDisabled]}>
            Walking route (robot → report)
          </Text>
        </Pressable>

        <Pressable
          style={({ pressed }) => [
            styles.mapsButton,
            styles.mapsButtonSecondary,
            !pinUrl && styles.mapsButtonDisabled,
            pressed && pinUrl && styles.mapsButtonPressed,
          ]}
          disabled={!pinUrl}
          onPress={() => pinUrl && openUrl(pinUrl, 'destination pin')}
        >
          <Text style={[styles.mapsButtonText, !pinUrl && styles.mapsButtonTextDisabled]}>
            Pin destination only
          </Text>
        </Pressable>

        <Pressable
          style={({ pressed }) => [
            styles.mapsButton,
            styles.mapsButtonSecondary,
            !poseUrl && styles.mapsButtonDisabled,
            pressed && poseUrl && styles.mapsButtonPressed,
          ]}
          disabled={!poseUrl}
          onPress={() => poseUrl && openUrl(poseUrl, 'robot pin')}
        >
          <Text style={[styles.mapsButtonText, !poseUrl && styles.mapsButtonTextDisabled]}>
            Pin robot position only
          </Text>
        </Pressable>

        {routeUrl ? (
          <>
            <Text style={styles.jsonLabel}>URL</Text>
            <Text style={styles.jsonBlock}>{routeUrl}</Text>
          </>
        ) : null}
        {Platform.OS === 'android' ? (
          <Text style={styles.helperText}>
            On Android this opens Apple's web viewer (or your default maps app) instead of the
            native Maps app.
          </Text>
        ) : null}
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
        title="Waypoint list"
        subtitle="Every lat/lon the robot will drive through, in order. Active waypoint is highlighted; reached ones are dimmed."
      >
        {nav.route && nav.route.waypoints.length > 0 ? (
          <>
            <DataRow
              label="Progress"
              value={`${Math.min(nav.decision.waypointIndex + 1, nav.route.waypoints.length)} / ${nav.route.waypoints.length}`}
            />
            <ScrollView
              style={styles.waypointScroll}
              nestedScrollEnabled
              contentContainerStyle={styles.waypointScrollContent}
            >
              {nav.route.waypoints.map((wp, i) => {
                const reached = i < nav.decision.waypointIndex;
                const active = i === nav.decision.waypointIndex && !nav.decision.arrived;
                const distM = pose.location ? haversineMeters(pose.location, wp) : null;
                const bearing = pose.location ? bearingDegrees(pose.location, wp) : null;
                const stepIdx = findStepIndexForFlat(nav.route?.steps ?? [], i);
                const marker = reached ? '✓' : active ? '▶' : '·';
                return (
                  <View
                    key={`${i}-${wp.latitude.toFixed(6)}-${wp.longitude.toFixed(6)}`}
                    style={[
                      styles.waypointRow,
                      active && styles.waypointRowActive,
                      reached && styles.waypointRowReached,
                    ]}
                  >
                    <Text style={styles.waypointIndex}>
                      {marker} {String(i + 1).padStart(2, ' ')}
                    </Text>
                    <View style={styles.waypointBody}>
                      <Text
                        style={[
                          styles.waypointCoord,
                          active && styles.waypointActiveText,
                          reached && styles.waypointReachedText,
                        ]}
                      >
                        {wp.latitude.toFixed(6)}, {wp.longitude.toFixed(6)}
                      </Text>
                      <Text style={styles.waypointMeta}>
                        {distM != null ? `${distM.toFixed(1)} m` : '— m'}
                        {bearing != null ? ` · ${bearing.toFixed(0)}°` : ''}
                        {stepIdx != null ? ` · step ${stepIdx + 1}` : ''}
                      </Text>
                    </View>
                  </View>
                );
              })}
            </ScrollView>
          </>
        ) : (
          <Text style={styles.helperText}>
            No waypoints yet. They appear once a task is assigned and the relay
            returns a route (or the straight-line fallback kicks in).
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
    const appleDegenerate =
      rawNavigation != null && rawNavigation.distanceMeters === 0;
    if (appleDegenerate) {
      return {
        title: 'Apple route is degenerate — driving straight to the pin',
        body:
          'Apple Maps snapped both your origin and the report destination onto the same walkway node and returned distanceMeters = 0. The stepPaths it sent back are on that walkway node, not at the actual reporter pin, so following them would drive the robot dozens of meters the wrong way. The nav loop is ignoring the snap polyline and steering by haversine + bearing to task.destination instead. "Arrived" will fire when haversine-to-pin < 3 m or Apple\'s total drops to 0 on the next refresh.',
      };
    }
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

// Map a flat waypoint index back to the step it belongs to. Mirrors the
// nav-loop's flattening: step[0].waypoints then step[1].waypoints, etc.
function findStepIndexForFlat(
  steps: { waypoints: { latitude: number; longitude: number }[] }[],
  flatIndex: number,
): number | null {
  if (!steps.length) return null;
  let running = 0;
  for (let i = 0; i < steps.length; i += 1) {
    const count = steps[i].waypoints.length;
    if (count === 0) continue;
    if (flatIndex < running + count) return i;
    running += count;
  }
  return null;
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
  waypointScroll: {
    backgroundColor: '#F3F5F2',
    borderRadius: 8,
    marginTop: 8,
    maxHeight: 320,
  },
  waypointScrollContent: {
    gap: 2,
    padding: 6,
  },
  waypointRow: {
    alignItems: 'flex-start',
    borderRadius: 6,
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 6,
    paddingVertical: 4,
  },
  waypointRowActive: {
    backgroundColor: '#E4EDE7',
  },
  waypointRowReached: {
    opacity: 0.55,
  },
  waypointIndex: {
    color: '#5F6D67',
    fontFamily: 'monospace',
    fontSize: 12,
    minWidth: 36,
  },
  waypointBody: {
    flex: 1,
    gap: 2,
  },
  waypointCoord: {
    color: '#1B2B21',
    fontFamily: 'monospace',
    fontSize: 12,
  },
  waypointActiveText: {
    fontWeight: '800',
  },
  waypointReachedText: {
    textDecorationLine: 'line-through',
  },
  waypointMeta: {
    color: '#5F6D67',
    fontFamily: 'monospace',
    fontSize: 11,
  },
  mapsButton: {
    alignItems: 'center',
    backgroundColor: '#1E7B52',
    borderRadius: 8,
    marginTop: 10,
    paddingVertical: 12,
  },
  mapsButtonSecondary: {
    backgroundColor: '#2D3A33',
  },
  mapsButtonPressed: {
    opacity: 0.75,
  },
  mapsButtonDisabled: {
    backgroundColor: '#C7CEC9',
  },
  mapsButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
  },
  mapsButtonTextDisabled: {
    color: '#6B756F',
  },
});
