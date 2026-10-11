import { MaterialIcons } from '@expo/vector-icons';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import MapView, { Polyline, Region } from 'react-native-maps';
import { useCountdown } from '../hooks/useCountdown';
import { getStopById, getStopsInBounds, getTripHeadsign } from '../services/gtfs';
import { getShapeForTrip } from '../services/gtfsStatic';
import { getCurrentCoordinates, getFastCoordinates } from '../services/location';
import { getNextStopForTrip, NextStopInfo } from '../services/realtime';
import { MODE_ICON } from '../services/markerIcon';
import { getVehiclePositions } from '../services/vehicles';
import { useSettings } from '../context/SettingsContext';
import { useThemeColors, useThemeScheme } from '../context/ThemeContext';
import { useTranslation } from '../i18n/useTranslation';
import { darkMapStyle, lightMapStyle, MY_LOCATION_ZOOM_DELTA } from '../mapStyle';
import { spacing } from '../theme';
import { Stop, VehiclePosition } from '../types';
import HeadingArrowBadge, { bearingBucket } from './HeadingArrowBadge';
import LocateButton from './LocateButton';
import StableMarker from './StableMarker';
import StopBadge, { STOP_BADGE_SIZE } from './StopBadge';
import { createStyles } from './VehicleMap.styles';

// AT's realtime feed itself updates roughly every 30s server-side; polling at 15s just
// picks those updates up sooner on average without hammering the weekly request quota.
const POLL_INTERVAL_MS = 15_000;

// Stop markers only render at close zoom — any wider and dozens-to-hundreds of stops
// would bury the vehicles.
const STOP_MARKER_MAX_DELTA = 0.02;

// Vehicles only render once zoomed in past a city-wide view — at the default zoomed-out
// region (delta ~0.06) there can be 1000+ vehicles at once, covering the whole map.
const VEHICLE_MARKER_MAX_DELTA = 0.04;

const DEFAULT_REGION: Region = {
  latitude: -36.8485,
  longitude: 174.7633,
  latitudeDelta: 0.06,
  longitudeDelta: 0.06,
};

const LOCATION_TIMEOUT_MS = 5_000;

// Size and corner radius of a vehicle's badge — must match styles.dot in VehicleMap.styles.ts
// (which is fixed at exactly this size) so HeadingArrowBadge can keep its heading arrowhead a
// steady distance from the badge's edge at every angle.
const VEHICLE_BADGE = { width: 40, height: 38, radius: 8 };

// Stops are drawn as small ring dots until the map is zoomed in this tight, then as the full
// labelled badge. Even the default "my location" zoom (MY_LOCATION_ZOOM_DELTA, 0.005) is crowded
// enough in the CBD that labelled badges collapse into each other, so the badge waits for a
// closer look than that.
const STOP_BADGE_MAX_DELTA = 0.003;

// The bus-icon bitmap (see markerIcon.ts) is a plain square glyph, not a teardrop pin — the
// native default anchor (bottom-center, correct for a pin whose tip touches the ground) would
// leave a square icon floating above the real coordinate instead of centered on it. A stable
// module-level object (not a fresh `{ x: 0.5, y: 0.5 }` literal per render) for the same reason
// customMapStyle/coordinate/anchor references elsewhere in this file need to stay stable.
const CENTER_ANCHOR = { x: 0.5, y: 0.5 };

// A stable, never-recreated empty array for the selected-route Polyline's `coordinates`
// when nothing is selected — see EMPTY_SHAPE's usage below for why the Polyline itself
// stays permanently mounted instead of being conditionally rendered.
const EMPTY_SHAPE: { latitude: number; longitude: number }[] = [];

// How close two markers' actual on-screen positions need to be (in points) to count as
// overlapping enough that tapping one is ambiguous with the other, rather than each being
// cleanly, independently tappable.
const COLLISION_SCREEN_DISTANCE = 40;

