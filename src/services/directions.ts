import { JourneyEndpoint, JourneyRoute, PlaceSuggestion, TransitStep, TransportMode } from '../types';

const PLACES_AUTOCOMPLETE_URL = 'https://places.googleapis.com/v1/places:autocomplete';
export const COMPUTE_ROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';

// Roughly centered on Auckland, used to bias (not restrict) autocomplete results.
const AUCKLAND_BIAS = { latitude: -36.8485, longitude: 174.7633 };

export function getApiKey(): string {
  return process.env.EXPO_PUBLIC_GOOGLE_DIRECTIONS_KEY ?? '';
}

export function createSessionToken(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

interface AutocompleteResponse {
  suggestions?: {
    placePrediction: {
      placeId: string;
      structuredFormat: { mainText: { text: string }; secondaryText?: { text: string } };
    };
  }[];
}

export async function autocompletePlace(input: string, sessionToken: string): Promise<PlaceSuggestion[]> {
  if (!input.trim()) return [];

  const response = await fetch(PLACES_AUTOCOMPLETE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': getApiKey(),
    },
    body: JSON.stringify({
      input,
      sessionToken,
      includedRegionCodes: ['nz'],
      locationBias: { circle: { center: AUCKLAND_BIAS, radius: 50000 } },
    }),
  });

  if (!response.ok) {
    throw new Error(`Places autocomplete error ${response.status}: ${await response.text()}`);
  }

  const data: AutocompleteResponse = await response.json();
  return (data.suggestions ?? []).map((s) => ({
    placeId: s.placePrediction.placeId,
    mainText: s.placePrediction.structuredFormat.mainText.text,
    secondaryText: s.placePrediction.structuredFormat.secondaryText?.text ?? '',
  }));
}

interface TransitDetailsData {
  headsign?: string;
  transitLine?: {
    name?: string;
    // The dedicated short route-number field (e.g. "70") — buses in particular often
    // have no useful `name`, only this, which is why the badge showed "?" without it.
    nameShort?: string;
    vehicle?: { type?: string };
  };
  stopCount?: number;
  stopDetails?: {
    departureTime?: string;
    arrivalTime?: string;
    departureStop?: { name?: string; location?: { latLng?: { latitude?: number; longitude?: number } } };
    arrivalStop?: { name?: string; location?: { latLng?: { latitude?: number; longitude?: number } } };
  };
  localizedValues?: {
    departureTime?: { time?: { text?: string } };
    arrivalTime?: { time?: { text?: string } };
  };
}

interface RouteStep {
  transitDetails?: TransitDetailsData;
  staticDuration?: string;
  navigationInstruction?: { instructions?: string };
  polyline?: { encodedPolyline?: string };
}

interface RouteData {
  legs: { steps: RouteStep[] }[];
  localizedValues?: { duration?: { text?: string } };
  polyline?: { encodedPolyline?: string };
}

interface ComputeRoutesResponse {
  routes?: RouteData[];
}

// staticDuration comes back as a raw seconds string (e.g. "54s"), not localized text.
function formatWalkDuration(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const seconds = parseInt(raw, 10);
  if (Number.isNaN(seconds)) return raw;
  const minutes = Math.round(seconds / 60);
  return minutes < 1 ? 'Less than 1 min' : `${minutes} min`;
}

function modeFromGoogleVehicleType(type: string | undefined): TransportMode {
  if (!type) return 'unknown';
  if (type === 'FERRY') return 'ferry';
  if (type === 'BUS' || type === 'INTERCITY_BUS' || type === 'TROLLEYBUS' || type === 'SHARE_TAXI') return 'bus';
  return 'train';
}

function toStopLocation(stop: { name?: string; location?: { latLng?: { latitude?: number; longitude?: number } } } | undefined) {
  const latLng = stop?.location?.latLng;
  if (!stop?.name || latLng?.latitude == null || latLng?.longitude == null) return undefined;
  return { name: stop.name, lat: latLng.latitude, lon: latLng.longitude };
}

function toStep(step: RouteStep): TransitStep {
  if (step.transitDetails) {
    const t = step.transitDetails;
    const lineName = t.transitLine?.nameShort ?? t.transitLine?.name;
    return {
      kind: 'transit',
      mode: modeFromGoogleVehicleType(t.transitLine?.vehicle?.type),
      instruction: `${lineName ?? 'Transit'}${t.headsign ? ` towards ${t.headsign}` : ''}`,
      departureTime: t.localizedValues?.departureTime?.time?.text,
      arrivalTime: t.localizedValues?.arrivalTime?.time?.text,
      departureTimestamp: t.stopDetails?.departureTime,
      arrivalTimestamp: t.stopDetails?.arrivalTime,
      lineName,
      headsign: t.headsign,
      numStops: t.stopCount,
      encodedPolyline: step.polyline?.encodedPolyline,
      departureStop: toStopLocation(t.stopDetails?.departureStop),
      arrivalStop: toStopLocation(t.stopDetails?.arrivalStop),
    };
  }
  return {
    kind: 'walk',
    instruction: step.navigationInstruction?.instructions ?? 'Walk',
    durationText: formatWalkDuration(step.staticDuration),
    // Raw seconds (distinct from durationText's formatted "3 min" string) — lets the UI
    // compute a real arrival clock time for any trailing walk after the last transit leg,
    // without needing a separate route-level duration field (see toJourneyRoute below).
    durationSeconds: step.staticDuration ? parseInt(step.staticDuration, 10) || 0 : undefined,
    encodedPolyline: step.polyline?.encodedPolyline,
  };
}

