import AsyncStorage from '@react-native-async-storage/async-storage';
import { JourneyEndpoint, JourneyRoute } from '../types';

const STORAGE_KEY = 'auckland-transit:active-journey';

// If a journey is abandoned abnormally (app force-killed mid-route, never "ended" properly)
// this persisted state would otherwise silently resurrect on every future cold launch or
// Journey Planner visit — including days later. A journey this old is surely over by now
// regardless of what its own steps say, so treat it as stale and drop it rather than trying
// to resume into it. Generous on purpose: comfortably covers any realistic single trip.
const STALE_AFTER_MS = 6 * 60 * 60 * 1000;

interface ActiveJourneyData {
  route: JourneyRoute;
  searchedDepartureTime: string;
  // Where the trip is heading, so "Plan again from here" still works after the app is reopened mid-route.
  // Absent on journeys saved before this was recorded.
  destination?: JourneyEndpoint;
}

// The single source of truth for "is a journey currently active," persisted so it survives
// the app process being killed and relaunched — JourneyPlannerScreen restores from this on
// mount rather than losing the in-progress route, and journeyNotification.ts's background
// task reads it too (a headless JS context has no access to React state).
export async function saveActiveJourney(
  route: JourneyRoute,
  searchedDepartureTime: Date,
  destination?: JourneyEndpoint
): Promise<void> {
  await AsyncStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ route, searchedDepartureTime: searchedDepartureTime.toISOString(), destination })
  );
}

export async function loadActiveJourney(): Promise<ActiveJourneyData | null> {
  const raw = await AsyncStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  let data: ActiveJourneyData;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (Date.now() - new Date(data.searchedDepartureTime).getTime() > STALE_AFTER_MS) {
    await clearActiveJourney();
    return null;
  }
  return data;
}

export async function clearActiveJourney(): Promise<void> {
  await AsyncStorage.removeItem(STORAGE_KEY);
}
