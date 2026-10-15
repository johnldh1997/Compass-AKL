// --- Which Bus Are You On? ---
// During a journey the app polls every live vehicle on the route's lines — but which one is carrying you? The
// feed doesn't say, and comparing a bus's reported position with yours doesn't work directly: the feed runs
// behind (see VehiclePosition.timestampMs — typically seconds, sometimes half a minute), and a bus covers
// ~10 m a second, so "where the bus was when it reported" can sit hundreds of metres behind "where you are now".
//
// What does work is comparing like with like: where was the bus when it reported, and where were *you* at that
// same moment? You keep a trail of your own recent GPS fixes, so your position at any recent time can be
// interpolated. A bus you're riding was within a few tens of metres of you at its own timestamp, heading the
// way you were going, whatever the lag. Pure and network-free (no Expo imports), so it runs under `node --test`.
import type { VehiclePosition } from '../types';
import { angleDifference, bearingDegrees, distanceMeters, type LatLon } from './geo.ts';

export interface TrailFix extends LatLon {
  // When the fix was taken (ms since epoch).
  t: number;
}

// How long a trail is kept — enough to cover the worst feed lag we see (a few minutes) with room to spare.
export const TRAIL_KEEP_MS = 5 * 60_000;

// A bus counts as yours when it was this close to where you were at its own report time. GPS is good to
// ~10-20 m, the bus's own fix is similar, and interpolating between your fixes adds a little more; streets in
// the CBD are ~80-100 m apart, so this is also tight enough not to grab a bus on the next street.
export const MATCH_RADIUS_M = 60;

// Once matched, a bus stays yours until it is clearly somewhere else — a stop-start crawl or a few seconds of
// GPS drift must not make the match flicker on and off.
export const KEEP_RADIUS_M = 160;

// You must be moving like a vehicle to *start* a match: standing at a stop with a bus pulled in next to you is
// not "on board", and neither is walking beside one. Walking is ~1.4 m/s; a bus pulling away is well over 3.
export const MIN_BOARDING_SPEED_MPS = 2.5;

// A bus heading the opposite way past you at the same moment is not yours. Generous, because a bus turns
// corners and a short trail gives only a rough course.
export const MAX_COURSE_DIFFERENCE_DEG = 75;

// If your last fix is older than this when the bus reported, we can't say where you were then.
const MAX_EXTRAPOLATION_MS = 15_000;

// A matched bus that drops out of the feed for a moment (a hiccup, not a trip ending) is kept this long.
export const KEEP_MISSING_MS = 45_000;

export function trimTrail(trail: TrailFix[], now: number): TrailFix[] {
  const cutoff = now - TRAIL_KEEP_MS;
  const first = trail.findIndex((fix) => fix.t >= cutoff);
  return first === -1 ? [] : first === 0 ? trail : trail.slice(first);
}

// Where you were at time `t`, interpolated between your two surrounding fixes. A time just after your last fix
// (the bus reported a few seconds after your latest reading) uses that fix; anything earlier than the trail, or
// more than MAX_EXTRAPOLATION_MS after it, is unknown.
export function userPositionAt(trail: TrailFix[], t: number): LatLon | null {
  if (trail.length === 0) return null;
  const first = trail[0];
  const last = trail[trail.length - 1];
  if (t < first.t) return null;
  if (t >= last.t) return t - last.t <= MAX_EXTRAPOLATION_MS ? last : null;
  for (let i = 1; i < trail.length; i++) {
    if (trail[i].t >= t) {
      const a = trail[i - 1];
      const b = trail[i];
      const span = b.t - a.t;
      const f = span === 0 ? 0 : (t - a.t) / span;
      return { latitude: a.latitude + (b.latitude - a.latitude) * f, longitude: a.longitude + (b.longitude - a.longitude) * f };
    }
  }
  return last;
}

