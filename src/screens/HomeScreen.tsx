import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import AnimatedPressable from '../components/AnimatedPressable';
import DepartureTimePicker from '../components/DepartureTimePicker';
import FavoritesPanel, { PANEL_PEEK_HEIGHT } from '../components/FavoritesPanel';
import PlaceAutocompleteInput from '../components/PlaceAutocompleteInput';
import SideMenu from '../components/SideMenu';
import VehicleMap from '../components/VehicleMap';
import { useDismissedAlerts } from '../context/DismissedAlertsContext';
import { useFavoritePlaces } from '../context/FavoritePlacesContext';
import { useFavorites } from '../context/FavoritesContext';
import { useReadAlerts } from '../context/ReadAlertsContext';
import { useThemeColors } from '../context/ThemeContext';
import { useTranslation } from '../i18n/useTranslation';
import { getNearbyActiveAlerts } from '../services/alerts';
import { radius, spacing, ThemeColors } from '../theme';
import { JourneyEndpoint, RootStackParamList } from '../types';

type Props = NativeStackScreenProps<RootStackParamList, 'Home'>;

// Verified live against AT's own site rather than guessed.
const HOP_TOP_UP_URL = 'https://at.govt.nz/bus-train-ferry/at-hop-card/top-up-at-hop-card/';

