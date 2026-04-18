import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { radius } from '@/constants/theme';
import { useReporterContext } from '@/context/reporter-context';
import { hasRemoteBackend } from '@/services/routing-api';

export default function RelayScreen() {
  const { feedBusy, refreshReportFeed, reportFeed } = useReporterContext();

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Text style={styles.caption}>
        Inspect the current relay mode, assignment state, and manually refresh the queue feed.
      </Text>

      <View style={styles.group}>
        <SettingsValueRow
          label="Backend mode"
          value={hasRemoteBackend() ? 'Live relay feed' : 'Mock feed'}
        />
        <Divider />
        <SettingsValueRow label="Feed refresh" value={feedBusy ? 'Refreshing' : 'Idle'} />
        <Divider />
        <SettingsValueRow label="Active robot target" value={reportFeed.activeAssignmentId ?? 'None'} />
        <Divider />
        <SettingsValueRow label="Queued reports" value={String(reportFeed.reports.length)} />
        <Divider />
        <Pressable onPress={() => void refreshReportFeed(true)} style={styles.row}>
          <Text style={styles.actionLabel}>Refresh relay feed</Text>
          <Text style={styles.actionValue}>Run now</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

function SettingsValueRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowTitle}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

function Divider() {
  return <View style={styles.divider} />;
}

const styles = StyleSheet.create({
  content: {
    gap: 14,
    paddingBottom: 36,
    paddingHorizontal: 16,
    paddingTop: 20,
  },
  caption: {
    color: '#6D6D72',
    fontSize: 14,
    lineHeight: 20,
    paddingHorizontal: 4,
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
  rowTitle: {
    color: '#111112',
    fontSize: 16,
  },
  rowValue: {
    color: '#8A8A8E',
    fontSize: 16,
    marginLeft: 12,
    textAlign: 'right',
  },
  actionLabel: {
    color: '#111112',
    fontSize: 16,
    fontWeight: '600',
  },
  actionValue: {
    color: '#007AFF',
    fontSize: 16,
  },
  divider: {
    backgroundColor: '#E8E8ED',
    height: StyleSheet.hairlineWidth,
    marginLeft: 16,
  },
});
