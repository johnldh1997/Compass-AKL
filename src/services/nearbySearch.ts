// --- Nearby Search ---
// "What's within N minutes of me" — a category search (e.g. "Japanese restaurant") ranked by
// real walking/transit time, not just distance. Also handles a named reference location ("at
// Britomart") and a future day/time ("tomorrow at 5pm") instead of always assuming the user's
// current location right now. The parsing of a free-text query into structured intent happens
// server-side (see server/), never here — this module only ever receives already-structured
// intent and turns it into real places with real times.
import { COMPUTE_ROUTES_URL, getApiKey } from './directions';
import { JourneyEndpoint } from '../types';
import {
  chooseTravelMode,
  filterAndRankByDuration,
  isOpenAt,
  pruneByStraightLineDistance,
  resolveTargetDateTime,
  DEFAULT_MAX_ROUTED_CANDIDATES,
  PRUNE_RADIUS_METERS,
  UNBOUNDED_PRUNE_RADIUS_METERS,
  NearbyCandidate,
  OpeningPeriod,
  PrunedCandidate,
  RoutedCandidate,
  TargetDay,
  TravelMode,
} from './nearbyRanking';

const PLACES_TEXT_SEARCH_URL = 'https://places.googleapis.com/v1/places:searchText';

export interface NearbySearchIntent {
  // Free text handed straight to Google's Places Text Search — e.g. "Japanese restaurant".
  category: string;
  // Null means the user stated no time/distance limit at all (e.g. "closest X") — the search
  // then has nothing to filter against, only to rank by, and searches a wider radius since
  // there's no duration-based reasoning to justify a tight one.
  maxMinutes: number | null;
  modes: TravelMode[];
  // True when the user meant their own saved home address (e.g. "home", "집") as the starting
  // point — a personal reference, not a business name, so it's resolved from the app's own
  // saved address (see HomeAddressContext) rather than geocoded through Places at all.
  useSavedHome: boolean;
  // A specific named place the user gave as their starting point (e.g. "Britomart") — null
  // means their current live location (or their saved home, if useSavedHome is true).
  // Geocoded client-side, never resolved by the model itself.
  referenceLocationText: string | null;
  // Raw day/time fields exactly as the user stated them — resolveTargetDateTime turns these
  // into an actual Date; the model never computes a timestamp itself.
  targetDay: TargetDay | null;
  hour: number | null;
  minute: number | null;
}

export type NearbySearchResult = RoutedCandidate;

export interface ParsedNearbyQuery extends NearbySearchIntent {
  // False when the proxy's model couldn't confidently identify a category from the text —
  // category is then empty and the caller should ask the user to rephrase, not search.
  confident: boolean;
  // A specific question to show instead of a generic "couldn't understand" message, only
  // present when confident is false.
  clarifyingQuestion: string | null;
}

export interface NearbySearchOutcome {
  results: NearbySearchResult[];
  // Where the search actually ran from — the geocoded reference location if one was given
  // and found, otherwise the caller's own location. The UI needs this for the "from" side of
  // any follow-up route hand-off, since it may not be the user's current position.
  origin: { lat: number; lon: number };
  // A human-readable label for that origin — the resolved place's own name when a reference
  // location was given and found, otherwise whatever the caller passed in.
  originLabel: string;
  // True only when a named reference location was both given and successfully geocoded — lets
  // the UI show a "searched near X" confirmation only when that's actually what happened,
  // rather than inferring it from comparing coordinates.
  usedReferenceLocation: boolean;
  // The resolved future departure time, if the query implied one — null means "now".
  departureTime: Date | null;
}

function getNearbyProxyUrl(): string {
  return process.env.EXPO_PUBLIC_NEARBY_PROXY_URL ?? '';
}

