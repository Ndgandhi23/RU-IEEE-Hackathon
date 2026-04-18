import { ScrollView, StyleSheet, Switch, Text, View } from 'react-native';

import { CAMPUSES } from '@/constants/campuses';
import { palette, radius } from '@/constants/theme';
import { useReporterContext } from '@/context/reporter-context';

export default function UniversitiesScreen() {
  const { enabledCampuses, toggleCampus } = useReporterContext();

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Text style={styles.caption}>
        Choose which Rutgers campuses appear in the reporter map experience.
      </Text>

      <View style={styles.group}>
        {CAMPUSES.map((campus, index) => (
          <View key={campus.id}>
            <View style={styles.row}>
              <View style={styles.copy}>
                <Text style={styles.rowTitle}>{campus.name}</Text>
                <Text style={styles.rowSubtitle}>
                  Include this campus in map rendering and trash overlays.
                </Text>
              </View>
              <Switch
                value={enabledCampuses[campus.id]}
                onValueChange={() => toggleCampus(campus.id)}
                trackColor={{ false: '#D8D2C4', true: '#7FC8AE' }}
                thumbColor={enabledCampuses[campus.id] ? palette.primary : '#F7F4EC'}
              />
            </View>
            {index < CAMPUSES.length - 1 ? <Divider /> : null}
          </View>
        ))}
      </View>
    </ScrollView>
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
    gap: 12,
    justifyContent: 'space-between',
    minHeight: 64,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  copy: {
    flex: 1,
    gap: 4,
    paddingRight: 12,
  },
  rowTitle: {
    color: '#111112',
    fontSize: 16,
    fontWeight: '600',
  },
  rowSubtitle: {
    color: '#6D6D72',
    fontSize: 13,
    lineHeight: 18,
  },
  divider: {
    backgroundColor: '#E8E8ED',
    height: StyleSheet.hairlineWidth,
    marginLeft: 16,
  },
});
