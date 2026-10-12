import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import React, { useMemo } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useThemeColors } from '../context/ThemeContext';
import { useTranslation } from '../i18n/useTranslation';
import { radius, spacing, ThemeColors } from '../theme';

const FEATURE_KEYS = [
  'about.feature.liveTracking',
  'about.feature.journeyPlanner',
  'about.feature.search',
  'about.feature.favourites',
  'about.feature.nearby',
] as const;

const HOW_TO_KEYS = ['about.howTo.map', 'about.howTo.plan', 'about.howTo.menu', 'about.howTo.favourite'] as const;

const LIMITATION_KEYS = ['about.limitation.routeShapes', 'nearby.privacy'] as const;

export default function AboutScreen() {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const t = useTranslation();

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.scrollContent}>
      <Text style={styles.appName}>{t('home.title')}</Text>
      <Text style={styles.tagline}>{t('about.tagline')}</Text>

      <Text style={styles.sectionTitle}>{t('about.whatItDoes')}</Text>
      <View style={styles.section}>
        {FEATURE_KEYS.map((key) => (
          <View key={key} style={styles.row}>
            <Ionicons name="checkmark-circle" size={16} color={colors.success} />
            <Text style={styles.rowText}>{t(key)}</Text>
          </View>
        ))}
      </View>

      <Text style={styles.sectionTitle}>{t('about.howToUse')}</Text>
      <View style={styles.section}>
        {HOW_TO_KEYS.map((key) => (
          <View key={key} style={styles.row}>
            <Ionicons name="arrow-forward-circle" size={16} color={colors.primary} />
            <Text style={styles.rowText}>{t(key)}</Text>
          </View>
        ))}
      </View>

      <Text style={styles.sectionTitle}>{t('about.goodToKnow')}</Text>
      <View style={styles.section}>
        {LIMITATION_KEYS.map((key) => (
          <View key={key} style={styles.row}>
            <Ionicons name="information-circle-outline" size={16} color={colors.textMuted} />
            <Text style={styles.rowText}>{t(key)}</Text>
          </View>
        ))}
      </View>

      <Text style={styles.version}>{t('about.version', { value: Constants.expoConfig?.version ?? 'n/a' })}</Text>
    </ScrollView>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },
    scrollContent: { paddingTop: spacing.lg, paddingBottom: spacing.xl },
    appName: { fontSize: 22, fontWeight: '700', color: colors.text, textAlign: 'center' },
    tagline: {
      fontSize: 14,
      color: colors.textMuted,
      textAlign: 'center',
      marginTop: spacing.xs,
      marginHorizontal: spacing.xl,
    },
    sectionTitle: {
      fontSize: 13,
      fontWeight: '700',
      color: colors.textMuted,
      textTransform: 'uppercase',
      paddingHorizontal: spacing.lg,
      marginTop: spacing.lg,
      marginBottom: spacing.xs,
    },
    section: {
      marginHorizontal: spacing.lg,
      backgroundColor: colors.surface,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.border,
      padding: spacing.md,
      gap: spacing.sm,
    },
    row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    rowText: { flex: 1, fontSize: 14, color: colors.text },
    version: { textAlign: 'center', color: colors.textMuted, fontSize: 12, padding: spacing.lg },
  });
}