// Finds which of `candidates` actually render close enough on screen to the tapped
// coordinate to be a real tap ambiguity — reported live: tapping a stop or vehicle when
// they visually overlap sometimes hit the other one instead, and which one the user meant
// varies (sometimes the stop, sometimes the bus), so this surfaces both as options instead
// of guessing. Pre-filters by raw lat/lon distance first (scaled to the current region, so
// it stays cheap at any zoom) before paying for the async pointForCoordinate() screen-space
// check on only the few candidates actually worth checking.
async function findScreenCollisions<T>(
  map: MapView,
  region: Region,
  tapped: { latitude: number; longitude: number },
  candidates: { point: { latitude: number; longitude: number }; payload: T }[]
): Promise<T[]> {
  const coarseDegrees = Math.max(region.latitudeDelta, region.longitudeDelta) * 0.15;
  const coarse = candidates.filter(
    (c) =>
      Math.abs(c.point.latitude - tapped.latitude) < coarseDegrees &&
      Math.abs(c.point.longitude - tapped.longitude) < coarseDegrees
  );
  if (coarse.length === 0) return [];

  const tappedScreen = await map.pointForCoordinate(tapped);
  const hits: T[] = [];
  for (const candidate of coarse) {
    const screen = await map.pointForCoordinate(candidate.point);
    if (Math.hypot(screen.x - tappedScreen.x, screen.y - tappedScreen.y) <= COLLISION_SCREEN_DISTANCE) {
      hits.push(candidate.payload);
    }
  }
  return hits;
}

function isInRegion(vehicle: VehiclePosition, region: Region): boolean {
  const latMin = region.latitude - region.latitudeDelta / 2;
  const latMax = region.latitude + region.latitudeDelta / 2;
  const lonMin = region.longitude - region.longitudeDelta / 2;
  const lonMax = region.longitude + region.longitudeDelta / 2;
  return vehicle.lat >= latMin && vehicle.lat <= latMax && vehicle.lon >= lonMin && vehicle.lon <= lonMax;
}

function minutesUntil(iso: string): number {
  if (!iso) return 0;
  return Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 60_000));
}

interface CollisionOption {
  key: string;
  label: string;
  icon: React.ComponentProps<typeof MaterialIcons>['name'];
  onSelect: () => void;
}

interface Props {
  onStopPress: (stop: Stop) => void;
  // Extra bottom spacing for the Locate button so it doesn't sit under the favourites
  // panel's collapsed peek.
  bottomInset?: number;
  // Lets the parent (e.g. hide the "Plan a Journey" button) react to a vehicle being
  // selected, since the info card and that button would otherwise overlap.
  onSelectedVehicleChange?: (hasSelection: boolean) => void;
  // Set (e.g. from Search Stops) when the map should snap to a specific stop's location —
  // requestedAt so picking the same stop again still re-triggers the camera move.
  focusStop?: { lat: number; lon: number; requestedAt: number };
}

