import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import { useRouter } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { CAMPUSES } from '@/constants/campuses';
import { radius } from '@/constants/theme';
import { useReporterContext } from '@/context/reporter-context';
import { hasRemoteBackend } from '@/services/routing-api';

type IconName = keyof typeof Ionicons.glyphMap;

export default function SettingsIndexScreen() {
  const router = useRouter();
  const { enabledCampuses, reportFeed, selectedCampusId, submittedReport } = useReporterContext();

  const enabledCount = CAMPUSES.filter((campus) => enabledCampuses[campus.id]).length;
  const selectedCampus = CAMPUSES.find((campus) => campus.id === selectedCampusId);
  const appVersion = Constants.expoConfig?.version ?? '1.0.0';

  return (
    <ScrollView
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic"
      style={styles.scroll}>
      <Text style={[styles.sectionHeader, styles.sectionHeaderFirst]}>LOCATION</Text>
      <View style={styles.group}>
        <ChevronRow
          icon="school"
          iconColor="#147154"
          label="Campuses"
          detail={`${enabledCount} of ${CAMPUSES.length}`}
          onPress={() => router.push('/(tabs)/settings/campuses')}
        />
        <Divider />
        <ChevronRow
          icon="map"
          iconColor="#0A84FF"
          label="Map focus"
          detail={selectedCampus?.shortName ?? 'Not set'}
          onPress={() => router.push('/(tabs)/settings/map-focus')}
        />
      </View>
      <Text style={styles.sectionFooter}>
        Choose which campuses appear and where the map opens.
      </Text>

      <Text style={styles.sectionHeader}>BACKEND</Text>
      <View style={styles.group}>
        <ChevronRow
          icon="cloud"
          iconColor="#5E5CE6"
          label="Relay"
          detail={hasRemoteBackend() ? `Live • ${reportFeed.reports.length}` : 'Mock'}
          onPress={() => router.push('/(tabs)/settings/relay')}
        />
      </View>
      <Text style={styles.sectionFooter}>
        Connection to the backend that stores and dispatches reports.
      </Text>

      <Text style={styles.sectionHeader}>DATA</Text>
      <View style={styles.group}>
        <ChevronRow
          icon="document-text"
          iconColor="#FF9500"
          label="Latest submission"
          detail={submittedReport ? 'Available' : 'None'}
          onPress={() => router.push('/(tabs)/settings/latest-submission')}
        />
      </View>
      <Text style={styles.sectionFooter}>
        Review the most recent report this device submitted.
      </Text>

      <Text style={styles.sectionHeader}>ABOUT</Text>
      <View style={styles.group}>
        <ValueRow
          icon="information-circle"
          iconColor="#8E8E93"
          label="Version"
          value={appVersion}
        />
      </View>
      <Text style={styles.sectionFooter}>Campus Cleanup Router</Text>
    </ScrollView>
  );
}

function IconBubble({ icon, color }: { icon: IconName; color: string }) {
  return (
    <View style={[styles.iconBubble, { backgroundColor: color }]}>
      <Ionicons color="#FFFFFF" name={icon} size={18} />
    </View>
  );
}

function ChevronRow({
  icon,
  iconColor,
  label,
  detail,
  onPress,
}: {
  icon: IconName;
  iconColor: string;
  label: string;
  detail?: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      android_ripple={{ color: 'rgba(0,0,0,0.06)' }}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}>
      <IconBubble icon={icon} color={iconColor} />
      <Text style={styles.rowLabel} numberOfLines={1}>
        {label}
      </Text>
      <View style={styles.rowRight}>
        {detail ? (
          <Text style={styles.rowDetail} numberOfLines={1}>
            {detail}
          </Text>
        ) : null}
        <Ionicons color="#C7C7CC" name="chevron-forward" size={18} />
      </View>
    </Pressable>
  );
}

function ValueRow({
  icon,
  iconColor,
  label,
  value,
}: {
  icon: IconName;
  iconColor: string;
  label: string;
  value: string;
}) {
  return (
    <View style={styles.row}>
      <IconBubble icon={icon} color={iconColor} />
      <Text style={styles.rowLabel} numberOfLines={1}>
        {label}
      </Text>
      <View style={styles.rowRight}>
        <Text style={styles.rowDetail} numberOfLines={1}>
          {value}
        </Text>
      </View>
    </View>
  );
}

function Divider() {
  return <View style={styles.divider} />;
}

const styles = StyleSheet.create({
  scroll: {
    backgroundColor: '#F2F2F7',
  },
  content: {
    paddingBottom: 36,
    paddingHorizontal: 16,
    paddingTop: 0,
  },
  sectionHeader: {
    color: '#6D6D72',
    fontSize: 13,
    fontWeight: '500',
    letterSpacing: 0.4,
    marginBottom: 6,
    marginTop: 24,
    paddingHorizontal: 16,
  },
  sectionHeaderFirst: {
    marginTop: 8,
  },
  sectionFooter: {
    color: '#6D6D72',
    fontSize: 12,
    lineHeight: 17,
    marginTop: 6,
    paddingHorizontal: 16,
  },
  group: {
    backgroundColor: '#FFFFFF',
    borderRadius: radius.md,
    overflow: 'hidden',
  },
  row: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    flexDirection: 'row',
    gap: 12,
    minHeight: 44,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  rowPressed: {
    backgroundColor: '#D1D1D6',
  },
  iconBubble: {
    alignItems: 'center',
    borderRadius: 7,
    height: 30,
    justifyContent: 'center',
    width: 30,
  },
  rowLabel: {
    color: '#111112',
    flex: 1,
    fontSize: 17,
  },
  rowRight: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 6,
    marginLeft: 8,
    maxWidth: '55%',
  },
  rowDetail: {
    color: '#8A8A8E',
    fontSize: 16,
    textAlign: 'right',
  },
  divider: {
    backgroundColor: '#E8E8ED',
    height: StyleSheet.hairlineWidth,
    marginLeft: 56,
  },
});
