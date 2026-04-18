import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { radius } from '@/constants/theme';
import { useReporterContext } from '@/context/reporter-context';
import { formatCoordinate, formatTimestamp } from '@/utils/format';

export default function LatestSubmissionScreen() {
  const { submitMode, submittedReport } = useReporterContext();

  return (
    <ScrollView contentContainerStyle={styles.content}>
      {submittedReport ? (
        <View style={styles.group}>
          <SettingsValueRow label="Submission id" value={submittedReport.id} />
          <Divider />
          <SettingsValueRow
            label="Transport"
            value={submitMode === 'backend' ? 'Backend relay' : 'Mock feed'}
          />
          <Divider />
          <SettingsValueRow label="Created" value={formatTimestamp(submittedReport.createdAt)} />
          <Divider />
          <SettingsValueRow
            label="Latitude"
            value={formatCoordinate(submittedReport.reporterLocation.latitude)}
          />
          <Divider />
          <SettingsValueRow
            label="Longitude"
            value={formatCoordinate(submittedReport.reporterLocation.longitude)}
          />
        </View>
      ) : (
        <View style={styles.emptyCard}>
          <Text style={styles.emptyTitle}>No submission yet</Text>
          <Text style={styles.emptySubtitle}>
            Once this device submits a trash report, its details will appear here.
          </Text>
        </View>
      )}
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
    flexShrink: 1,
    fontSize: 15,
    marginLeft: 12,
    textAlign: 'right',
  },
  divider: {
    backgroundColor: '#E8E8ED',
    height: StyleSheet.hairlineWidth,
    marginLeft: 16,
  },
  emptyCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: radius.lg,
    gap: 6,
    padding: 18,
  },
  emptyTitle: {
    color: '#111112',
    fontSize: 18,
    fontWeight: '700',
  },
  emptySubtitle: {
    color: '#6D6D72',
    fontSize: 14,
    lineHeight: 20,
  },
});
