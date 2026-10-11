import { Ionicons } from '@expo/vector-icons';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import * as Location from 'expo-location';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Dimensions, FlatList, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import AnimatedPressable from '../components/AnimatedPressable';
import BackButton from '../components/BackButton';
import DepartureTimePicker from '../components/DepartureTimePicker';
import DraggableSheet from '../components/DraggableSheet';
import LegStopList from '../components/LegStopList';
import PlaceAutocompleteInput from '../components/PlaceAutocompleteInput';
import RoutePreviewMap from '../components/RoutePreviewMap';
import TripRow from '../components/TripRow';
import { useFavoriteTrips } from '../context/FavoriteTripsContext';
import { useLegStops } from '../hooks/useLegStops';
import { useRecentTrips } from '../context/RecentTripsContext';
import { useSettings } from '../context/SettingsContext';
import { useThemeColors } from '../context/ThemeContext';
import { useTranslation } from '../i18n/useTranslation';
import { getAlertsForRoutes } from '../services/alerts';
import { loadActiveJourney, saveActiveJourney, clearActiveJourney } from '../services/activeJourney';
import { clampToNow } from '../services/departureTime';
import { decodePolyline, getTransitRoutes } from '../services/directions';
import { estimateFare, FareEstimate } from '../services/fareZones';
import { getRouteIdsByShortName } from '../services/gtfs';
import { getCurrentStepIndex } from '../services/journeyTracking';
import { startJourneyTracking, stopJourneyTracking, updateJourneyNotification } from '../services/journeyNotification';
import { getLegColor } from '../services/legColors';
import { computeLegProgress, LatLon } from '../services/legProgress';
import { getVehiclesForRoutes } from '../services/liveVehicleMatch';
import { radius, spacing, ThemeColors } from '../theme';
import {
  JourneyEndpoint,
  JourneyRoute,
  RootStackParamList,
  ServiceAlert,
  Stop,
  TransitStep,
  VehiclePosition,
} from '../types';

// How often to re-check live vehicles on the journey's routes during an active journey —
// matches the live map's own poll interval.
const LIVE_VEHICLE_POLL_MS = 15_000;

// Every transit line used anywhere in the route, each mapped to that leg's own color —
// so all matching live vehicles can be shown colored consistently with their polyline.
function getLineColors(steps: TransitStep[], colors: ThemeColors): Map<string, string> {
  const map = new Map<string, string>();
  steps.forEach((step, index) => {
    if (step.kind === 'transit' && step.lineName) map.set(step.lineName, getLegColor(steps, index, colors));
  });
  return map;
}

// Uses the Korean locale's own time formatting (오전/오후 before the time) rather than a
// fixed "h:mm AM/PM" string — same reasoning as DepartureTimePicker.tsx's formatTimeLabel.
function formatClockTime(date: Date, isKorean: boolean): string {
  return date.toLocaleTimeString(isKorean ? 'ko-KR' : 'en-NZ', { hour: 'numeric', minute: '2-digit', hour12: true });
}

// Anchored to the last transit leg's own alighting time (the same departureTimestamp/
// arrivalTimestamp fields the live GPS/schedule tracking below already trusts), plus any
// walking after it — rather than a separate route-level duration field, so this always
// lines up with what the step list itself shows instead of risking the two disagreeing.
function computeArrival(steps: TransitStep[], start: Date): Date {
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    if (step.kind === 'transit' && step.arrivalTimestamp) {
      let arrivalMs = new Date(step.arrivalTimestamp).getTime();
      for (let j = i + 1; j < steps.length; j++) {
        arrivalMs += (steps[j].durationSeconds ?? 0) * 1000;
      }
      return new Date(arrivalMs);
    }
  }
  // No transit leg at all (walking-only route) — sum every step's own duration from start.
  const totalSeconds = steps.reduce((sum, step) => sum + (step.durationSeconds ?? 0), 0);
  return new Date(start.getTime() + totalSeconds * 1000);
}

// `start` should be the departure time a route was actually searched for
// (searchedDepartureTime below) rather than the live time-picker value, so a route's shown
// times don't silently drift if the user fiddles with the picker after seeing results
// without re-searching.
function formatTimeRange(steps: TransitStep[], start: Date, isKorean: boolean): string {
  const end = computeArrival(steps, start);
  return `${formatClockTime(start, isKorean)} – ${formatClockTime(end, isKorean)}`;
}

