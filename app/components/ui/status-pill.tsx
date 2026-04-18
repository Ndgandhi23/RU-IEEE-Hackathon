import { StyleSheet, Text, View } from 'react-native';

import { palette, radius } from '@/constants/theme';

type StatusPillProps = {
  label: string;
  tone?: 'default' | 'success' | 'warning';
};

export function StatusPill({ label, tone = 'default' }: StatusPillProps) {
  return (
    <View style={[styles.base, toneStyles[tone]]}>
      <Text style={[styles.label, labelStyles[tone]]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  base: {
    alignSelf: 'flex-start',
    borderRadius: radius.sm,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  label: {
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
  },
});

const toneStyles = StyleSheet.create({
  default: {
    backgroundColor: '#EEF3F1',
  },
  success: {
    backgroundColor: '#E6F4EA',
  },
  warning: {
    backgroundColor: '#FFF1DA',
  },
});

const labelStyles = StyleSheet.create({
  default: {
    color: palette.text,
  },
  success: {
    color: palette.success,
  },
  warning: {
    color: palette.accent,
  },
});
