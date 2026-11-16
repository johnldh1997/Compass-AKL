import { NativeStackScreenProps } from '@react-navigation/native-stack';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import DepartureRow from '../components/DepartureRow';
import StopLocationMap from '../components/StopLocationMap';
import { useFavorites } from '../context/FavoritesContext';
import { useSettings } from '../context/SettingsContext';
import { useThemeColors } from '../context/ThemeContext';
import { useTranslation } from '../i18n/useTranslation';
import { getAlertsForRoutes, getAlertsForStop } from '../services/alerts';
import { mergeDepartures } from '../services/departures';
import { getStopById } from '../services/gtfs';
import { getScheduledDeparturesForStop } from '../services/gtfsStatic';
import { ensureNotificationSetup, scheduleDepartureReminder } from '../services/notifications';
import { CrowdingLevel, crowdingLevel } from '../services/occupancy';
import { getDeparturesForStop } from '../services/realtime';
import { getVehiclePositions } from '../services/vehicles';
import { radius, spacing, ThemeColors } from '../theme';
import { Departure, RootStackParamList, ServiceAlert, Stop } from '../types';

type Props = NativeStackScreenProps<RootStackParamList, 'StopDetail'>;

const POLL_INTERVAL_MS = 30_000;
const REMINDER_MINUTES_BEFORE = 5;

