import { ScrollView, StyleSheet, Switch, Text, View } from 'react-native';

import { CAMPUSES } from '@/constants/campuses';
import { radius } from '@/constants/theme';
import { useReporterContext } from '@/context/reporter-context';

export default function CampusesScreen() {
  const { enabledCampuses, toggleCampus } = useReporterContext();

  return (
    <ScrollView
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic"
      style={styles.scroll}>
      <Text style={styles.sectionHeader}>ENABLED CAMPUSES</Text>

      <View style={styles.group}>
        {CAMPUSES.map((campus, index) => (
          <View key={campus.id}>
            <View style={styles.row}>
              <View style={styles.copy}>
                <Text style={styles.rowTitle}>{campus.name}</Text>
                <Text style={styles.rowSubtitle}>{campus.shortName}</Text>
              </View>
              <Switch
                value={enabledCampuses[campus.id]}
                onValueChange={() => toggleCampus(campus.id)}
                trackColor={{ false: '#E5E5EA', true: '#34C759' }}
                thumbColor="#FFFFFF"
                ios_backgroundColor="#E5E5EA"
              />
            </View>
            {index < CAMPUSES.length - 1 ? <Divider /> : null}
          </View>
        ))}
      </View>

      <Text style={styles.sectionFooter}>
        Toggle which Rutgers–New Brunswick campuses appear in the reporter map
        and trash overlays.
      </Text>
    </ScrollView>
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
    marginTop: 8,
    paddingHorizontal: 16,
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
    gap: 12,
    justifyContent: 'space-between',
    minHeight: 56,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  copy: {
    flex: 1,
    gap: 2,
    paddingRight: 12,
  },
  rowTitle: {
    color: '#111112',
    fontSize: 17,
  },
  rowSubtitle: {
    color: '#8A8A8E',
    fontSize: 13,
    lineHeight: 18,
  },
  divider: {
    backgroundColor: '#E8E8ED',
    height: StyleSheet.hairlineWidth,
    marginLeft: 16,
  },
});
