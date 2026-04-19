import { Ionicons } from '@expo/vector-icons';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { CAMPUSES } from '@/constants/campuses';
import { radius } from '@/constants/theme';
import { useReporterContext } from '@/context/reporter-context';

export default function MapFocusScreen() {
  const { selectedCampusId, setSelectedCampusId } = useReporterContext();

  return (
    <ScrollView
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic"
      style={styles.scroll}>
      <Text style={styles.sectionHeader}>CENTER MAP ON</Text>

      <View style={styles.group}>
        {CAMPUSES.map((campus, index) => {
          const selected = campus.id === selectedCampusId;
          return (
            <View key={campus.id}>
              <Pressable
                onPress={() => setSelectedCampusId(campus.id)}
                android_ripple={{ color: 'rgba(0,0,0,0.06)' }}
                style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}>
                <View style={styles.copy}>
                  <Text style={styles.rowTitle}>{campus.shortName}</Text>
                  <Text style={styles.rowSubtitle}>{campus.name}</Text>
                </View>
                {selected ? (
                  <Ionicons color="#007AFF" name="checkmark" size={22} />
                ) : null}
              </Pressable>
              {index < CAMPUSES.length - 1 ? <Divider /> : null}
            </View>
          );
        })}
      </View>

      <Text style={styles.sectionFooter}>
        Pick the campus the map should center on when the Map tab opens.
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
    justifyContent: 'space-between',
    minHeight: 56,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  rowPressed: {
    backgroundColor: '#D1D1D6',
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
