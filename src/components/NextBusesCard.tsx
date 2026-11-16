import { Ionicons } from '@expo/vector-icons';
import React, { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useThemeColors } from '../context/ThemeContext';
import { useTranslation } from '../i18n/useTranslation';
import { useNextBuses } from '../hooks/useNextBuses';
import { radius, spacing, ThemeColors } from '../theme';
import CrowdingIndicator from './CrowdingIndicator';

// Same cadence as a departure row: the list refetches every 30 s, the countdown ticks in between.
const TICK_MS = 15_000;
// The planned bus counts as missed this long after it was due to leave.
const MISSED_AFTER_MS = 60_000;

// --- Next Buses ---
// While you're waiting for a bus: the next few of that line from the boarding stop, each with a live countdown and
// how full it is, so you can decide between the one coming now and waiting for a seat. If the bus the plan was
// built around has already left, it says so — the list is then your new options and timers.
export default function NextBusesCard({
  lineName,
  stopId,
  stopName,
  plannedDeparture,
  onReplan,
}: {
  lineName: string;
  stopId: string;
  stopName?: string;
  // ISO time the planned bus was due to leave this stop.
  plannedDeparture?: string;
  // Offered once the planned bus has been missed: search again from where you are now.
  onReplan?: () => Promise<void>;
}) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const t = useTranslation();
  const buses = useNextBuses(lineName, stopId);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(interval);
  }, []);

  // Finding where you are can take a few seconds, so the button says so and ignores more taps.
  const [replanning, setReplanning] = useState(false);
  async function handleReplan() {
    if (!onReplan || replanning) return;
    setReplanning(true);
    try {
      await onReplan();
    } finally {
      setReplanning(false);
    }
  }

  if (buses.length === 0) return null;
  const missed = !!plannedDeparture && now > new Date(plannedDeparture).getTime() + MISSED_AFTER_MS;

  return (
    <View style={styles.card}>
      <Text style={[styles.title, missed && { color: colors.danger }]}>
        {missed ? t('journey.missedBus', { line: lineName }) : t('journey.nextBuses', { line: lineName })}
        {stopName ? ` · ${stopName}` : ''}
      </Text>
      {buses.map(({ departure, crowding }) => {
        const minutes = Math.max(0, Math.round((new Date(departure.estimatedTime).getTime() - now) / 60_000));
        return (
          <View key={departure.tripId} style={styles.row}>
            <Text style={styles.minutes}>{t('departure.minutes', { minutes })}</Text>
            {departure.isLive === false && <Text style={styles.scheduled}>{t('departure.scheduled')}</Text>}
            <View style={styles.spacer} />
            {crowding && <CrowdingIndicator level={crowding} />}
          </View>
        );
      })}
      {/* --- Plan Again From Here --- */}
      {missed && !!onReplan && (
        <Pressable style={styles.replanButton} onPress={handleReplan} disabled={replanning} accessibilityRole="button">
          {replanning ? (
            <ActivityIndicator size="small" color={colors.primary} />
          ) : (
            <Ionicons name="refresh" size={14} color={colors.primary} />
          )}
          <Text style={styles.replanText}>{replanning ? t('map.findingLocation') : t('journey.replanFromHere')}</Text>
        </Pressable>
      )}
    </View>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    card: {
      marginHorizontal: spacing.lg,
      marginBottom: spacing.sm,
      backgroundColor: colors.primaryMuted,
      borderRadius: radius.sm,
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.xs,
      gap: 2,
    },
    title: { color: colors.primary, fontWeight: '600', fontSize: 12 },
    row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    minutes: { color: colors.text, fontWeight: '700', fontSize: 14, minWidth: 56 },
    scheduled: { color: colors.textMuted, fontSize: 11 },
    spacer: { flex: 1 },
    replanButton: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
      alignSelf: 'flex-start',
      marginTop: spacing.xs,
      paddingVertical: spacing.xs,
    },
    replanText: { color: colors.primary, fontWeight: '700', fontSize: 13 },
  });
}
