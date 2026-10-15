// --- Google Maps Platform Proxy ---
// The app used to call Google Places and Routes directly, with the API key shipped inside it — so anyone
// who unpacked the app had the key. These endpoints do the same calls from here, where the key never leaves.
// They are a narrow door, not a pass-through: each endpoint accepts only the few fields the app actually
// sends, caps sizes (results, radius, text length), and fixes the field mask itself. Google bills by the
// fields requested, so a caller can't ask for a pricier tier than the app does.
//
//  - POST /google/autocomplete     place suggestions as the user types
//  - POST /google/search-text      Places text search (words in a category)
//  - POST /google/search-nearby    Places nearby search (by Google place type)
//  - POST /google/place-location   where a place id is
//  - POST /google/route            a route (journey planning, or a Find Nearby candidate's travel time)
//
// buildGoogleRequest is pure, so what may reach Google is covered by tests (google.spec.ts).
import { z } from 'zod';
import { jsonResponse, readJsonBody } from './http';

const PLACES = 'https://places.googleapis.com/v1';
const COMPUTE_ROUTES = 'https://routes.googleapis.com/directions/v2:computeRoutes';

// Roughly centred on Auckland, used to bias (not restrict) autocomplete results.
const AUCKLAND_BIAS = { latitude: -36.8485, longitude: 174.7633 };

// Everything the Find Nearby searches read from a place. Fixed here, never taken from the caller.
export const PLACES_FIELD_MASK =
  'places.id,places.displayName,places.location,places.regularOpeningHours,places.currentOpeningHours,places.rating,places.userRatingCount,places.editorialSummary,places.googleMapsUri,places.priceLevel,places.servesVegetarianFood,places.outdoorSeating';

// --- Input Shapes ---
const lat = z.number().min(-90).max(90);
const lon = z.number().min(-180).max(180);
const circle = { lat, lon, radiusMeters: z.number().min(1).max(50_000) };
const placeId = z.string().regex(/^[A-Za-z0-9_-]{10,300}$/);

const Autocomplete = z.object({
  input: z.string().min(1).max(100),
  sessionToken: z.string().regex(/^[A-Za-z0-9-]{8,64}$/),
});

const SearchText = z.object({
  textQuery: z.string().min(1).max(100),
  ...circle,
  maxResultCount: z.number().int().min(1).max(20).default(20),
});

const SearchNearby = z.object({
  includedTypes: z.array(z.string().regex(/^[a-z_]{3,50}$/)).min(1).max(4),
  rankPreference: z.enum(['DISTANCE', 'POPULARITY']),
  ...circle,
  maxResultCount: z.number().int().min(1).max(20).default(20),
});

const PlaceLocation = z.object({ placeId });

const Waypoint = z.union([z.object({ placeId }), z.object({ lat, lon })]);

// The four kinds of route the app asks for, each with its own travel mode and field mask. The two
// "journey" ones return what the route screen draws; the two "candidate" ones return just a duration (and,
// for transit, the line), which is all a Find Nearby result needs.
const ROUTE_PROFILES = {
  'journey-transit': {
    travelMode: 'TRANSIT',
    alternatives: true,
    fieldMask:
      'routes.legs.steps.transitDetails,routes.legs.steps.staticDuration,routes.legs.steps.navigationInstruction,routes.legs.steps.polyline.encodedPolyline,routes.localizedValues.duration,routes.polyline.encodedPolyline',
  },
  'journey-walk': {
    travelMode: 'WALK',
    alternatives: false,
    fieldMask:
      'routes.legs.steps.staticDuration,routes.legs.steps.navigationInstruction,routes.legs.steps.polyline.encodedPolyline,routes.localizedValues.duration,routes.polyline.encodedPolyline',
  },
  'candidate-walk': { travelMode: 'WALK', alternatives: false, fieldMask: 'routes.duration' },
  'candidate-transit': {
    travelMode: 'TRANSIT',
    alternatives: false,
    fieldMask:
      'routes.duration,routes.legs.steps.transitDetails.transitLine.nameShort,routes.legs.steps.transitDetails.transitLine.name',
  },
} as const;

const Route = z.object({
  profile: z.enum(['journey-transit', 'journey-walk', 'candidate-walk', 'candidate-transit']),
  origin: Waypoint,
  destination: Waypoint,
  departureTime: z.string().datetime().optional(),
});

function toGoogleWaypoint(waypoint: z.infer<typeof Waypoint>) {
  return 'placeId' in waypoint
    ? { placeId: waypoint.placeId }
    : { location: { latLng: { latitude: waypoint.lat, longitude: waypoint.lon } } };
}

function toGoogleCircle(input: { lat: number; lon: number; radiusMeters: number }) {
  return { circle: { center: { latitude: input.lat, longitude: input.lon }, radius: input.radiusMeters } };
}

