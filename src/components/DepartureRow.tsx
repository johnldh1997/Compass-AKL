import React, { useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useThemeColors } from '../context/ThemeContext';
import { useTranslation } from '../i18n/useTranslation';
import { CrowdingLevel } from '../services/occupancy';
import { radius, spacing, ThemeColors } from '../theme';
import { Departure } from '../types';
import CrowdingIndicator from './CrowdingIndicator';

// The parent list only refetches every ~30s — ticking locally in between keeps the
// countdown honest as time passes rather than freezing until the next network poll.
const TICK_INTERVAL_MS = 15_000;

function minutesUntil(iso: string, now: number): number {
  return Math.max(0, Math.round((new Date(iso).getTime() - now) / 60_000));
}

export default function DepartureRow({ departure, crowding }: { departure: Departure; crowding?: CrowdingLevel }) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const t = useTranslation();
  const modeColor = {
    bus: colors.busLine,
    train: colors.trainLine,
    ferry: colors.ferryLine,
    unknown: colors.textMuted,
  };

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), TICK_INTERVAL_MS);
    return () => clearInterval(interval);
  }, []);

  const minutes = minutesUntil(departure.estimatedTime, now);

  return (
    <View style={styles.row}>
      <View style={[styles.badge, { backgroundColor: modeColor[departure.mode] }]}>
        <Text style={styles.badgeText}>{departure.routeShortName}</Text>
      </View>
      <View style={styles.details}>
        <Text style={styles.headsign} numberOfLines={1}>
          {departure.headsign || t('departure.destinationUnavailable')}
        </Text>
        {departure.cancelled ? (
          <Text style={styles.cancelled}>{t('departure.cancelled')}</Text>
        ) : departure.delayMinutes > 0 ? (
          <Text style={styles.delayed}>{t('departure.delayed', { minutes: departure.delayMinutes })}</Text>
        ) : departure.isLive === false ? (
          <Text style={styles.scheduled}>{t('departure.scheduled')}</Text>
        ) : (
          <Text style={styles.onTime}>{t('departure.onTime')}</Text>
        )}
        {/* --- Crowding --- */}
        {crowding && !departure.cancelled && <CrowdingIndicator level={crowding} />}
      </View>
      <Text style={styles.minutes}>{departure.cancelled ? '--' : t('departure.minutes', { minutes })}</Text>
    </View>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: spacing.sm,
      paddingHorizontal: spacing.md,
      gap: spacing.sm,
    },
    badge: {
      minWidth: 44,
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.xs,
      borderRadius: radius.sm,
      alignItems: 'center',
    },
    badgeText: { color: '#FFFFFF', fontWeight: '700', fontSize: 13 },
    details: { flex: 1 },
    headsign: { color: colors.text, fontSize: 15, fontWeight: '600' },
    onTime: { color: colors.success, fontSize: 12, marginTop: 2 },
    scheduled: { color: colors.textMuted, fontSize: 12, marginTop: 2 },
    delayed: { color: colors.danger, fontSize: 12, marginTop: 2 },
    cancelled: { color: colors.danger, fontSize: 12, marginTop: 2, fontWeight: '700' },
    minutes: { color: colors.text, fontWeight: '700', fontSize: 15 },
  });
}
