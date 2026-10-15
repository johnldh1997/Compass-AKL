import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import * as Updates from 'expo-updates';
import React, { useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useThemeColors } from '../context/ThemeContext';
import { useTranslation } from '../i18n/useTranslation';
import { LoggedError, readLastError } from '../services/errorLog';
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
  const [lastError, setLastError] = useState<LoggedError | null>(null);
  useEffect(() => {
    readLastError().then(setLastError);
  }, []);

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

      {/* --- Which Version Is This? ---
          "Version" is the install number: it changes only when the app needs reinstalling, never for an update
          that arrives over the air (see scripts/check-install-version.js). It is also part of the update runtime,
          so a phone showing it is on an install that receives updates for that same number. The line below names
          the update actually running, or says the built-in code is running because none has been downloaded. */}
      <Text style={styles.version}>{t('about.version', { value: Constants.expoConfig?.version ?? 'n/a' })}</Text>
      <Text style={styles.versionHint}>{t('about.versionHint')}</Text>
      <Text style={styles.updateInfo} selectable>
        {Updates.isEmbeddedLaunch || !Updates.updateId
          ? t('about.builtIn')
          : t('about.update', {
              id: Updates.updateId.slice(0, 8),
              date: Updates.createdAt ? Updates.createdAt.toLocaleString() : '',
            })}
        {Updates.runtimeVersion ? `\n${t('about.runtime', { id: Updates.runtimeVersion.slice(0, 8) })}` : ''}
      </Text>
      {/* --- Last Crash --- The most recent uncaught error, kept by services/errorLog.ts, so a crash report can say why. */}
      {lastError && (
        <Text style={styles.lastError} selectable>
          {`${t('about.lastError', { date: new Date(lastError.at).toLocaleString() })}\n${lastError.message}\n${lastError.stack}`}
        </Text>
      )}
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
    version: { textAlign: 'center', color: colors.textMuted, fontSize: 12, paddingTop: spacing.lg },
    versionHint: { textAlign: 'center', color: colors.textMuted, fontSize: 11, paddingTop: 2, paddingHorizontal: spacing.xl },
    lastError: { color: colors.textMuted, fontSize: 10, paddingHorizontal: spacing.lg, paddingBottom: spacing.lg },
    updateInfo: { textAlign: 'center', color: colors.textMuted, fontSize: 11, paddingTop: spacing.xs, paddingBottom: spacing.lg },
  });
}
