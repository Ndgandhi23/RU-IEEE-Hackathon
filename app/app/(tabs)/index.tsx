import { Ionicons } from '@expo/vector-icons';
import {
  BottomSheetBackdrop,
  BottomSheetModal,
  BottomSheetView,
} from '@gorhom/bottom-sheet';
import type { BottomSheetBackdropProps } from '@gorhom/bottom-sheet';
import { Image } from 'expo-image';
import { forwardRef, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import MapView, { Marker } from 'react-native-maps';
import Animated, {
  Easing,
  Extrapolation,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  CAMPUSES,
  CampusDefinition,
  DEFAULT_CAMPUS_BOUNDARY_MARGIN_DEGREES,
  findCampusForLocation,
  getCampusById,
  isLocationWithinCampus,
} from '@/constants/campuses';
import {
  getAllMockSingletons,
  getMockHotspotsForCampus,
  getMockMetricsForCampus,
  MockHotspot,
} from '@/constants/mock-map-data';
import { useReporterContext } from '@/context/reporter-context';
import { TrashReport } from '@/types/routing';

type CampusMetrics = {
  total: number;
  active: number;
  cleaned: number;
};

const MAX_SINGLETON_MARKERS = 5;
const MAP_REPORT_BOUNDARY_MARGIN_DEGREES = DEFAULT_CAMPUS_BOUNDARY_MARGIN_DEGREES;

const PANEL_SIDE_PADDING = 14;
const PANEL_BUTTON_SIZE = 44;
const CAMPUS_ROW_HEIGHT = 46;
const SUMMARY_ROW_HEIGHT = 48;
const SCROLL_VISIBLE_ROWS = 3;
const PANEL_COLLAPSED_HEIGHT = PANEL_BUTTON_SIZE;
const PANEL_EXPANDED_HEIGHT =
  PANEL_BUTTON_SIZE + SUMMARY_ROW_HEIGHT + CAMPUS_ROW_HEIGHT * SCROLL_VISIBLE_ROWS + 4;

const ANIMATION_DURATION = 520;

export default function ReporterMapScreen() {
  const mapRef = useRef<MapView | null>(null);
  const lastFocusedSubmissionIdRef = useRef<string | null>(null);
  const insets = useSafeAreaInsets();
  const { width: windowWidth } = useWindowDimensions();
  const { selectedCampusId, reportFeed, submittedReport } = useReporterContext();
  const [metricsOpen, setMetricsOpen] = useState(false);
  const [selectedReport, setSelectedReport] = useState<TrashReport | null>(null);
  const [selectedHotspot, setSelectedHotspot] = useState<MockHotspot | null>(null);

  const reportSheetRef = useRef<BottomSheetModal>(null);
  const hotspotSheetRef = useRef<BottomSheetModal>(null);

  const showReport = useCallback((report: TrashReport) => {
    hotspotSheetRef.current?.dismiss();
    setSelectedHotspot(null);
    setSelectedReport(report);
    reportSheetRef.current?.present();
  }, []);

  const showHotspot = useCallback((hotspot: MockHotspot) => {
    reportSheetRef.current?.dismiss();
    setSelectedReport(null);
    setSelectedHotspot(hotspot);
    hotspotSheetRef.current?.present();
  }, []);

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop
        {...props}
        appearsOnIndex={0}
        disappearsOnIndex={-1}
        opacity={0.35}
        pressBehavior="close"
      />
    ),
    []
  );

  const selectedCampus = getCampusById(selectedCampusId);

  const mockSingletons = useMemo(() => getAllMockSingletons(), []);
  const singletons = useMemo(() => {
    const out: TrashReport[] = [];
    const shouldShowReport = (report: TrashReport) =>
      report.id === submittedReport?.id ||
      isLocationWithinCampus(
        report.reporterLocation,
        selectedCampus,
        MAP_REPORT_BOUNDARY_MARGIN_DEGREES
      );

    for (const report of reportFeed.reports) {
      if (shouldShowReport(report)) {
        out.push(report);
        if (out.length >= MAX_SINGLETON_MARKERS) {
          return out;
        }
      }
    }
    for (const report of mockSingletons) {
      if (shouldShowReport(report)) {
        out.push(report);
        if (out.length >= MAX_SINGLETON_MARKERS) {
          return out;
        }
      }
    }
    return out;
  }, [mockSingletons, reportFeed.reports, selectedCampus, submittedReport?.id]);

  const hotspots = useMemo(
    () => getMockHotspotsForCampus(selectedCampus.id),
    [selectedCampus]
  );

  const perCampus = useMemo(
    () =>
      CAMPUSES.map((campus) => {
        const realMetrics = computeMetrics(
          reportFeed.reports.filter((report) =>
            isLocationWithinCampus(
              report.reporterLocation,
              campus,
              MAP_REPORT_BOUNDARY_MARGIN_DEGREES
            )
          ),
          reportFeed.activeAssignmentId
        );
        const mockMetrics = getMockMetricsForCampus(campus.id);
        return {
          campus,
          metrics: {
            total: realMetrics.total + mockMetrics.total,
            active: realMetrics.active + mockMetrics.active,
            cleaned: realMetrics.cleaned + mockMetrics.cleaned,
          },
        };
      }),
    [reportFeed.reports, reportFeed.activeAssignmentId]
  );

  const totals = useMemo<CampusMetrics>(
    () =>
      perCampus.reduce<CampusMetrics>(
        (acc, entry) => ({
          total: acc.total + entry.metrics.total,
          active: acc.active + entry.metrics.active,
          cleaned: acc.cleaned + entry.metrics.cleaned,
        }),
        { total: 0, active: 0, cleaned: 0 }
      ),
    [perCampus]
  );

  useEffect(() => {
    mapRef.current?.animateToRegion(selectedCampus.region, 400);
  }, [selectedCampus]);

  useEffect(() => {
    if (!submittedReport) {
      return;
    }

    if (lastFocusedSubmissionIdRef.current === submittedReport.id) {
      return;
    }

    const submissionCampus = findCampusForLocation(
      submittedReport.reporterLocation,
      MAP_REPORT_BOUNDARY_MARGIN_DEGREES
    );
    if (submissionCampus.id !== selectedCampus.id) {
      return;
    }

    lastFocusedSubmissionIdRef.current = submittedReport.id;
    mapRef.current?.animateToRegion(
      {
        latitude: submittedReport.reporterLocation.latitude,
        longitude: submittedReport.reporterLocation.longitude,
        latitudeDelta: Math.min(selectedCampus.region.latitudeDelta, 0.006),
        longitudeDelta: Math.min(selectedCampus.region.longitudeDelta, 0.006),
      },
      500
    );
  }, [
    selectedCampus,
    submittedReport,
    submittedReport?.id,
    submittedReport?.reporterLocation.latitude,
    submittedReport?.reporterLocation.longitude,
  ]);

  const panelCollapsedWidth = PANEL_BUTTON_SIZE;
  const panelExpandedWidth = Math.max(
    windowWidth - PANEL_SIDE_PADDING * 2,
    panelCollapsedWidth
  );

  const openProgress = useSharedValue(0);

  useEffect(() => {
    openProgress.value = withTiming(metricsOpen ? 1 : 0, {
      duration: ANIMATION_DURATION,
    });
  }, [metricsOpen, openProgress]);

  const panelStyle = useAnimatedStyle(() => {
    const heightProgress = interpolate(
      openProgress.value,
      [0, 0.5],
      [0, 1],
      Extrapolation.CLAMP
    );
    const widthProgress = interpolate(
      openProgress.value,
      [0.5, 1],
      [0, 1],
      Extrapolation.CLAMP
    );
    return {
      height:
        PANEL_COLLAPSED_HEIGHT +
        heightProgress * (PANEL_EXPANDED_HEIGHT - PANEL_COLLAPSED_HEIGHT),
      width: panelCollapsedWidth + widthProgress * (panelExpandedWidth - panelCollapsedWidth),
    };
  });

  const menuIconStyle = useAnimatedStyle(() => {
    const progress = interpolate(
      openProgress.value,
      [0, 0.35],
      [1, 0],
      Extrapolation.CLAMP
    );
    return {
      opacity: progress,
      transform: [{ rotate: `${(1 - progress) * -90}deg` }],
    };
  });

  const closeIconStyle = useAnimatedStyle(() => {
    const progress = interpolate(
      openProgress.value,
      [0.35, 0.75],
      [0, 1],
      Extrapolation.CLAMP
    );
    return {
      opacity: progress,
      transform: [{ rotate: `${(1 - progress) * 90}deg` }],
    };
  });

  const contentStyle = useAnimatedStyle(() => {
    const p = interpolate(openProgress.value, [0.6, 1], [0, 1], Extrapolation.CLAMP);
    return {
      opacity: p,
      transform: [{ translateX: (1 - p) * -6 }],
    };
  });

  return (
    <View style={styles.screen}>
      <MapView
        ref={mapRef}
        style={styles.map}
        initialRegion={selectedCampus.region}
        showsCompass
        showsScale
        showsUserLocation
        toolbarEnabled={false}>
        {singletons.map((report, index) => {
          const isActive = report.id === reportFeed.activeAssignmentId;
          const isCleaned = report.status === 'completed';
          const pinColor = isActive
            ? '#B54734'
            : isCleaned
            ? '#34C759'
            : selectedCampus.accent;
          const iconName: keyof typeof Ionicons.glyphMap = isCleaned
            ? 'checkmark'
            : isActive
            ? 'navigate'
            : 'trash';
          return (
            <SingletonMarker
              key={report.id}
              report={report}
              color={pinColor}
              iconName={iconName}
              pulse={isActive}
              delay={index * 80}
              onPress={() => showReport(report)}
            />
          );
        })}
      </MapView>

      <ReportDetailSheetModal
        ref={reportSheetRef}
        report={selectedReport}
        activeAssignmentId={reportFeed.activeAssignmentId}
        accent={selectedCampus.accent}
        renderBackdrop={renderBackdrop}
        onDismissed={() => setSelectedReport(null)}
      />

      <HotspotDetailSheetModal
        ref={hotspotSheetRef}
        hotspot={selectedHotspot}
        renderBackdrop={renderBackdrop}
        onDismissed={() => setSelectedHotspot(null)}
      />

      <Animated.View style={[styles.panel, { top: insets.top + 12 }, panelStyle]}>
        <View style={styles.topRow}>
          <Pressable
            accessibilityLabel={metricsOpen ? 'Close stats' : 'Open stats'}
            onPress={() => setMetricsOpen((prev) => !prev)}
            style={({ pressed }) => [styles.iconButton, pressed && styles.iconButtonPressed]}>
            <Animated.View style={[styles.iconAbs, menuIconStyle]}>
              <Ionicons color="#111112" name="menu" size={22} />
            </Animated.View>
            <Animated.View style={[styles.iconAbs, closeIconStyle]}>
              <Ionicons color="#111112" name="close" size={22} />
            </Animated.View>
          </Pressable>
          <Animated.Text
            numberOfLines={1}
            style={[styles.topTitle, contentStyle]}>
            All Campuses
          </Animated.Text>
        </View>

        <Animated.View style={[styles.contentArea, contentStyle]}>
          <View style={styles.summaryRow}>
            <SummaryStat label="Total Reports" value={totals.total} accent="#0A84FF" />
            <View style={styles.summaryDivider} />
            <SummaryStat label="Total Cleaned" value={totals.cleaned} accent="#34C759" />
          </View>

          <View style={styles.sectionDivider} />

          <ScrollView
            style={styles.scroll}
            contentContainerStyle={styles.scrollContent}
            showsVerticalScrollIndicator
            bounces>
            {perCampus.map(({ campus, metrics }, index) => (
              <View key={campus.id}>
                {index > 0 ? <View style={styles.rowDivider} /> : null}
                <CampusRow campus={campus} metrics={metrics} />
              </View>
            ))}
          </ScrollView>
        </Animated.View>
      </Animated.View>
    </View>
  );
}

