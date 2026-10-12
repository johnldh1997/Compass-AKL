// --- Nearby Chat Turn ---
// What happens between "the user sent a message" and "the chat has an answer": the one pipeline behind the
// Find Nearby screen. The screen owns what's drawn (messages, the spinner, navigation); this owns the
// decisions, and reports back through callbacks so results can reach the screen the moment they exist
// instead of waiting for the slower written summary.
//
// A message is read first (messageKind), then goes one of three ways:
//  - search: find places — from the user's location, a named place, their saved home, a saved place
//    ("near work"), or where their planned trip ends ("near my stop") — rank them, show them, then write
//    a summary.
//  - question: answer it from the results already on screen. No Places or Routes call is made.
//  - action: do something with one of those results (open directions, open the map).
import { TranslationKey } from '../i18n/translations';
import { FavoritePlace, JourneyEndpoint, JourneyStop } from '../types';
import { loadActiveJourney } from './activeJourney';
import { clampToNow } from './departureTime';
import { getCurrentLocationEndpoint } from './location';
import {
  findSavedPlace,
  journeyStopFromRoute,
  mapsUrlFor,
  pickActionTarget,
  RecentTurn,
  savedPlaceLabel,
  savedPlaceLabels,
  toShownResults,
} from './nearbyConversation';
import {
  answerQuestion,
  explainResults,
  NearbySearchResult,
  ParsedNearbyQuery,
  parseNearbyQuery,
  resolveEndpointCoordinates,
  searchNearby,
} from './nearbySearch';

// A fresh GPS fix (getCurrentLocationEndpoint, deliberately not the faster-but-stale getFastCoordinates —
// see alerts.ts) can occasionally hang far longer than a normal network call, especially indoors. Without
// a bound here the spinner never resolves — matches the LOCATION_TIMEOUT_MS pattern in VehicleMap.tsx/
// ChooseOnMapScreen.tsx, just longer since accuracy matters more for "what's near me" than for map centering.
const STEP_TIMEOUT_MS = 12_000;

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('nearby search step timed out')), STEP_TIMEOUT_MS));
  return Promise.race([promise, timeout]);
}

// --- What The Screen Hears ---
// 'answering' (a question about results already on screen) locks the input like a search does; 'writing'
// (the summary after results are shown) doesn't, since the results are already usable by then.
export type ProgressStep = 'locating' | 'understanding' | 'searching' | 'answering' | 'writing';

export type TurnOutput =
  | { kind: 'error'; text: string }
  // A clarifying question — a normal part of the conversation, not a failure.
  | { kind: 'question'; text: string }
  // A written reply: a search summary, an answer, or a note that an action is under way.
  | { kind: 'summary'; text: string }
  | {
      kind: 'results';
      results: NearbySearchResult[];
      origin: JourneyEndpoint;
      // Whether to show where the search ran from — only when that wasn't simply where they are.
      usedReferenceLocation: boolean;
      departureTime: Date | null;
    };

// The most recent search the chat is showing — what a question or action refers to.
export interface ShownSearch {
  results: NearbySearchResult[];
  origin: JourneyEndpoint;
  departureTime: Date | null;
}

export interface TurnInput {
  text: string;
  lastIntent: ParsedNearbyQuery | null;
  shown: ShownSearch | null;
  recentTurns: RecentTurn[];
  savedPlaces: FavoritePlace[];
  homeAddress: JourneyEndpoint | null;
  // Set when the chat was opened from a planned trip; otherwise a started trip is looked up when needed.
  journeyStop: JourneyStop | null;
}

export interface TurnCallbacks {
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
  setProgress: (step: ProgressStep | null) => void;
  emit: (output: TurnOutput) => void;
  // Called with a search's parsed intent so a short follow-up can be read as a refinement of it. Not
  // called for a question or action: those leave the search being refined as it was.
  setLastIntent: (intent: ParsedNearbyQuery) => void;
  openDirections: (target: { origin: JourneyEndpoint; departureTime: Date | null; result: NearbySearchResult }) => void;
  openUrl: (url: string) => void;
  // False once a newer message has been sent — a slow summary for the old one should then just be dropped.
  isCurrent: () => boolean;
}

async function startedTripStop(): Promise<JourneyStop | null> {
  try {
    const data = await loadActiveJourney();
    return data ? journeyStopFromRoute(data.route) : null;
  } catch {
    return null;
  }
}

