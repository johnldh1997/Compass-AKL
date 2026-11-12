// --- Timetable Drift Check ---
// AT re-issues trip IDs whenever it publishes a new schedule, so the bundled timetable can
// stop matching the live feed well before its calendar end date. The share of live trips
// the bundled database still recognises is the direct measure of that.
const MIN_SAMPLE = 20;
const MIN_MATCH_RATE = 0.8;

export function isFeedDrifted(matched: number, total: number): boolean {
  // Too few live trips (night, feed outage) to say anything — don't cry wolf.
  if (total < MIN_SAMPLE) return false;
  return matched / total < MIN_MATCH_RATE;
}
