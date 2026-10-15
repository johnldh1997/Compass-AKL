// --- Small Geometry Helpers ---
// Flat, dependency-free map maths shared by the pure modules that decide things from GPS fixes (which bus
// you're on, which way the map should face). No Expo or React imports, so they run under `node --test`.
export type LatLon = { latitude: number; longitude: number };

const EARTH_RADIUS_M = 6371000;
const toRad = (deg: number) => (deg * Math.PI) / 180;
const toDeg = (rad: number) => (rad * 180) / Math.PI;

export function distanceMeters(a: LatLon, b: LatLon): number {
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

// Compass bearing from one point to another: 0 = north, 90 = east, in [0, 360).
export function bearingDegrees(from: LatLon, to: LatLon): number {
  const dLon = toRad(to.longitude - from.longitude);
  const lat1 = toRad(from.latitude);
  const lat2 = toRad(to.latitude);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

// The signed shortest turn from `from` to `to`, in (-180, 180]: +20 means 20° clockwise. A bearing of 359°
// and one of 1° are 2° apart, not 358°.
export function angleDifference(from: number, to: number): number {
  let diff = (((to - from) % 360) + 540) % 360 - 180;
  if (diff === -180) diff = 180;
  return diff;
}

// Flat local metres east (x) and north (y) of `origin` — accurate to well under a metre across a few km,
// which is all any of this needs.
export function projectToMeters(origin: LatLon, point: LatLon): { x: number; y: number } {
  return {
    x: toRad(point.longitude - origin.longitude) * Math.cos(toRad(origin.latitude)) * EARTH_RADIUS_M,
    y: toRad(point.latitude - origin.latitude) * EARTH_RADIUS_M,
  };
}