function toWaypoint(endpoint: JourneyEndpoint) {
  return endpoint.kind === 'place'
    ? { placeId: endpoint.placeId }
    : { location: { latLng: { latitude: endpoint.lat, longitude: endpoint.lon } } };
}

function toJourneyRoute(route: RouteData): JourneyRoute {
  const steps = route.legs.flatMap((leg) => leg.steps.map(toStep));

  const walkSeconds = route.legs
    .flatMap((leg) => leg.steps)
    .filter((step) => !step.transitDetails)
    .reduce((sum, step) => sum + (parseInt(step.staticDuration ?? '0', 10) || 0), 0);
  const walkMinutes = Math.round(walkSeconds / 60);

  return {
    durationText: route.localizedValues?.duration?.text ?? '',
    steps,
    encodedPolyline: route.polyline?.encodedPolyline,
    walkSummary: walkMinutes < 1 ? 'Less than 1 min walk' : `${walkMinutes} min walk`,
  };
}

async function computeTransitRoutes(
  origin: JourneyEndpoint,
  destination: JourneyEndpoint,
  departureTime?: Date
): Promise<JourneyRoute[]> {
  const response = await fetch(COMPUTE_ROUTES_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': getApiKey(),
      'X-Goog-FieldMask':
        'routes.legs.steps.transitDetails,routes.legs.steps.staticDuration,routes.legs.steps.navigationInstruction,routes.legs.steps.polyline.encodedPolyline,routes.localizedValues.duration,routes.polyline.encodedPolyline',
      // Note: transitDetails.stopDetails.{departureTime,arrivalTime,departureStop,arrivalStop}
      // and transitLine's nameShort/vehicle.type come along for free as part of the
      // transitDetails subtree already requested above.
    },
    body: JSON.stringify({
      origin: toWaypoint(origin),
      destination: toWaypoint(destination),
      travelMode: 'TRANSIT',
      computeAlternativeRoutes: true,
      ...(departureTime ? { departureTime: departureTime.toISOString() } : {}),
    }),
  });

  if (!response.ok) {
    throw new Error(`Routes API error ${response.status}: ${await response.text()}`);
  }

  const data: ComputeRoutesResponse = await response.json();
  return (data.routes ?? []).map(toJourneyRoute);
}

// A plain walking route between the same two points — verified live that travelMode
// WALK works on computeRoutes. TRANSIT alternatives don't reliably include a pure-walk
// fallback, so this is fetched separately and appended, giving a walking option even
// when transit is faster (useful for short hops or when a bus/train just isn't worth it).
async function getWalkingRoute(origin: JourneyEndpoint, destination: JourneyEndpoint): Promise<JourneyRoute | null> {
  const response = await fetch(COMPUTE_ROUTES_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': getApiKey(),
      'X-Goog-FieldMask':
        'routes.legs.steps.staticDuration,routes.legs.steps.navigationInstruction,routes.legs.steps.polyline.encodedPolyline,routes.localizedValues.duration,routes.polyline.encodedPolyline',
    },
    body: JSON.stringify({
      origin: toWaypoint(origin),
      destination: toWaypoint(destination),
      travelMode: 'WALK',
    }),
  });

  if (!response.ok) return null;
  const data: ComputeRoutesResponse = await response.json();
  const route = data.routes?.[0];
  return route ? toJourneyRoute(route) : null;
}

// Returns up to a handful of alternative routes (Google typically gives 2-6 for transit),
// plus a guaranteed walking-only option appended at the end (unless one already came back
// from the transit alternatives). Fare/cost is deliberately not requested: verified live
// that routes.travelAdvisory.transitFare comes back empty ({}) for Auckland — Google has
// no AT fare data.
//
// departureTime is optional (verified live with a real future timestamp): omitting it
// defaults to "leave now"; passing an ISO string computes routes for that future time instead.
export async function getTransitRoutes(
  origin: JourneyEndpoint,
  destination: JourneyEndpoint,
  departureTime?: Date
): Promise<JourneyRoute[]> {
  const [transitRoutes, walkingRoute] = await Promise.all([
    computeTransitRoutes(origin, destination, departureTime),
    getWalkingRoute(origin, destination).catch(() => null),
  ]);

  const hasWalkingOnly = transitRoutes.some((route) => route.steps.every((step) => step.kind === 'walk'));
  if (walkingRoute && !hasWalkingOnly) {
    return [...transitRoutes, walkingRoute];
  }
  return transitRoutes;
}

// Standard Google encoded-polyline decoding (used for drawing the route on the map).
export function decodePolyline(encoded: string): { latitude: number; longitude: number }[] {
  const points: { latitude: number; longitude: number }[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    let shift = 0;
    let result = 0;
    let byte: number;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    shift = 0;
    result = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;

    points.push({ latitude: lat / 1e5, longitude: lng / 1e5 });
  }

  return points;
}
