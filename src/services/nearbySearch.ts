// --- Nearby Search ---
// "What's within N minutes of me" — a category search (e.g. "Japanese restaurant") ranked by
// real walking/transit time, not just distance. Also handles a named reference location ("at
// Britomart") and a future day/time ("tomorrow at 5pm") instead of always assuming the user's
// current location right now. The parsing of a free-text query into structured intent happens
// server-side (see server/), never here — this module only ever receives already-structured
// intent and turns it into real places with real times.
import { COMPUTE_ROUTES_URL, getApiKey } from './directions';
import { getInstallId } from './installId';
import { RecentTurn, ShownResult } from './nearbyConversation';
import { JourneyEndpoint } from '../types';
import {
  chooseTravelMode,
  departureForRouting,
  filterAndRankByDuration,
  isOpenDuring,
  mergeCandidates,
  placeTypesFor,
  priceLevelFromPlaces,
  resolveTargetDateTime,
  selectCandidatesForRouting,
  withArrivalHours,
  DEFAULT_MAX_ROUTED_CANDIDATES,
  DEFAULT_RESULT_LIMIT,
  PRUNE_RADIUS_METERS,
  UNBOUNDED_PRUNE_RADIUS_METERS,
  NearbyCandidate,
  PrunedCandidate,
  RankBy,
  RoutedCandidate,
  TargetDay,
  TravelMode,
} from './nearbyRanking';

const PLACES_TEXT_SEARCH_URL = 'https://places.googleapis.com/v1/places:searchText';
const PLACES_NEARBY_SEARCH_URL = 'https://places.googleapis.com/v1/places:searchNearby';

export interface NearbySearchIntent {
  // Free text handed straight to Google's Places Text Search — e.g. "Japanese restaurant".
  category: string;
  // Google's own type for the kind of place asked for ("hamburger_restaurant"), or 'none' for a brand or a
  // specific shop. When set, places filed under it are searched for as well as places matching the words —
  // see searchNearby. Optional so an older Worker, which doesn't send it, still works.
  placeType?: string;
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
  // Closest first (the default) or best rated first. Optional on all four so an older Worker that
  // doesn't send them, or a chat saved before they existed, still works as a plain nearest search.
  rankBy?: RankBy;
  wantsCheap?: boolean;
  wantsVegetarian?: boolean;
  wantsOutdoorSeating?: boolean;
}

export type NearbySearchResult = RoutedCandidate;

