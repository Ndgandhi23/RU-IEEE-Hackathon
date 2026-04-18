import { StatusBar } from 'expo-status-bar';
import * as Location from 'expo-location';
import { startTransition, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

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

const API_BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL?.replace(/\/$/, '') ?? '';
const INITIAL_HEADING_TIMEOUT_MS = 3000;
const IDLE_ASSIGNMENT_PING_MS = 8000;

const emptyPacket: RobotPacket = {
  status: 'idle',
  current: null,
  task: null,
  queue: {
    pendingCount: 0,
  },
};

export default function App() {
  const [packet, setPacket] = useState<RobotPacket>(emptyPacket);
  const [locationBusy, setLocationBusy] = useState(false);
  const [completeBusy, setCompleteBusy] = useState(false);
  const [trackingEnabled, setTrackingEnabled] = useState(false);
  const [startupDebug, setStartupDebug] = useState<string[]>([]);
  const watchRef = useRef<Location.LocationSubscription | null>(null);
  const headingRef = useRef<Location.LocationSubscription | null>(null);
  const currentLocationRef = useRef<Coordinates | null>(null);
  const idlePingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function pushStartupDebug(message: string) {
    const line = `${new Date().toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })} ${message}`;
    console.log(`[robot-console] ${line}`);
    setStartupDebug((current) => [...current.slice(-19), line]);
  }

  useEffect(() => {
    return () => {
      stopTracking();
    };
  }, []);

  async function syncPacket(showError = true, source = 'manual-sync') {
    if (!API_BASE_URL) {
      if (showError) {
        Alert.alert('Relay missing', 'Set EXPO_PUBLIC_API_BASE_URL in robot-console/.env first.');
      }
      pushStartupDebug(`${source}: relay URL missing`);
      return;
    }

    try {
      if (currentLocationRef.current) {
        pushStartupDebug(`${source}: repinging relay for assignment`);
        const nextPacket = await sendRobotHeartbeat(currentLocationRef.current);
        currentLocationRef.current = nextPacket.current ?? currentLocationRef.current;
        setPacket(nextPacket);
        syncIdlePing(nextPacket.status);
        pushStartupDebug(`${source}: packet task=${nextPacket.task?.id ?? 'none'} status=${nextPacket.status}`);
        return;
      }

      pushStartupDebug(`${source}: fetching robot packet without location`);
      const nextPacket = await fetchRobotPacket();
      currentLocationRef.current = nextPacket.current;
      setPacket(nextPacket);
      syncIdlePing(nextPacket.status);
      pushStartupDebug(`${source}: packet task=${nextPacket.task?.id ?? 'none'} status=${nextPacket.status}`);
    } catch (error) {
      pushStartupDebug(
        `${source}: failed - ${error instanceof Error ? error.message : 'unknown error'}`
      );
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
      pushStartupDebug(`${source}: relay URL missing`);
      Alert.alert('Relay missing', 'Set EXPO_PUBLIC_API_BASE_URL in robot-console/.env first.');
      return emptyPacket;
    }

    pushStartupDebug(
      `${source}: heartbeat -> lat=${location.latitude.toFixed(6)} lon=${location.longitude.toFixed(6)} heading=${location.heading ?? 'null'}`
    );
    currentLocationRef.current = location;
    startTransition(() => {
      setPacket((currentPacket) => ({
        ...currentPacket,
        current: location,
      }));
    });

    pushStartupDebug(`${source}: sending heartbeat to relay`);
    const nextPacket = await sendRobotHeartbeat(location);
    currentLocationRef.current = nextPacket.current ?? location;
    setPacket(nextPacket);
    syncIdlePing(nextPacket.status);
    pushStartupDebug(`${source}: packet task=${nextPacket.task?.id ?? 'none'} status=${nextPacket.status}`);
    return nextPacket;
  }

  async function startTracking() {
    if (watchRef.current) {
      pushStartupDebug('tracking: already running');
      return;
    }

    try {
      setLocationBusy(true);
      pushStartupDebug('tracking: requesting foreground permission');
      const permission = await Location.requestForegroundPermissionsAsync();
      pushStartupDebug(`tracking: permission status = ${permission.status}`);
      if (!permission.granted) {
        Alert.alert(
          'Location permission needed',
          'Allow location access before enabling continuous tracking.'
        );
        pushStartupDebug('tracking: permission denied');
        return;
      }

      pushStartupDebug('tracking: requesting initial position');
      const currentPosition = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      pushStartupDebug(
        `tracking: initial position resolved lat=${currentPosition.coords.latitude.toFixed(6)} lon=${currentPosition.coords.longitude.toFixed(6)}`
      );
      pushStartupDebug('tracking: requesting initial heading (non-blocking timeout)');
      const currentHeading = await getInitialHeadingSnapshot(pushStartupDebug);
      const initialPacket = await publishRobotLocation(
        normalizeCoordinates(
          currentPosition.coords,
          currentPosition.timestamp,
          currentHeading
        ),
        'tracking-start'
      );
      pushStartupDebug('tracking: initial publish complete');

      pushStartupDebug('tracking: starting watchPositionAsync');
      watchRef.current = await Location.watchPositionAsync(
        {
          accuracy: Location.Accuracy.Balanced,
          timeInterval: 2000,
          distanceInterval: 2,
        },
        (position) => {
          pushStartupDebug(
            `tracking: position update lat=${position.coords.latitude.toFixed(6)} lon=${position.coords.longitude.toFixed(6)}`
          );
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
        }
      );
      pushStartupDebug('tracking: watchPositionAsync attached');

      pushStartupDebug('tracking: starting watchHeadingAsync');
      headingRef.current = await Location.watchHeadingAsync((heading) => {
        pushStartupDebug(
          `tracking: heading update true=${heading.trueHeading} magnetic=${heading.magHeading} accuracy=${heading.accuracy}`
        );
        const headingSnapshot = normalizeHeading(heading);
        const currentLocation = currentLocationRef.current;
        if (!currentLocation) {
          pushStartupDebug('tracking: heading update ignored because current location is missing');
          return;
        }

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
      pushStartupDebug('tracking: watchHeadingAsync attached');

      setTrackingEnabled(true);
      syncIdlePing(initialPacket.status, true);
      pushStartupDebug('tracking: enabled');
    } catch (error) {
      pushStartupDebug(
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
    pushStartupDebug('tracking: stopped');
  }

  function startIdlePing() {
    if (idlePingRef.current) {
      pushStartupDebug('idle: watcher already running');
      return;
    }

    pushStartupDebug('idle: starting assignment check loop');
    idlePingRef.current = setInterval(() => {
      if (!currentLocationRef.current) {
        pushStartupDebug('idle: assignment check skipped because current location is missing');
        return;
      }

      void syncPacket(false, 'idle-check');
    }, IDLE_ASSIGNMENT_PING_MS);
  }

  function stopIdlePing() {
    if (!idlePingRef.current) {
      return;
    }

    clearInterval(idlePingRef.current);
    idlePingRef.current = null;
    pushStartupDebug('idle: assignment check loop stopped');
  }

  function syncIdlePing(status: RobotPacket['status'], forceStart = false) {
    if (!trackingEnabled && !forceStart) {
      return;
    }

    if (status === 'idle') {
      startIdlePing();
      return;
    }

    stopIdlePing();
  }

  async function handleCompleteTask() {
    if (!packet.task?.id) {
      return;
    }

    try {
      setCompleteBusy(true);
      pushStartupDebug(`complete: sending completion for ${packet.task.id}`);
      const nextPacket = await completeRobotTask(packet.task.id, currentLocationRef.current);
      currentLocationRef.current = nextPacket.current;
      setPacket(nextPacket);
      syncIdlePing(nextPacket.status);
      pushStartupDebug(`complete: next task=${nextPacket.task?.id ?? 'none'} status=${nextPacket.status}`);
    } catch (error) {
      Alert.alert(
        'Task completion failed',
        error instanceof Error ? error.message : 'Could not complete the current robot task.'
      );
    } finally {
      setCompleteBusy(false);
    }
  }

  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.hero}>
          <Text style={styles.badge}>ROBOT CONSOLE</Text>
          <Text style={styles.title}>Standalone robot app linked to the relay.</Text>
          <Text style={styles.copy}>
            This app publishes robot GPS plus heading, pulls the next assigned task automatically,
            and exposes the raw packet that the Raspberry Pi can consume.
          </Text>
          <Text style={[styles.pill, API_BASE_URL ? styles.pillOk : styles.pillWarn]}>
            {API_BASE_URL ? `Relay: ${API_BASE_URL}` : 'Relay URL missing'}
          </Text>
        </View>

        <Card
          title="Robot state"
          subtitle="Start auto mode to capture GPS + heading. The robot only repings the relay when it needs work or when it completes a task."
        >
          <View style={styles.buttonColumn}>
            <ActionButton
              label={
                trackingEnabled
                  ? 'Stop robot auto mode'
                  : locationBusy
                    ? 'Starting robot auto mode...'
                    : 'Start robot auto mode'
              }
              onPress={trackingEnabled ? stopTracking : startTracking}
              variant={trackingEnabled ? 'danger' : 'primary'}
              disabled={locationBusy}
            />
          </View>

          <Text style={styles.helperText}>
            Auto mode keeps local GPS + heading live. While idle, it checks for the next task. While assigned, it waits for the robot to report completion.
          </Text>

          <DataRow label="Auto mode" value={trackingEnabled ? 'Active' : 'Idle'} />

          {packet.current ? (
            <View style={styles.dataBlock}>
              <DataRow label="Latitude" value={formatCoordinate(packet.current.latitude)} />
              <DataRow label="Longitude" value={formatCoordinate(packet.current.longitude)} />
              <DataRow
                label="Heading"
                value={
                  packet.current.heading != null
                    ? `${packet.current.heading.toFixed(3)} deg`
                    : 'No heading yet'
                }
              />
              <DataRow
                label="Heading accuracy"
                value={
                  packet.current.headingAccuracy != null
                    ? `${packet.current.headingAccuracy.toFixed(3)} deg`
                    : 'Unknown'
                }
              />
              <DataRow label="Timestamp" value={formatTimestamp(packet.current.timestamp)} />
            </View>
          ) : (
            <Text style={styles.helperText}>No robot location captured yet.</Text>
          )}

          <Text style={styles.jsonLabel}>Startup debug</Text>
          <Text style={styles.jsonBlock}>
            {startupDebug.length ? startupDebug.join('\n') : 'No startup events yet'}
          </Text>
        </Card>

        <Card
          title="Assigned target"
          subtitle="The relay assigns the nearest pending report when the robot asks for work. Completing a task immediately requests the next nearest task."
        >
          <View style={styles.buttonColumn}>
            <ActionButton
              label={completeBusy ? 'Completing...' : 'Complete current task'}
              onPress={handleCompleteTask}
              variant="primary"
              disabled={!packet.task?.id || completeBusy}
            />
          </View>

          <DataRow label="Status" value={packet.status} />
          <DataRow label="Task id" value={packet.task?.id ?? 'None'} />

          {packet.task ? (
            <View style={styles.dataBlock}>
              <DataRow label="Target latitude" value={formatCoordinate(packet.task.destination.latitude)} />
              <DataRow label="Target longitude" value={formatCoordinate(packet.task.destination.longitude)} />
              <DataRow
                label="Target timestamp"
                value={formatTimestamp(packet.task.destination.timestamp)}
              />
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
            </View>
          ) : (
            <Text style={styles.helperText}>No report is assigned right now.</Text>
          )}
        </Card>

        <Card
          title="Pi packet"
          subtitle="This is the compact navigation packet the robot can consume: current pose, pending queue count, destination, and walking route geometry."
        >
          <DataRow label="Pending tasks" value={String(packet.queue.pendingCount)} />

          <Text style={styles.jsonLabel}>Robot navigation packet</Text>
          <Text style={styles.jsonBlock}>{JSON.stringify(packet, null, 2)}</Text>
        </Card>
      </ScrollView>
      <StatusBar style="light" />
    </View>
  );
}

async function sendRobotHeartbeat(location: Coordinates): Promise<RobotPacket> {
  const response = await fetch(`${requireRelayBaseUrl()}/robot/heartbeat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      location,
      sentAt: new Date().toISOString(),
    }),
  });

  if (!response.ok) {
    throw new Error(`Robot heartbeat failed with ${response.status}`);
  }

  const payload = (await response.json()) as { packet: RobotPacket };
  return payload.packet;
}

async function fetchRobotPacket(): Promise<RobotPacket> {
  const response = await fetch(`${requireRelayBaseUrl()}/robot/packet`);
  if (!response.ok) {
    throw new Error(`Robot packet fetch failed with ${response.status}`);
  }

  const payload = (await response.json()) as { packet: RobotPacket };
  return payload.packet;
}

async function completeRobotTask(
  taskId: string,
  location: Coordinates | null
): Promise<RobotPacket> {
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
    throw new Error(`Robot task completion failed with ${response.status}`);
  }

  const payload = (await response.json()) as { packet: RobotPacket };
  return payload.packet;
}

function requireRelayBaseUrl() {
  if (!API_BASE_URL) {
    throw new Error('EXPO_PUBLIC_API_BASE_URL is not configured.');
  }

  return API_BASE_URL;
}

async function getInitialHeadingSnapshot(
  pushStartupDebug: (message: string) => void
): Promise<Pick<Coordinates, 'heading' | 'headingAccuracy'> | null> {
  try {
    const heading = await Promise.race<Location.LocationHeadingObject | null>([
      Location.getHeadingAsync(),
      new Promise<null>((resolve) => {
        setTimeout(() => resolve(null), INITIAL_HEADING_TIMEOUT_MS);
      }),
    ]);

    if (!heading) {
      pushStartupDebug(
        `tracking: initial heading timed out after ${INITIAL_HEADING_TIMEOUT_MS}ms; continuing with GPS only`
      );
      return null;
    }

    pushStartupDebug(
      `tracking: initial heading resolved true=${heading.trueHeading} magnetic=${heading.magHeading} accuracy=${heading.accuracy}`
    );
    return normalizeHeading(heading);
  } catch (error) {
    pushStartupDebug(
      `tracking: initial heading failed - ${error instanceof Error ? error.message : 'unknown error'}; continuing with GPS only`
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
  })}`;
}

function formatMeters(value: number | null | undefined) {
  if (value == null) {
    return 'Unavailable';
  }

  return `${value.toFixed(1)} m`;
}

function formatSeconds(value: number | null | undefined) {
  if (value == null) {
    return 'Unavailable';
  }

  if (value < 60) {
    return `${Math.round(value)} s`;
  }

  return `${(value / 60).toFixed(1)} min`;
}

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
      <Text style={styles.cardSubtitle}>{subtitle}</Text>
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

const styles = StyleSheet.create({
  screen: {
    backgroundColor: '#0E1614',
    flex: 1,
  },
  content: {
    gap: 18,
    padding: 18,
    paddingBottom: 32,
    paddingTop: 52,
  },
  hero: {
    backgroundColor: '#123A35',
    borderRadius: 28,
    gap: 12,
    padding: 22,
  },
  badge: {
    alignSelf: 'flex-start',
    backgroundColor: '#F7E6BF',
    borderRadius: 999,
    color: '#7A4B00',
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0.6,
    overflow: 'hidden',
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  title: {
    color: '#FFFFFF',
    fontSize: 28,
    fontWeight: '800',
    lineHeight: 34,
  },
  copy: {
    color: '#D9E8E1',
    fontSize: 15,
    lineHeight: 22,
  },
  pill: {
    alignSelf: 'flex-start',
    borderRadius: 999,
    fontSize: 12,
    fontWeight: '700',
    overflow: 'hidden',
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  pillOk: {
    backgroundColor: '#E5F5EC',
    color: '#1E7B52',
  },
  pillWarn: {
    backgroundColor: '#FFF0E0',
    color: '#9A4A00',
  },
  card: {
    backgroundColor: '#F7F4EC',
    borderColor: '#DDD7C8',
    borderRadius: 24,
    borderWidth: 1,
    gap: 8,
    padding: 18,
  },
  cardTitle: {
    color: '#13231F',
    fontSize: 22,
    fontWeight: '800',
  },
  cardSubtitle: {
    color: '#5F6D67',
    fontSize: 14,
    lineHeight: 20,
  },
  cardBody: {
    gap: 12,
    marginTop: 6,
  },
  buttonColumn: {
    gap: 10,
  },
  button: {
    alignItems: 'center',
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 14,
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
    fontSize: 15,
    fontWeight: '700',
  },
  buttonLabelDark: {
    color: '#13231F',
  },
  dataBlock: {
    gap: 10,
  },
  row: {
    borderBottomColor: '#E4DED0',
    borderBottomWidth: 1,
    gap: 4,
    paddingBottom: 10,
  },
  rowLabel: {
    color: '#5F6D67',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
  },
  rowValue: {
    color: '#13231F',
    fontSize: 15,
    fontWeight: '600',
  },
  helperText: {
    color: '#5F6D67',
    fontSize: 14,
    lineHeight: 20,
  },
  jsonLabel: {
    color: '#13231F',
    fontSize: 13,
    fontWeight: '800',
  },
  jsonBlock: {
    backgroundColor: '#ECE6D8',
    borderRadius: 16,
    color: '#13231F',
    fontFamily: 'monospace',
    fontSize: 12,
    lineHeight: 18,
    padding: 14,
  },
});