type ReportSheetProps = {
  report: TrashReport | null;
  activeAssignmentId: string | null;
  accent: string;
  renderBackdrop: (props: BottomSheetBackdropProps) => React.ReactElement;
  onDismissed: () => void;
};

const ReportDetailSheetModal = forwardRef<BottomSheetModal, ReportSheetProps>(
  function ReportDetailSheetModal(
    { report, activeAssignmentId, accent, renderBackdrop, onDismissed },
    ref
  ) {
    const snapPoints = useMemo(() => ['55%'], []);
    const insets = useSafeAreaInsets();

    const isActive = report && report.id === activeAssignmentId;
    const status = !report
      ? null
      : isActive
      ? { label: 'Assigned to robot', color: '#B54734' }
      : report.status === 'completed'
      ? { label: 'Cleaned', color: '#34C759' }
      : { label: 'Pending pickup', color: '#FF9500' };
    const photoSource = report?.photoUrl ?? report?.photoUri ?? null;
    const when = report ? formatRelativeTime(report.createdAt) : '';

    return (
      <BottomSheetModal
        ref={ref}
        snapPoints={snapPoints}
        backdropComponent={renderBackdrop}
        backgroundStyle={sheetStyles.background}
        handleIndicatorStyle={sheetStyles.handleIndicator}
        enablePanDownToClose
        onDismiss={onDismissed}>
        <BottomSheetView
          style={[sheetStyles.content, { paddingBottom: insets.bottom + 18 }]}>
          {report ? (
            <>
              <View style={sheetStyles.headerRow}>
                <View style={[sheetStyles.accentDot, { backgroundColor: accent }]} />
                <Text style={sheetStyles.eyebrow} numberOfLines={1}>
                  REPORT · {when}
                </Text>
              </View>

              {photoSource ? (
                <Image
                  contentFit="cover"
                  source={{ uri: photoSource }}
                  style={sheetStyles.photo}
                  transition={200}
                />
              ) : (
                <View style={[sheetStyles.photo, sheetStyles.photoFallback]}>
                  <Ionicons color="#8A8A8E" name="image-outline" size={28} />
                </View>
              )}

              {status ? (
                <View
                  style={[
                    sheetStyles.statusPill,
                    { backgroundColor: `${status.color}1A` },
                  ]}>
                  <View
                    style={[sheetStyles.statusDot, { backgroundColor: status.color }]}
                  />
                  <Text style={[sheetStyles.statusLabel, { color: status.color }]}>
                    {status.label}
                  </Text>
                </View>
              ) : null}

              {report.caption ? (
                <Text style={sheetStyles.caption} numberOfLines={3}>
                  {report.caption}
                </Text>
              ) : null}
            </>
          ) : null}
        </BottomSheetView>
      </BottomSheetModal>
    );
  }
);

