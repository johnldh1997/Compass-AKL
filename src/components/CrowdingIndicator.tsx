import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { StyleProp, View, ViewStyle } from 'react-native';
import { useThemeColors } from '../context/ThemeContext';
import { useTranslation } from '../i18n/useTranslation';
import { CROWDING_FILLED_ICONS, CrowdingLevel } from '../services/occupancy';

const ICON_SIZE = 16;

// --- Crowding ---
// How full a bus is, as three bus icons: all grey = almost empty, 1 green = some passengers, 2 yellow = few
// seats left, 3 red = crowded. Shared by the vehicle cards, the stop's departure rows and the journey steps.
export default function CrowdingIndicator({ level, style }: { level: CrowdingLevel; style?: StyleProp<ViewStyle> }) {
  const colors = useThemeColors();
  const t = useTranslation();
  const filled = CROWDING_FILLED_ICONS[level];
  const filledColor = { empty: colors.textMuted, many: colors.success, few: colors.amber, full: colors.danger }[level];
  return (
    <View
      style={[{ flexDirection: 'row', alignItems: 'center', gap: 2, marginTop: 2 }, style]}
      accessible
      accessibilityRole="image"
      accessibilityLabel={t(`crowding.${level}`)}
    >
      {[0, 1, 2].map((i) => (
        <MaterialIcons
          key={i}
          name="directions-bus"
          size={ICON_SIZE}
          color={i < filled ? filledColor : colors.textMuted}
          style={i < filled ? undefined : { opacity: 0.35 }}
        />
      ))}
    </View>
  );
}
