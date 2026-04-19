import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { radius } from '@/constants/theme';
import { useReporterContext } from '@/context/reporter-context';
import { hasRemoteBackend } from '@/services/routing-api';

export default function RelayScreen() {
  const { feedBusy, refreshReportFeed, reportFeed } = useReporterContext();

  return (
    <ScrollView
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic"
      style={styles.scroll}>
      <Text style={[styles.sectionHeader, styles.sectionHeaderFirst]}>STATUS</Text>
      <View style={styles.group}>
        <ValueRow
          label="Mode"
          value={hasRemoteBackend() ? 'Live relay' : 'Mock feed'}
          valueColor={hasRemoteBackend() ? '#34C759' : '#8A8A8E'}
        />
        <Divider />
        <ValueRow label="Feed" value={feedBusy ? 'Refreshing…' : 'Idle'} />
      </View>
      <Text style={styles.sectionFooter}>
        Live relay requires the backend URL to be configured.
      </Text>

      <Text style={styles.sectionHeader}>QUEUE</Text>
      <View style={styles.group}>
        <ValueRow
          label="Active assignment"
          value={reportFeed.activeAssignmentId ?? 'None'}
        />
        <Divider />
        <ValueRow label="Queued reports" value={String(reportFeed.reports.length)} />
      </View>

      <Text style={styles.sectionHeader}>ACTIONS</Text>
      <View style={styles.group}>
        <Pressable
          onPress={() => void refreshReportFeed(true)}
          android_ripple={{ color: 'rgba(0,0,0,0.06)' }}
          style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}>
          <Text style={styles.actionLabel}>Refresh relay feed</Text>
        </Pressable>
      </View>
      <Text style={styles.sectionFooter}>
        Manually re-query the relay for the latest queue state.
      </Text>
    </ScrollView>
  );
}

function ValueRow({
  label,
  value,
  valueColor,
}: {
  label: string;
  value: string;
  valueColor?: string;
}) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowTitle} numberOfLines={1}>
        {label}
      </Text>
      <Text
        style={[styles.rowValue, valueColor ? { color: valueColor } : null]}
        numberOfLines={1}>
        {value}
      </Text>
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
    flexDirection: 'row',
    justifyContent: 'space-between',
    minHeight: 44,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  rowPressed: {
    backgroundColor: '#D1D1D6',
  },
  rowTitle: {
    color: '#111112',
    flex: 1,
    fontSize: 17,
  },
  rowValue: {
    color: '#8A8A8E',
    fontSize: 16,
    marginLeft: 12,
    maxWidth: '60%',
    textAlign: 'right',
  },
  actionLabel: {
    color: '#007AFF',
    fontSize: 17,
    fontWeight: '500',
  },
  divider: {
    backgroundColor: '#E8E8ED',
    height: StyleSheet.hairlineWidth,
    marginLeft: 16,
  },
});
