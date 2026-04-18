import { useEffect, useMemo, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import MapView, { Circle, Marker } from 'react-native-maps';

import { CampusDefinition, getCampusById } from '@/constants/campuses';
import { useReporterContext } from '@/context/reporter-context';
import { Coordinates, TrashReport } from '@/types/routing';

type TrashHotspot = {
  id: string;
  latitude: number;
  longitude: number;
  count: number;
};

const HOTSPOT_LAT_BUCKET = 0.0009;
const HOTSPOT_LON_BUCKET = 0.0011;

export default function ReporterMapScreen() {
  const mapRef = useRef<MapView | null>(null);
  const { selectedCampusId, reportFeed } = useReporterContext();

  const selectedCampus = getCampusById(selectedCampusId);
  const campusReports = useMemo(
    () =>
      reportFeed.reports.filter((report) =>
        isWithinCampusBounds(report.reporterLocation, selectedCampus)
      ),
    [reportFeed.reports, selectedCampus]
  );
  const campusHotspots = useMemo(() => buildCampusHotspots(campusReports), [campusReports]);

  useEffect(() => {
    mapRef.current?.animateToRegion(selectedCampus.region, 400);
  }, [selectedCampus]);

  return (
    <View style={styles.screen}>
      <MapView
        ref={mapRef}
        style={styles.map}
        initialRegion={selectedCampus.region}
        showsBuildings
        showsCompass
        showsScale
        showsUserLocation
        toolbarEnabled={false}>
        {campusHotspots.map((hotspot) => (
          <Circle
            key={`${selectedCampus.id}-hotspot-${hotspot.id}`}
            center={{ latitude: hotspot.latitude, longitude: hotspot.longitude }}
            radius={getHotspotRadius(hotspot.count)}
            strokeColor="rgba(229,159,65,0.22)"
            fillColor={getHotspotFillColor(hotspot.count)}
          />
        ))}

        {campusReports.map((report) => (
          <Marker
            key={report.id}
            coordinate={{
              latitude: report.reporterLocation.latitude,
              longitude: report.reporterLocation.longitude,
            }}
            pinColor={report.id === reportFeed.activeAssignmentId ? '#B54734' : selectedCampus.accent}
            title={report.id === reportFeed.activeAssignmentId ? 'Assigned trash report' : 'Trash report'}
          />
        ))}
      </MapView>
    </View>
  );
}

function isWithinCampusBounds(location: Coordinates, campus: CampusDefinition) {
  const { minLat, maxLat, minLon, maxLon } = campus.boundingBox;
  return (
    location.latitude >= minLat &&
    location.latitude <= maxLat &&
    location.longitude >= minLon &&
    location.longitude <= maxLon
  );
}

function buildCampusHotspots(reports: TrashReport[]) {
  const hotspots = new Map<string, TrashHotspot>();

  for (const report of reports) {
    const bucketLat = Math.round(report.reporterLocation.latitude / HOTSPOT_LAT_BUCKET);
    const bucketLon = Math.round(report.reporterLocation.longitude / HOTSPOT_LON_BUCKET);
    const key = `${bucketLat}:${bucketLon}`;
    const existing = hotspots.get(key);

    if (!existing) {
      hotspots.set(key, {
        id: key,
        latitude: report.reporterLocation.latitude,
        longitude: report.reporterLocation.longitude,
        count: 1,
      });
      continue;
    }

    const nextCount = existing.count + 1;
    hotspots.set(key, {
      ...existing,
      latitude:
        (existing.latitude * existing.count + report.reporterLocation.latitude) / nextCount,
      longitude:
        (existing.longitude * existing.count + report.reporterLocation.longitude) / nextCount,
      count: nextCount,
    });
  }

  return Array.from(hotspots.values());
}

function getHotspotRadius(count: number) {
  return 30 + count * 28;
}

function getHotspotFillColor(count: number) {
  const alpha = Math.min(0.14 + count * 0.08, 0.42);
  return `rgba(229,159,65,${alpha.toFixed(2)})`;
}

const styles = StyleSheet.create({
  screen: {
    backgroundColor: '#0D1715',
    flex: 1,
  },
  map: {
    ...StyleSheet.absoluteFillObject,
  },
});
