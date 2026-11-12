import { Ionicons } from '@expo/vector-icons';
import React, { useMemo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useThemeColors } from '../context/ThemeContext';
import { useTranslation } from '../i18n/useTranslation';
import { spacing } from '../theme';

interface Props {
  onSwap: () => void;
  children: React.ReactNode;
}

// --- Swap From/To ---
// The From and To inputs (children) with a swap button to their right, shared by Home's
// inline journey search and the Journey Planner form.
export default function EndpointsWithSwap({ onSwap, children }: Props) {
  const colors = useThemeColors();
  const t = useTranslation();
  const styles = useMemo(
    () =>
      StyleSheet.create({
        row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
        inputs: { flex: 1 },
        swapButton: { padding: spacing.xs },
      }),
    []
  );

  return (
    <View style={styles.row}>
      <View style={styles.inputs}>{children}</View>
      <Pressable
        onPress={onSwap}
        hitSlop={8}
        style={styles.swapButton}
        accessibilityRole="button"
        accessibilityLabel={t('journey.swap')}
      >
        <Ionicons name="swap-vertical" size={22} color={colors.primary} />
      </Pressable>
    </View>
  );
}
