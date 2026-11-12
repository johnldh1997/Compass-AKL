import { countKnownTrips } from './gtfsStatic';
import { getVehiclePositions } from './vehicles';

// --- Timetable Drift Check ---
// How many of the live fleet's trips the bundled timetable still recognises (see feedDrift.ts
// for what counts as drift). Rejects when the live feed can't be fetched.
export async function getFeedMatch(): Promise<{ matched: number; total: number }> {
  const vehicles = await getVehiclePositions();
  return countKnownTrips(vehicles.map((v) => v.tripId).filter((id): id is string => !!id));
}