// --- Query Parsing ---
// Turns free text into structured search intent via the nearby-search-proxy Worker (see
// server/) — the only place the Anthropic key lives, since a client bundle can't hold it
// safely. This never touches Places/Routes itself, only extracts what to search for.
// previousIntent (the prior turn's own parsed result, if any) lets a short follow-up like
// "actually walking only" be understood as a refinement rather than failing as its own,
// category-less request — the server decides whether it's actually a refinement or not.
export async function parseNearbyQuery(text: string, previousIntent?: NearbySearchIntent | null): Promise<ParsedNearbyQuery> {
  const response = await fetch(`${getNearbyProxyUrl()}/parse-nearby`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(previousIntent ? { text, previousIntent } : { text }),
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body?.error ?? `Query parsing error ${response.status}`);
  }
  return body;
}

// --- Result Explanation ---
// Hands the client's own already-computed real results back to Claude for a short written
// reply — never asked to pick, rank, or invent anything, only to explain what was found.
export async function explainResults(query: string, results: NearbySearchResult[], hadExplicitTime: boolean): Promise<string> {
  const response = await fetch(`${getNearbyProxyUrl()}/explain-results`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query,
      hadExplicitTime,
      results: results.map((r) => ({
        name: r.name,
        durationMinutes: r.durationMinutes,
        mode: r.mode,
        ...(r.routeShortName ? { routeShortName: r.routeShortName } : {}),
        ...(r.rating != null ? { rating: r.rating } : {}),
        ...(r.editorialSummary ? { editorialSummary: r.editorialSummary } : {}),
        ...(r.isOpenNow != null ? { isOpenNow: r.isOpenNow } : {}),
        ...(r.todayHoursText ? { todayHoursText: r.todayHoursText } : {}),
      })),
    }),
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body?.error ?? `Explanation error ${response.status}`);
  }
  return body.reply ?? '';
}

interface OpeningHoursField {
  periods?: {
    open?: { day?: number; hour?: number; minute?: number };
    close?: { day?: number; hour?: number; minute?: number };
  }[];
  // Google's own formatted text, one entry per day, Monday-first (index 0 = Monday).
  weekdayDescriptions?: string[];
}

interface PlacesTextSearchResponse {
  places?: {
    id?: string;
    displayName?: { text?: string };
    location?: { latitude?: number; longitude?: number };
    regularOpeningHours?: OpeningHoursField;
    // Covers a rolling 7-day window with that week's actual occurrences, so a one-off holiday
    // closure just omits that day's entry — unlike regularOpeningHours, which is always the
    // standing weekly pattern regardless of exceptions. Preferred when present; not always
    // returned, so regularOpeningHours remains the fallback.
    currentOpeningHours?: OpeningHoursField;
    rating?: number;
    userRatingCount?: number;
    editorialSummary?: { text?: string };
    googleMapsUri?: string;
  }[];
}

export interface NearbyCandidateWithHours extends NearbyCandidate {
  // null means Places returned no opening-hours data at all for this candidate — distinct
  // from an empty periods list, which would mean "confirmed never open" (see isOpenAt).
  openingPeriods: OpeningPeriod[] | null;
  // Raw per-day formatted text, kept alongside openingPeriods until a reference moment (the
  // stated time, or now) is known — see the isOpenNow/todayHoursText computation in searchNearby.
  weekdayDescriptions: string[] | null;
}

