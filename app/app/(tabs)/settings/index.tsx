import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { CAMPUSES } from '@/constants/campuses';
import { radius } from '@/constants/theme';
import { useReporterContext } from '@/context/reporter-context';
import { hasRemoteBackend } from '@/services/routing-api';

export default function SettingsIndexScreen() {
  const router = useRouter();
  const { enabledCampuses, reportFeed, selectedCampusId, submittedReport } = useReporterContext();

  const enabledCount = CAMPUSES.filter((campus) => enabledCampuses[campus.id]).length;
  const selectedCampus = CAMPUSES.find((campus) => campus.id === selectedCampusId);

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <SettingsGroup>
        <SettingsChevronRow
          label="Universities"
          detail={`${enabledCount} enabled`}
          onPress={() => router.push('/(tabs)/settings/universities')}
        />
        <Divider />
        <SettingsChevronRow
          label="Map focus"
          detail={selectedCampus?.shortName ?? 'Not set'}
          onPress={() => router.push('/(tabs)/settings/map-focus')}
        />
      </SettingsGroup>

      <SettingsGroup>
        <SettingsChevronRow
          label="Relay"
          detail={hasRemoteBackend() ? `${reportFeed.reports.length} reports` : 'Mock mode'}
          onPress={() => router.push('/(tabs)/settings/relay')}
        />
        <Divider />
        <SettingsChevronRow
          label="Latest submission"
          detail={submittedReport ? 'Available' : 'None'}
          onPress={() => router.push('/(tabs)/settings/latest-submission')}
        />
      </SettingsGroup>
    </ScrollView>
  );
}

function SettingsGroup({ children }: { children: React.ReactNode }) {
  return <View style={styles.group}>{children}</View>;
}

function SettingsChevronRow({
  label,
  detail,
  onPress,
}: {
  label: string;
  detail?: string;
  onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <View style={styles.rowRight}>
        {detail ? <Text style={styles.rowDetail}>{detail}</Text> : null}
        <Ionicons color="#C7C7CC" name="chevron-forward" size={18} />
      </View>
    </Pressable>
  );
}

function Divider() {
  return <View style={styles.divider} />;
}

const styles = StyleSheet.create({
  content: {
    gap: 28,
    paddingBottom: 36,
    paddingHorizontal: 16,
    paddingTop: 20,
  },
  group: {
    backgroundColor: '#FFFFFF',
    borderRadius: radius.lg,
    overflow: 'hidden',
  },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    minHeight: 52,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  rowLabel: {
    color: '#111112',
    fontSize: 17,
  },
  rowRight: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 6,
    marginLeft: 12,
  },
  rowDetail: {
    color: '#8A8A8E',
    fontSize: 16,
  },
  divider: {
    backgroundColor: '#E8E8ED',
    height: StyleSheet.hairlineWidth,
    marginLeft: 16,
  },
});
