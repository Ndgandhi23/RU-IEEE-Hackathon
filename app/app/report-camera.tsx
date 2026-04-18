import { useFocusEffect } from '@react-navigation/native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import * as Location from 'expo-location';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { Ionicons } from '@expo/vector-icons';
import { runOnJS, useSharedValue } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CAMPUSES, CampusDefinition, CampusId } from '@/constants/campuses';
import { useReporterContext } from '@/context/reporter-context';
import { submitTrashReport } from '@/services/routing-api';
import { Coordinates } from '@/types/routing';

export default function ReportCameraRoute() {
  const cameraRef = useRef<CameraView | null>(null);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const {
    selectedCampusId,
    registerSubmission,
    refreshReportFeed,
    setSelectedCampusId,
  } = useReporterContext();
  const [reporterLocation, setReporterLocation] = useState<Coordinates | null>(null);
  const [locationStatus, setLocationStatus] = useState<'idle' | 'locating' | 'ready' | 'error'>('idle');
  const [cameraStatus, setCameraStatus] = useState<'checking' | 'ready' | 'denied'>('checking');
  const [capturedPhotoUri, setCapturedPhotoUri] = useState<string | null>(null);
  const [captureBusy, setCaptureBusy] = useState(false);
  const [submitBusy, setSubmitBusy] = useState(false);
  const [zoomLevel, setZoomLevel] = useState(0);
  const zoomValue = useSharedValue(0);
  const zoomStart = useSharedValue(0);

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

  function updateZoomLevel(value: number) {
    setZoomLevel(clamp(value));
  }

  const pinchGesture = Gesture.Pinch()
    .enabled(!capturedPhotoUri && cameraStatus === 'ready')
    .onStart(() => {
      zoomStart.value = zoomValue.value;
    })
    .onUpdate((event) => {
      const nextZoom = clamp(zoomStart.value + (event.scale - 1) * 0.22);
      zoomValue.value = nextZoom;
      runOnJS(updateZoomLevel)(nextZoom);
    });

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

  async function handleSubmit() {
    if (!capturedPhotoUri || !reporterLocation) {
      Alert.alert(
        'Still preparing',
        'The photo and GPS fix both need to be ready before the report can be submitted.'
      );
      return;
    }

    try {
      setSubmitBusy(true);
      const response = await submitTrashReport({
        photoUri: capturedPhotoUri,
        reporterLocation,
      });

      registerSubmission(response.report, response.mode);
      setCapturedPhotoUri(null);
      await refreshLocation();
      await refreshReportFeed(false);
      router.back();
    } catch (error) {
      Alert.alert('Report failed', error instanceof Error ? error.message : 'Unknown upload error.');
    } finally {
      setSubmitBusy(false);
    }
  }

  function handleRetake() {
    setCapturedPhotoUri(null);
  }

  function handleClose() {
    setCapturedPhotoUri(null);
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

  const cameraBody = capturedPhotoUri ? (
    <Image contentFit="cover" source={{ uri: capturedPhotoUri }} style={styles.camera} />
  ) : (
    <GestureDetector gesture={pinchGesture}>
      <CameraView ref={cameraRef} facing="back" style={styles.camera} zoom={zoomLevel} />
    </GestureDetector>
  );

  return (
    <View style={styles.screen}>
      {cameraBody}

      <View style={styles.overlay}>
        <Pressable onPress={handleClose} style={[styles.topCloseButton, { top: insets.top + 16 }]}>
          <Ionicons color="#FFFFFF" name="close" size={24} />
        </Pressable>

        <View style={[styles.bottomControls, { bottom: Math.max(insets.bottom, 14) }]}>
          {capturedPhotoUri ? (
            <View style={styles.previewControls}>
              <CircularIconButton icon="refresh" disabled={submitBusy} onPress={handleRetake} />
              <View style={styles.previewSpacer} />
              <CircularIconButton
                icon={submitBusy ? 'cloud-upload-outline' : 'arrow-up'}
                disabled={submitBusy}
                onPress={handleSubmit}
              />
            </View>
          ) : (
            <View style={styles.captureControls}>
              <View style={styles.captureSideSpacer} />
              <Pressable
                onPress={handleTakePhoto}
                disabled={captureBusy || cameraStatus !== 'ready'}
                style={[styles.shutterOuter, (captureBusy || cameraStatus !== 'ready') && styles.disabledButton]}>
                <View style={styles.shutterInner} />
              </Pressable>
              <View style={styles.captureSideSpacer} />
            </View>
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

function clamp(value: number) {
  return Math.max(0, Math.min(1, Number(value.toFixed(3))));
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
