import { StyleSheet, Text, View } from 'react-native';

import { palette } from '@/constants/theme';

type DataRowProps = {
  label: string;
  value: string;
};

export function DataRow({ label, value }: DataRowProps) {
  return (
    <View style={styles.row}>
      <Text style={styles.label}>{label}</Text>
      <Text style={styles.value}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'space-between',
  },
  label: {
    color: palette.muted,
    flex: 1,
    fontSize: 14,
  },
  value: {
    color: palette.text,
    flex: 1,
    fontSize: 14,
    fontVariant: ['tabular-nums'],
    textAlign: 'right',
  },
});
