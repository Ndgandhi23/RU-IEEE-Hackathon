import { Ionicons } from '@expo/vector-icons';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { CAMPUSES } from '@/constants/campuses';
import { palette, radius } from '@/constants/theme';
import { useReporterContext } from '@/context/reporter-context';

export default function MapFocusScreen() {
  const { selectedCampusId, setSelectedCampusId } = useReporterContext();

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Text style={styles.caption}>
        Pick the campus the map should center on when the reporter opens the Map tab.
      </Text>

      <View style={styles.group}>
        {CAMPUSES.map((campus, index) => {
          const selected = campus.id === selectedCampusId;
          return (
            <View key={campus.id}>
              <Pressable onPress={() => setSelectedCampusId(campus.id)} style={styles.row}>
                <View style={styles.copy}>
                  <Text style={styles.rowTitle}>{campus.shortName}</Text>
                  <Text style={styles.rowSubtitle}>{campus.name}</Text>
                </View>
                <Ionicons
                  color={selected ? palette.primary : '#C7C7CC'}
                  name={selected ? 'checkmark-circle' : 'ellipse-outline'}
                  size={22}
                />
              </Pressable>
              {index < CAMPUSES.length - 1 ? <Divider /> : null}
            </View>
          );
        })}
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
    justifyContent: 'space-between',
    minHeight: 60,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  copy: {
    gap: 4,
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
