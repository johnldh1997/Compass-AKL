import { MaterialIcons } from '@expo/vector-icons';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import MapView, { Marker, Polyline } from 'react-native-maps';
import { useThemeColors, useThemeScheme } from '../context/ThemeContext';
import { useTranslation } from '../i18n/useTranslation';
import { useCountdown } from '../hooks/useCountdown';
import { useFollowCamera } from '../hooks/useFollowCamera';
import { useLegStops } from '../hooks/useLegStops';
import { useWalkHeading } from '../hooks/useWalkHeading';
import { darkMapStyle, lightMapStyle, MY_LOCATION_ZOOM_DELTA } from '../mapStyle';
import { decodePolyline } from '../services/directions';
import { getStopById, getTripHeadsign } from '../services/gtfs';
import { getLegColor } from '../services/legColors';
import { getCurrentCoordinates } from '../services/location';
import { getNextStopForTrip, NextStopInfo } from '../services/realtime';
import { radius, spacing } from '../theme';
import { Stop, TransitStep, TransportMode, VehiclePosition } from '../types';
import HeadingArrowBadge, { bearingBucket } from './HeadingArrowBadge';
import LocateButton from './LocateButton';
import StableMarker from './StableMarker';
import StopBadge, { STOP_BADGE_SIZE } from './StopBadge';

// Matches the parent's own live-vehicle poll cadence (JourneyPlannerScreen's
// LIVE_VEHICLE_POLL_MS) — no need to import it directly, just stay consistent so a
// selected vehicle's next-stop info doesn't go stale slower or faster than the dots move.
const NEXT_STOP_POLL_MS = 15_000;

function minutesUntil(iso: string): number {
  if (!iso) return 0;
  return Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 60_000));
}

// Fallback center if a route somehow has no decodable points — without this, a MapView
// with no initialRegion at all defaults to the native SDK's (0,0), which renders in the
// ocean off the coast of Africa until fitToCoordinates (an imperative, post-mount call)
// has a chance to run. Setting initialRegion up front means it never starts there.
const AUCKLAND_CENTER = { latitude: -36.8485, longitude: 174.7633 };

// The bus-icon bitmap (see markerIcon.ts) is a plain square glyph, not a teardrop pin — the
// native default anchor (bottom-center) would leave it floating above the real coordinate
// instead of centered on it. A stable module-level reference, same reasoning as VehicleMap.tsx.
const CENTER_ANCHOR = { x: 0.5, y: 0.5 };

// The live-vehicle badge is a circle (styles.liveVehicleBadge) — its heading arrowhead sits a
// steady distance off that circle's edge, in the same colour as its ring.
const BADGE_SIZE = 34;
const LIVE_VEHICLE_BADGE = { width: BADGE_SIZE, height: BADGE_SIZE, round: true };

// Stops only get their full labelled badge once the map is zoomed in this far — wider than that,
// a route's stops are drawn as small icon markers, since full badges overlap into a blob along the line
// (and badly in the CBD, where stops are only a few metres apart).
const STOP_BADGE_MAX_DELTA = 0.01;

interface Props {
  encodedPolyline: string;
  steps: TransitStep[];
  currentPosition?: { latitude: number; longitude: number };
  // Bumped (e.g. Date.now()) whenever the map should snap to the user's live position —
  // used when a route is started, rather than re-centering on every position update.
  focusOnUserAt?: number;
  // Set whenever the steps list wants the map to snap to a specific step's own segment —
  // requestedAt (not just the index) so tapping the same step twice in a row still re-fires.
  focusStep?: { index: number; requestedAt: number };
  // Every live vehicle currently running on any of the journey's transit lines (see
  // liveVehicleMatch.ts) — not narrowed to a single guessed vehicle, since Google's
  // transit data and AT's realtime feed share no common trip ID to confirm one.
  liveVehicles?: VehiclePosition[];
  // When liveVehicles last actually refreshed (the parent's own poll) — threaded down to
  // SelectedVehicleInfo so its "Updates in Ns" describes the same poll that actually moves
  // the marker on the map, not an independent, out-of-phase timer of its own.
  liveVehiclesUpdatedAt?: number;
  // Each line's own color (matching its polyline/step-list badge), keyed by route short name.
  lineColors?: Map<string, string>;
  // True during a journey under way (not the preview before it starts): the camera follows you, and on a
  // walking leg turns to face the way you're going.
  followUser?: boolean;
  // Which step you're on — a walking step makes the map face your direction of travel.
  currentStepIndex?: number;
  // Your phone's reported heading (degrees, 0 = north) and speed (m/s) when it has them.
  userHeading?: number | null;
  userSpeedMps?: number | null;
  // The bus you're riding, once the app has worked out which one it is. From then on the map shows just that
  // bus, at your own GPS position (the feed's position for it runs seconds behind), and hides the others —
  // they were only there to show whether your bus was coming.
  boardedVehicle?: VehiclePosition | null;
}

