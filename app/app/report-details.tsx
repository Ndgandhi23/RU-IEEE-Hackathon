import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  Keyboard,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useReporterContext } from '@/context/reporter-context';
import { submitTrashReport } from '@/services/routing-api';
import { Coordinates } from '@/types/routing';

const MAX_CAPTION_LENGTH = 280;

export default function ReportDetailsRoute() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{
    photoUri?: string;
    latitude?: string;
    longitude?: string;
    timestamp?: string;
    accuracy?: string;
  }>();

  const { registerSubmission, refreshReportFeed } = useReporterContext();

  const [caption, setCaption] = useState('');
  const [busy, setBusy] = useState(false);

  const keyboardPadding = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const showSub = Keyboard.addListener(showEvent, (e) => {
      Animated.timing(keyboardPadding, {
        toValue: e.endCoordinates.height,
        duration: e.duration ?? 220,
        useNativeDriver: false,
      }).start();
    });
    const hideSub = Keyboard.addListener(hideEvent, (e) => {
      Animated.timing(keyboardPadding, {
        toValue: 0,
        duration: e.duration ?? 220,
        useNativeDriver: false,
      }).start();
    });
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, [keyboardPadding]);

  const reporterLocation = useMemo<Coordinates | null>(() => {
    const lat = Number(params.latitude);
    const lon = Number(params.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return null;
    }
    const accuracy = Number(params.accuracy);
    return {
      latitude: lat,
      longitude: lon,
      accuracy: Number.isFinite(accuracy) ? accuracy : null,
      timestamp: params.timestamp || new Date().toISOString(),
    };
  }, [params.accuracy, params.latitude, params.longitude, params.timestamp]);

  const photoUri = typeof params.photoUri === 'string' ? params.photoUri : null;
  const canShare = Boolean(photoUri && reporterLocation) && !busy;

  async function handleShare() {
    if (!photoUri || !reporterLocation) {
      Alert.alert('Missing photo or location', 'Return to the camera and try again.');
      return;
    }

    try {
      setBusy(true);
      const response = await submitTrashReport({
        photoUri,
        reporterLocation,
        caption: caption.trim() || null,
      });

      registerSubmission(response.report, response.mode);
      await refreshReportFeed(false);
      router.dismissAll();
    } catch (error) {
      Alert.alert(
        'Report failed',
        error instanceof Error ? error.message : 'Unknown upload error.'
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Animated.View style={[styles.screen, { paddingBottom: keyboardPadding }]}>
      <View style={[styles.navBar, { paddingTop: insets.top + 8 }]}>
        <Pressable
          accessibilityLabel="Back to camera"
          onPress={() => router.back()}
          style={({ pressed }) => [styles.navButton, pressed && styles.navButtonPressed]}>
          <Ionicons color="#111112" name="chevron-back" size={26} />
        </Pressable>
        <Text style={styles.navTitle}>New Report</Text>
        <View style={styles.navButton} />
      </View>

      <ScrollView
        contentContainerStyle={[
          styles.scrollContent,
          { paddingBottom: Math.max(insets.bottom + 20, 32) },
        ]}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}>
        {photoUri ? (
          <View style={styles.photoCard}>
            <Image
              contentFit="cover"
              source={{ uri: photoUri }}
              style={styles.photo}
              transition={220}
            />
          </View>
        ) : (
          <View style={[styles.photoCard, styles.photoMissing]}>
            <Ionicons color="#8A8A8E" name="image-outline" size={32} />
            <Text style={styles.photoMissingLabel}>Photo unavailable</Text>
          </View>
        )}

        <View style={styles.captionCard}>
          <TextInput
            maxLength={MAX_CAPTION_LENGTH}
            multiline
            onChangeText={setCaption}
            placeholder="Describe what you found (optional)"
            placeholderTextColor="#9A9AA2"
            style={styles.captionInput}
            textAlignVertical="top"
            value={caption}
          />
          <Text style={styles.captionCounter}>
            {caption.length}/{MAX_CAPTION_LENGTH}
          </Text>
        </View>

        <Text style={styles.sectionFooter}>
          Share this report with nearby cleanup robots. Location is attached
          automatically.
        </Text>

        {reporterLocation ? (
          <View style={styles.locationRow}>
            <Ionicons color="#6D6D72" name="location-outline" size={14} />
            <Text style={styles.locationLabel} numberOfLines={1}>
              {reporterLocation.latitude.toFixed(5)},{' '}
              {reporterLocation.longitude.toFixed(5)}
            </Text>
          </View>
        ) : null}

        <Pressable
          disabled={!canShare}
          onPress={handleShare}
          style={({ pressed }) => [
            styles.primaryButton,
            !canShare && styles.primaryButtonDisabled,
            pressed && canShare && styles.primaryButtonPressed,
          ]}>
          {busy ? (
            <ActivityIndicator color="#FFFFFF" size="small" />
          ) : (
            <>
              <Ionicons color="#FFFFFF" name="paper-plane" size={16} />
              <Text style={styles.primaryButtonLabel}>Share Report</Text>
            </>
          )}
        </Pressable>
      </ScrollView>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  screen: {
    backgroundColor: '#F7F7F8',
    flex: 1,
  },
  navBar: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderBottomColor: '#E5E5EA',
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    paddingBottom: 10,
    paddingHorizontal: 12,
  },
  navButton: {
    alignItems: 'center',
    borderRadius: 20,
    height: 40,
    justifyContent: 'center',
    width: 40,
  },
  navButtonPressed: {
    backgroundColor: 'rgba(0,0,0,0.06)',
  },
  navTitle: {
    color: '#111112',
    flex: 1,
    fontSize: 17,
    fontWeight: '700',
    letterSpacing: -0.2,
    textAlign: 'center',
  },
  scrollContent: {
    paddingHorizontal: 16,
    paddingTop: 16,
  },
  photoCard: {
    aspectRatio: 4 / 5,
    backgroundColor: '#111112',
    borderRadius: 18,
    elevation: 6,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.14,
    shadowRadius: 12,
    width: '100%',
  },
  photo: {
    flex: 1,
    height: '100%',
    width: '100%',
  },
  photoMissing: {
    alignItems: 'center',
    aspectRatio: 4 / 5,
    backgroundColor: '#E5E5EA',
    gap: 8,
    justifyContent: 'center',
  },
  photoMissingLabel: {
    color: '#6D6D72',
    fontSize: 14,
    fontWeight: '600',
  },
  captionCard: {
    backgroundColor: '#FFFFFF',
    borderColor: '#E5E5EA',
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    marginTop: 16,
    paddingBottom: 8,
    paddingHorizontal: 14,
    paddingTop: 12,
  },
  captionInput: {
    color: '#111112',
    fontSize: 15,
    lineHeight: 21,
    minHeight: 76,
    paddingVertical: 0,
  },
  captionCounter: {
    alignSelf: 'flex-end',
    color: '#8A8A8E',
    fontSize: 11,
    fontVariant: ['tabular-nums'],
    fontWeight: '600',
    marginTop: 4,
  },
  sectionFooter: {
    color: '#8A8A8E',
    fontSize: 12,
    lineHeight: 17,
    marginHorizontal: 4,
    marginTop: 18,
  },
  locationRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 6,
    marginLeft: 4,
    marginTop: 10,
  },
  locationLabel: {
    color: '#6D6D72',
    fontSize: 12,
    fontVariant: ['tabular-nums'],
    fontWeight: '600',
  },
  primaryButton: {
    alignItems: 'center',
    backgroundColor: '#147154',
    borderRadius: 16,
    flexDirection: 'row',
    gap: 8,
    height: 54,
    justifyContent: 'center',
    marginTop: 24,
    shadowColor: '#147154',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.25,
    shadowRadius: 10,
  },
  primaryButtonPressed: {
    opacity: 0.88,
  },
  primaryButtonDisabled: {
    backgroundColor: '#C7C7CC',
    shadowOpacity: 0,
  },
  primaryButtonLabel: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '800',
    letterSpacing: 0.2,
  },
});