// How fast you're moving (m/s) over roughly the last `windowMs`, from the trail itself. Null with too little
// data to say.
export function trailSpeedMps(trail: TrailFix[], now: number, windowMs = 20_000): number | null {
  const recent = trail.filter((fix) => fix.t >= now - windowMs);
  if (recent.length < 2) return null;
  const a = recent[0];
  const b = recent[recent.length - 1];
  const seconds = (b.t - a.t) / 1000;
  return seconds <= 0 ? null : distanceMeters(a, b) / seconds;
}

// The compass course you've been travelling on over roughly the last `windowMs`; null while you've barely
// moved (a course from a few metres of GPS jitter is noise).
export function trailCourseDegrees(trail: TrailFix[], now: number, windowMs = 30_000, minMetres = 25): number | null {
  const recent = trail.filter((fix) => fix.t >= now - windowMs);
  if (recent.length < 2) return null;
  const a = recent[0];
  const b = recent[recent.length - 1];
  return distanceMeters(a, b) >= minMetres ? bearingDegrees(a, b) : null;
}

export interface BoardedMatch {
  vehicleId: string;
  // How far the bus was from you at its own report time (m) — smaller is a surer match.
  distanceMeters: number;
}

export interface MatchInput {
  trail: TrailFix[];
  vehicles: VehiclePosition[];
  // The route short name of the transit leg you're on ("70", "E-W"); only that line's buses are candidates.
  lineName: string;
  now: number;
  // The bus matched last time, if any: which line it was matched for, and when it was last seen in the feed. A
  // match for a different line (you've changed buses) is ignored.
  previous?: { vehicleId: string; lineName: string; lastSeenAt: number } | null;
}

function distanceAtReportTime(trail: TrailFix[], vehicle: VehiclePosition, now: number): number | null {
  // A vehicle with no report time is compared as if it had just reported — the best we can do, and the same
  // as the old behaviour.
  const at = vehicle.timestampMs ?? now;
  const user = userPositionAt(trail, at);
  return user ? distanceMeters(user, { latitude: vehicle.lat, longitude: vehicle.lon }) : null;
}

function headsTheSameWay(vehicle: VehiclePosition, course: number | null): boolean {
  if (course === null || vehicle.bearing === undefined || !Number.isFinite(vehicle.bearing)) return true;
  return Math.abs(angleDifference(course, vehicle.bearing)) <= MAX_COURSE_DIFFERENCE_DEG;
}

// The bus you're on, or null. A bus already matched stays matched while it remains plausibly yours (KEEP_RADIUS_M)
// or briefly missing from the feed; a new match needs you to be moving like a vehicle, a bus of your line that
// was within MATCH_RADIUS_M of you when it reported, and heading the way you are.
export function matchBoardedVehicle(input: MatchInput): BoardedMatch | null {
  const { trail, vehicles, lineName, now, previous } = input;
  const candidates = vehicles.filter((v) => v.routeShortName === lineName);

  if (previous && previous.lineName === lineName) {
    const sticky = candidates.find((v) => v.vehicleId === previous.vehicleId);
    if (sticky) {
      const d = distanceAtReportTime(trail, sticky, now);
      // Can't evaluate (no trail yet at its report time) is not evidence it's a different bus: keep it.
      if (d === null || d <= KEEP_RADIUS_M) return { vehicleId: sticky.vehicleId, distanceMeters: d ?? 0 };
    } else if (now - previous.lastSeenAt <= KEEP_MISSING_MS) {
      return { vehicleId: previous.vehicleId, distanceMeters: 0 };
    }
  }

  const speed = trailSpeedMps(trail, now);
  if (speed === null || speed < MIN_BOARDING_SPEED_MPS) return null;
  const course = trailCourseDegrees(trail, now);

  let best: BoardedMatch | null = null;
  for (const vehicle of candidates) {
    if (!headsTheSameWay(vehicle, course)) continue;
    const d = distanceAtReportTime(trail, vehicle, now);
    if (d === null || d > MATCH_RADIUS_M) continue;
    if (!best || d < best.distanceMeters) best = { vehicleId: vehicle.vehicleId, distanceMeters: d };
  }
  return best;
}