export default function RoutePreviewMap({
  encodedPolyline,
  steps,
  currentPosition,
  focusOnUserAt,
  focusStep,
  liveVehicles = [],
  liveVehiclesUpdatedAt = Date.now(),
  lineColors,
  followUser = false,
  currentStepIndex,
  userHeading = null,
  userSpeedMps = null,
  boardedVehicle = null,
}: Props) {
  const colors = useThemeColors();
  const isDark = useThemeScheme() === 'dark';
  const t = useTranslation();
  const mapRef = useRef<MapView>(null);
  const lastFocusRequestRef = useRef<number | undefined>(undefined);
  const lastStepFocusRequestRef = useRef<number | undefined>(undefined);
  const points = decodePolyline(encodedPolyline);
  const legStops = useLegStops(steps);
  const [selectedVehicleId, setSelectedVehicleId] = useState<string | null>(null);
  // Starts false: a route opens fitted to its whole length, which is almost always zoomed out.
  const [zoomedInOnStops, setZoomedInOnStops] = useState(false);
  const [mapReady, setMapReady] = useState(false);
  // The bus you're on shows its info card on its own; closing it keeps it closed for that bus.
  const [dismissedBoardedId, setDismissedBoardedId] = useState<string | null>(null);
  const showBoardedCard = !!boardedVehicle && dismissedBoardedId !== boardedVehicle.vehicleId;
  const selectedVehicle = showBoardedCard
    ? boardedVehicle
    : liveVehicles.find((v) => v.vehicleId === selectedVehicleId) ?? null;

  // --- Follow You, Facing Your Way ---
  // On a walking leg the map turns to face the way you're walking, so a left turn on the route is to the left
  // of the screen. On any other leg it stays north-up and just follows you.
  const currentStep = currentStepIndex === undefined ? undefined : steps[currentStepIndex];
  const walkPath = useMemo(
    () => (currentStep?.kind === 'walk' && currentStep.encodedPolyline ? decodePolyline(currentStep.encodedPolyline) : []),
    [currentStep]
  );
  const userPosition = currentPosition ?? null;
  const walkHeading = useWalkHeading({
    enabled: followUser && currentStep?.kind === 'walk',
    path: walkPath,
    position: userPosition,
    gpsHeading: userHeading,
    speedMps: userSpeedMps,
  });
  const follow = useFollowCamera({ mapRef, mapReady, enabled: followUser, position: userPosition, heading: walkHeading });

  useEffect(() => {
    if (points.length > 1) {
      // Snap instantly rather than animating the pan/zoom, so the whole highlighted
      // route is visible the moment it's chosen instead of a moment later.
      mapRef.current?.fitToCoordinates(points, {
        edgePadding: { top: 60, right: 60, bottom: 60, left: 60 },
        animated: false,
      });
    }
    // Only re-fit when the route itself changes, not on every live position update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [encodedPolyline]);

  useEffect(() => {
    // A native map silently ignores camera moves until it is ready, and this request is only marked handled once
    // it has been made — so wait for onMapReady, or a journey resumed after a restart stayed at the route-wide zoom.
    if (!mapReady) return;
    if (focusOnUserAt !== undefined && focusOnUserAt !== lastFocusRequestRef.current && currentPosition) {
      mapRef.current?.animateToRegion(
        { ...currentPosition, latitudeDelta: MY_LOCATION_ZOOM_DELTA, longitudeDelta: MY_LOCATION_ZOOM_DELTA },
        500
      );
      lastFocusRequestRef.current = focusOnUserAt;
    }
  }, [focusOnUserAt, currentPosition, mapReady]);

  useEffect(() => {
    if (!focusStep || focusStep.requestedAt === lastStepFocusRequestRef.current) return;
    lastStepFocusRequestRef.current = focusStep.requestedAt;
    const step = steps[focusStep.index];
    if (!step) return;
    follow.disengage();
    const stepPoints = step.encodedPolyline ? decodePolyline(step.encodedPolyline) : [];
    if (stepPoints.length > 1) {
      mapRef.current?.fitToCoordinates(stepPoints, {
        edgePadding: { top: 80, right: 80, bottom: 80, left: 80 },
        animated: true,
      });
    }
  }, [focusStep, steps]);

  async function handleLocate() {
    follow.engage();
    const coords = currentPosition ?? (await getCurrentCoordinates({ askToTurnOnLocation: true })) ?? undefined;
    if (!coords) {
      Alert.alert(t('map.locationUnavailableTitle'), t('map.locationUnavailableMessage'));
      return;
    }
    mapRef.current?.animateToRegion(
      { ...coords, latitudeDelta: MY_LOCATION_ZOOM_DELTA, longitudeDelta: MY_LOCATION_ZOOM_DELTA },
      500
    );
  }

  const start = points[0];
  const end = points[points.length - 1];
  const initialRegion = { ...(start ?? AUCKLAND_CENTER), latitudeDelta: 0.05, longitudeDelta: 0.05 };

  // These stops never move once fetched — pre-computing each one's coordinate here means
  // it's only recreated when the route itself changes, not on every re-render this
  // component gets from the parent's 15s live-vehicle poll (see the identical reasoning
  // for stopMarkers in VehicleMap.tsx).
  const legStopMarkers = useMemo(() => {
    const markers: {
      key: string;
      stop: Stop;
      coordinate: { latitude: number; longitude: number };
      color: string;
      mode: TransportMode;
    }[] = [];
    legStops.forEach((stopsForLeg, index) => {
      const color = getLegColor(steps, index, colors);
      const mode = steps[index]?.mode ?? 'bus';
      stopsForLeg.forEach((stop) => {
        markers.push({ key: `${index}-${stop.id}`, stop, coordinate: { latitude: stop.lat, longitude: stop.lon }, color, mode });
      });
    });
    return markers;
  }, [legStops, steps, colors]);

  return (
    <View style={styles.container}>
      <MapView
        ref={mapRef}
        style={StyleSheet.absoluteFill}
        initialRegion={initialRegion}
        // The blue dot gives way to the bus marker once you're on a bus: that marker sits at your position.
        showsUserLocation={!(boardedVehicle && currentPosition)}
        showsMyLocationButton={false}
        toolbarEnabled={false}
        customMapStyle={isDark ? darkMapStyle : lightMapStyle}
        onMapReady={() => setMapReady(true)}
        onPanDrag={follow.disengage}
        onRegionChangeComplete={(region) => setZoomedInOnStops(region.latitudeDelta <= STOP_BADGE_MAX_DELTA)}
      >
        {steps.map((step, index) => {
          const segmentPoints = step.encodedPolyline ? decodePolyline(step.encodedPolyline) : [];
          if (segmentPoints.length < 2) return null;
          const color = getLegColor(steps, index, colors);
          return (
            <Polyline
              key={index}
              coordinates={segmentPoints}
              strokeColor={color}
              strokeWidth={step.kind === 'walk' ? 3 : 5}
              lineDashPattern={step.kind === 'walk' ? [8, 6] : undefined}
            />
          );
        })}
        {/* zIndex keeps stops above the route polylines (a separate overlay layer, always
            beneath markers) but below the live vehicles rendered after them. */}
        {legStopMarkers.map(({ key, stop, coordinate, color, mode }) => (
          <StableMarker
            key={key}
            coordinate={coordinate}
            anchor={CENTER_ANCHOR}
            zIndex={1}
            title={stop.name}
            // The marker's native bitmap is frozen once it's drawn, so switching between the
            // dot and the full badge needs a fresh snapshot (see StableMarker's snapshotKey).
            snapshotKey={zoomedInOnStops ? 'badge' : 'dot'}
          >
            <StopBadge
              size={STOP_BADGE_SIZE}
              color={color}
              mode={mode}
              label={t('map.stopLabel')}
              compact={!zoomedInOnStops}
            />
          </StableMarker>
        ))}
        {start && <Marker coordinate={start} pinColor={colors.success} title={t('map.start')} />}
        {end && <Marker coordinate={end} pinColor={colors.danger} title={t('map.destination')} />}
        {/* Once you're on a bus the others are hidden — they were there to show whether yours was coming.
            Yours is drawn at your own position, solid so it reads as "you", facing your direction of travel. */}
        {boardedVehicle && currentPosition && (
          <BoardedBusMarker
            position={currentPosition}
            color={(boardedVehicle.routeShortName && lineColors?.get(boardedVehicle.routeShortName)) || colors.primary}
            bearing={userSpeedMps !== null && userSpeedMps >= 1 && userHeading !== null ? userHeading : boardedVehicle.bearing}
            title={boardedVehicle.routeShortName ?? t('common.vehicle')}
            onPress={() => setDismissedBoardedId(null)}
          />
        )}
        {(boardedVehicle && currentPosition ? [] : liveVehicles).map((vehicle) => {
          const color = (vehicle.routeShortName && lineColors?.get(vehicle.routeShortName)) || colors.primary;
          return (
            <StableMarker
              key={vehicle.vehicleId}
              coordinate={{ latitude: vehicle.lat, longitude: vehicle.lon }}
              title={vehicle.routeShortName ?? t('common.vehicle')}
              // Centered so the heading arrow orbits the vehicle's true position.
              anchor={CENTER_ANCHOR}
              zIndex={2}
              snapshotKey={bearingBucket(vehicle.bearing)}
              onPress={() => setSelectedVehicleId((current) => (current === vehicle.vehicleId ? null : vehicle.vehicleId))}
            >
              <HeadingArrowBadge bearing={vehicle.bearing} arrowColor={color} badge={LIVE_VEHICLE_BADGE}>
                <View style={[styles.liveVehicleBadge, { borderColor: color }]}>
                  <MaterialIcons name="directions-bus" size={19} color={color} />
                </View>
              </HeadingArrowBadge>
            </StableMarker>
          );
        })}
      </MapView>
      <LocateButton onPress={handleLocate} following={followUser && follow.following} style={styles.locateButton} />
      {selectedVehicle && (
        <SelectedVehicleInfo
          vehicle={selectedVehicle}
          onBoard={showBoardedCard}
          onClose={() => {
            if (showBoardedCard && boardedVehicle) setDismissedBoardedId(boardedVehicle.vehicleId);
            else setSelectedVehicleId(null);
          }}
          liveVehiclesUpdatedAt={liveVehiclesUpdatedAt}
        />
      )}
    </View>
  );
}

// The bus you're riding, drawn at your own position. A solid, filled circle (the other buses are white with a
// coloured ring), so it reads as "this is you, on this bus" and can't be mistaken for a bus you're waiting for.
function BoardedBusMarker({
  position,
  color,
  bearing,
  title,
  onPress,
}: {
  position: { latitude: number; longitude: number };
  color: string;
  bearing: number | undefined;
  title: string;
  onPress: () => void;
}) {
  return (
    <StableMarker
      coordinate={position}
      title={title}
      anchor={CENTER_ANCHOR}
      zIndex={3}
      snapshotKey={`${color}-${bearingBucket(bearing)}`}
      onPress={onPress}
    >
      <HeadingArrowBadge bearing={bearing} arrowColor={color} badge={LIVE_VEHICLE_BADGE}>
        <View style={[styles.boardedBadge, { backgroundColor: color }]}>
          <MaterialIcons name="directions-bus" size={19} color="#FFFFFF" />
        </View>
      </HeadingArrowBadge>
    </StableMarker>
  );
}

// Isolated in its own component so its 15s next-stop poll only re-renders this small info
// card, not the whole RoutePreviewMap (which would otherwise re-render the MapView and
// every marker on it too) — the same reasoning as VehicleMap.tsx's NextStopStatus.
function SelectedVehicleInfo({
  vehicle,
  onBoard = false,
  onClose,
  liveVehiclesUpdatedAt,
}: {
  vehicle: VehiclePosition;
  // True when this is the bus you're riding rather than one you tapped.
  onBoard?: boolean;
  onClose: () => void;
  liveVehiclesUpdatedAt: number;
}) {
  const colors = useThemeColors();
  const t = useTranslation();
  const [headsign, setHeadsign] = useState('');
  const [nextStop, setNextStop] = useState<(NextStopInfo & { stopName: string }) | null>(null);
  const secondsLeft = useCountdown(NEXT_STOP_POLL_MS, liveVehiclesUpdatedAt);

  useEffect(() => {
    const tripId = vehicle.tripId;
    if (!tripId) {
      setHeadsign('');
      setNextStop(null);
      return;
    }

    let cancelled = false;
    getTripHeadsign(tripId).then((h) => {
      if (!cancelled) setHeadsign(h);
    });

    function load() {
      getNextStopForTrip(tripId as string)
        .then(async (info) => {
          if (cancelled) return;
          if (!info) {
            setNextStop(null);
            return;
          }
          const stop = await getStopById(info.stopId);
          if (!cancelled) setNextStop({ ...info, stopName: stop?.name ?? t('common.unknownStop') });
        })
        .catch(() => {
          if (!cancelled) setNextStop(null);
        });
    }

    load();
    const interval = setInterval(load, NEXT_STOP_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [vehicle.tripId]);

  return (
    <View style={[styles.infoCard, { backgroundColor: colors.surface, borderColor: colors.primary }]}>
      {onBoard && <Text style={[styles.infoOnBoard, { color: colors.primary }]}>{t('map.onThisBus')}</Text>}
      <Text style={[styles.infoRoute, { color: colors.text }]}>{vehicle.routeShortName ?? t('common.vehicle')}</Text>
      {headsign ? <Text style={[styles.infoHeadsign, { color: colors.textMuted }]}>{headsign}</Text> : null}
      {nextStop && (
        <>
          <Text style={[styles.infoNextStopLabel, { color: colors.text }]}>
            {t('map.nextStop', { name: nextStop.stopName })}
          </Text>
          {nextStop.cancelled ? (
            <Text style={[styles.infoStatus, { color: colors.danger, fontWeight: '700' }]}>{t('departure.cancelled')}</Text>
          ) : nextStop.delayMinutes > 0 ? (
            <Text style={[styles.infoStatus, { color: colors.danger }]}>
              {t('map.delayedEta', { minutes: nextStop.delayMinutes, eta: minutesUntil(nextStop.etaIso) })}
            </Text>
          ) : (
            <Text style={[styles.infoStatus, { color: colors.success }]}>
              {t('map.onTimeEta', { eta: minutesUntil(nextStop.etaIso) })}
            </Text>
          )}
        </>
      )}
      <Text style={[styles.infoUpdatesIn, { color: colors.textMuted }]}>{t('map.updatesIn', { seconds: secondsLeft })}</Text>
      <Pressable onPress={onClose}>
        <Text style={[styles.infoClear, { color: colors.accent }]}>{t('common.close')}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  liveVehicleBadge: {
    width: BADGE_SIZE,
    height: BADGE_SIZE,
    borderRadius: BADGE_SIZE / 2,
    backgroundColor: '#FFFFFF',
    borderWidth: 3,
    alignItems: 'center',
    justifyContent: 'center',
  },
  locateButton: {
    position: 'absolute',
    right: spacing.md,
    bottom: spacing.md,
  },
  infoCard: {
    position: 'absolute',
    bottom: spacing.sm,
    left: spacing.sm,
    right: spacing.sm,
    borderRadius: radius.md,
    padding: spacing.md,
    borderWidth: 2,
    elevation: 8,
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
  },
  infoOnBoard: { fontSize: 11, fontWeight: '700', textTransform: 'uppercase', marginBottom: 2 },
  boardedBadge: {
    width: BADGE_SIZE,
    height: BADGE_SIZE,
    borderRadius: BADGE_SIZE / 2,
    borderWidth: 3,
    borderColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  infoRoute: { fontWeight: '700' },
  infoHeadsign: { fontSize: 12, marginTop: 2 },
  infoNextStopLabel: { fontSize: 13, fontWeight: '600', marginTop: spacing.xs },
  infoStatus: { fontSize: 12, marginTop: 2 },
  infoUpdatesIn: { fontSize: 11, marginTop: 2 },
  infoClear: { fontWeight: '600', fontSize: 12, marginTop: spacing.xs },
});