export default function HomeScreen({ navigation, route }: Props) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const [menuVisible, setMenuVisible] = useState(false);
  const [alertsCount, setAlertsCount] = useState(0);
  // --- Inline Journey Search ---
  const [searchExpanded, setSearchExpanded] = useState(false);
  const [homeFrom, setHomeFrom] = useState<JourneyEndpoint | null>(null);
  const [homeTo, setHomeTo] = useState<JourneyEndpoint | null>(null);
  const [homeDepartureTime, setHomeDepartureTime] = useState<Date>(() => new Date());
  const { favorites } = useFavorites();
  const { places } = useFavoritePlaces();
  const { isRead } = useReadAlerts();
  const { isDismissed } = useDismissedAlerts();
  const t = useTranslation();
  const favouritesCount = favorites.length + places.length;
  // Always clears the device's gesture bar/home indicator; adds the favourites panel's
  // own peek height on top of that when it's showing, so the locate button and the
  // selected-vehicle info card never sit under it.
  const bottomInset = insets.bottom + (favorites.length > 0 ? PANEL_PEEK_HEIGHT : 0);

  // Runs on every focus (not just mount) — a mount-only effect computed the badge from
  // whatever GPS fix was available at cold launch (often an imprecise first fix) and then
  // never touched it again, so it could get stuck showing a count for stops that were
  // never really nearby, while AlertsScreen's own fresh fix correctly showed nothing.
  // Also excludes dismissed alerts the same way AlertsScreen's own list does — otherwise
  // a dismissed-but-unread alert keeps inflating the badge even though it no longer shows
  // up anywhere in the Near Me list.
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      getNearbyActiveAlerts()
        .then((alerts) => {
          if (!cancelled) setAlertsCount(alerts.filter((alert) => !isRead(alert.id) && !isDismissed(alert.id)).length);
        })
        .catch(() => {});
      return () => {
        cancelled = true;
      };
    }, [isRead, isDismissed])
  );

  // Picks up a From/To pair carried back from ChooseOnMap/Favorites when one of those was
  // opened from this inline form (returnTo: 'Home') rather than from JourneyPlanner's own
  // form — same restoration pattern JourneyPlannerScreen itself uses.
  useEffect(() => {
    const { restoredFrom, restoredTo } = route.params ?? {};
    if (restoredFrom !== undefined || restoredTo !== undefined) {
      if (restoredFrom !== undefined) setHomeFrom(restoredFrom);
      if (restoredTo !== undefined) setHomeTo(restoredTo);
      setSearchExpanded(true);
      navigation.setParams({ restoredFrom: undefined, restoredTo: undefined });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route.params, navigation]);

  function handleHomeGetDirections() {
    if (!homeFrom || !homeTo) return;
    navigation.navigate('JourneyPlanner', {
      restoredFrom: homeFrom,
      restoredTo: homeTo,
      restoredDepartureTime: homeDepartureTime.toISOString(),
      autoSearch: true,
    });
  }

  return (
    <View style={styles.container}>
      <View style={[styles.header, { paddingTop: insets.top + spacing.md }]}>
        <Pressable
          onPress={() => setMenuVisible(true)}
          hitSlop={12}
          accessibilityRole="button"
          accessibilityLabel={t('menu.openMenu')}
        >
          <Ionicons name="menu" size={26} color={colors.text} />
        </Pressable>
        <Text style={styles.title}>{t('home.title')}</Text>
        <Pressable
          onPress={() => navigation.navigate('Alerts')}
          hitSlop={12}
          accessibilityRole="button"
          accessibilityLabel={
            alertsCount > 0 ? t('home.serviceAlertsActive', { count: alertsCount }) : t('home.serviceAlerts')
          }
        >
          <Ionicons name="warning-outline" size={24} color={alertsCount > 0 ? colors.danger : colors.text} />
          {alertsCount > 0 && (
            <View style={styles.alertBadge}>
              <Text style={styles.alertBadgeText}>{alertsCount}</Text>
            </View>
          )}
        </Pressable>
      </View>

      <View style={styles.mapArea}>
        <VehicleMap
          bottomInset={bottomInset}
          onStopPress={(stop) =>
            navigation.navigate('StopDetail', { stopId: stop.id, stopName: stop.name, stopCode: stop.code })
          }
          focusStop={route.params?.focusStop}
        />
        {/* --- Journey Search Bar --- */}
        {searchExpanded ? (
          <View style={styles.searchCard}>
            <View style={styles.searchCardHeader}>
              <Text style={styles.searchCardTitle}>{t('journey.planAJourney')}</Text>
              <Pressable
                onPress={() => setSearchExpanded(false)}
                hitSlop={12}
                accessibilityRole="button"
                accessibilityLabel={t('common.close')}
              >
                <Ionicons name="close" size={22} color={colors.textMuted} />
              </Pressable>
            </View>
            <PlaceAutocompleteInput
              key={homeFrom ? `from-${homeFrom.label}` : 'from-empty'}
              placeholder={t('journey.from')}
              onSelect={setHomeFrom}
              onClear={() => setHomeFrom(null)}
              onChooseOnMap={() =>
                navigation.navigate('ChooseOnMap', {
                  mode: 'journey',
                  pickingFor: 'from',
                  currentFrom: homeFrom ?? undefined,
                  currentTo: homeTo ?? undefined,
                })
              }
              onOpenFavorites={() =>
                navigation.navigate('Favorites', {
                  pickingFor: 'from',
                  currentFrom: homeFrom ?? undefined,
                  currentTo: homeTo ?? undefined,
                })
              }
              initialEndpoint={homeFrom ?? undefined}
            />
            <PlaceAutocompleteInput
              key={homeTo ? `to-${homeTo.label}` : 'to-empty'}
              placeholder={t('journey.to')}
              onSelect={setHomeTo}
              onClear={() => setHomeTo(null)}
              onChooseOnMap={() =>
                navigation.navigate('ChooseOnMap', {
                  mode: 'journey',
                  pickingFor: 'to',
                  currentFrom: homeFrom ?? undefined,
                  currentTo: homeTo ?? undefined,
                })
              }
              onOpenFavorites={() =>
                navigation.navigate('Favorites', {
                  pickingFor: 'to',
                  currentFrom: homeFrom ?? undefined,
                  currentTo: homeTo ?? undefined,
                })
              }
              initialEndpoint={homeTo ?? undefined}
            />
            <DepartureTimePicker value={homeDepartureTime} onChange={setHomeDepartureTime} />
            <AnimatedPressable
              style={[styles.getDirectionsButton, (!homeFrom || !homeTo) && styles.getDirectionsButtonDisabled]}
              onPress={handleHomeGetDirections}
              disabled={!homeFrom || !homeTo}
            >
              <Text style={styles.getDirectionsButtonText}>{t('journey.getDirections')}</Text>
            </AnimatedPressable>
          </View>
        ) : (
          <AnimatedPressable scaleTo={0.98} style={styles.searchBar} onPress={() => setSearchExpanded(true)}>
            <Ionicons name="search-outline" size={19} color={colors.textMuted} />
            <Text style={styles.searchBarText}>{t('home.whereTo')}</Text>
          </AnimatedPressable>
        )}
        <FavoritesPanel
          onStopPress={(stopId, stopName, stopCode) => navigation.navigate('StopDetail', { stopId, stopName, stopCode })}
          bottomInset={insets.bottom}
        />
      </View>

      <SideMenu
        visible={menuVisible}
        onClose={() => setMenuVisible(false)}
        items={[
          {
            label: t('menu.favourites'),
            subtitle: favouritesCount > 0 ? t('menu.favouritesSaved', { count: favouritesCount }) : undefined,
            icon: 'star-outline',
            iconColor: colors.amber,
            onPress: () => navigation.navigate('Favorites'),
          },
          {
            label: t('menu.searchStops'),
            icon: 'search-outline',
            iconColor: colors.accent,
            onPress: () => navigation.navigate('SearchStops'),
          },
          {
            label: t('menu.myTrips'),
            icon: 'repeat-outline',
            iconColor: colors.violet,
            onPress: () => navigation.navigate('MyTrips'),
          },
          {
            label: t('menu.nearbySearch'),
            icon: 'compass-outline',
            iconColor: colors.rose,
            onPress: () => navigation.navigate('NearbySearch'),
          },
          { label: t('menu.settings'), icon: 'settings-outline', onPress: () => navigation.navigate('Settings') },
          {
            label: t('menu.about'),
            icon: 'information-circle-outline',
            iconColor: colors.primary,
            onPress: () => navigation.navigate('About'),
          },
          {
            label: t('menu.topUpHop'),
            icon: 'card-outline',
            iconColor: colors.emerald,
            external: true,
            onPress: () =>
              Alert.alert(t('hop.confirmTitle'), t('hop.confirmMessage'), [
                { text: t('common.cancel'), style: 'cancel' },
                { text: t('common.open'), onPress: () => Linking.openURL(HOP_TOP_UP_URL) },
              ]),
          },
        ]}
      />
    </View>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.lg,
      paddingBottom: spacing.md,
    },
    title: { fontSize: 24, fontWeight: '700', color: colors.text, flex: 1 },
    alertBadge: {
      position: 'absolute',
      top: -4,
      right: -6,
      backgroundColor: colors.danger,
      borderRadius: 8,
      minWidth: 16,
      height: 16,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 3,
    },
    alertBadgeText: { color: '#FFFFFF', fontSize: 10, fontWeight: '700' },
    mapArea: { flex: 1 },
    searchBar: {
      position: 'absolute',
      top: spacing.md,
      left: spacing.lg,
      right: spacing.lg,
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      backgroundColor: colors.surface,
      paddingVertical: 14,
      paddingHorizontal: spacing.lg,
      borderRadius: radius.lg,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.2,
      shadowRadius: 10,
      elevation: 6,
    },
    searchBarText: { color: colors.textMuted, fontWeight: '600', fontSize: 15 },
    searchCard: {
      position: 'absolute',
      top: spacing.md,
      left: spacing.lg,
      right: spacing.lg,
      backgroundColor: colors.surface,
      padding: spacing.md,
      borderRadius: radius.lg,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.2,
      shadowRadius: 10,
      elevation: 6,
    },
    searchCardHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: spacing.sm,
    },
    searchCardTitle: { fontSize: 16, fontWeight: '700', color: colors.text },
    getDirectionsButton: {
      backgroundColor: colors.primary,
      borderRadius: radius.md,
      paddingVertical: spacing.sm,
      alignItems: 'center',
      marginTop: spacing.xs,
    },
    getDirectionsButtonDisabled: { opacity: 0.5 },
    getDirectionsButtonText: { color: '#FFFFFF', fontWeight: '700' },
  });
}
