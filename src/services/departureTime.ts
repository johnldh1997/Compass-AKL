// --- Departure Time Floor ---
// Pure, no Expo imports (like nearbyRanking.ts), so it runs directly under `node --test`.
//
// A journey search can't usefully start in the past: the picker's value is set once when the
// screen opens (or restored from a saved trip / an old chat result), so by the time someone
// re-searches — e.g. after missing a bus and switching From to their current location — it can
// be an hour stale. Asking for a route "leaving 12:41" at 1:05 returns the bus they already
// missed. Anything earlier than `now` becomes `now`; anything later is left exactly as chosen.
export function clampToNow(requested: Date, now: Date = new Date()): Date {
  return requested.getTime() < now.getTime() ? now : requested;
}
