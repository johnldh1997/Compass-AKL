import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import { Pressable, StyleSheet } from 'react-native';
import { useThemeColors } from '../context/ThemeContext';
import { useTranslation } from '../i18n/useTranslation';

interface Props {
  onPress: () => void;
  style?: object;
  // True while the map is following you: the icon fills in, so it's clear whether the map will move with you
  // or has been left where you dragged it (press to follow again).
  following?: boolean;
}

export default function LocateButton({ onPress, style, following = false }: Props) {
  const colors = useThemeColors();
  const t = useTranslation();
  return (
    <Pressable
      style={[styles.button, style]}
      onPress={onPress}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={t('common.centerOnMyLocation')}
    >
      <Ionicons name={following ? 'navigate' : 'locate'} size={22} color={colors.primary} />
    </Pressable>
  );
}

// Stays a plain white circle regardless of app theme, like a map app's own floating
// controls — it sits over the map, not the app's themed background.
const styles = StyleSheet.create({
  button: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 4,
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
  },
});
