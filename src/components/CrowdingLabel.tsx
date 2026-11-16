import React from 'react';
import { StyleProp, Text, TextStyle } from 'react-native';
import { useThemeColors } from '../context/ThemeContext';
import { useTranslation } from '../i18n/useTranslation';
import { CrowdingLevel } from '../services/occupancy';

// --- Crowding ---
// How full a bus is ("Plenty of seats" ... "Very full"), coloured green / amber / red. Shared by the vehicle
// info cards and the stop's departure rows.
export default function CrowdingLabel({ level, style }: { level: CrowdingLevel; style?: StyleProp<TextStyle> }) {
  const colors = useThemeColors();
  const t = useTranslation();
  const color = { many: colors.success, few: colors.amber, standing: colors.amber, full: colors.danger }[level];
  return <Text style={[style, { color }]}>{t(`crowding.${level}`)}</Text>;
}