export default function VehicleMap({ onStopPress, bottomInset = 0, onSelectedVehicleChange, focusStop }: Props) {
  const colors = useThemeColors();
  const isDark = useThemeScheme() === 'dark';
  const styles = useMemo(() => createStyles(colors), [colors]);
  const modeColor = useMemo(
    () => ({
      bus: colors.busLine,
      train: colors.trainLine,
      ferry: colors.ferryLine,
      unknown: colors.textMuted,
    }),
    [colors]
  );
  const mapRef = useRef<MapView>(null);
  // A non-null mapRef only means React has assigned the ref — react-native-maps' native map
  // (especially on Android) can still be mid-initialization at that point, and calling
  // animateToRegion before it's actually ready silently no-ops. onMapReady is the real
  // signal to wait for; reported live as "still having trouble" after an earlier fix that
  // only checked mapRef.current, which explains why the retry-once-ready logic below wasn't
  // actually catching every case.
  const [mapReady, setMapReady] = useState(false);
  // No region until the user's location resolves (or times out) — the map isn't
  // rendered until then, so it starts at the right place instead of jumping there.
  const [initialRegion, setInitialRegion] = useState<Region | null>(null);
  const [vehicles, setVehicles] = useState<VehiclePosition[]>([]);
  // When `vehicles` last actually refreshed — passed down so the info card's "Updates in
  // Ns" reflects this exact poll (the one that actually moves the marker on the map)
  // instead of ticking on its own independent, out-of-phase timer.
  const [vehiclesUpdatedAt, setVehiclesUpdatedAt] = useState(Date.now());
  const [stops, setStops] = useState<Stop[]>([]);
  const [region, setRegion] = useState<Region>(DEFAULT_REGION);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedHeadsign, setSelectedHeadsign] = useState('');
  const [selectedShape, setSelectedShape] = useState<{ latitude: number; longitude: number }[]>([]);
  // A marker's onPress and the underlying MapView's own onPress can both fire for the same
  // tap gesture (confirmed live: selecting a vehicle immediately reverted to unselected,
  // every time) — this flag lets the map's background-tap deselect handler recognize "a
  // marker just handled this" and skip its own deselect, instead of racing it.
  const markerPressedRef = useRef(false);
  // Options shown when a tap is ambiguous between a stop and a vehicle (see
  // findScreenCollisions below) — a custom overlay rather than the OS's Alert.alert:
  // reported live, tapping "Bus X" from the native Alert sometimes failed to highlight its
  // route. A custom overlay stays mounted (and blocks touches to the map underneath it) for
  // the whole time the choice is showing, unlike a native modal dialog whose dismiss timing
  // isn't fully under this app's control — removing that as a possible cause entirely.
  const [collisionOptions, setCollisionOptions] = useState<CollisionOption[] | null>(null);

  const { showLiveVehicles, vehicleModeFilters } = useSettings();
  const t = useTranslation();

  useEffect(() => {
    let done = false;

    const timeout = setTimeout(() => {
      if (!done) {
        done = true;
        setInitialRegion(DEFAULT_REGION);
      }
    }, LOCATION_TIMEOUT_MS);

    getFastCoordinates()
      .then((coords) => {
        if (!done) {
          done = true;
          clearTimeout(timeout);
          const start = coords
            ? { ...coords, latitudeDelta: MY_LOCATION_ZOOM_DELTA, longitudeDelta: MY_LOCATION_ZOOM_DELTA }
            : DEFAULT_REGION;
          setInitialRegion(start);
          setRegion(start);
        }
      })
      .catch(() => {
        if (!done) {
          done = true;
          clearTimeout(timeout);
          setInitialRegion(DEFAULT_REGION);
        }
      });

    return () => clearTimeout(timeout);
  }, []);

  function handleRegionChange(newRegion: Region) {
    setRegion(newRegion);
  }

  const lastStopFocusRequestRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!focusStop || focusStop.requestedAt === lastStopFocusRequestRef.current) return;
    // mapRef.current being non-null only means React has assigned the ref, not that the
    // native map has finished initializing (animateToRegion silently no-ops if called too
    // early, especially on Android) — mapReady (set from the MapView's own onMapReady) is
    // the real signal to wait for. Only mark this request "handled" once both are true;
    // mapReady is a dependency so this effect re-runs (and retries) the moment the map
    // actually becomes ready to receive it, rather than leaving the map wherever its own
    // initial GPS-based centering put it.
    if (!mapRef.current || !mapReady) return;
    lastStopFocusRequestRef.current = focusStop.requestedAt;
    mapRef.current.animateToRegion(
      {
        latitude: focusStop.lat,
        longitude: focusStop.lon,
        latitudeDelta: MY_LOCATION_ZOOM_DELTA,
        longitudeDelta: MY_LOCATION_ZOOM_DELTA,
      },
      500
    );
  }, [focusStop, initialRegion, mapReady]);

  useEffect(() => {
    if (!showLiveVehicles) {
      setVehicles([]);
      return;
    }
    let cancelled = false;
    function load() {
      getVehiclePositions().then((result) => {
        if (!cancelled) {
          setVehicles(result);
          setVehiclesUpdatedAt(Date.now());
        }
      });
    }
    load();
    const interval = setInterval(load, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [showLiveVehicles]);

  const stopsRequestId = useRef(0);

  useEffect(() => {
    if (region.latitudeDelta > STOP_MARKER_MAX_DELTA) {
      stopsRequestId.current += 1;
      setStops([]);
      return;
    }
    // Panning/zooming quickly can fire several of these before earlier ones resolve;
    // a stale response landing after a newer one previously overwrote it with
    // out-of-date (sometimes empty) results, which looked like stops "not appearing".
    const requestId = ++stopsRequestId.current;
    getStopsInBounds({
      latMin: region.latitude - region.latitudeDelta / 2,
      latMax: region.latitude + region.latitudeDelta / 2,
      lonMin: region.longitude - region.longitudeDelta / 2,
      lonMax: region.longitude + region.longitudeDelta / 2,
    }).then((result) => {
      if (stopsRequestId.current === requestId) setStops(result);
    });
  }, [region]);

  const selected = vehicles.find((v) => v.vehicleId === selectedId) ?? null;

  useEffect(() => {
    onSelectedVehicleChange?.(!!selected);
    // Only the presence/absence of a selection matters to the parent, not which vehicle —
    // re-notifying with the same boolean on every vehicle-poll refresh is harmless (React
    // bails out of re-rendering on an unchanged boolean state), so this doesn't need
    // onSelectedVehicleChange itself in the dependency array.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  useEffect(() => {
    let cancelled = false;
    if (selected?.tripId) {
      const tripId = selected.tripId;
      getTripHeadsign(tripId).then((headsign) => {
        if (!cancelled) setSelectedHeadsign(headsign);
      });
      // Best-effort: not every trip has a shape in the static feed, and the route this
      // shape belongs to is a general path for the line, not guaranteed to exactly match
      // this specific trip's stopping pattern. A failure here (e.g. first-use database
      // copy) should just mean no shape drawn, not break the info card.
      //
      // `cancelled` guards against switching vehicles quickly: tapping bus A then bus B
      // before A's fetch resolves previously let A's shape land *after* B's and overwrite
      // it, leaving the wrong route highlighted — reported live as "the route stays
      // highlighted and duplicates with the next bus".
      getShapeForTrip(tripId)
        .then((shape) => {
          if (cancelled) return;
          if (shape.length > 1) {
            // Reported live: re-selecting a vehicle (or picking a different one right
            // after) sometimes left the route not (re-)highlighted at all — some
            // react-native-maps/Android combinations don't reliably force a native
            // Polyline redraw when `coordinates` jumps straight from one non-empty array
            // to another. Clearing for one frame before setting the real shape forces two
            // distinct updates instead of a single one the native view can silently no-op,
            // the same class of native-view-staleness issue StableMarker.tsx already
            // guards against for markers.
            setSelectedShape([]);
            requestAnimationFrame(() => {
              if (!cancelled) setSelectedShape(shape);
            });
          } else {
            setSelectedShape([]);
          }
        })
        .catch((err) => {
          console.warn('getShapeForTrip failed:', err);
          if (!cancelled) setSelectedShape([]);
        });
    } else {
      setSelectedHeadsign('');
      setSelectedShape([]);
    }
    return () => {
      cancelled = true;
    };
  }, [selected?.tripId]);

  const visibleVehicles = useMemo(() => {
    if (selected) return [selected];
    if (region.latitudeDelta > VEHICLE_MARKER_MAX_DELTA) return [];
    return vehicles.filter((v) => isInRegion(v, region) && vehicleModeFilters.includes(v.mode));
  }, [vehicles, region, selected, vehicleModeFilters]);

  // Stops never actually move — pre-computing each one's coordinate object here means it
  // only gets recreated when `stops` itself changes (an actual refetch), instead of a
  // fresh `{ latitude, longitude }` literal on every unrelated re-render (vehicle polling
  // every 15s, region updates, selection changes, ...). Reported live as red pins still
  // appearing on some stop markers even after the customMapStyle fix — this is the same
  // class of issue, just for each marker's own coordinate prop this time.
  const stopMarkers = useMemo(
    () => stops.map((stop) => ({ stop, coordinate: { latitude: stop.lat, longitude: stop.lon } })),
    [stops]
  );

  const stopsAsBadges = region.latitudeDelta <= STOP_BADGE_MAX_DELTA;

  async function handleStopPress(stop: Stop, coordinate: { latitude: number; longitude: number }) {
    markerPressedRef.current = true;
    if (!mapRef.current) {
      onStopPress(stop);
      return;
    }
    const collidingVehicles = await findScreenCollisions(
      mapRef.current,
      region,
      coordinate,
      visibleVehicles.map((v) => ({ point: { latitude: v.lat, longitude: v.lon }, payload: v }))
    );
    if (collidingVehicles.length === 0) {
      onStopPress(stop);
      return;
    }
    markerPressedRef.current = true;
    setCollisionOptions([
      { key: `stop-${stop.id}`, label: stop.name, icon: MODE_ICON.bus, onSelect: () => onStopPress(stop) },
      ...collidingVehicles.map((vehicle) => ({
        key: `vehicle-${vehicle.vehicleId}`,
        label: `Bus ${vehicle.routeShortName ?? '?'}`,
        icon: MODE_ICON[vehicle.mode],
        onSelect: () => setSelectedId(vehicle.vehicleId),
      })),
    ]);
  }

  async function handleVehiclePress(v: VehiclePosition) {
    markerPressedRef.current = true;
    if (!mapRef.current) {
      setSelectedId(v.vehicleId);
      return;
    }
    const collidingStops = await findScreenCollisions(
      mapRef.current,
      region,
      { latitude: v.lat, longitude: v.lon },
      stopMarkers.map(({ stop, coordinate }) => ({ point: coordinate, payload: stop }))
    );
    if (collidingStops.length === 0) {
      setSelectedId(v.vehicleId);
      return;
    }
    markerPressedRef.current = true;
    setCollisionOptions([
      { key: `vehicle-${v.vehicleId}`, label: `Bus ${v.routeShortName ?? '?'}`, icon: MODE_ICON[v.mode], onSelect: () => setSelectedId(v.vehicleId) },
      ...collidingStops.map((stop) => ({
        key: `stop-${stop.id}`,
        label: stop.name,
        icon: MODE_ICON.bus,
        onSelect: () => onStopPress(stop),
      })),
    ]);
  }

  // The overlay fully covers the map (blocking its onPress) while it's showing, so the
  // map's own background-tap handler never gets a chance to consume markerPressedRef
  // itself here — reset it on every close (pick or cancel) so it can't leak "true" into
  // some unrelated later tap on the map.
  function closeCollisionChooser(onSelect?: () => void) {
    markerPressedRef.current = false;
    setCollisionOptions(null);
    onSelect?.();
  }

  async function handleLocate() {
    const coords = await getCurrentCoordinates();
    if (coords) {
      mapRef.current?.animateToRegion(
        { ...coords, latitudeDelta: MY_LOCATION_ZOOM_DELTA, longitudeDelta: MY_LOCATION_ZOOM_DELTA },
        500
      );
    }
  }

  if (!initialRegion) {
    return (
      <View style={[styles.container, styles.loadingContainer]}>
        <ActivityIndicator size="large" color={colors.primary} />
        <Text style={styles.loadingText}>{t('map.findingLocation')}</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <MapView
        ref={mapRef}
        style={{ flex: 1 }}
        initialRegion={initialRegion}
        onMapReady={() => setMapReady(true)}
        onRegionChangeComplete={handleRegionChange}
        onPress={() => {
          if (markerPressedRef.current) {
            markerPressedRef.current = false;
            return;
          }
          setSelectedId(null);
        }}
        showsUserLocation
        showsMyLocationButton={false}
        toolbarEnabled={false}
        customMapStyle={isDark ? darkMapStyle : lightMapStyle}
      >
        {/* zIndex keeps stops above the route polyline (a separate overlay layer, always
            beneath markers) but below live vehicles, so a vehicle passing over a stop stays
            the thing on top. */}
        {stopMarkers.map(({ stop, coordinate }) => (
          <StableMarker
            key={`stop-${stop.id}`}
            coordinate={coordinate}
            anchor={CENTER_ANCHOR}
            zIndex={1}
            // The marker's native bitmap is frozen once drawn, so switching between the dot
            // and the full badge needs a fresh snapshot (see StableMarker's snapshotKey).
            snapshotKey={stopsAsBadges ? 'badge' : 'dot'}
            onPress={() => handleStopPress(stop, coordinate)}
          >
            <StopBadge
              size={STOP_BADGE_SIZE}
              color={colors.primary}
              mode="bus"
              label={t('map.stopLabel')}
              compact={!stopsAsBadges}
            />
          </StableMarker>
        ))}
        {/* Always mounted, coordinates just swap to EMPTY_SHAPE when deselected — unmounting
            this on every deselect used to leave the route stuck drawn on the native map. */}
        <Polyline
          coordinates={selected && selectedShape.length > 1 ? selectedShape : EMPTY_SHAPE}
          strokeColor={selected ? modeColor[selected.mode] : colors.primary}
          strokeWidth={4}
        />
        {visibleVehicles.map((v) => (
          <StableMarker
            key={v.vehicleId}
            coordinate={{ latitude: v.lat, longitude: v.lon }}
            // Centered (not the default bottom-center) so the heading arrow orbits the
            // vehicle's true position rather than a point above it.
            anchor={CENTER_ANCHOR}
            zIndex={2}
            snapshotKey={bearingBucket(v.bearing)}
            onPress={() => handleVehiclePress(v)}
          >
            <HeadingArrowBadge bearing={v.bearing} arrowColor={modeColor[v.mode]} badge={VEHICLE_BADGE}>
              <View style={[styles.dot, { backgroundColor: modeColor[v.mode] }]}>
                <MaterialIcons name={MODE_ICON[v.mode]} size={14} color="#FFFFFF" />
                <Text style={styles.dotText} numberOfLines={1}>
                  {v.routeShortName ?? '?'}
                </Text>
              </View>
            </HeadingArrowBadge>
          </StableMarker>
        ))}
      </MapView>

      <LocateButton onPress={handleLocate} style={[styles.locateButton, { bottom: spacing.md + bottomInset }]} />

      {selected && (
        <View style={[styles.infoCard, { bottom: spacing.sm + bottomInset }]}>
          <Text style={styles.infoRoute}>{selected.routeShortName ?? 'Vehicle'}</Text>
          {selectedHeadsign ? <Text style={styles.infoHeadsign}>{selectedHeadsign}</Text> : null}
          {selected.tripId && (
            <NextStopStatus tripId={selected.tripId} styles={styles} vehiclesUpdatedAt={vehiclesUpdatedAt} />
          )}
          <Pressable onPress={() => setSelectedId(null)}>
            <Text style={styles.infoClear}>{t('map.showAllVehicles')}</Text>
          </Pressable>
        </View>
      )}

      {collisionOptions && (
        <Pressable style={styles.collisionBackdrop} onPress={() => closeCollisionChooser()}>
          <Pressable style={styles.collisionCard} onPress={() => {}}>
            <Text style={styles.collisionTitle}>{t('map.whichOneDidYouMean')}</Text>
            {collisionOptions.map((option) => (
              <Pressable
                key={option.key}
                style={styles.collisionRow}
                onPress={() => closeCollisionChooser(option.onSelect)}
              >
                <MaterialIcons name={option.icon} size={18} color={colors.primary} />
                <Text style={styles.collisionRowText} numberOfLines={1}>
                  {option.label}
                </Text>
              </Pressable>
            ))}
          </Pressable>
        </Pressable>
      )}
    </View>
  );
}

// Isolated in its own component so its 15s poll only re-renders this small info card, not
// the whole VehicleMap (which would otherwise re-render every marker on the map too, on
// top of the map's own vehicle-position poll already doing that every 15s — unnecessary
// extra render churn that's exactly the kind of thing that can destabilize native marker
// snapshots on Android, the same class of issue StableMarker.tsx already guards against).
function NextStopStatus({
  tripId,
  styles,
  vehiclesUpdatedAt,
}: {
  tripId: string;
  styles: ReturnType<typeof createStyles>;
  // When the selected vehicle's own position last refreshed — the countdown below
  // describes this poll (the one that actually moves the marker on the map), not this
  // component's own separate next-stop-info poll a few lines down.
  vehiclesUpdatedAt: number;
}) {
  const [nextStop, setNextStop] = useState<(NextStopInfo & { stopName: string }) | null>(null);
  const t = useTranslation();
  const secondsLeft = useCountdown(POLL_INTERVAL_MS, vehiclesUpdatedAt);

  useEffect(() => {
    let cancelled = false;
    function load() {
      getNextStopForTrip(tripId)
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
    const interval = setInterval(load, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [tripId]);

  return (
    <>
      {nextStop && (
        <>
          <Text style={styles.infoNextStopLabel}>{t('map.nextStop', { name: nextStop.stopName })}</Text>
          {nextStop.cancelled ? (
            <Text style={styles.infoCancelled}>{t('departure.cancelled')}</Text>
          ) : nextStop.delayMinutes > 0 ? (
            <Text style={styles.infoDelayed}>
              {t('map.delayedEta', { minutes: nextStop.delayMinutes, eta: minutesUntil(nextStop.etaIso) })}
            </Text>
          ) : (
            <Text style={styles.infoOnTime}>{t('map.onTimeEta', { eta: minutesUntil(nextStop.etaIso) })}</Text>
          )}
        </>
      )}
      <Text style={styles.infoUpdatesIn}>{t('map.updatesIn', { seconds: secondsLeft })}</Text>
    </>
  );
}
