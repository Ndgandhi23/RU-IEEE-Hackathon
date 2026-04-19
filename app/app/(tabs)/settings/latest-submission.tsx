import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { radius } from '@/constants/theme';
import { useReporterContext } from '@/context/reporter-context';
import { formatCoordinate, formatTimestamp } from '@/utils/format';

export default function LatestSubmissionScreen() {
  const { submitMode, submittedReport } = useReporterContext();

  if (!submittedReport) {
    return (
      <ScrollView
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
        style={styles.scroll}>
        <View style={styles.emptyCard}>
          <Text style={styles.emptyTitle}>No submission yet</Text>
          <Text style={styles.emptySubtitle}>
            Once this device submits a trash report, its details will appear here.
          </Text>
        </View>
      </ScrollView>
    );
  }

  return (
    <ScrollView
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic"
      style={styles.scroll}>
      <Text style={[styles.sectionHeader, styles.sectionHeaderFirst]}>REPORT</Text>
      <View style={styles.group}>
        <ValueRow label="ID" value={submittedReport.id} />
        <Divider />
        <ValueRow
          label="Transport"
          value={submitMode === 'backend' ? 'Backend relay' : 'Mock feed'}
        />
        <Divider />
        <ValueRow label="Created" value={formatTimestamp(submittedReport.createdAt)} />
      </View>

      <Text style={styles.sectionHeader}>LOCATION</Text>
      <View style={styles.group}>
        <ValueRow
          label="Latitude"
          value={formatCoordinate(submittedReport.reporterLocation.latitude)}
        />
        <Divider />
        <ValueRow
          label="Longitude"
          value={formatCoordinate(submittedReport.reporterLocation.longitude)}
        />
      </View>
      <Text style={styles.sectionFooter}>
        The GPS coordinates captured when this report was submitted.
      </Text>
    </ScrollView>
  );
}

function ValueRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowTitle} numberOfLines={1}>
        {label}
      </Text>
      <Text style={styles.rowValue} numberOfLines={1}>
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
  rowTitle: {
    color: '#111112',
    flex: 1,
    fontSize: 17,
  },
  rowValue: {
    color: '#8A8A8E',
    fontSize: 15,
    marginLeft: 12,
    maxWidth: '60%',
    textAlign: 'right',
  },
  divider: {
    backgroundColor: '#E8E8ED',
    height: StyleSheet.hairlineWidth,
    marginLeft: 16,
  },
  emptyCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: radius.md,
    gap: 6,
    marginTop: 8,
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