export async function runNearbyTurn(input: TurnInput, callbacks: TurnCallbacks): Promise<void> {
  const { t, setProgress, emit } = callbacks;
  const { text, shown, savedPlaces, homeAddress } = input;

  function fail(key: TranslationKey) {
    emit({ kind: 'error', text: t(key) });
    setProgress(null);
  }

  // The user's own location is wanted by most searches but by no question or action, and a fresh fix can
  // be slow — so it starts alongside the parse when the message can only be a search (nothing on screen
  // to ask about), and otherwise waits until a search turns out to need it.
  let locationRequest: Promise<JourneyEndpoint | null> | null = null;
  function requestLocation(): Promise<JourneyEndpoint | null> {
    locationRequest ??= withTimeout(getCurrentLocationEndpoint()).catch((err) => {
      console.error('Nearby search: location fetch failed', err);
      return null;
    });
    return locationRequest;
  }
  if (!shown) requestLocation();

  // --- Read The Message ---
  setProgress('understanding');
  let intent: ParsedNearbyQuery;
  try {
    intent = await withTimeout(
      parseNearbyQuery(text, {
        previousIntent: input.lastIntent,
        shownResults: shown ? toShownResults(shown.results) : undefined,
        savedPlaces: savedPlaceLabels(savedPlaces),
      })
    );
  } catch (err) {
    console.error('Nearby search: query parsing failed', err);
    fail('nearby.loadError');
    return;
  }
  // Nothing on screen means nothing to ask about or act on, whatever the model made of the wording.
  const kind = shown ? (intent.messageKind ?? 'search') : 'search';

  // --- Question ---
  if (kind === 'question' && shown) {
    setProgress('answering');
    try {
      emit({ kind: 'summary', text: await withTimeout(answerQuestion(text, shown.results, input.recentTurns)) });
    } catch (err) {
      console.error('Nearby search: answering failed', err);
      emit({ kind: 'error', text: t('nearby.loadError') });
    }
    setProgress(null);
    return;
  }

  // --- Action ---
  if (kind === 'action' && shown) {
    const index = pickActionTarget(intent.actionTargetIndex, shown.results.length);
    if (index === null) {
      emit({ kind: 'question', text: intent.clarifyingQuestion || t('nearby.whichOne') });
      setProgress(null);
      return;
    }
    const result = shown.results[index];
    if (intent.actionType === 'maps') {
      emit({ kind: 'summary', text: t('nearby.openingMaps', { name: result.name }) });
      callbacks.openUrl(mapsUrlFor(result));
    } else {
      emit({ kind: 'summary', text: t('nearby.openingDirections', { name: result.name }) });
      callbacks.openDirections({ origin: shown.origin, departureTime: shown.departureTime, result });
    }
    setProgress(null);
    return;
  }

  // --- Search ---
  // Kept even when not confident — a clarifying question's answer is a follow-up to *this* partial
  // intent, so the next turn needs it as context to merge into, not a blank slate.
  callbacks.setLastIntent(intent);
  if (!intent.confident || !intent.category) {
    emit(intent.clarifyingQuestion ? { kind: 'question', text: intent.clarifyingQuestion } : { kind: 'error', text: t('nearby.notUnderstood') });
    setProgress(null);
    return;
  }

  // Where from, and (for a trip) when. "Home" is a personal reference to the app's own saved address,
  // never a business name to geocode through Places — without this, "home" was being searched literally
  // and matching whatever nearby business happened to be named "Home" (e.g. a real "Home Cafe").
  setProgress('searching');
  let searchOrigin: { lat: number; lon: number; label: string };
  let defaultDepartureTime: Date | null = null;
  // Shown as a "near <place>" chip on the results when the search didn't just start from where they are.
  let startedElsewhere = false;

  if (intent.useJourneyDestination) {
    const stop = input.journeyStop ?? (await startedTripStop());
    if (!stop) {
      fail('nearby.noJourney');
      return;
    }
    searchOrigin = { lat: stop.lat, lon: stop.lon, label: stop.name };
    // The trip can't have them there before now, so a stale arrival time is brought forward.
    defaultDepartureTime = clampToNow(new Date(stop.arrivalIso));
    startedElsewhere = true;
  } else if (intent.savedPlaceLabel) {
    const place = findSavedPlace(intent.savedPlaceLabel, savedPlaces);
    if (!place) {
      fail('nearby.savedPlaceNotFound');
      return;
    }
    const coords = await resolveEndpointCoordinates(place.endpoint);
    if (!coords) {
      fail('nearby.loadError');
      return;
    }
    searchOrigin = { lat: coords.lat, lon: coords.lon, label: savedPlaceLabel(place) };
    startedElsewhere = true;
  } else if (intent.useSavedHome) {
    if (!homeAddress) {
      fail('nearby.homeNotSet');
      return;
    }
    const coords = await resolveEndpointCoordinates(homeAddress);
    if (!coords) {
      fail('nearby.loadError');
      return;
    }
    searchOrigin = { lat: coords.lat, lon: coords.lon, label: homeAddress.label };
  } else {
    setProgress('locating');
    const here = await requestLocation();
    if (!here || here.kind !== 'coordinates') {
      fail('nearby.locationNeeded');
      return;
    }
    searchOrigin = { lat: here.lat, lon: here.lon, label: here.label };
    setProgress('searching');
  }

  let outcome;
  try {
    // A start point already worked out above beats any place name the model also picked out.
    const overridden = intent.useJourneyDestination || !!intent.savedPlaceLabel || intent.useSavedHome;
    outcome = await withTimeout(
      searchNearby(searchOrigin, overridden ? { ...intent, referenceLocationText: null } : intent, defaultDepartureTime)
    );
  } catch (err) {
    console.error('Nearby search: place search failed', err);
    fail('nearby.loadError');
    return;
  }
  if (outcome.results.length === 0) {
    fail('nearby.noResults');
    return;
  }

  // The results go on screen now; the written summary follows as its own message when it's ready.
  emit({
    kind: 'results',
    results: outcome.results,
    origin: { kind: 'coordinates', lat: outcome.origin.lat, lon: outcome.origin.lon, label: outcome.originLabel },
    usedReferenceLocation: outcome.usedReferenceLocation || startedElsewhere,
    departureTime: outcome.departureTime,
  });
  setProgress('writing');

  // Best-effort: the results are the real value here, so a failed or slow summary just means no summary
  // message, rather than losing anything already shown.
  let summary: string | undefined;
  try {
    summary = await withTimeout(explainResults(text, outcome.results, outcome.departureTime !== null, intent.rankBy));
  } catch (err) {
    console.error('Nearby search: explanation failed', err);
  }
  // A newer message took over while this was being written — its own progress and answer apply now.
  if (!callbacks.isCurrent()) return;
  if (summary) emit({ kind: 'summary', text: summary });
  setProgress(null);
}
