import { Pressable, StyleSheet, Text } from 'react-native';

import { palette, radius } from '@/constants/theme';

type ActionButtonProps = {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  variant?: 'primary' | 'secondary' | 'danger';
};

export function ActionButton({
  label,
  onPress,
  disabled = false,
  variant = 'primary',
}: ActionButtonProps) {
  return (
    <Pressable
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.base,
        variantStyles[variant],
        disabled && styles.disabled,
        pressed && !disabled && pressedStyles[variant],
      ]}>
      <Text style={[styles.label, labelStyles[variant], disabled && styles.disabledLabel]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    alignItems: 'center',
    borderRadius: radius.md,
    justifyContent: 'center',
    minHeight: 52,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  label: {
    fontSize: 15,
    fontWeight: '700',
  },
  disabled: {
    opacity: 0.5,
  },
  disabledLabel: {
    color: palette.muted,
  },
});

const variantStyles = StyleSheet.create({
  primary: {
    backgroundColor: palette.primary,
  },
  secondary: {
    backgroundColor: palette.surfaceMuted,
    borderColor: palette.border,
    borderWidth: 1,
  },
  danger: {
    backgroundColor: '#FCECEA',
    borderColor: '#F6C7C0',
    borderWidth: 1,
  },
});

const pressedStyles = StyleSheet.create({
  primary: {
    backgroundColor: palette.primaryPressed,
  },
  secondary: {
    backgroundColor: '#D9E8DE',
  },
  danger: {
    backgroundColor: '#F8D8D1',
  },
});

const labelStyles = StyleSheet.create({
  primary: {
    color: '#FFFFFF',
  },
  secondary: {
    color: palette.text,
  },
  danger: {
    color: palette.danger,
  },
});