// --- The Request That Reaches Google ---
export interface GoogleRequest {
  url: string;
  method: 'GET' | 'POST';
  body?: unknown;
  // Absent for autocomplete, which doesn't take one.
  fieldMask?: string;
}

export const GOOGLE_ENDPOINTS = ['autocomplete', 'search-text', 'search-nearby', 'place-location', 'route'] as const;
export type GoogleEndpoint = (typeof GOOGLE_ENDPOINTS)[number];

export function isGoogleEndpoint(value: string): value is GoogleEndpoint {
  return (GOOGLE_ENDPOINTS as readonly string[]).includes(value);
}

export function buildGoogleRequest(endpoint: GoogleEndpoint, raw: unknown): { request: GoogleRequest } | { error: string } {
  switch (endpoint) {
    case 'autocomplete': {
      const parsed = Autocomplete.safeParse(raw);
      if (!parsed.success) return { error: 'Invalid autocomplete request' };
      return {
        request: {
          url: `${PLACES}/places:autocomplete`,
          method: 'POST',
          body: {
            input: parsed.data.input,
            sessionToken: parsed.data.sessionToken,
            includedRegionCodes: ['nz'],
            locationBias: { circle: { center: AUCKLAND_BIAS, radius: 50_000 } },
          },
        },
      };
    }
    case 'search-text': {
      const parsed = SearchText.safeParse(raw);
      if (!parsed.success) return { error: 'Invalid text search request' };
      return {
        request: {
          url: `${PLACES}/places:searchText`,
          method: 'POST',
          fieldMask: PLACES_FIELD_MASK,
          body: {
            textQuery: parsed.data.textQuery,
            locationBias: toGoogleCircle(parsed.data),
            maxResultCount: parsed.data.maxResultCount,
          },
        },
      };
    }
    case 'search-nearby': {
      const parsed = SearchNearby.safeParse(raw);
      if (!parsed.success) return { error: 'Invalid nearby search request' };
      return {
        request: {
          url: `${PLACES}/places:searchNearby`,
          method: 'POST',
          fieldMask: PLACES_FIELD_MASK,
          body: {
            includedTypes: parsed.data.includedTypes,
            rankPreference: parsed.data.rankPreference,
            maxResultCount: parsed.data.maxResultCount,
            locationRestriction: toGoogleCircle(parsed.data),
          },
        },
      };
    }
    case 'place-location': {
      const parsed = PlaceLocation.safeParse(raw);
      if (!parsed.success) return { error: 'Invalid place id' };
      return { request: { url: `${PLACES}/places/${parsed.data.placeId}`, method: 'GET', fieldMask: 'location' } };
    }
    case 'route': {
      const parsed = Route.safeParse(raw);
      if (!parsed.success) return { error: 'Invalid route request' };
      const profile = ROUTE_PROFILES[parsed.data.profile];
      return {
        request: {
          url: COMPUTE_ROUTES,
          method: 'POST',
          fieldMask: profile.fieldMask,
          body: {
            origin: toGoogleWaypoint(parsed.data.origin),
            destination: toGoogleWaypoint(parsed.data.destination),
            travelMode: profile.travelMode,
            ...(profile.alternatives ? { computeAlternativeRoutes: true } : {}),
            ...(parsed.data.departureTime ? { departureTime: parsed.data.departureTime } : {}),
          },
        },
      };
    }
  }
}

// --- Handler ---
const GOOGLE_TIMEOUT_MS = 10_000;

export async function handleGoogle(request: Request, endpoint: GoogleEndpoint, apiKey: string | undefined): Promise<Response> {
  const read = await readJsonBody(request);
  if ('error' in read) return read.error;
  const built = buildGoogleRequest(endpoint, read.body);
  if ('error' in built) return jsonResponse({ error: built.error }, 400);
  if (!apiKey) return jsonResponse({ error: 'Server misconfigured: GOOGLE_API_KEY is not set' }, 500);

  const { url, method, body, fieldMask } = built.request;
  try {
    const upstream = await fetch(url, {
      method,
      headers: {
        'X-Goog-Api-Key': apiKey,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(fieldMask ? { 'X-Goog-FieldMask': fieldMask } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
    });
    if (!upstream.ok) {
      // Only the status is logged and passed on: Google's error text can name the key's project and settings.
      console.error(`Google ${endpoint} returned ${upstream.status}`);
      return jsonResponse({ error: `Google ${endpoint} request failed`, status: upstream.status }, 502);
    }
    return new Response(upstream.body, { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    console.error(`Google ${endpoint} call failed:`, err instanceof Error ? err.name : 'unknown');
    return jsonResponse({ error: `Google ${endpoint} is unavailable right now` }, 502);
  }
}
