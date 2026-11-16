import type { Departure } from '../types';

// --- Next Buses ---
// A bus that left a minute ago may still be pulling away; older than this and it's gone.
const GRACE_MS = 60_000;

// The next few departures of one line from a stop, soonest first. Pure and network-free (no Expo imports), so
// it runs under `node --test`. Cancelled trips are skipped; a trip leaving just now is kept.
export function pickNextBuses(departures: Departure[], lineName: string, now: number, count = 3): Departure[] {
  return departures
    .filter((d) => d.routeShortName === lineName && !d.cancelled && new Date(d.estimatedTime).getTime() >= now - GRACE_MS)
    .sort((a, b) => a.estimatedTime.localeCompare(b.estimatedTime))
    .slice(0, count);
}