export interface ParsedNearbyQuery extends NearbySearchIntent {
  // What kind of message this was: a search (the default — also what an older Worker, which doesn't
  // say, is taken to mean), a question about the results on screen, or an action on one of them.
  messageKind?: 'search' | 'question' | 'action';
  actionType?: 'none' | 'directions' | 'maps';
  // 1-based position among the results that were on screen; 0 when the model couldn't tell which.
  actionTargetIndex?: number;
  // The label of the saved place the message starts from ("" for none).
  savedPlaceLabel?: string;
  // True when it starts from where the planned trip ends ("near my stop").
  useJourneyDestination?: boolean;
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

// --- Proxy Calls ---
// Every call to the Find Nearby Worker (see server/) goes through here: it is the only place the Anthropic
// key lives, since a client bundle can't hold it safely. Each call carries this install's id so the Worker
// can rate-limit installs separately (see installId.ts and server/src/limits.ts).
// A call that outlives this is abandoned for real — the request is aborted, not just ignored — so a
// connection that has silently stalled (common on a flaky mobile network) is dropped rather than reused
// by the next attempt. Just under the 12 s step timeout in nearbyTurn.ts, so that one never gets there first.
const PROXY_TIMEOUT_MS = 11_000;

async function callProxy(path: string, body: unknown, failureLabel: string): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);
  try {
    const response = await fetch(`${getNearbyProxyUrl()}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Install-Id': await getInstallId() },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data?.error ?? `${failureLabel} error ${response.status}`);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

// --- Query Parsing ---
// Turns free text into structured search intent via the Worker. This never touches Places/Routes itself,
// only works out what the message is and what to search for. The context is what the app knows that
// changes how a message reads:
//  - previousIntent (the prior turn's own parsed result) lets a short follow-up like "actually walking
//    only" be understood as a refinement rather than failing as its own, category-less request — the
//    server decides whether it's actually a refinement or not.
//  - shownResults (the results on screen) is what "take me to the second one" or "which is cheapest?"
//    points at; without any, every message is a search.
//  - savedPlaces (their labels) is what "near work" is matched against.
export interface ParseContext {
  previousIntent?: NearbySearchIntent | null;
  shownResults?: ShownResult[];
  savedPlaces?: string[];
}

export async function parseNearbyQuery(text: string, context: ParseContext = {}): Promise<ParsedNearbyQuery> {
  const { previousIntent, shownResults, savedPlaces } = context;
  return callProxy(
    '/parse-nearby',
    {
      text,
      ...(previousIntent ? { previousIntent } : {}),
      ...(shownResults && shownResults.length > 0 ? { shownResults } : {}),
      ...(savedPlaces ? { savedPlaces } : {}),
    },
    'Query parsing'
  );
}

// The results as the Worker's reply-writing endpoints take them. Those endpoints only describe what
// they're handed, so this is everything they're allowed to say about a place.
function resultsPayload(results: NearbySearchResult[]) {
  return results.map((r) => ({
    name: r.name,
    durationMinutes: r.durationMinutes,
    mode: r.mode,
    ...(r.routeShortName ? { routeShortName: r.routeShortName } : {}),
    ...(r.rating != null ? { rating: r.rating } : {}),
    ...(r.userRatingCount != null ? { userRatingCount: r.userRatingCount } : {}),
    ...(r.editorialSummary ? { editorialSummary: r.editorialSummary } : {}),
    ...(r.isOpenOnArrival != null ? { isOpenOnArrival: r.isOpenOnArrival } : {}),
    ...(r.closesInMinutes != null ? { closesInMinutes: r.closesInMinutes } : {}),
    ...(r.todayHoursText ? { todayHoursText: r.todayHoursText } : {}),
    ...(r.priceLevel != null ? { priceLevel: r.priceLevel } : {}),
    ...(r.servesVegetarianFood != null ? { servesVegetarianFood: r.servesVegetarianFood } : {}),
    ...(r.outdoorSeating != null ? { outdoorSeating: r.outdoorSeating } : {}),
  }));
}

// --- Result Explanation ---
// Hands the client's own already-computed real results back to Claude for a short written
// reply — never asked to pick, rank, or invent anything, only to explain what was found.
export async function explainResults(
  query: string,
  results: NearbySearchResult[],
  hadExplicitTime: boolean,
  rankedBy: RankBy = 'nearest'
): Promise<string> {
  const data = await callProxy('/explain-results', { query, hadExplicitTime, rankedBy, results: resultsPayload(results) }, 'Explanation');
  return data.reply ?? '';
}

// --- Follow-up Questions ---
// Answers a question about results already on screen ("which is best rated?") from those results alone —
// no new Places or Routes call is made. recentTurns is the last few things said, for "and the other one?".
export async function answerQuestion(question: string, results: NearbySearchResult[], recentTurns: RecentTurn[]): Promise<string> {
  const data = await callProxy('/answer-question', { question, results: resultsPayload(results), recentTurns }, 'Answer');
  return data.reply ?? '';
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
    priceLevel?: string;
    servesVegetarianFood?: boolean;
    outdoorSeating?: boolean;
  }[];
}

// Every Places search asks for the same fields, so a place found by words and the same place found by type
// look identical and can be merged (see mergeCandidates).
const PLACES_FIELD_MASK =
  'places.id,places.displayName,places.location,places.regularOpeningHours,places.currentOpeningHours,places.rating,places.userRatingCount,places.editorialSummary,places.googleMapsUri,places.priceLevel,places.servesVegetarianFood,places.outdoorSeating';

async function postPlaces(url: string, body: unknown, failureLabel: string): Promise<PlacesTextSearchResponse> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': getApiKey(), 'X-Goog-FieldMask': PLACES_FIELD_MASK },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`${failureLabel} error ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

// By the words in the category ("burger restaurant"). Google ranks these by relevance, so it favours places
// whose name or reviews match the words — fine for "yogost" or "Barrel N Burger", but a chain like McDonald's
// has no "burger" in its name and never makes the 20 (see searchNearbyPlacesByType for that).
async function textSearchPlaces(
  category: string,
  near: { lat: number; lon: number },
  radiusMeters: number
): Promise<NearbyCandidate[]> {
  const data = await postPlaces(
    PLACES_TEXT_SEARCH_URL,
    {
      textQuery: category,
      locationBias: { circle: { center: { latitude: near.lat, longitude: near.lon }, radius: radiusMeters } },
      maxResultCount: 20,
    },
    'Places text search'
  );
  return toCandidates(data.places);
}

// By Google's own type for the kind of place ("hamburger_restaurant"): everything Google files under it,
// whatever it's called — which is how McDonald's, Burger King and Carl's Jr turn up for "burger place". Ranked
// by distance for a "closest" search and by popularity for a "best" one, so the 20 are the right 20.
async function searchNearbyPlacesByType(
  placeType: string,
  near: { lat: number; lon: number },
  radiusMeters: number,
  rankBy: RankBy
): Promise<NearbyCandidate[]> {
  const data = await postPlaces(
    PLACES_NEARBY_SEARCH_URL,
    {
      includedTypes: placeTypesFor(placeType),
      rankPreference: rankBy === 'best' ? 'POPULARITY' : 'DISTANCE',
      maxResultCount: 20,
      locationRestriction: { circle: { center: { latitude: near.lat, longitude: near.lon }, radius: radiusMeters } },
    },
    'Places nearby search'
  );
  return toCandidates(data.places);
}

function toCandidates(places: PlacesTextSearchResponse['places']): NearbyCandidate[] {
  return (places ?? [])
    .filter((p) => p.id && p.displayName?.text && p.location?.latitude != null && p.location?.longitude != null)
    .map((p) => {
      const hours = p.currentOpeningHours ?? p.regularOpeningHours;
      const priceLevel = priceLevelFromPlaces(p.priceLevel);
      return {
        id: p.id!,
        name: p.displayName!.text!,
        lat: p.location!.latitude!,
        lon: p.location!.longitude!,
        // null means Places returned no opening-hours data at all — distinct from an empty
        // list, which would mean "confirmed never open" (see isOpenAt).
        openingPeriods: hours?.periods
          ? hours.periods
              .filter((period) => period.open)
              .map((period) => {
                // Places leaves `close` out for a place that is open around the clock; a period
                // that closes the moment it opens is how isOpenAt reads "the whole week".
                const close = period.close ?? period.open!;
                return {
                  openDay: period.open!.day ?? 0,
                  openHour: period.open!.hour ?? 0,
                  openMinute: period.open!.minute ?? 0,
                  closeDay: close.day ?? 0,
                  closeHour: close.hour ?? 0,
                  closeMinute: close.minute ?? 0,
                };
              })
          : null,
        weekdayDescriptions: hours?.weekdayDescriptions ?? null,
        ...(p.rating != null ? { rating: p.rating } : {}),
        ...(p.userRatingCount != null ? { userRatingCount: p.userRatingCount } : {}),
        ...(p.editorialSummary?.text ? { editorialSummary: p.editorialSummary.text } : {}),
        ...(p.googleMapsUri ? { mapsUri: p.googleMapsUri } : {}),
        ...(priceLevel !== undefined ? { priceLevel } : {}),
        ...(p.servesVegetarianFood != null ? { servesVegetarianFood: p.servesVegetarianFood } : {}),
        ...(p.outdoorSeating != null ? { outdoorSeating: p.outdoorSeating } : {}),
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
// cheap distance pruning -> mode filtering -> real routing on the survivors only -> opening hours
// at the moment the user would arrive -> filter to the time budget (if any) -> soonest first.
export async function searchNearby(
  userLocation: { lat: number; lon: number; label: string },
  intent: NearbySearchIntent,
  // The time to search for when the user stated none of their own — e.g. when their trip gets them
  // there ("near my stop"). A time they did state always wins.
  defaultDepartureTime: Date | null = null,
  maxRoutedCandidates: number = DEFAULT_MAX_ROUTED_CANDIDATES
): Promise<NearbySearchOutcome> {
  const reference = intent.referenceLocationText
    ? await geocodeReferenceLocation(intent.referenceLocationText, userLocation)
    : null;
  const origin = reference ?? userLocation;
  const originLabel = reference?.name ?? userLocation.label;
  const departureTime = resolveTargetDateTime(new Date(), intent.targetDay, intent.hour, intent.minute) ?? defaultDepartureTime;

  const rankBy = intent.rankBy ?? 'nearest';
  const rankOptions = {
    rankBy,
    requirements: {
      wantsCheap: intent.wantsCheap,
      wantsVegetarian: intent.wantsVegetarian,
      wantsOutdoorSeating: intent.wantsOutdoorSeating,
    },
  };
  // "Closest X" with no limit searches all of greater Auckland, since the answer is simply whatever is
  // closest. "Best X" with no limit can't do the same — the best ramen in the whole region isn't a
  // useful answer to "near me" — so it stays within the ordinary radius.
  const searchRadius = intent.maxMinutes === null && rankBy === 'nearest' ? UNBOUNDED_PRUNE_RADIUS_METERS : PRUNE_RADIUS_METERS;
  // The words and the type are searched together, because each finds what the other misses: the words catch a
  // shop with the right name but a loose Google type, the type catches a chain whose name never says what it
  // sells. The type search is a bonus — if it fails, the search carries on with the words alone.
  const placeType = intent.placeType && intent.placeType !== 'none' ? intent.placeType : null;
  const [byWords, byType] = await Promise.all([
    textSearchPlaces(intent.category, origin, searchRadius),
    placeType
      ? searchNearbyPlacesByType(placeType, origin, searchRadius, rankBy).catch((err) => {
          console.error('Nearby search: type search failed, using the words alone', err);
          return [] as NearbyCandidate[];
        })
      : Promise.resolve([] as NearbyCandidate[]),
  ]);
  const places = mergeCandidates(byWords, byType);

  // The travel time isn't known yet, so this first pass is deliberately loose: it only drops a
  // place that is closed for the whole of the longest trip that could still qualify. The exact
  // check, at the moment the user would actually arrive, happens after routing below. Only done
  // when the user gave a real time — a place confirmed closed at a time they explicitly asked
  // about genuinely isn't a match, however close it is.
  const longestTripMinutes = intent.maxMinutes ?? 60;
  const possiblyOpen = departureTime
    ? places.filter((p) => isOpenDuring(p.openingPeriods ?? null, departureTime, new Date(departureTime.getTime() + longestTripMinutes * 60_000)))
    : places;
  const pruned = selectCandidatesForRouting(origin, possiblyOpen, { ...rankOptions, maxCandidates: maxRoutedCandidates, radiusMeters: searchRadius });
  const eligible = pruned.filter((c) => intent.modes.includes(chooseTravelMode(c.straightLineMeters)));

  const routingTime = departureForRouting(departureTime);
  const routed = await Promise.all(eligible.map((c) => routeToCandidate(origin, c, routingTime)));
  const successful = routed.filter((r): r is RoutedCandidate => r !== null);

  // Opening hours are judged at departure + travel time, not at departure: a place that closes ten
  // minutes after you leave isn't open for a twenty-minute trip. A query with no stated time still
  // isn't filtered by it (the user didn't ask for "open"), only annotated — same reasoning as
  // maxMinutes: an unstated constraint doesn't get enforced just because it has a convenient
  // default value (see the "closest yogost" fix).
  const hoursBase = departureTime ?? new Date();
  const annotated = successful.map((c) => withArrivalHours(c, hoursBase));
  const openOnArrival = departureTime ? annotated.filter((c) => c.isOpenOnArrival !== false) : annotated;

  return {
    results: filterAndRankByDuration(openOnArrival, intent.maxMinutes, DEFAULT_RESULT_LIMIT, rankOptions),
    origin,
    originLabel,
    usedReferenceLocation: reference !== null,
    departureTime,
  };
}
