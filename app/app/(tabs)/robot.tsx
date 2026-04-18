import { Ionicons } from '@expo/vector-icons';
import * as Linking from 'expo-linking';
import * as Location from 'expo-location';
import { startTransition, useEffect, useRef, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native';

import { ActionButton } from '@/components/ui/action-button';
import { DataRow } from '@/components/ui/data-row';
import { Panel } from '@/components/ui/panel';
import { StatusPill } from '@/components/ui/status-pill';
import { palette } from '@/constants/theme';
import {
  buildRoutePlan,
  fetchLatestReport,
  hasRemoteBackend,
  sendRobotHeartbeat,
} from '@/services/routing-api';
import { Coordinates, RoutePlan, TrashReport } from '@/types/routing';
import { formatCoordinate, formatDistance, formatDuration, formatTimestamp } from '@/utils/format';

export default function RobotScreen() {
  const [robotLocation, setRobotLocation] = useState<Coordinates | null>(null);
  const [latestReport, setLatestReport] = useState<TrashReport | null>(null);
  const [routePlan, setRoutePlan] = useState<RoutePlan | null>(null);
  const [routeMode, setRouteMode] = useState<'backend' | 'mock' | null>(null);
  const [loadingReport, setLoadingReport] = useState(false);
  const [loadingLocation, setLoadingLocation] = useState(false);
  const [loadingRoute, setLoadingRoute] = useState(false);
  const [trackingEnabled, setTrackingEnabled] = useState(false);
  const watchRef = useRef<Location.LocationSubscription | null>(null);
  const headingRef = useRef<Location.LocationSubscription | null>(null);

  function handlePositionUpdate(position: Location.LocationObject) {
    const nextLocation = normalizeCoordinates(position.coords, position.timestamp, robotLocation);
    startTransition(() => {
      setRobotLocation(nextLocation);
    });
    void sendRobotHeartbeat(nextLocation);
  }

  function handleHeadingUpdate(heading: Location.LocationHeadingObject) {
    const normalizedHeading = normalizeHeading(heading);
    startTransition(() => {
      setRobotLocation((current) =>
        current
          ? {
              ...current,
              heading: normalizedHeading.heading,
              headingAccuracy: normalizedHeading.headingAccuracy,
            }
          : current
      );
    });
  }

  useEffect(() => {
    void refreshLatestReport();
    return () => {
      stopTracking();
    };
  }, []);

  async function refreshLatestReport() {
    try {
      setLoadingReport(true);
      const report = await fetchLatestReport();
      setLatestReport(report);
      setRoutePlan(null);
    } catch (error) {
      Alert.alert(
        'Feed unavailable',
        error instanceof Error ? error.message : 'Could not load the latest trash report.'
      );
    } finally {
      setLoadingReport(false);
    }
  }

  async function captureRobotLocation() {
    try {
      setLoadingLocation(true);
      const permission = await Location.requestForegroundPermissionsAsync();
      if (!permission.granted) {
        Alert.alert(
          'Location permission needed',
          'Allow location access so the robot can compute a route from its current position.'
        );
        return;
      }

      const currentPosition = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      const currentHeading = await Location.getHeadingAsync();
      const currentLocation = normalizeCoordinates(
        currentPosition.coords,
        currentPosition.timestamp,
        normalizeHeading(currentHeading)
      );
      setRobotLocation(currentLocation);
      await sendRobotHeartbeat(currentLocation);
    } catch (error) {
      Alert.alert(
        'Robot location unavailable',
        error instanceof Error ? error.message : 'Could not read the robot phone position.'
      );
    } finally {
      setLoadingLocation(false);
    }
  }

  async function startTracking() {
    if (watchRef.current) {
      return;
    }

    try {
      setLoadingLocation(true);
      const permission = await Location.requestForegroundPermissionsAsync();
      if (!permission.granted) {
        Alert.alert(
          'Location permission needed',
          'Allow location access before enabling continuous robot tracking.'
        );
        return;
      }

      const currentPosition = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      handlePositionUpdate(currentPosition);

      watchRef.current = await Location.watchPositionAsync(
        {
          accuracy: Location.Accuracy.Balanced,
          timeInterval: 2000,
          distanceInterval: 2,
        },
        handlePositionUpdate
      );
      headingRef.current = await Location.watchHeadingAsync(handleHeadingUpdate);
      setTrackingEnabled(true);
    } catch (error) {
      Alert.alert(
        'Tracking unavailable',
        error instanceof Error ? error.message : 'Could not start robot tracking.'
      );
    } finally {
      setLoadingLocation(false);
    }
  }

  function stopTracking() {
    watchRef.current?.remove();
    watchRef.current = null;
    headingRef.current?.remove();
    headingRef.current = null;
    setTrackingEnabled(false);
  }

  async function handleBuildRoute() {
    if (!robotLocation || !latestReport) {
      Alert.alert(
        'Route incomplete',
        'Load the latest report and capture the robot position before building a route.'
      );
      return;
    }

    try {
      setLoadingRoute(true);
      const response = await buildRoutePlan({
        origin: robotLocation,
        destination: latestReport.reporterLocation,
      });

      setRoutePlan(response.route);
      setRouteMode(response.mode);
    } catch (error) {
      Alert.alert(
        'Route failed',
        error instanceof Error ? error.message : 'Could not generate the walking path.'
      );
    } finally {
      setLoadingRoute(false);
    }
  }

  function openAppleMaps() {
    if (!robotLocation || !latestReport) {
      return;
    }

    const source = `${robotLocation.latitude},${robotLocation.longitude}`;
    const destination = `${latestReport.reporterLocation.latitude},${latestReport.reporterLocation.longitude}`;
    void Linking.openURL(`http://maps.apple.com/?saddr=${source}&daddr=${destination}&dirflg=w`);
  }

  return (
    <ScrollView contentContainerStyle={styles.content} style={styles.screen}>
      <View style={styles.hero}>
        <View style={styles.heroBadge}>
          <Ionicons color={palette.accent} name="navigate" size={18} />
          <Text style={styles.heroBadgeLabel}>Robot flow</Text>
        </View>
        <Text style={styles.heroTitle}>Track the robot phone and request the route.</Text>
        <Text style={styles.heroCopy}>
          This screen is the robot-side operator view. It reads the latest trash report, keeps the
          robot phone location fresh, and asks the backend for a walking route.
        </Text>
        <StatusPill
          label={trackingEnabled ? 'Continuous tracking active' : 'Tracking idle'}
          tone={trackingEnabled ? 'success' : 'default'}
        />
      </View>

      <Panel
        title="Robot position"
        subtitle="Use one-time capture for demos, or continuous tracking if the robot will move while the route is being watched.">
        <View style={styles.buttonRow}>
          <ActionButton
            label={loadingLocation ? 'Locating...' : 'Capture robot GPS'}
            onPress={captureRobotLocation}
            disabled={loadingLocation}
          />
          <ActionButton
            label={trackingEnabled ? 'Stop tracking' : loadingLocation ? 'Starting...' : 'Start tracking'}
            onPress={trackingEnabled ? stopTracking : startTracking}
            disabled={loadingLocation}
            variant={trackingEnabled ? 'danger' : 'secondary'}
          />
        </View>

        {robotLocation ? (
          <View style={styles.dataStack}>
            <DataRow label="Latitude" value={formatCoordinate(robotLocation.latitude)} />
            <DataRow label="Longitude" value={formatCoordinate(robotLocation.longitude)} />
            <DataRow
              label="Phone facing"
              value={
                robotLocation.heading != null
                  ? `${Math.round(robotLocation.heading)}°`
                  : 'No heading yet'
              }
            />
            <DataRow
              label="Heading accuracy"
              value={
                robotLocation.headingAccuracy != null
                  ? `${Math.round(robotLocation.headingAccuracy)}°`
                  : 'Unknown'
              }
            />
            <DataRow label="Last update" value={formatTimestamp(robotLocation.timestamp)} />
          </View>
        ) : (
          <Text style={styles.helperText}>No robot GPS fix has been captured yet.</Text>
        )}
      </Panel>

      <Panel
        title="Latest trash report"
        subtitle="The reporter device should push this through the backend. Without a backend, mock mode only works in the same JS session.">
        <View style={styles.buttonRow}>
          <ActionButton
            label={loadingReport ? 'Refreshing feed...' : 'Refresh latest report'}
            onPress={refreshLatestReport}
            disabled={loadingReport}
          />
        </View>

        {latestReport ? (
          <View style={styles.dataStack}>
            <StatusPill
              label={hasRemoteBackend() ? 'Backend feed' : 'Local mock feed'}
              tone={hasRemoteBackend() ? 'success' : 'warning'}
            />
            <DataRow label="Report id" value={latestReport.id} />
            <DataRow label="Created" value={formatTimestamp(latestReport.createdAt)} />
            <DataRow
              label="Destination lat"
              value={formatCoordinate(latestReport.reporterLocation.latitude)}
            />
            <DataRow
              label="Destination lon"
              value={formatCoordinate(latestReport.reporterLocation.longitude)}
            />
            {latestReport.note ? <DataRow label="Operator note" value={latestReport.note} /> : null}
          </View>
        ) : (
          <Text style={styles.helperText}>
            No report is available yet. Submit one from the Reporter tab or connect a backend feed.
          </Text>
        )}
      </Panel>

      <Panel
        title="Route request"
        subtitle="For production, point the backend to Apple Maps Server API or native MapKit routing and return a normalized path object.">
        <View style={styles.buttonRow}>
          <ActionButton
            label={loadingRoute ? 'Building route...' : 'Generate walking route'}
            onPress={handleBuildRoute}
            disabled={loadingRoute}
          />
          <ActionButton
            label="Open Apple Maps fallback"
            onPress={openAppleMaps}
            disabled={!robotLocation || !latestReport}
            variant="secondary"
          />
        </View>

        {routePlan ? (
          <View style={styles.dataStack}>
            <StatusPill
              label={routeMode === 'backend' ? 'Apple route via backend' : 'Straight-line mock route'}
              tone={routeMode === 'backend' ? 'success' : 'warning'}
            />
            <DataRow label="Distance" value={formatDistance(routePlan.distanceMeters)} />
            <DataRow label="ETA" value={formatDuration(routePlan.durationSeconds)} />
            <DataRow label="Provider" value={routePlan.provider} />
            <View style={styles.stepList}>
              {routePlan.steps.map((step, index) => (
                <View key={`${step.instruction}-${index}`} style={styles.stepRow}>
                  <View style={styles.stepMarker}>
                    <Text style={styles.stepMarkerLabel}>{index + 1}</Text>
                  </View>
                  <View style={styles.stepBody}>
                    <Text style={styles.stepInstruction}>{step.instruction}</Text>
                    <Text style={styles.stepMeta}>
                      {formatDistance(step.distanceMeters)} · {formatDuration(step.durationSeconds)}
                    </Text>
                  </View>
                </View>
              ))}
            </View>
          </View>
        ) : (
          <Text style={styles.helperText}>
            Build the route after both the robot location and destination report are available.
          </Text>
        )}
      </Panel>
    </ScrollView>
  );
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

const styles = StyleSheet.create({
  screen: {
    backgroundColor: palette.background,
    flex: 1,
  },
  content: {
    gap: 18,
    padding: 18,
    paddingBottom: 32,
  },
  hero: {
    backgroundColor: '#123A35',
    borderRadius: 30,
    gap: 12,
    padding: 22,
  },
  heroBadge: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    backgroundColor: '#FEF1DB',
    borderRadius: 999,
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  heroBadgeLabel: {
    color: palette.accent,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
  },
  heroTitle: {
    color: '#FFFFFF',
    fontSize: 28,
    fontWeight: '800',
    lineHeight: 34,
  },
  heroCopy: {
    color: '#D9E8E1',
    fontSize: 15,
    lineHeight: 22,
  },
  buttonRow: {
    gap: 12,
  },
  helperText: {
    color: palette.muted,
    fontSize: 14,
    lineHeight: 20,
  },
  dataStack: {
    gap: 12,
  },
  stepList: {
    gap: 12,
    marginTop: 4,
  },
  stepRow: {
    flexDirection: 'row',
    gap: 12,
  },
  stepMarker: {
    alignItems: 'center',
    backgroundColor: palette.surfaceMuted,
    borderRadius: 999,
    height: 28,
    justifyContent: 'center',
    width: 28,
  },
  stepMarkerLabel: {
    color: palette.primary,
    fontSize: 12,
    fontWeight: '700',
  },
  stepBody: {
    flex: 1,
    gap: 4,
  },
  stepInstruction: {
    color: palette.text,
    fontSize: 14,
    fontWeight: '600',
    lineHeight: 19,
  },
  stepMeta: {
    color: palette.muted,
    fontSize: 13,
  },
});
