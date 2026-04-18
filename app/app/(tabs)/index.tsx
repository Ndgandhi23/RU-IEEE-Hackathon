import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import * as Linking from 'expo-linking';
import * as Location from 'expo-location';
import { useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { ActionButton } from '@/components/ui/action-button';
import { DataRow } from '@/components/ui/data-row';
import { Panel } from '@/components/ui/panel';
import { StatusPill } from '@/components/ui/status-pill';
import { palette, radius } from '@/constants/theme';
import { hasRemoteBackend, submitTrashReport } from '@/services/routing-api';
import { Coordinates, TrashReport } from '@/types/routing';
import { formatCoordinate, formatTimestamp } from '@/utils/format';

export default function ReporterScreen() {
  const [photoUri, setPhotoUri] = useState<string | null>(null);
  const [reporterLocation, setReporterLocation] = useState<Coordinates | null>(null);
  const [note, setNote] = useState('');
  const [submittedReport, setSubmittedReport] = useState<TrashReport | null>(null);
  const [submitMode, setSubmitMode] = useState<'backend' | 'mock' | null>(null);
  const [cameraBusy, setCameraBusy] = useState(false);
  const [locationBusy, setLocationBusy] = useState(false);
  const [submitBusy, setSubmitBusy] = useState(false);

  async function handleTakePhoto() {
    try {
      setCameraBusy(true);
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) {
        Alert.alert('Camera permission needed', 'Allow camera access to capture the trash report.');
        return;
      }

      const result = await ImagePicker.launchCameraAsync({
        cameraType: ImagePicker.CameraType.back,
        allowsEditing: true,
        aspect: [4, 3],
        quality: 0.7,
      });

      if (!result.canceled) {
        setPhotoUri(result.assets[0].uri);
      }
    } catch (error) {
      Alert.alert('Camera unavailable', error instanceof Error ? error.message : 'Unknown camera error.');
    } finally {
      setCameraBusy(false);
    }
  }

  async function handleCaptureLocation() {
    try {
      setLocationBusy(true);
      const permission = await Location.requestForegroundPermissionsAsync();
      if (!permission.granted) {
        Alert.alert(
          'Location permission needed',
          'Allow location access so each report includes GPS coordinates.'
        );
        return;
      }

      const position = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });

      setReporterLocation({
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        accuracy: position.coords.accuracy,
        timestamp: new Date(position.timestamp).toISOString(),
      });
    } catch (error) {
      Alert.alert(
        'Location unavailable',
        error instanceof Error ? error.message : 'Unknown location error.'
      );
    } finally {
      setLocationBusy(false);
    }
  }

  async function handleSubmit() {
    if (!photoUri || !reporterLocation) {
      Alert.alert('Incomplete report', 'Capture both the photo and the GPS fix before submitting.');
      return;
    }

    try {
      setSubmitBusy(true);
      const response = await submitTrashReport({
        photoUri,
        reporterLocation,
        note,
      });

      setSubmittedReport(response.report);
      setSubmitMode(response.mode);
      Alert.alert('Report sent', 'The robot feed now has the latest trash target.');
    } catch (error) {
      Alert.alert('Report failed', error instanceof Error ? error.message : 'Unknown upload error.');
    } finally {
      setSubmitBusy(false);
    }
  }

  function openReportInMaps() {
    if (!submittedReport) {
      return;
    }

    const { latitude, longitude } = submittedReport.reporterLocation;
    void Linking.openURL(`http://maps.apple.com/?ll=${latitude},${longitude}&q=Trash%20report`);
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.select({ ios: 'padding', default: undefined })}
      style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.hero}>
          <View style={styles.heroBadge}>
            <Ionicons color={palette.primary} name="leaf" size={18} />
            <Text style={styles.heroBadgeLabel}>Reporter flow</Text>
          </View>
          <Text style={styles.heroTitle}>Capture trash location with a photo and a GPS fix.</Text>
          <Text style={styles.heroCopy}>
            The reporter phone packages the image, latitude, longitude, and timestamp. The robot
            phone pulls the latest report and requests a walking route from the backend.
          </Text>
          <StatusPill
            label={hasRemoteBackend() ? 'Backend relay enabled' : 'Mock mode until API is configured'}
            tone={hasRemoteBackend() ? 'success' : 'warning'}
          />
        </View>

        <Panel
          title="Step 1: Capture evidence"
          subtitle="Take the photo first, then freeze the GPS coordinate so the route request matches the same moment.">
          <View style={styles.buttonRow}>
            <ActionButton
              label={cameraBusy ? 'Opening camera...' : photoUri ? 'Retake photo' : 'Take photo'}
              onPress={handleTakePhoto}
              disabled={cameraBusy || submitBusy}
            />
            <ActionButton
              label={locationBusy ? 'Locating...' : reporterLocation ? 'Refresh GPS' : 'Capture GPS'}
              onPress={handleCaptureLocation}
              disabled={locationBusy || submitBusy}
              variant="secondary"
            />
          </View>

          {photoUri ? (
            <Image contentFit="cover" source={{ uri: photoUri }} style={styles.photoPreview} />
          ) : (
            <View style={styles.emptyPhoto}>
              <Ionicons color={palette.muted} name="camera-outline" size={28} />
              <Text style={styles.emptyPhotoLabel}>No photo captured yet</Text>
            </View>
          )}

          {reporterLocation ? (
            <View style={styles.dataStack}>
              <DataRow label="Latitude" value={formatCoordinate(reporterLocation.latitude)} />
              <DataRow label="Longitude" value={formatCoordinate(reporterLocation.longitude)} />
              <DataRow label="Captured" value={formatTimestamp(reporterLocation.timestamp)} />
            </View>
          ) : (
            <Text style={styles.helperText}>GPS has not been captured for this report yet.</Text>
          )}
        </Panel>

        <Panel
          title="Step 2: Add operator context"
          subtitle="This note can carry a quick observation to help the robot know what to expect.">
          <TextInput
            multiline
            onChangeText={setNote}
            placeholder="Example: soda can near the engineering bus stop"
            placeholderTextColor={palette.muted}
            style={styles.noteInput}
            value={note}
          />
          <ActionButton
            label={submitBusy ? 'Submitting...' : 'Submit report to robot feed'}
            onPress={handleSubmit}
            disabled={submitBusy}
          />
        </Panel>

        <Panel
          title="Latest submission"
          subtitle="This is the payload your backend should publish to the robot device.">
          {submittedReport ? (
            <View style={styles.dataStack}>
              <StatusPill
                label={
                  submitMode === 'backend' ? 'Shared through backend relay' : 'Stored in local mock feed'
                }
                tone={submitMode === 'backend' ? 'success' : 'warning'}
              />
              <DataRow label="Report id" value={submittedReport.id} />
              <DataRow label="Submitted" value={formatTimestamp(submittedReport.createdAt)} />
              <DataRow
                label="Latitude"
                value={formatCoordinate(submittedReport.reporterLocation.latitude)}
              />
              <DataRow
                label="Longitude"
                value={formatCoordinate(submittedReport.reporterLocation.longitude)}
              />
              {submittedReport.note ? <DataRow label="Note" value={submittedReport.note} /> : null}
              <ActionButton label="Preview in Apple Maps" onPress={openReportInMaps} variant="secondary" />
            </View>
          ) : (
            <Text style={styles.helperText}>
              Nothing has been submitted yet. Capture a photo and GPS fix, then send the report.
            </Text>
          )}
        </Panel>
      </ScrollView>
    </KeyboardAvoidingView>
  );
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
    backgroundColor: palette.text,
    borderRadius: 30,
    gap: 12,
    padding: 22,
  },
  heroBadge: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    backgroundColor: '#ECF7F2',
    borderRadius: 999,
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  heroBadgeLabel: {
    color: palette.primary,
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
    color: '#D7E8E1',
    fontSize: 15,
    lineHeight: 22,
  },
  buttonRow: {
    gap: 12,
  },
  photoPreview: {
    borderRadius: radius.md,
    height: 220,
    width: '100%',
  },
  emptyPhoto: {
    alignItems: 'center',
    backgroundColor: '#F0F4F2',
    borderColor: palette.border,
    borderRadius: radius.md,
    borderStyle: 'dashed',
    borderWidth: 1,
    gap: 10,
    justifyContent: 'center',
    minHeight: 180,
  },
  emptyPhotoLabel: {
    color: palette.muted,
    fontSize: 14,
    fontWeight: '600',
  },
  dataStack: {
    gap: 12,
  },
  helperText: {
    color: palette.muted,
    fontSize: 14,
    lineHeight: 20,
  },
  noteInput: {
    backgroundColor: '#F9F7F1',
    borderColor: palette.border,
    borderRadius: radius.md,
    borderWidth: 1,
    color: palette.text,
    minHeight: 110,
    paddingHorizontal: 14,
    paddingVertical: 14,
    textAlignVertical: 'top',
  },
});