type HotspotSheetProps = {
  hotspot: MockHotspot | null;
  renderBackdrop: (props: BottomSheetBackdropProps) => React.ReactElement;
  onDismissed: () => void;
};

const HotspotDetailSheetModal = forwardRef<BottomSheetModal, HotspotSheetProps>(
  function HotspotDetailSheetModal({ hotspot, renderBackdrop, onDismissed }, ref) {
    const snapPoints = useMemo(() => ['38%'], []);
    const insets = useSafeAreaInsets();

    const heat = hotspot ? getHeatLevel(hotspot.total) : null;
    const label = hotspot ? getHeatLabel(hotspot.total) : '';

    return (
      <BottomSheetModal
        ref={ref}
        snapPoints={snapPoints}
        backdropComponent={renderBackdrop}
        backgroundStyle={sheetStyles.background}
        handleIndicatorStyle={sheetStyles.handleIndicator}
        enablePanDownToClose
        onDismiss={onDismissed}>
        <BottomSheetView
          style={[sheetStyles.content, { paddingBottom: insets.bottom + 18 }]}>
          {hotspot && heat ? (
            <>
              <View style={sheetStyles.headerRow}>
                <View style={[sheetStyles.accentDot, { backgroundColor: heat.stroke }]} />
                <Text style={sheetStyles.eyebrow} numberOfLines={1}>
                  AREA · {label}
                </Text>
              </View>

              <Text style={sheetStyles.hotspotTitle}>
                {formatMetricValue(hotspot.total)} reports in this area
              </Text>

              <View style={sheetStyles.hotspotStats}>
                <HotspotStat
                  label="In progress"
                  value={hotspot.active}
                  color="#FF9500"
                />
                <View style={sheetStyles.hotspotDivider} />
                <HotspotStat label="Cleaned" value={hotspot.cleaned} color="#34C759" />
                <View style={sheetStyles.hotspotDivider} />
                <HotspotStat label="Total" value={hotspot.total} color="#111112" />
              </View>
            </>
          ) : null}
        </BottomSheetView>
      </BottomSheetModal>
    );
  }
);