// A parenthetical note when the estimate is on shakier ground than usual — a ferry leg
// (priced separately, not included) and/or at least one zone the device's geocoder
// couldn't resolve, so the shown total is a lower-confidence floor.
function formatFareEstimate(estimate: FareEstimate, t: ReturnType<typeof useTranslation>): string {
  if (estimate.amount === 0) return t('journey.fareFree');
  const base = t('journey.fareEstimate', { amount: estimate.amount.toFixed(2) });
  const notes = [
    estimate.hasFerry ? t('journey.fareFerryExcluded') : null,
    estimate.unresolved ? t('journey.fareApprox') : null,
  ].filter((note): note is string => !!note);
  return notes.length > 0 ? `${base} (${notes.join(', ')})` : base;
}

// The next transit leg the user still needs to catch (the first one from currentStepIndex
// onward that hasn't departed yet) — a relative countdown is more useful while actually
// standing at a stop than the fixed scheduled clock times already shown per step.
function getUpcomingWait(steps: TransitStep[], currentStepIndex: number, now: Date): { lineName?: string; minutes: number } | null {
  for (let i = currentStepIndex; i < steps.length; i++) {
    const step = steps[i];
    if (step.kind !== 'transit' || !step.departureTimestamp) continue;
    const minutes = Math.round((new Date(step.departureTimestamp).getTime() - now.getTime()) / 60_000);
    return minutes > 0 ? { lineName: step.lineName, minutes } : null;
  }
  return null;
}

type Props = NativeStackScreenProps<RootStackParamList, 'JourneyPlanner'>;
type ScreenState = 'form' | 'preview' | 'active';

const TRACKING_UPDATE_INTERVAL_MS = 15_000;
const GPS_ACCURACY_THRESHOLD_METERS = 50;
const SHEET_MIN_HEIGHT = 140;
const SHEET_MAX_HEIGHT = Math.round(Dimensions.get('window').height * 0.7);