async function textSearchPlaces(
  category: string,
  near: { lat: number; lon: number },
  radiusMeters: number
): Promise<NearbyCandidateWithHours[]> {
  const response = await fetch(PLACES_TEXT_SEARCH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': getApiKey(),
      'X-Goog-FieldMask':
        'places.id,places.displayName,places.location,places.regularOpeningHours,places.currentOpeningHours,places.rating,places.userRatingCount,places.editorialSummary,places.googleMapsUri',
    },
    body: JSON.stringify({
      textQuery: category,
      locationBias: { circle: { center: { latitude: near.lat, longitude: near.lon }, radius: radiusMeters } },
      maxResultCount: 20,
    }),
  });
  if (!response.ok) {
    throw new Error(`Places text search error ${response.status}: ${await response.text()}`);
  }
  const data: PlacesTextSearchResponse = await response.json();
  return (data.places ?? [])
    .filter((p) => p.id && p.displayName?.text && p.location?.latitude != null && p.location?.longitude != null)
    .map((p) => {
      const hours = p.currentOpeningHours ?? p.regularOpeningHours;
      return {
        id: p.id!,
        name: p.displayName!.text!,
        lat: p.location!.latitude!,
        lon: p.location!.longitude!,
        openingPeriods: hours?.periods
          ? hours.periods
              .filter((period) => period.open && period.close)
              .map((period) => ({
                openDay: period.open!.day ?? 0,
                openHour: period.open!.hour ?? 0,
                openMinute: period.open!.minute ?? 0,
                closeDay: period.close!.day ?? 0,
                closeHour: period.close!.hour ?? 0,
                closeMinute: period.close!.minute ?? 0,
              }))
          : null,
        weekdayDescriptions: hours?.weekdayDescriptions ?? null,
        ...(p.rating != null ? { rating: p.rating } : {}),
        ...(p.userRatingCount != null ? { userRatingCount: p.userRatingCount } : {}),
        ...(p.editorialSummary?.text ? { editorialSummary: p.editorialSummary.text } : {}),
        ...(p.googleMapsUri ? { mapsUri: p.googleMapsUri } : {}),
      };
    });
}

// --- Reference Location ---
// Resolves a named place ("Britomart") to real coordinates via the same Places Text Search
// used for category results — biased toward the user's actual location so a common name
// resolves to the nearby branch, not one on the other side of the country. Best-effort: a
// place that fails to geocode falls back to the caller's own location rather than failing
// the whole search over it.
export async function geocodeReferenceLocation(
  text: string,
  near: { lat: number; lon: number }
): Promise<{ lat: number; lon: number; name: string } | null> {
  try {
    const matches = await textSearchPlaces(text, near, UNBOUNDED_PRUNE_RADIUS_METERS);
    const first = matches[0];
    return first ? { lat: first.lat, lon: first.lon, name: first.name } : null;
  } catch {
    return null;
  }
}

// --- Saved Endpoint Resolution ---
// A saved endpoint (e.g. the app's own home address) is already real coordinates, or just a
// placeId with no coordinates at all (SetHomeAddressScreen saves either, depending on how it
// was picked) — this resolves either shape to real coordinates via Place Details, never a
// Places Text Search, since there's no search term here at all, just a specific known place.
export async function resolveEndpointCoordinates(endpoint: JourneyEndpoint): Promise<{ lat: number; lon: number } | null> {
  if (endpoint.kind === 'coordinates') return { lat: endpoint.lat, lon: endpoint.lon };
  try {
    const response = await fetch(`https://places.googleapis.com/v1/places/${endpoint.placeId}`, {
      headers: { 'X-Goog-Api-Key': getApiKey(), 'X-Goog-FieldMask': 'location' },
    });
    if (!response.ok) return null;
    const data: { location?: { latitude?: number; longitude?: number } } = await response.json();
    return data.location?.latitude != null && data.location?.longitude != null
      ? { lat: data.location.latitude, lon: data.location.longitude }
      : null;
  } catch {
    return null;
  }
}

interface ComputeRoutesMinimalResponse {
  routes?: {
    duration?: string; // e.g. "723s"
    legs?: { steps?: { transitDetails?: { transitLine?: { nameShort?: string; name?: string } } }[] }[];
  }[];
}

