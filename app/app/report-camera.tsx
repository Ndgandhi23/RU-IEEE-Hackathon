import { useFocusEffect } from '@react-navigation/native';
import { CameraType, CameraView, useCameraPermissions } from 'expo-camera';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import * as Location from 'expo-location';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { Ionicons } from '@expo/vector-icons';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CAMPUSES, CampusDefinition, CampusId } from '@/constants/campuses';
import { useReporterContext } from '@/context/reporter-context';
import { Coordinates } from '@/types/routing';

export default function ReportCameraRoute() {
  const cameraRef = useRef<CameraView | null>(null);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const { selectedCampusId, setSelectedCampusId } = useReporterContext();
  const [reporterLocation, setReporterLocation] = useState<Coordinates | null>(null);
  const [locationStatus, setLocationStatus] = useState<'idle' | 'locating' | 'ready' | 'error'>('idle');
  const [cameraStatus, setCameraStatus] = useState<'checking' | 'ready' | 'denied'>('checking');
  const [capturedPhotoUri, setCapturedPhotoUri] = useState<string | null>(null);
  const [captureBusy, setCaptureBusy] = useState(false);
  const [zoomLevel, setZoomLevel] = useState(0);
  const [cameraFacing, setCameraFacing] = useState<CameraType>('back');
  const zoomStartRef = useRef(0);

  const spinnerOpacity = useSharedValue(0);
  const spinnerRotation = useSharedValue(0);
  const previewOpacity = useSharedValue(0);
  const previewControlsOpacity = useSharedValue(0);
  const captureControlsOpacity = useSharedValue(1);

  useEffect(() => {
    spinnerRotation.value = withRepeat(
      withTiming(360, { duration: 900, easing: Easing.linear }),
      -1,
      false
    );
  }, [spinnerRotation]);

  useEffect(() => {
    if (captureBusy) {
      spinnerOpacity.value = withTiming(1, { duration: 180 });
      captureControlsOpacity.value = withTiming(0, { duration: 160 });
    } else {
      spinnerOpacity.value = withTiming(0, { duration: 220 });
      if (!capturedPhotoUri) {
        captureControlsOpacity.value = withTiming(1, { duration: 260 });
      }
    }
  }, [captureBusy, capturedPhotoUri, captureControlsOpacity, spinnerOpacity]);

  useEffect(() => {
    if (capturedPhotoUri) {
      previewOpacity.value = withDelay(80, withTiming(1, { duration: 320 }));
      previewControlsOpacity.value = withDelay(320, withTiming(1, { duration: 280 }));
      captureControlsOpacity.value = withTiming(0, { duration: 160 });
    } else {
      previewOpacity.value = withTiming(0, { duration: 180 });
      previewControlsOpacity.value = withTiming(0, { duration: 160 });
      captureControlsOpacity.value = withDelay(80, withTiming(1, { duration: 260 }));
    }
  }, [capturedPhotoUri, captureControlsOpacity, previewControlsOpacity, previewOpacity]);

  const spinnerStyle = useAnimatedStyle(() => ({ opacity: spinnerOpacity.value }));
  const spinnerRingStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${spinnerRotation.value}deg` }],
  }));
  const previewImageStyle = useAnimatedStyle(() => ({ opacity: previewOpacity.value }));
  const previewControlsStyle = useAnimatedStyle(() => ({
    opacity: previewControlsOpacity.value,
    transform: [{ translateY: (1 - previewControlsOpacity.value) * 14 }],
  }));
  const captureControlsStyle = useAnimatedStyle(() => ({
    opacity: captureControlsOpacity.value,
    transform: [{ translateY: (1 - captureControlsOpacity.value) * 14 }],
  }));

  const refreshLocation = useCallback(async () => {
    try {
      setLocationStatus('locating');
      const permission = await Location.requestForegroundPermissionsAsync();
      if (!permission.granted) {
        setLocationStatus('error');
        Alert.alert(
          'Location permission needed',
          'Allow location access so each trash report includes GPS coordinates.'
        );
        return;
      }

      const position = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });

      const nextLocation = {
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        accuracy: position.coords.accuracy,
        timestamp: new Date(position.timestamp).toISOString(),
      };

      setReporterLocation(nextLocation);
      setLocationStatus('ready');

      const nextCampusId = inferCampusId(nextLocation) ?? selectedCampusId;
      if (nextCampusId !== selectedCampusId) {
        setSelectedCampusId(nextCampusId);
      }
    } catch (error) {
      setLocationStatus('error');
      Alert.alert(
        'Location unavailable',
        error instanceof Error ? error.message : 'Unknown location error.'
      );
    }
  }, [selectedCampusId, setSelectedCampusId]);

  useFocusEffect(
    useCallback(() => {
      let active = true;

      async function prepareCameraAndLocation() {
        const permission =
          cameraPermission?.granted ? cameraPermission : await requestCameraPermission();

        if (!active) {
          return;
        }

        setCameraStatus(permission.granted ? 'ready' : 'denied');
        void refreshLocation();
      }

      void prepareCameraAndLocation();

      return () => {
        active = false;
      };
    }, [cameraPermission, refreshLocation, requestCameraPermission])
  );

  useEffect(() => {
    if (cameraPermission?.granted) {
      setCameraStatus('ready');
    }
  }, [cameraPermission]);

  const pinchGesture = Gesture.Pinch()
    .enabled(!capturedPhotoUri && cameraStatus === 'ready')
    .runOnJS(true)
    .onStart(() => {
      zoomStartRef.current = zoomLevel;
    })
    .onUpdate((event) => {
      const next = clamp(zoomStartRef.current + (event.scale - 1) * 0.15);
      setZoomLevel((prev) => (Math.abs(prev - next) < 0.01 ? prev : next));
    });

  function resetZoom() {
    setZoomLevel(0);
  }

  function handleFlipCamera() {
    if (capturedPhotoUri) {
      return;
    }
    resetZoom();
    setCameraFacing((prev) => (prev === 'back' ? 'front' : 'back'));
  }

  async function handleTakePhoto() {
    if (!cameraRef.current || captureBusy) {
      return;
    }

    try {
      setCaptureBusy(true);
      const photo = await cameraRef.current.takePictureAsync({
        quality: 0.8,
      });

      if (!photo?.uri) {
        throw new Error('Camera returned no photo.');
      }

      setCapturedPhotoUri(photo.uri);
      if (locationStatus !== 'ready') {
        void refreshLocation();
      }
    } catch (error) {
      Alert.alert('Capture failed', error instanceof Error ? error.message : 'Unknown camera error.');
    } finally {
      setCaptureBusy(false);
    }
  }

  function handleDone() {
    if (!capturedPhotoUri) {
      return;
    }
    if (!reporterLocation) {
      Alert.alert(
        'Still preparing',
        'The GPS fix needs to be ready before you can caption and share this report.'
      );
      return;
    }

    router.push({
      pathname: '/report-details',
      params: {
        photoUri: capturedPhotoUri,
        latitude: String(reporterLocation.latitude),
        longitude: String(reporterLocation.longitude),
        timestamp: reporterLocation.timestamp,
        accuracy:
          reporterLocation.accuracy != null ? String(reporterLocation.accuracy) : '',
      },
    });
  }

  function handleRetake() {
    setCapturedPhotoUri(null);
    resetZoom();
  }

  function handleClose() {
    setCapturedPhotoUri(null);
    resetZoom();
    router.back();
  }

  if (cameraStatus === 'checking') {
    return (
      <View style={styles.loadingScreen}>
        <ActivityIndicator color="#FFFFFF" size="large" />
        <Text style={styles.loadingTitle}>Opening camera</Text>
      </View>
    );
  }

  if (cameraStatus === 'denied') {
    return (
      <View style={styles.permissionScreen}>
        <Text style={styles.permissionTitle}>Camera access is required</Text>
        <Text style={styles.permissionCopy}>
          Enable camera permission so the report flow can open directly into the camera.
        </Text>
        <Pressable
          onPress={() => {
            setCameraStatus('checking');
            void requestCameraPermission();
          }}
          style={styles.permissionButton}>
          <Text style={styles.permissionButtonLabel}>Retry camera permission</Text>
        </Pressable>
        <Pressable onPress={handleClose} style={styles.permissionSecondaryButton}>
          <Text style={styles.permissionSecondaryLabel}>Close</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <GestureDetector gesture={pinchGesture}>
        <CameraView ref={cameraRef} facing={cameraFacing} style={styles.camera} zoom={zoomLevel} />
      </GestureDetector>

      {capturedPhotoUri ? (
        <Animated.View
          pointerEvents="none"
          style={[StyleSheet.absoluteFillObject, previewImageStyle]}>
          <Image contentFit="cover" source={{ uri: capturedPhotoUri }} style={styles.camera} />
        </Animated.View>
      ) : null}

      <Animated.View
        pointerEvents="none"
        style={[styles.captureSpinnerWrap, spinnerStyle]}>
        <View style={styles.captureSpinnerCard}>
          <View style={styles.ringTrack} />
          <Animated.View style={[styles.ringArc, spinnerRingStyle]} />
        </View>
      </Animated.View>

      <View style={styles.overlay} pointerEvents="box-none">
        <Pressable onPress={handleClose} style={[styles.topCloseButton, { top: insets.top + 16 }]}>
          <Ionicons color="#FFFFFF" name="close" size={24} />
        </Pressable>

        {!capturedPhotoUri ? (
          <Pressable
            onPress={handleFlipCamera}
            style={({ pressed }) => [
              styles.topFlipButton,
              { top: insets.top + 16 },
              pressed && styles.topFlipButtonPressed,
            ]}>
            <Ionicons color="#FFFFFF" name="camera-reverse-outline" size={24} />
          </Pressable>
        ) : null}

        {!capturedPhotoUri && zoomLevel > 0.001 ? (
          <View style={[styles.zoomBadge, { top: insets.top + 16 }]} pointerEvents="none">
            <Text style={styles.zoomBadgeLabel}>{formatZoomLabel(zoomLevel)}</Text>
          </View>
        ) : null}

        <View style={[styles.bottomControls, { bottom: Math.max(insets.bottom, 14) }]}>
          {capturedPhotoUri ? (
            <Animated.View style={[styles.previewControls, previewControlsStyle]}>
              <CircularIconButton icon="refresh" onPress={handleRetake} />
              <View style={styles.previewSpacer} />
              <CircularLabelButton label="Done" onPress={handleDone} />
            </Animated.View>
          ) : (
            <Animated.View style={[styles.captureControls, captureControlsStyle]}>
              <View style={styles.captureSideSpacer} />
              <Pressable
                onPress={handleTakePhoto}
                disabled={captureBusy || cameraStatus !== 'ready'}
                style={[styles.shutterOuter, (captureBusy || cameraStatus !== 'ready') && styles.disabledButton]}>
                <View style={styles.shutterInner} />
              </Pressable>
              <View style={styles.captureSideSpacer} />
            </Animated.View>
          )}
        </View>
      </View>
    </View>
  );
}

function CircularIconButton({
  icon,
  disabled,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      disabled={disabled}
      onPress={onPress}
      style={[styles.iconButton, disabled && styles.disabledButton]}>
      <Ionicons color="#FFFFFF" name={icon} size={22} />
    </Pressable>
  );
}

function CircularLabelButton({
  label,
  disabled,
  onPress,
}: {
  label: string;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      disabled={disabled}
      onPress={onPress}
      style={[styles.iconButton, disabled && styles.disabledButton]}>
      <Text style={styles.iconButtonLabel}>{label}</Text>
    </Pressable>
  );
}

function clamp(value: number) {
  return Math.max(0, Math.min(1, Number(value.toFixed(3))));
}

function formatZoomLabel(zoom: number) {
  const multiplier = 1 + zoom * 9;
  return `${multiplier < 10 ? multiplier.toFixed(1) : Math.round(multiplier)}x`;
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

function inferCampusId(location: Coordinates): CampusId | null {
  const campus = CAMPUSES.find((candidate) => isWithinCampusBounds(location, candidate));
  return campus?.id ?? null;
}

const styles = StyleSheet.create({
  screen: {
    backgroundColor: '#000000',
    flex: 1,
  },
  camera: {
    ...StyleSheet.absoluteFillObject,
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
  },
  topCloseButton: {
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.52)',
    borderRadius: 22,
    height: 44,
    justifyContent: 'center',
    left: 18,
    position: 'absolute',
    width: 44,
  },
  topFlipButton: {
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.52)',
    borderRadius: 22,
    height: 44,
    justifyContent: 'center',
    position: 'absolute',
    right: 18,
    width: 44,
  },
  topFlipButtonPressed: {
    backgroundColor: 'rgba(0,0,0,0.72)',
  },
  bottomControls: {
    left: 18,
    position: 'absolute',
    right: 18,
  },
  captureControls: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'center',
  },
  captureSpinnerWrap: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  captureSpinnerCard: {
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.45)',
    borderRadius: 36,
    height: 72,
    justifyContent: 'center',
    shadowColor: '#34C759',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.55,
    shadowRadius: 14,
    width: 72,
  },
  ringTrack: {
    borderColor: 'rgba(52,199,89,0.2)',
    borderRadius: 22,
    borderWidth: 4,
    height: 44,
    position: 'absolute',
    width: 44,
  },
  ringArc: {
    borderBottomColor: 'transparent',
    borderColor: '#34C759',
    borderLeftColor: 'transparent',
    borderRadius: 22,
    borderRightColor: 'transparent',
    borderWidth: 4,
    height: 44,
    position: 'absolute',
    width: 44,
  },
  zoomBadge: {
    alignItems: 'center',
    alignSelf: 'center',
    backgroundColor: 'rgba(0,0,0,0.56)',
    borderRadius: 14,
    minWidth: 56,
    paddingHorizontal: 12,
    paddingVertical: 6,
    position: 'absolute',
  },
  zoomBadgeLabel: {
    color: '#FFE27A',
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 0.3,
  },
  captureSideSpacer: {
    flex: 1,
  },
  shutterOuter: {
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.25)',
    borderColor: '#FFFFFF',
    borderRadius: 42,
    borderWidth: 3,
    height: 84,
    justifyContent: 'center',
    width: 84,
  },
  shutterInner: {
    backgroundColor: '#FFFFFF',
    borderRadius: 30,
    height: 60,
    width: 60,
  },
  previewControls: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  previewSpacer: {
    flex: 1,
  },
  iconButton: {
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.56)',
    borderRadius: 26,
    height: 52,
    justifyContent: 'center',
    width: 52,
  },
  iconButtonLabel: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '800',
    letterSpacing: 0.3,
  },
  disabledButton: {
    opacity: 0.52,
  },
  loadingScreen: {
    alignItems: 'center',
    backgroundColor: '#000000',
    flex: 1,
    gap: 12,
    justifyContent: 'center',
  },
  loadingTitle: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
  },
  permissionScreen: {
    alignItems: 'center',
    backgroundColor: '#000000',
    flex: 1,
    gap: 12,
    justifyContent: 'center',
    paddingHorizontal: 28,
  },
  permissionTitle: {
    color: '#FFFFFF',
    fontSize: 24,
    fontWeight: '800',
    textAlign: 'center',
  },
  permissionCopy: {
    color: 'rgba(255,255,255,0.76)',
    fontSize: 14,
    lineHeight: 21,
    textAlign: 'center',
  },
  permissionButton: {
    backgroundColor: '#147154',
    borderRadius: 18,
    marginTop: 6,
    paddingHorizontal: 18,
    paddingVertical: 14,
  },
  permissionButtonLabel: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '800',
  },
  permissionSecondaryButton: {
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  permissionSecondaryLabel: {
    color: 'rgba(255,255,255,0.76)',
    fontSize: 14,
    fontWeight: '700',
  },
});
