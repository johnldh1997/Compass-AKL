// --- Nearby Conversation Logic ---
// The pure, network-free decisions behind the Find Nearby chat beyond a plain search: what the model is
// told about the results on screen, how an "action" is pinned to one of them, how a saved place is found
// from the name the user used, and where a planned trip ends. No Expo or React imports, so it runs under
// `node --test` (see nearbyConversation.test.ts) like nearbyRanking.ts.
// Type-only imports (erased at runtime) so this file stays loadable by `node --test` without the app's bundler.
import type { FavoritePlace, JourneyRoute, JourneyStop } from '../types';
import type { RoutedCandidate } from './nearbyRanking';

// --- Results On Screen ---
// The compact form of a result the parser is given so a message like "take me to the second one" or
// "which is cheapest?" has a numbered list to point at. Mirrors ShownResultSchema in server/src/parse.ts.
export interface ShownResult {
  name: string;
  minutes: number;
  mode: 'WALK' | 'TRANSIT';
  route?: string;
  rating?: number;
  ratingCount?: number;
  priceLevel?: number;
  vegetarian?: boolean;
  outdoorSeating?: boolean;
  hours?: 'open' | 'closes soon' | 'closed';
}

export function toShownResults(results: RoutedCandidate[]): ShownResult[] {
  return results.map((r) => ({
    name: r.name,
    minutes: r.durationMinutes,
    mode: r.mode,
    ...(r.routeShortName ? { route: r.routeShortName } : {}),
    ...(r.rating != null ? { rating: r.rating } : {}),
    ...(r.userRatingCount != null ? { ratingCount: r.userRatingCount } : {}),
    ...(r.priceLevel != null ? { priceLevel: r.priceLevel } : {}),
    ...(r.servesVegetarianFood ? { vegetarian: true } : {}),
    ...(r.outdoorSeating ? { outdoorSeating: true } : {}),
    ...(r.isOpenOnArrival == null
      ? {}
      : { hours: !r.isOpenOnArrival ? ('closed' as const) : r.closesInMinutes != null ? ('closes soon' as const) : ('open' as const) }),
  }));
}

// --- Actions ---
// The parser says which numbered result an action means (1-based, 0 for "couldn't tell"). That is the
// model's claim about a list it was shown, so it's checked against the real list before anything acts on it.
export function pickActionTarget(index: number | undefined, resultCount: number): number | null {
  if (index === undefined || !Number.isInteger(index) || index < 1 || index > resultCount) return null;
  return index - 1;
}

// A Google Maps link for a result that has none of its own (Places doesn't always return one).
export function mapsUrlFor(result: { name: string; lat: number; lon: number; mapsUri?: string }): string {
  return result.mapsUri ?? `https://www.google.com/maps/search/?api=1&query=${result.lat},${result.lon}`;
}

// --- Saved Places ---
// "Near work" only means something for a place the user has named, so only those take part: a favourite
// that was never given a name ("Spark Arena", or a street address) is never offered to the parser, which
// also keeps what leaves the phone to the names the user chose to give.
export function savedPlaceLabel(place: FavoritePlace): string {
  return place.nickname?.trim() || place.endpoint.label;
}

const MAX_SAVED_PLACE_LABELS = 30;

// The names sent to the parser so it can match "near work" — each once, in saved order.
export function savedPlaceLabels(places: FavoritePlace[]): string[] {
  const names = places.map((place) => place.nickname?.trim() ?? '').filter((name) => name.length > 0);
  return Array.from(new Set(names)).slice(0, MAX_SAVED_PLACE_LABELS);
}

// The named place the parser picked out. It was told to answer with a name exactly as listed, but the
// match ignores case and surrounding space anyway — a near miss shouldn't turn into "not found".
export function findSavedPlace(label: string, places: FavoritePlace[]): FavoritePlace | null {
  const wanted = label.trim().toLowerCase();
  if (!wanted) return null;
  return places.find((place) => place.nickname?.trim().toLowerCase() === wanted) ?? null;
}

// --- Where A Trip Ends ---
// The stop the last transit leg gets off at, with the time the vehicle gets there — what "near my stop"
// and "open when I arrive" mean. A walking-only route has no stop, so no answer.
export function journeyStopFromRoute(route: JourneyRoute): JourneyStop | null {
  for (let i = route.steps.length - 1; i >= 0; i--) {
    const step = route.steps[i];
    if (step.kind === 'transit' && step.arrivalStop && step.arrivalTimestamp) {
      return {
        name: step.arrivalStop.name,
        lat: step.arrivalStop.lat,
        lon: step.arrivalStop.lon,
        arrivalIso: step.arrivalTimestamp,
      };
    }
  }
  return null;
}

// --- Recent Turns ---
// The last few things said in the chat, for a follow-up question that leans on them ("and the other
// one?"). Result lists are left out: the answer step is given the results themselves.
export interface RecentTurn {
  role: 'user' | 'assistant';
  text: string;
}

interface TurnSource {
  role: 'user' | 'assistant';
  kind?: string;
  text?: string;
}

export function recentTurnsFrom(messages: TurnSource[], limit = 6): RecentTurn[] {
  const turns: RecentTurn[] = [];
  for (const message of messages) {
    if (message.text && (message.role === 'user' || message.kind === 'summary' || message.kind === 'question')) {
      turns.push({ role: message.role, text: message.text });
    }
  }
  return turns.slice(-limit);
}