export default function JourneyPlannerScreen({ route, navigation }: Props) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const [from, setFrom] = useState<JourneyEndpoint | null>(null);
  const [to, setTo] = useState<JourneyEndpoint | null>(null);
  const [routeOptions, setRouteOptions] = useState<JourneyRoute[]>([]);
  const [departureTime, setDepartureTime] = useState<Date>(() => new Date());
  // Snapshot of departureTime at the moment a search actually ran — used (not the live
  // picker value) to compute each result's start/arrival times, so they don't silently
  // drift if the user tweaks the picker afterward without re-searching.
  const [searchedDepartureTime, setSearchedDepartureTime] = useState<Date | null>(null);
  const [journeyRoute, setJourneyRoute] = useState<JourneyRoute | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [screenState, setScreenState] = useState<ScreenState>('form');
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [currentPosition, setCurrentPosition] = useState<{ latitude: number; longitude: number }>();
  // Like currentPosition, but only fixes accurate enough to trust for matching a stop (see the
  // accuracy filter in beginTracking) — what the per-leg stop list highlights against.
  const [matchedPosition, setMatchedPosition] = useState<LatLon>();
  const legStops = useLegStops(journeyRoute?.steps);
  const [focusOnUserAt, setFocusOnUserAt] = useState<number>();
  const [focusStepAt, setFocusStepAt] = useState<{ index: number; requestedAt: number }>();
  const [routeAlerts, setRouteAlerts] = useState<ServiceAlert[]>([]);
  const [fareEstimate, setFareEstimate] = useState<FareEstimate | null>(null);
  const [liveVehicles, setLiveVehicles] = useState<VehiclePosition[]>([]);
  // When liveVehicles last actually refreshed — threaded down to RoutePreviewMap so its
  // selected-vehicle info card's "Updates in Ns" describes this exact poll (the one that
  // actually moves the marker on the map), not an independent, out-of-phase timer.
  const [liveVehiclesUpdatedAt, setLiveVehiclesUpdatedAt] = useState(Date.now());
  const locationSubscription = useRef<Location.LocationSubscription | null>(null);
  const trackingInterval = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  // The tracking interval below is set up once (when the route starts) and would
  // otherwise always see the currentPosition value from that moment — a stale closure —
  // rather than wherever the user has actually moved to since. This ref always holds the
  // latest position for it to read instead.
  const currentPositionRef = useRef<{ latitude: number; longitude: number } | undefined>(undefined);
  // When currentPositionRef was last updated — lets the periodic re-check tell a fresh fix from
  // one that's gone stale (no signal underground or in a tunnel).
  const lastFixAtRef = useRef(0);

  const { trips: favoriteTrips, isFavoriteTrip, toggleFavoriteTrip } = useFavoriteTrips();
  const { trips: recentTrips, addRecentTrip, removeRecentTrip } = useRecentTrips();
  const { language } = useSettings();
  const isKorean = language === 'ko';
  const t = useTranslation();

  useEffect(() => {
    const { restoredFrom, restoredTo, restoredDepartureTime, autoSearch } = route.params ?? {};
    if (restoredFrom !== undefined || restoredTo !== undefined) {
      if (restoredFrom !== undefined) setFrom(restoredFrom);
      if (restoredTo !== undefined) setTo(restoredTo);
      const restoredTime = restoredDepartureTime ? new Date(restoredDepartureTime) : undefined;
      if (restoredTime) setDepartureTime(restoredTime);
      // "My Trips" and Home's own inline journey form both want tapping/searching to go
      // straight to results, not just refill the form — same From/To restoration path
      // everything else (Favorites, ChooseOnMap) uses, just with the search kicked off
      // immediately when both ends are known. Passes restoredTime explicitly rather than
      // relying on the departureTime state set just above — that setDepartureTime call
      // hasn't re-rendered yet, so reading the state here would still see the old value.
      if (autoSearch && restoredFrom && restoredTo) {
        runSearch(restoredFrom, restoredTo, restoredTime);
      }
      navigation.setParams({
        restoredFrom: undefined,
        restoredTo: undefined,
        restoredDepartureTime: undefined,
        autoSearch: undefined,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route.params, navigation]);

  useEffect(() => {
    return () => {
      locationSubscription.current?.remove();
      if (trackingInterval.current) clearInterval(trackingInterval.current);
    };
  }, []);

  // The header kept saying "Plan a Journey" even once a route was chosen or being tracked —
  // set in App.tsx's Stack.Screen options as a single static title, which can't react to
  // screen state. Overriding it here per state instead. The form state hides the native
  // header entirely and draws its own top bar instead (see the 'form' render branch below),
  // so its content sits directly under that bar rather than a separate title strip above it.
  useEffect(() => {
    navigation.setOptions({
      headerShown: screenState !== 'form',
      title:
        screenState === 'active'
          ? t('journey.yourRoute')
          : screenState === 'preview'
            ? t('journey.routePreview')
            : t('journey.planAJourney'),
    });
  }, [screenState, navigation, t]);

  // Back (header button, hardware back, or swipe gesture) during a preview or an active
  // route returns to the Plan a Journey form — never leaves the screen mid-route. Ending
  // an active journey asks for confirmation first, same as the End Route button.
  useEffect(() => {
    const unsubscribe = navigation.addListener('beforeRemove', (e) => {
      if (screenState === 'form') return;
      e.preventDefault();
      if (screenState === 'preview') {
        handleCancelPreview();
        return;
      }
      Alert.alert(t('journey.endRouteConfirmTitle'), t('journey.endRouteConfirmMessage'), [
        { text: t('journey.keepGoing'), style: 'cancel' },
        { text: t('journey.endRoute'), style: 'destructive', onPress: confirmedEndRoute },
      ]);
    });
    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigation, screenState]);

  useEffect(() => {
    if (!journeyRoute) {
      setRouteAlerts([]);
      return;
    }
    const lineNames = Array.from(
      new Set(
        journeyRoute.steps
          .filter((step) => step.kind === 'transit')
          .map((step) => step.lineName)
          .filter((name): name is string => !!name)
      )
    );
    Promise.all(lineNames.map(getRouteIdsByShortName)).then((idLists) => {
      getAlertsForRoutes(idLists.flat()).then(setRouteAlerts);
    });
  }, [journeyRoute]);

  useEffect(() => {
    if (!journeyRoute) {
      setFareEstimate(null);
      return;
    }
    let cancelled = false;
    setFareEstimate(null);
    estimateFare(journeyRoute).then((estimate) => {
      if (!cancelled) setFareEstimate(estimate);
    });
    return () => {
      cancelled = true;
    };
  }, [journeyRoute]);

  useEffect(() => {
    if (screenState !== 'active' || !journeyRoute) {
      setLiveVehicles([]);
      return;
    }
    const lineNames = Array.from(
      new Set(
        journeyRoute.steps
          .filter((step) => step.kind === 'transit')
          .map((step) => step.lineName)
          .filter((name): name is string => !!name)
      )
    );
    if (lineNames.length === 0) {
      setLiveVehicles([]);
      return;
    }
    let cancelled = false;
    function load() {
      getVehiclesForRoutes(lineNames).then((vehicles) => {
        if (!cancelled) {
          setLiveVehicles(vehicles);
          setLiveVehiclesUpdatedAt(Date.now());
        }
      });
    }
    load();
    const interval = setInterval(load, LIVE_VEHICLE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [screenState, journeyRoute]);

  async function runSearch(searchFrom: JourneyEndpoint, searchTo: JourneyEndpoint, requestedDepartureTime = departureTime) {
    // --- Departure Time Floor ---
    // Every search path (Get Directions, changing From/To, a recent trip, a handoff from My
    // Trips or Find Nearby) ends up here, so this is the one place a stale time gets caught —
    // e.g. missing a bus, then switching From to the current location an hour after the
    // picker was last set. The picker is updated too, so the form shows what was searched.
    const searchDepartureTime = clampToNow(requestedDepartureTime);
    setDepartureTime(searchDepartureTime);
    setLoading(true);
    setError('');
    setRouteOptions([]);
    setJourneyRoute(null);
    setSearchedDepartureTime(searchDepartureTime);
    try {
      const results = await getTransitRoutes(searchFrom, searchTo, searchDepartureTime);
      if (results.length === 0) {
        setError(t('journey.noRouteFound'));
        return;
      }
      setRouteOptions(results);
      addRecentTrip(searchFrom, searchTo);
    } catch {
      setError(t('journey.loadError'));
    } finally {
      setLoading(false);
    }
  }

  function handleSearch() {
    if (!from || !to) return;
    runSearch(from, to);
  }

  // Changing either end re-searches straight away once both are known, so the route options
  // on screen never describe a trip that no longer matches the From/To shown above them.
  function handleEndpointChange(which: 'from' | 'to', endpoint: JourneyEndpoint) {
    const nextFrom = which === 'from' ? endpoint : from;
    const nextTo = which === 'to' ? endpoint : to;
    if (which === 'from') setFrom(endpoint);
    else setTo(endpoint);
    if (nextFrom && nextTo) runSearch(nextFrom, nextTo);
  }

  function handleRunTrip(tripFrom: JourneyEndpoint, tripTo: JourneyEndpoint) {
    setFrom(tripFrom);
    setTo(tripTo);
    runSearch(tripFrom, tripTo);
  }

  function handleChooseRoute(option: JourneyRoute) {
    setJourneyRoute(option);
    setScreenState('preview');
  }

  function handleCancelPreview() {
    setScreenState('form');
    setJourneyRoute(null);
  }

  // Shared by a fresh "Go" press and by resuming an already-active journey after the app
  // was closed and reopened — takes `route` explicitly (rather than reading the outer
  // journeyRoute state) so a resume can call this before that state even exists yet.
  async function beginTracking(activeRoute: JourneyRoute): Promise<boolean> {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert(t('journey.locationNeededTitle'), t('journey.locationNeededMessage'));
      return false;
    }

    setScreenState('active');
    setCurrentStepIndex(getCurrentStepIndex(activeRoute.steps, new Date(), currentPositionRef.current));
    setFocusOnUserAt(Date.now());

    // Best-effort: posts the ongoing notification and, if "Allow all the time" location is
    // granted, starts background delivery so it keeps updating with the screen off. See
    // journeyNotification.ts for what happens when that permission is denied instead.
    startJourneyTracking(activeRoute.steps).catch(() => {});

    locationSubscription.current = await Location.watchPositionAsync(
      { accuracy: Location.Accuracy.High, timeInterval: 5_000, distanceInterval: 5 },
      (position) => {
        const coords = { latitude: position.coords.latitude, longitude: position.coords.longitude };
        setCurrentPosition(coords);

        // A low-accuracy fix (e.g. a stale cell/wifi-based estimate right when tracking
        // starts, before a real GPS lock) can still land within the match threshold of
        // some step purely by chance on a long multi-leg route — highlighting a step
        // nowhere near where the user actually is. Only trust reasonably precise fixes
        // for step-matching; still show the (possibly rough) dot on the map either way.
        if (position.coords.accuracy != null && position.coords.accuracy > GPS_ACCURACY_THRESHOLD_METERS) {
          return;
        }
        currentPositionRef.current = coords;
        lastFixAtRef.current = Date.now();
        setMatchedPosition(coords);
        // Update immediately on every position fix rather than waiting for the interval
        // below — GPS matching is cheap (pure geometry, no network), so there's no
        // reason to delay the highlight up to 15s behind where the user actually is.
        setCurrentStepIndex(getCurrentStepIndex(activeRoute.steps, new Date(), coords));
        // Keeps the notification fresh while the app is foregrounded even if background
        // location delivery isn't running (permission denied, or still starting up).
        updateJourneyNotification(activeRoute.steps, coords).catch(() => {});
      }
    );

    trackingInterval.current = setInterval(() => {
      setCurrentStepIndex(getCurrentStepIndex(activeRoute.steps, new Date(), currentPositionRef.current));
      // Also re-checks the get-off alert with no new fix needed: underground or in a tunnel
      // no fixes arrive at all, and with a stale position the alert falls back to the
      // scheduled arrival instead of waiting forever for a GPS update that isn't coming.
      updateJourneyNotification(
        activeRoute.steps,
        currentPositionRef.current,
        Date.now() - lastFixAtRef.current
      ).catch(() => {});
    }, TRACKING_UPDATE_INTERVAL_MS);
    return true;
  }

  async function handleStartRoute() {
    if (!journeyRoute) return;
    const started = await beginTracking(journeyRoute);
    if (started) saveActiveJourney(journeyRoute, searchedDepartureTime ?? new Date()).catch(() => {});
  }

  // Restores an in-progress journey after the app process was closed and reopened (e.g. by
  // the OS reclaiming memory in the background, or the user swiping it away from recents),
  // so a killed app doesn't lose the whole journey and force starting over. Runs once on
  // mount regardless of how this screen was reached — App.tsx also auto-navigates straight
  // here on cold launch when one is found, so this doesn't depend on the user remembering
  // to reopen Journey Planner themselves.
  useEffect(() => {
    loadActiveJourney().then((data) => {
      if (!data) return;
      setJourneyRoute(data.route);
      setSearchedDepartureTime(new Date(data.searchedDepartureTime));
      beginTracking(data.route).then((started) => {
        if (started) return;
        // Location permission was denied (or revoked in OS settings since the journey
        // started) — beginTracking already alerted, and screenState was never advanced
        // past 'form', so the active/step-list view (and its End Route button) never
        // renders. Without this, the stale persisted journey would silently fail to
        // resume — and re-prompt — on every future launch with no way to reach End Route
        // to clear it. Give up on resuming and reset instead of leaving it stuck.
        setJourneyRoute(null);
        clearActiveJourney().catch(() => {});
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function confirmedEndRoute() {
    locationSubscription.current?.remove();
    locationSubscription.current = null;
    if (trackingInterval.current) clearInterval(trackingInterval.current);
    stopJourneyTracking().catch(() => {});
    clearActiveJourney().catch(() => {});
    setScreenState('form');
    setJourneyRoute(null);
    setCurrentPosition(undefined);
    setMatchedPosition(undefined);
  }

  function handleEndRoute() {
    Alert.alert(t('journey.endRouteConfirmTitle'), t('journey.endRouteConfirmMessage'), [
      { text: t('journey.keepGoing'), style: 'cancel' },
      { text: t('journey.endRoute'), style: 'destructive', onPress: confirmedEndRoute },
    ]);
  }

  if (screenState !== 'form' && journeyRoute) {
    const waitInfo =
      screenState === 'active' ? getUpcomingWait(journeyRoute.steps, currentStepIndex, new Date()) : null;

    return (
      <View style={styles.container}>
        <View style={styles.mapArea}>
          <RoutePreviewMap
            encodedPolyline={journeyRoute.encodedPolyline ?? ''}
            steps={journeyRoute.steps}
            currentPosition={currentPosition}
            focusOnUserAt={focusOnUserAt}
            focusStep={focusStepAt}
            liveVehicles={liveVehicles}
            liveVehiclesUpdatedAt={liveVehiclesUpdatedAt}
            lineColors={getLineColors(journeyRoute.steps, colors)}
          />
          {screenState === 'preview' && (
            <AnimatedPressable style={styles.goButton} onPress={handleStartRoute}>
              <Text style={styles.goButtonText}>{t('journey.go')}</Text>
            </AnimatedPressable>
          )}
        </View>

        <DraggableSheet minHeight={SHEET_MIN_HEIGHT} maxHeight={SHEET_MAX_HEIGHT} bottomInset={insets.bottom}>
          <View style={styles.activeHeader}>
            <View style={styles.durationBlock}>
              <Text style={styles.duration}>{t('journey.total', { duration: journeyRoute.durationText })}</Text>
              {searchedDepartureTime && (
                <Text style={styles.durationTimes}>
                  {formatTimeRange(journeyRoute.steps, searchedDepartureTime, isKorean)}
                </Text>
              )}
              {fareEstimate && <Text style={styles.durationTimes}>{formatFareEstimate(fareEstimate, t)}</Text>}
            </View>
            {screenState === 'active' && (
              <Pressable style={styles.endButton} onPress={handleEndRoute} hitSlop={8}>
                <Text style={styles.endLink}>{t('journey.endRouteLink')}</Text>
              </Pressable>
            )}
          </View>
          {waitInfo && (
            <View style={styles.waitBanner}>
              <Ionicons name="time-outline" size={14} color={colors.primary} />
              <Text style={styles.waitBannerText}>
                {t('journey.waitFor', { minutes: waitInfo.minutes, line: waitInfo.lineName ?? '?' })}
              </Text>
            </View>
          )}
          {routeAlerts.length > 0 && (
            <View style={styles.alertsList}>
              {routeAlerts.map((alert) => (
                <View key={alert.id} style={styles.alertCard}>
                  <Text style={styles.alertHeader}>{alert.headerText}</Text>
                </View>
              ))}
            </View>
          )}
          <FlatList
            data={journeyRoute.steps}
            keyExtractor={(_, index) => String(index)}
            contentContainerStyle={styles.stepsList}
            extraData={[currentStepIndex, matchedPosition, legStops]}
            renderItem={({ item, index }) => (
              <StepRow
                step={item}
                color={getLegColor(journeyRoute.steps, index, colors)}
                isCurrent={screenState === 'active' && index === currentStepIndex}
                stops={legStops.get(index)}
                position={screenState === 'active' ? matchedPosition : undefined}
                onPress={() => setFocusStepAt({ index, requestedAt: Date.now() })}
              />
            )}
          />
        </DraggableSheet>
      </View>
    );
  }

  return (
    <View style={styles.formScreen}>
      {/* --- Journey Search Bar (continues from Home's) --- */}
      <View style={[styles.topBar, { paddingTop: insets.top + spacing.sm }]}>
        <BackButton />
        <Text style={styles.topBarTitle}>{t('journey.planAJourney')}</Text>
      </View>
      <ScrollView style={styles.container} contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
      <View style={styles.form}>
        {/* --- Editable Journey Endpoints --- */}
        <PlaceAutocompleteInput
          key={from ? `from-${from.label}` : 'from-empty'}
          placeholder={t('journey.from')}
          onSelect={(endpoint) => handleEndpointChange('from', endpoint)}
          onClear={() => setFrom(null)}
          onChooseOnMap={() =>
            navigation.navigate('ChooseOnMap', {
              mode: 'journey',
              pickingFor: 'from',
              currentFrom: from ?? undefined,
              currentTo: to ?? undefined,
              returnTo: 'JourneyPlanner',
            })
          }
          onOpenFavorites={() =>
            navigation.navigate('Favorites', {
              pickingFor: 'from',
              currentFrom: from ?? undefined,
              currentTo: to ?? undefined,
              returnTo: 'JourneyPlanner',
            })
          }
          initialEndpoint={from ?? undefined}
        />
        <PlaceAutocompleteInput
          key={to ? `to-${to.label}` : 'to-empty'}
          placeholder={t('journey.to')}
          onSelect={(endpoint) => handleEndpointChange('to', endpoint)}
          onClear={() => setTo(null)}
          onChooseOnMap={() =>
            navigation.navigate('ChooseOnMap', {
              mode: 'journey',
              pickingFor: 'to',
              currentFrom: from ?? undefined,
              currentTo: to ?? undefined,
              returnTo: 'JourneyPlanner',
            })
          }
          onOpenFavorites={() =>
            navigation.navigate('Favorites', {
              pickingFor: 'to',
              currentFrom: from ?? undefined,
              currentTo: to ?? undefined,
              returnTo: 'JourneyPlanner',
            })
          }
          initialEndpoint={to ?? undefined}
        />
        <DepartureTimePicker value={departureTime} onChange={setDepartureTime} />
        <AnimatedPressable
          style={[styles.searchButton, (!from || !to) && styles.searchButtonDisabled]}
          onPress={handleSearch}
          disabled={!from || !to}
        >
          <Text style={styles.searchButtonText}>{t('journey.getDirections')}</Text>
        </AnimatedPressable>
      </View>

      {loading && <ActivityIndicator style={styles.loader} color={colors.primary} />}
      {!!error && <Text style={styles.error}>{error}</Text>}

      {routeOptions.length > 0 && (
        <View style={styles.tripsList}>
          <Text style={styles.sectionLabel}>{t('journey.routeOptions')}</Text>
          {routeOptions.map((option, index) => (
            <AnimatedPressable key={index} scaleTo={0.98} style={styles.optionRow} onPress={() => handleChooseRoute(option)}>
              <View style={styles.optionMain}>
                <Text style={styles.optionDuration}>{option.durationText}</Text>
                {searchedDepartureTime && (
                  <Text style={styles.optionTimes}>
                    {formatTimeRange(option.steps, searchedDepartureTime, isKorean)}
                  </Text>
                )}
                <RouteLineBadges steps={option.steps} />
                <Text style={styles.optionWalk}>{option.walkSummary}</Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
            </AnimatedPressable>
          ))}
        </View>
      )}

      <View style={styles.tripsList}>
        {favoriteTrips.length > 0 && <Text style={styles.sectionLabel}>{t('common.favouriteTrips')}</Text>}
        {favoriteTrips.map((trip) => (
          <TripRow
            key={trip.id}
            from={trip.from}
            to={trip.to}
            isFavorite
            onPress={() => handleRunTrip(trip.from, trip.to)}
            onToggleFavorite={() => toggleFavoriteTrip(trip.from, trip.to)}
          />
        ))}
        {recentTrips.length > 0 && <Text style={styles.sectionLabel}>{t('common.recentTrips')}</Text>}
        {recentTrips.map((trip, index) => (
          <TripRow
            key={index}
            from={trip.from}
            to={trip.to}
            isFavorite={isFavoriteTrip(trip.from, trip.to)}
            onPress={() => handleRunTrip(trip.from, trip.to)}
            onToggleFavorite={() => toggleFavoriteTrip(trip.from, trip.to)}
            onDelete={() => removeRecentTrip(trip.from, trip.to)}
          />
        ))}
      </View>
      </ScrollView>
    </View>
  );
}

function RouteLineBadges({ steps }: { steps: TransitStep[] }) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const t = useTranslation();
  const transitSteps = steps.map((step, index) => ({ step, index })).filter(({ step }) => step.kind === 'transit');

  if (transitSteps.length === 0) {
    return <Text style={styles.optionDetail}>{t('journey.walkingOnly')}</Text>;
  }

  return (
    <View style={styles.lineBadgeRow}>
      {transitSteps.map(({ step, index }, i) => (
        <React.Fragment key={index}>
          {i > 0 && <Ionicons name="arrow-forward" size={11} color={colors.textMuted} />}
          <View style={[styles.lineBadge, { backgroundColor: getLegColor(steps, index, colors) }]}>
            <Text style={styles.lineBadgeText} numberOfLines={1}>
              {step.lineName ?? '?'}
            </Text>
          </View>
        </React.Fragment>
      ))}
    </View>
  );
}

// A rider must be within this of a leg's path for the stop list to trust it as "on this leg" —
// looser than the step-matching threshold, since the leg's path is Google's own polyline and
// AT's stops sit beside the road rather than on it.
const STOP_LIST_ON_ROUTE_METERS = 150;

function StepRow({
  step,
  color,
  isCurrent,
  stops,
  position,
  onPress,
}: {
  step: TransitStep;
  color: string;
  isCurrent: boolean;
  // Every stop this leg passes through, when they could be resolved (see useLegStops).
  stops?: Stop[];
  // The rider's live position, only while a journey is active.
  position?: LatLon;
  onPress: () => void;
}) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const t = useTranslation();
  const rowStyle = [styles.stepRow, isCurrent && styles.stepRowCurrent];
  // undefined = follow whether this is the current leg (the current one opens itself, the
  // others stay folded); once tapped it holds the rider's own choice.
  const [stopsOpen, setStopsOpen] = useState<boolean | undefined>(undefined);
  const legPoints = useMemo(
    () => (step.kind === 'transit' && step.encodedPolyline ? decodePolyline(step.encodedPolyline) : []),
    [step]
  );
  const showStops = step.kind === 'transit' && !!stops && stops.length >= 2;
  const isOpen = stopsOpen ?? isCurrent;
  const progress = useMemo(() => {
    if (!isCurrent || !isOpen || !position || !stops || stops.length < 2) return null;
    const result = computeLegProgress(legPoints, stops, position);
    return result && result.offRouteMeters <= STOP_LIST_ON_ROUTE_METERS ? result : null;
  }, [isCurrent, isOpen, position, stops, legPoints]);

  if (step.kind === 'walk') {
    return (
      <Pressable style={rowStyle} onPress={onPress}>
        <Text style={styles.walkIcon}>🚶</Text>
        <View style={styles.stepDetails}>
          <Text style={styles.stepText}>{step.instruction}</Text>
          {!!step.durationText && <Text style={styles.stepSubtext}>{step.durationText}</Text>}
        </View>
      </Pressable>
    );
  }

  return (
    <View style={[styles.stepBlock, isCurrent && styles.stepRowCurrent]}>
      <Pressable style={styles.stepRow} onPress={onPress}>
        <View style={[styles.transitBadge, { backgroundColor: color }]}>
          <Text style={styles.transitBadgeText} numberOfLines={1}>
            {step.lineName ?? '?'}
          </Text>
        </View>
        <View style={styles.stepDetails}>
          <Text style={styles.stepText}>{step.instruction}</Text>
          <Text style={styles.stepSubtext}>
            {step.departureTime} → {step.arrivalTime}
            {step.numStops !== undefined ? ` · ${t('journey.numStops', { count: step.numStops })}` : ''}
          </Text>
        </View>
      </Pressable>
      {showStops && stops && (
        <>
          <Pressable style={styles.stopsToggle} onPress={() => setStopsOpen(!isOpen)} hitSlop={6}>
            <Text style={[styles.stopsToggleText, { color }]}>{t('journey.numStops', { count: stops.length - 1 })}</Text>
            <Ionicons name={isOpen ? 'chevron-up' : 'chevron-down'} size={14} color={color} />
          </Pressable>
          {isOpen && <LegStopList stops={stops} color={color} headsign={step.headsign} progress={progress} />}
        </>
      )}
    </View>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  formScreen: { flex: 1, backgroundColor: colors.background },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.md,
    backgroundColor: colors.surface,
  },
  topBarTitle: { fontSize: 18, fontWeight: '700', color: colors.text },
  scrollContent: { paddingBottom: spacing.xl },
  form: { padding: spacing.lg },
  tripsList: { paddingHorizontal: spacing.lg, gap: spacing.sm },
  optionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    gap: spacing.sm,
  },
  optionMain: { flex: 1 },
  optionDuration: { color: colors.text, fontSize: 16, fontWeight: '700' },
  optionTimes: { color: colors.textMuted, fontSize: 12, marginTop: 1 },
  optionDetail: { color: colors.text, fontSize: 13, marginTop: 2 },
  optionWalk: { color: colors.textMuted, fontSize: 12, marginTop: 2 },
  lineBadgeRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 4, marginTop: 4 },
  lineBadge: {
    minWidth: 28,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radius.sm,
    alignItems: 'center',
  },
  lineBadgeText: { color: '#FFFFFF', fontWeight: '700', fontSize: 11 },
  sectionLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.textMuted,
    textTransform: 'uppercase',
    marginTop: spacing.sm,
    marginBottom: spacing.xs,
  },
  searchButton: {
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    paddingVertical: spacing.sm,
    alignItems: 'center',
    marginTop: spacing.xs,
  },
  searchButtonDisabled: { opacity: 0.5 },
  searchButtonText: { color: '#FFFFFF', fontWeight: '700' },
  loader: { marginTop: spacing.lg },
  error: { color: colors.danger, textAlign: 'center', marginTop: spacing.lg, paddingHorizontal: spacing.lg },
  mapArea: { flex: 1 },
  goButton: {
    position: 'absolute',
    right: spacing.lg,
    bottom: spacing.lg,
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: colors.success,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 5,
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 5,
    shadowOffset: { width: 0, height: 2 },
  },
  goButtonText: { color: '#FFFFFF', fontWeight: '700', fontSize: 18 },
  activeHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm,
  },
  durationBlock: {},
  duration: { fontWeight: '700', color: colors.text },
  durationTimes: { color: colors.textMuted, fontSize: 12, marginTop: 2 },
  waitBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginHorizontal: spacing.lg,
    marginBottom: spacing.sm,
    backgroundColor: colors.primaryMuted,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  waitBannerText: { color: colors.primary, fontWeight: '600', fontSize: 12 },
  endButton: {
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.sm,
    backgroundColor: colors.dangerMuted,
    borderRadius: radius.sm,
  },
  endLink: { color: colors.danger, fontWeight: '700' },
  alertsList: { paddingHorizontal: spacing.lg, gap: spacing.xs, paddingBottom: spacing.sm },
  alertCard: {
    backgroundColor: colors.dangerMuted,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.danger,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  alertHeader: { color: colors.danger, fontWeight: '700', fontSize: 12 },
  stepsList: { paddingHorizontal: spacing.lg, gap: spacing.sm, paddingBottom: spacing.lg },
  stepRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    alignItems: 'flex-start',
    padding: spacing.xs,
    borderRadius: radius.sm,
  },
  stepRowCurrent: { backgroundColor: colors.primaryMuted },
  // Wraps a transit step's row together with its stop list, so the current-leg highlight
  // covers both rather than just the top row.
  stepBlock: { borderRadius: radius.sm, paddingBottom: spacing.xs },
  stopsToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    alignSelf: 'flex-start',
    marginLeft: 32 + spacing.sm + spacing.xs,
    paddingVertical: 2,
  },
  stopsToggleText: { fontSize: 12, fontWeight: '700' },
  walkIcon: { fontSize: 20, width: 32, textAlign: 'center' },
  stepDetails: { flex: 1 },
  transitBadge: {
    minWidth: 32,
    paddingHorizontal: spacing.xs,
    paddingVertical: 4,
    borderRadius: radius.sm,
    alignItems: 'center',
  },
  transitBadgeText: { color: '#FFFFFF', fontWeight: '700', fontSize: 12 },
  stepText: { color: colors.text, fontSize: 14, fontWeight: '600' },
  stepSubtext: { color: colors.textMuted, fontSize: 12, marginTop: 2 },
  });
}