function SingletonMarker({
  report,
  color,
  iconName,
  pulse,
  delay,
  onPress,
}: {
  report: TrashReport;
  color: string;
  iconName: keyof typeof Ionicons.glyphMap;
  pulse: boolean;
  delay: number;
  onPress: () => void;
}) {
  const [tracks, setTracks] = useState(true);

  useEffect(() => {
    if (pulse) {
      setTracks(true);
      return;
    }
    const timeout = setTimeout(() => setTracks(false), 650 + delay);
    return () => clearTimeout(timeout);
  }, [pulse, delay]);

  return (
    <Marker
      coordinate={{
        latitude: report.reporterLocation.latitude,
        longitude: report.reporterLocation.longitude,
      }}
      anchor={{ x: 0.5, y: 1 }}
      centerOffset={{ x: 0, y: -20 }}
      tracksViewChanges={tracks}
      onPress={onPress}>
      <AnimatedPin color={color} iconName={iconName} pulse={pulse} delay={delay} />
    </Marker>
  );
}

function AnimatedPin({
  color,
  iconName,
  pulse,
  delay,
}: {
  color: string;
  iconName: keyof typeof Ionicons.glyphMap;
  pulse: boolean;
  delay: number;
}) {
  const enter = useSharedValue(0);
  const pulseProgress = useSharedValue(0);

  useEffect(() => {
    enter.value = withDelay(
      delay,
      withTiming(1, {
        duration: 420,
        easing: Easing.out(Easing.back(1.4)),
      })
    );
  }, [enter, delay]);

  useEffect(() => {
    if (pulse) {
      pulseProgress.value = withRepeat(
        withSequence(
          withTiming(1, { duration: 1100, easing: Easing.out(Easing.quad) }),
          withTiming(0, { duration: 0 })
        ),
        -1,
        false
      );
    } else {
      pulseProgress.value = 0;
    }
  }, [pulse, pulseProgress]);

  const headStyle = useAnimatedStyle(() => ({
    transform: [
      { scale: interpolate(enter.value, [0, 1], [0.2, 1], Extrapolation.CLAMP) },
    ],
    opacity: enter.value,
  }));

  const tailStyle = useAnimatedStyle(() => ({
    transform: [
      { rotate: '45deg' },
      { scale: interpolate(enter.value, [0, 1], [0.2, 1], Extrapolation.CLAMP) },
    ],
    opacity: enter.value,
  }));

  const pulseStyle = useAnimatedStyle(() => ({
    opacity: interpolate(
      pulseProgress.value,
      [0, 0.4, 1],
      [0.55, 0.25, 0],
      Extrapolation.CLAMP
    ),
    transform: [
      { scale: interpolate(pulseProgress.value, [0, 1], [0.6, 2.1]) },
    ],
  }));

  return (
    <View style={styles.pinContainer}>
      {pulse ? (
        <Animated.View
          pointerEvents="none"
          style={[styles.pinPulse, { backgroundColor: color }, pulseStyle]}
        />
      ) : null}
      <Animated.View style={[styles.pinHead, { backgroundColor: color }, headStyle]}>
        <Ionicons color="#FFFFFF" name={iconName} size={18} />
      </Animated.View>
      <Animated.View style={[styles.pinTail, { backgroundColor: color }, tailStyle]} />
    </View>
  );
}

