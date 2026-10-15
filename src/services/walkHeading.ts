// --- Which Way Is The Map Facing While You Walk? ---
// On a walking leg the map should face the way you're going, so "turn left" on the route is to the left of
// the screen. The direction comes from the planned path (look a short way ahead along it, so the map starts
// turning before you reach a corner), falling back to the way your phone says you're moving when you're off
// the path. Pure and network-free (no Expo imports), so it runs under `node --test`.
import { angleDifference, bearingDegrees, distanceMeters, projectToMeters, type LatLon } from './geo.ts';

// How far ahead along the path the map looks. Far enough that the map begins to turn into a corner a few steps
// early, near enough that it doesn't swing round for a corner two blocks away.
export const LOOKAHEAD_M = 25;

// Beyond this far from the path you're not following it, so its direction says nothing about yours.
export const ON_PATH_M = 30;

// A phone's reported heading is only meaningful while you're actually moving.
export const MIN_HEADING_SPEED_MPS = 0.8;

interface PathPoint {
  point: LatLon;
  segment: number;
  distance: number;
}

function closestPointOnPath(path: LatLon[], position: LatLon): PathPoint | null {
  let best: PathPoint | null = null;
  for (let i = 0; i < path.length - 1; i++) {
    const a = projectToMeters(position, path[i]);
    const b = projectToMeters(position, path[i + 1]);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSq = dx * dx + dy * dy;
    const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, (-a.x * dx - a.y * dy) / lengthSq));
    const cx = a.x + t * dx;
    const cy = a.y + t * dy;
    const distance = Math.hypot(cx, cy);
    if (!best || distance < best.distance) {
      best = {
        point: {
          latitude: path[i].latitude + (path[i + 1].latitude - path[i].latitude) * t,
          longitude: path[i].longitude + (path[i + 1].longitude - path[i].longitude) * t,
        },
        segment: i,
        distance,
      };
    }
  }
  return best;
}

// The direction the planned path runs, a short way ahead of where you are on it: 0 = north, 90 = east. Null when
// there's no usable path, or you're too far from it for it to say which way you're facing.
export function pathBearingAhead(path: LatLon[], position: LatLon, aheadMeters = LOOKAHEAD_M, onPathMeters = ON_PATH_M): number | null {
  if (path.length < 2) return null;
  const closest = closestPointOnPath(path, position);
  if (!closest || closest.distance > onPathMeters) return null;

  // Walk forward along the path from the closest point until `aheadMeters` is used up (or the path ends).
  let remaining = aheadMeters;
  let from = closest.point;
  let target = closest.point;
  for (let i = closest.segment + 1; i < path.length && remaining > 0; i++) {
    const leg = distanceMeters(from, path[i]);
    if (leg >= remaining) {
      const f = leg === 0 ? 0 : remaining / leg;
      target = {
        latitude: from.latitude + (path[i].latitude - from.latitude) * f,
        longitude: from.longitude + (path[i].longitude - from.longitude) * f,
      };
      remaining = 0;
    } else {
      target = path[i];
      remaining -= leg;
      from = path[i];
    }
  }

  // At the very end of the path there's nothing ahead: keep the direction the last stretch ran.
  if (distanceMeters(closest.point, target) < 2) {
    const last = path[path.length - 1];
    const before = path[path.length - 2];
    return bearingDegrees(before, last);
  }
  return bearingDegrees(closest.point, target);
}

export interface WalkHeadingInput {
  // The current walking step's path.
  path: LatLon[];
  position: LatLon;
  // Your phone's reported heading (degrees, 0 = north) and speed (m/s), when it has them.
  gpsHeading?: number | null;
  speedMps?: number | null;
}

// The direction the map should face, or null to leave it as it is.
export function chooseWalkHeading({ path, position, gpsHeading, speedMps }: WalkHeadingInput): number | null {
  const along = pathBearingAhead(path, position);
  if (along !== null) return along;
  if (typeof gpsHeading === 'number' && Number.isFinite(gpsHeading) && gpsHeading >= 0 && (speedMps ?? 0) >= MIN_HEADING_SPEED_MPS) {
    return gpsHeading;
  }
  return null;
}

// Eases from the heading the map already has toward a new one, taking the short way round (350° -> 10° turns 20°,
// not 340°), and ignoring changes too small to be worth a camera move. The easing is light on purpose: the target
// comes from the planned path, which is steady, and fixes arrive only every few seconds — a heavier ease left the
// map still facing the old street a block after the turn (measured on a simulated walk). The camera's own
// animation does the visual smoothing between updates.
export function smoothHeading(previous: number | null, next: number, alpha = 0.8, deadbandDegrees = 4): number {
  if (previous === null) return (next + 360) % 360;
  const diff = angleDifference(previous, next);
  if (Math.abs(diff) < deadbandDegrees) return previous;
  return (previous + diff * alpha + 360) % 360;
}