export default function StopDetailScreen({ route }: Props) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { stopId, stopName, stopCode } = route.params;
  const [departures, setDepartures] = useState<Departure[]>([]);
  const [loading, setLoading] = useState(true);
  const [stopLocation, setStopLocation] = useState<Stop | undefined>();
  const [alerts, setAlerts] = useState<ServiceAlert[]>([]);
  const [debugInfo, setDebugInfo] = useState('');
  const [crowding, setCrowding] = useState<Map<string, CrowdingLevel>>(new Map());

  const { favorites, isFavorite, addFavorite, removeFavorite, setFavoriteNotifications } = useFavorites();
  const { notificationsMasterEnabled } = useSettings();
  const t = useTranslation();

  const favorite = favorites.find((f) => f.stopId === stopId);
  const notificationsAvailableForStop = notificationsMasterEnabled && !!favorite?.notificationsEnabled;

  const loadDepartures = useCallback(() => {
    let scheduledError = '';
    Promise.all([
      getDeparturesForStop(stopId),
      // A failure here (e.g. the bundled database failing to copy/open on first use)
      // must not also take down the live departures — the two are independent sources.
      getScheduledDeparturesForStop(stopId).catch((err) => {
        scheduledError = err instanceof Error ? err.message : String(err);
        console.warn('getScheduledDeparturesForStop failed:', err);
        return [];
      }),
      // --- Crowding --- Best-effort: a failure here just means no crowding shown.
      getVehiclePositions().catch(() => []),
    ])
      .then(([live, scheduled, vehicles]) => {
        setDebugInfo(
          `live=${live.length} scheduled=${scheduled.length}${scheduledError ? ` error="${scheduledError}"` : ''}`
        );
        setDepartures(mergeDepartures(live, scheduled));
        const levels = new Map<string, CrowdingLevel>();
        for (const v of vehicles) {
          const level = crowdingLevel(v.occupancy);
          if (v.tripId && level) levels.set(v.tripId, level);
        }
        setCrowding(levels);
      })
      .finally(() => setLoading(false));
  }, [stopId]);

  useEffect(() => {
    loadDepartures();
    const interval = setInterval(loadDepartures, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [loadDepartures]);

  useEffect(() => {
    getStopById(stopId).then(setStopLocation);
  }, [stopId]);

  useEffect(() => {
    const routeIds = Array.from(new Set(departures.map((d) => d.routeId)));
    Promise.all([getAlertsForStop(stopId), getAlertsForRoutes(routeIds)]).then(([stopAlerts, routeAlerts]) => {
      const merged = new Map<string, ServiceAlert>();
      [...stopAlerts, ...routeAlerts].forEach((a) => merged.set(a.id, a));
      setAlerts(Array.from(merged.values()));
    });
  }, [stopId, departures]);

  async function handleRemind(departure: Departure) {
    const granted = await ensureNotificationSetup();
    if (!granted) {
      Alert.alert(t('stopDetail.notificationsBlockedTitle'), t('stopDetail.notificationsBlockedMessage'));
      return;
    }
    const id = await scheduleDepartureReminder(stopName, departure, REMINDER_MINUTES_BEFORE);
    if (id) {
      Alert.alert(t('stopDetail.reminderSetTitle'), t('stopDetail.reminderSetMessage', { minutes: REMINDER_MINUTES_BEFORE }));
    } else {
      Alert.alert(t('stopDetail.tooSoonTitle'), t('stopDetail.tooSoonMessage'));
    }
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>{stopName}</Text>
          <Text style={styles.subtitle}>{t('common.stopCode', { code: stopCode })}</Text>
        </View>
        <Pressable
          style={styles.favoriteButton}
          onPress={() => (favorite ? removeFavorite(stopId) : addFavorite({ id: stopId, name: stopName, code: stopCode, lat: 0, lon: 0 }))}
        >
          <Text style={styles.favoriteButtonText}>
            {favorite ? t('stopDetail.removeFavorite') : t('stopDetail.addFavorite')}
          </Text>
        </Pressable>
      </View>

      {favorite && (
        <View style={styles.notificationRow}>
          <Text style={styles.notificationLabel}>{t('stopDetail.allowReminders')}</Text>
          <Switch
            value={favorite.notificationsEnabled}
            onValueChange={(value) => setFavoriteNotifications(stopId, value)}
            accessibilityLabel={t('stopDetail.allowReminders')}
          />
        </View>
      )}
      {favorite && !notificationsMasterEnabled && (
        <Text style={styles.hint}>{t('stopDetail.notificationsOffGlobally')}</Text>
      )}

      {alerts.length > 0 && (
        <View style={styles.alertsList}>
          {alerts.map((alert) => (
            <View key={alert.id} style={styles.alertCard}>
              <Text style={styles.alertHeader}>{alert.headerText}</Text>
              {!!alert.descriptionText && <Text style={styles.alertDescription}>{alert.descriptionText}</Text>}
            </View>
          ))}
        </View>
      )}

      {stopLocation && <StopLocationMap lat={stopLocation.lat} lon={stopLocation.lon} />}

      {!!debugInfo && <Text style={styles.debug}>{debugInfo}</Text>}

      {loading ? (
        <ActivityIndicator style={styles.loader} color={colors.primary} />
      ) : (
        <FlatList
          data={departures}
          keyExtractor={(item) => item.tripId}
          contentContainerStyle={styles.list}
          ListEmptyComponent={<Text style={styles.empty}>{t('favorites.noDepartures')}</Text>}
          renderItem={({ item }) => (
            <View>
              <DepartureRow departure={item} crowding={crowding.get(item.tripId)} />
              {notificationsAvailableForStop && !item.cancelled && (
                <Pressable style={styles.remindButton} onPress={() => handleRemind(item)}>
                  <Text style={styles.remindButtonText}>{t('stopDetail.remindMe')}</Text>
                </Pressable>
              )}
            </View>
          )}
        />
      )}
    </View>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },
    header: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      padding: spacing.lg,
      gap: spacing.sm,
    },
    title: { fontSize: 20, fontWeight: '700', color: colors.text },
    subtitle: { fontSize: 13, color: colors.textMuted, marginTop: 2 },
    favoriteButton: {
      backgroundColor: colors.primaryMuted,
      paddingVertical: spacing.xs,
      paddingHorizontal: spacing.sm,
      borderRadius: radius.sm,
    },
    favoriteButtonText: { color: colors.primary, fontWeight: '600', fontSize: 13 },
    alertsList: { paddingHorizontal: spacing.lg, gap: spacing.sm, paddingBottom: spacing.sm },
    alertCard: {
      backgroundColor: colors.dangerMuted,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.danger,
      padding: spacing.sm,
    },
    alertHeader: { color: colors.danger, fontWeight: '700', fontSize: 13 },
    alertDescription: { color: colors.text, fontSize: 12, marginTop: 2 },
    notificationRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingHorizontal: spacing.lg,
      paddingBottom: spacing.sm,
    },
    notificationLabel: { color: colors.text, fontSize: 14 },
    hint: { color: colors.textMuted, fontSize: 12, paddingHorizontal: spacing.lg, paddingBottom: spacing.sm },
    loader: { marginTop: spacing.lg },
    list: { paddingHorizontal: spacing.lg, paddingBottom: spacing.lg },
    empty: { textAlign: 'center', color: colors.textMuted, marginTop: spacing.lg },
    debug: { color: colors.textMuted, fontSize: 10, paddingHorizontal: spacing.lg, paddingBottom: spacing.xs },
    remindButton: { alignSelf: 'flex-end', marginRight: spacing.md, marginBottom: spacing.sm },
    remindButtonText: { color: colors.accent, fontWeight: '600', fontSize: 13 },
  });
}