function HotspotStat({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color: string;
}) {
  return (
    <View style={sheetStyles.hotspotStat}>
      <Text style={[sheetStyles.hotspotStatValue, { color }]}>
        {formatMetricValue(value)}
      </Text>
      <Text style={sheetStyles.hotspotStatLabel}>{label}</Text>
    </View>
  );
}

function getHeatLabel(count: number) {
  if (count >= 500) return 'EXTREME';
  if (count >= 150) return 'HIGH';
  if (count >= 40) return 'MEDIUM';
  return 'LOW';
}

function formatRelativeTime(iso: string) {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'just now';
  const diff = Date.now() - then;
  const minutes = Math.round(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function SummaryStat({
  label,
  value,
  accent,
}: {
  label: string;
  value: number;
  accent: string;
}) {
  return (
    <View style={styles.summaryStat}>
      <Text style={[styles.summaryValue, { color: accent }]}>{formatMetricValue(value)}</Text>
      <Text style={styles.summaryLabel} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

function CampusRow({ campus, metrics }: { campus: CampusDefinition; metrics: CampusMetrics }) {
  return (
    <View style={styles.campusRow}>
      <View style={[styles.campusDot, { backgroundColor: campus.accent }]} />
      <Text style={styles.campusName} numberOfLines={1}>
        {campus.shortName}
      </Text>
      <View style={styles.campusStats}>
        <Text style={[styles.campusStat, { color: '#0A84FF' }]}>
          {formatMetricValue(metrics.total)}
        </Text>
        <Text style={[styles.campusStat, { color: '#34C759' }]}>
          {formatMetricValue(metrics.cleaned)}
        </Text>
      </View>
    </View>
  );
}

function formatMetricValue(value: number) {
  if (value >= 1000) {
    return `${(value / 1000).toFixed(1)}k`;
  }
  return String(value);
}

function computeMetrics(
  reports: TrashReport[],
  activeAssignmentId: string | null
): CampusMetrics {
  let cleaned = 0;
  let active = 0;

  for (const report of reports) {
    if (report.status === 'completed') {
      cleaned += 1;
      continue;
    }
    if (report.status === 'assigned' || report.id === activeAssignmentId) {
      active += 1;
    }
  }

  return {
    total: reports.length,
    active,
    cleaned,
  };
}

type HeatLevel = {
  radius: number;
  stroke: string;
  fill: string;
};

function getHeatLevel(count: number): HeatLevel {
  if (count >= 500) {
    return {
      radius: 130,
      stroke: 'rgba(185,28,28,0.55)',
      fill: 'rgba(185,28,28,0.28)',
    };
  }
  if (count >= 150) {
    return {
      radius: 95,
      stroke: 'rgba(220,38,38,0.50)',
      fill: 'rgba(220,38,38,0.22)',
    };
  }
  if (count >= 40) {
    return {
      radius: 65,
      stroke: 'rgba(249,115,22,0.45)',
      fill: 'rgba(249,115,22,0.18)',
    };
  }
  return {
    radius: 45,
    stroke: 'rgba(245,158,11,0.45)',
    fill: 'rgba(245,158,11,0.16)',
  };
}

const styles = StyleSheet.create({
  screen: {
    backgroundColor: '#0D1715',
    flex: 1,
  },
  map: {
    ...StyleSheet.absoluteFillObject,
  },
  pinContainer: {
    alignItems: 'center',
    height: 52,
    justifyContent: 'flex-start',
    width: 44,
  },
  pinPulse: {
    borderRadius: 22,
    height: 44,
    left: 0,
    position: 'absolute',
    top: 0,
    width: 44,
  },
  pinHead: {
    alignItems: 'center',
    borderColor: '#FFFFFF',
    borderRadius: 20,
    borderWidth: 3,
    height: 40,
    justifyContent: 'center',
    width: 40,
    zIndex: 2,
  },
  pinTail: {
    borderRadius: 3,
    height: 14,
    marginTop: -8,
    width: 14,
    zIndex: 1,
  },
  hotspotBadge: {
    alignItems: 'center',
    borderRadius: 18,
    borderWidth: 2,
    height: 36,
    justifyContent: 'center',
    minWidth: 44,
    paddingHorizontal: 10,
  },
  hotspotBadgeText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontVariant: ['tabular-nums'],
    fontWeight: '800',
    letterSpacing: 0.2,
  },
  panel: {
    backgroundColor: 'rgba(255,255,255,0.97)',
    borderRadius: 22,
    elevation: 6,
    left: PANEL_SIDE_PADDING,
    overflow: 'hidden',
    position: 'absolute',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.18,
    shadowRadius: 12,
  },
  topRow: {
    alignItems: 'center',
    flexDirection: 'row',
    height: PANEL_BUTTON_SIZE,
  },
  iconButton: {
    alignItems: 'center',
    height: PANEL_BUTTON_SIZE,
    justifyContent: 'center',
    width: PANEL_BUTTON_SIZE,
  },
  iconButtonPressed: {
    backgroundColor: 'rgba(0,0,0,0.06)',
  },
  iconAbs: {
    alignItems: 'center',
    height: PANEL_BUTTON_SIZE,
    justifyContent: 'center',
    left: 0,
    position: 'absolute',
    top: 0,
    width: PANEL_BUTTON_SIZE,
  },
  topTitle: {
    color: '#111112',
    flex: 1,
    fontSize: 15,
    fontWeight: '700',
    letterSpacing: 0.1,
    paddingRight: 14,
  },
  contentArea: {
    flex: 1,
  },
  summaryRow: {
    alignItems: 'center',
    flexDirection: 'row',
    height: SUMMARY_ROW_HEIGHT,
    paddingHorizontal: 14,
  },
  summaryStat: {
    alignItems: 'flex-start',
    flex: 1,
  },
  summaryValue: {
    fontSize: 18,
    fontVariant: ['tabular-nums'],
    fontWeight: '700',
    letterSpacing: -0.2,
  },
  summaryLabel: {
    color: '#6D6D72',
    fontSize: 10,
    fontWeight: '600',
    letterSpacing: 0.3,
    marginTop: 1,
    textTransform: 'uppercase',
  },
  summaryDivider: {
    backgroundColor: '#E5E5EA',
    height: 28,
    marginHorizontal: 10,
    width: StyleSheet.hairlineWidth,
  },
  sectionDivider: {
    backgroundColor: '#E5E5EA',
    height: StyleSheet.hairlineWidth,
    marginHorizontal: 14,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingVertical: 2,
  },
  campusRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
    height: CAMPUS_ROW_HEIGHT,
    paddingHorizontal: 14,
  },
  campusDot: {
    borderRadius: 5,
    height: 10,
    width: 10,
  },
  campusName: {
    color: '#111112',
    flex: 1,
    fontSize: 14,
    fontWeight: '500',
  },
  campusStats: {
    flexDirection: 'row',
    gap: 18,
  },
  campusStat: {
    fontSize: 14,
    fontVariant: ['tabular-nums'],
    fontWeight: '700',
    minWidth: 26,
    textAlign: 'right',
  },
  rowDivider: {
    backgroundColor: '#EFEFF4',
    height: StyleSheet.hairlineWidth,
    marginLeft: 34,
  },
});

const sheetStyles = StyleSheet.create({
  background: {
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
  },
  handleIndicator: {
    backgroundColor: '#D1D1D6',
    height: 5,
    width: 40,
  },
  content: {
    paddingHorizontal: 18,
    paddingTop: 4,
  },
  headerRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
    marginBottom: 12,
  },
  accentDot: {
    borderRadius: 5,
    height: 10,
    width: 10,
  },
  eyebrow: {
    color: '#6D6D72',
    flex: 1,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.6,
  },
  photo: {
    aspectRatio: 16 / 10,
    backgroundColor: '#F2F2F7',
    borderRadius: 16,
    width: '100%',
  },
  photoFallback: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  statusPill: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    borderRadius: 14,
    flexDirection: 'row',
    gap: 6,
    marginTop: 12,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  statusDot: {
    borderRadius: 4,
    height: 8,
    width: 8,
  },
  statusLabel: {
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.2,
  },
  caption: {
    color: '#111112',
    fontSize: 15,
    lineHeight: 20,
    marginTop: 10,
  },
  hotspotTitle: {
    color: '#111112',
    fontSize: 20,
    fontWeight: '800',
    letterSpacing: -0.3,
    marginBottom: 14,
  },
  hotspotStats: {
    alignItems: 'stretch',
    backgroundColor: '#F7F7F9',
    borderRadius: 16,
    flexDirection: 'row',
    marginBottom: 4,
    paddingVertical: 12,
  },
  hotspotStat: {
    alignItems: 'center',
    flex: 1,
    gap: 2,
  },
  hotspotStatValue: {
    fontSize: 18,
    fontVariant: ['tabular-nums'],
    fontWeight: '800',
    letterSpacing: -0.2,
  },
  hotspotStatLabel: {
    color: '#6D6D72',
    fontSize: 10,
    fontWeight: '600',
    letterSpacing: 0.3,
    textTransform: 'uppercase',
  },
  hotspotDivider: {
    alignSelf: 'center',
    backgroundColor: '#E5E5EA',
    height: 28,
    width: StyleSheet.hairlineWidth,
  },
});