// One real routing call for one candidate — the expensive step pruning exists to limit the
// number of. Best-effort: a candidate that fails to route (no result, network error) is
// dropped rather than breaking the whole search, same as the rest of this app's live-API code.
async function routeToCandidate(
  origin: { lat: number; lon: number },
  candidate: PrunedCandidate,
  departureTime: Date | null
): Promise<RoutedCandidate | null> {
  const mode = chooseTravelMode(candidate.straightLineMeters);
  try {
    const response = await fetch(COMPUTE_ROUTES_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': getApiKey(),
        'X-Goog-FieldMask':
          mode === 'TRANSIT'
            ? 'routes.duration,routes.legs.steps.transitDetails.transitLine.nameShort,routes.legs.steps.transitDetails.transitLine.name'
            : 'routes.duration',
      },
      body: JSON.stringify({
        origin: { location: { latLng: { latitude: origin.lat, longitude: origin.lon } } },
        destination: { location: { latLng: { latitude: candidate.lat, longitude: candidate.lon } } },
        travelMode: mode,
        ...(departureTime ? { departureTime: departureTime.toISOString() } : {}),
      }),
    });
    if (!response.ok) return null;

    const data: ComputeRoutesMinimalResponse = await response.json();
    const route = data.routes?.[0];
    if (!route?.duration) return null;

    const seconds = parseInt(route.duration, 10) || 0;
    // First transit step's line — a transfer journey's later legs aren't summarized here;
    // tapping through to the full route preview shows the complete itinerary.
    const transitStep = route.legs?.[0]?.steps?.find((s) => s.transitDetails);
    const routeShortName = transitStep?.transitDetails?.transitLine?.nameShort ?? transitStep?.transitDetails?.transitLine?.name;

    return {
      ...candidate,
      durationMinutes: Math.round(seconds / 60),
      mode,
      ...(routeShortName ? { routeShortName } : {}),
    };
  } catch {
    return null;
  }
}

// The whole pipeline: resolve where/when the search is actually for -> category search ->
// cheap distance pruning -> mode filtering -> real routing on the survivors only -> filter to
// the time budget (if any) -> soonest first.
export async function searchNearby(
  userLocation: { lat: number; lon: number; label: string },
  intent: NearbySearchIntent,
  maxRoutedCandidates: number = DEFAULT_MAX_ROUTED_CANDIDATES
): Promise<NearbySearchOutcome> {
  const reference = intent.referenceLocationText
    ? await geocodeReferenceLocation(intent.referenceLocationText, userLocation)
    : null;
  const origin = reference ?? userLocation;
  const originLabel = reference?.name ?? userLocation.label;
  const departureTime = resolveTargetDateTime(new Date(), intent.targetDay, intent.hour, intent.minute);

  const searchRadius = intent.maxMinutes === null ? UNBOUNDED_PRUNE_RADIUS_METERS : PRUNE_RADIUS_METERS;
  const places = await textSearchPlaces(intent.category, origin, searchRadius);

  // referenceMoment is the stated time, or "now" as a display default — not a stated
  // constraint, so it annotates every candidate rather than silently dropping any of them
  // (same reasoning as maxMinutes: an unstated constraint doesn't get enforced just because
  // it has a convenient default value — see the "closest yogost" fix).
  const referenceMoment = departureTime ?? new Date();
  const annotated: NearbyCandidate[] = places.map((p) => ({
    ...p,
    isOpenNow: isOpenAt(p.openingPeriods, referenceMoment),
    todayHoursText: p.weekdayDescriptions?.[(referenceMoment.getDay() + 6) % 7],
  }));
  // Only actually filter by it when the user gave a real time — a place confirmed closed at
  // a time they explicitly asked about genuinely isn't a match, however close it is.
  const openAtTarget = departureTime ? annotated.filter((p) => p.isOpenNow) : annotated;
  const pruned = pruneByStraightLineDistance(origin, openAtTarget, maxRoutedCandidates, searchRadius);
  const eligible = pruned.filter((c) => intent.modes.includes(chooseTravelMode(c.straightLineMeters)));

  const routed = await Promise.all(eligible.map((c) => routeToCandidate(origin, c, departureTime)));
  const successful = routed.filter((r): r is RoutedCandidate => r !== null);

  return {
    results: filterAndRankByDuration(successful, intent.maxMinutes),
    origin,
    originLabel,
    usedReferenceLocation: reference !== null,
    departureTime,
  };
}
