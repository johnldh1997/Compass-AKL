import { Asset } from 'expo-asset';
import * as FileSystem from 'expo-file-system/legacy';
import * as SQLite from 'expo-sqlite';
import { TransportMode } from '../types';
import { modeFromRouteType } from './gtfs';

// AT's REST API has no stop_times/shapes endpoints (confirmed 404 live) — this queries a
// pre-built SQLite database (assets/gtfs.db, see scripts/build-gtfs-db.py) generated from
// AT's downloadable static GTFS zip instead. The app never downloads or parses GTFS
// itself, only this one-time-built, bundled snapshot.
const DB_NAME = 'gtfs.db';
const DOW_COLUMNS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const LOOKAHEAD_SECONDS = 90 * 60;

export interface ScheduledDeparture {
  tripId: string;
  routeShortName: string;
  mode: TransportMode;
  headsign: string;
  departureTime: string;
}

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

// expo-sqlite's defaultDatabaseDirectory is a bare filesystem path (its own native
// module's convention), but expo-file-system/legacy's functions expect a `file://` URI —
// passing the bare path through caused makeDirectoryAsync to fail live on a real device
// ("Location '...' isn't writable"), since it wasn't resolving to the location intended.
function toFileUri(path: string): string {
  return path.startsWith('file://') ? path : `file://${path}`;
}

async function ensureDatabaseFile(): Promise<void> {
  const dir = toFileUri(SQLite.defaultDatabaseDirectory);
  const destPath = `${dir}/${DB_NAME}`;
  // A sibling file recording the hash of whichever copy is currently on disk — copying
  // once and never again (just checking destPath.exists) meant a later app update that
  // ships a changed assets/gtfs.db would silently keep querying the stale first-ever
  // copy forever, since expo-sqlite always opens whatever's already at this path.
  const hashPath = `${dir}/${DB_NAME}.hash`;

  const asset = Asset.fromModule(require('../../assets/gtfs.db'));
  await asset.downloadAsync();
  if (!asset.localUri) throw new Error('GTFS database asset failed to resolve a local URI');

  const existing = await FileSystem.getInfoAsync(destPath);
  const hashInfo = await FileSystem.getInfoAsync(hashPath);
  const storedHash = hashInfo.exists ? await FileSystem.readAsStringAsync(hashPath) : null;
  if (existing.exists && asset.hash && storedHash === asset.hash) return;

  const dirInfo = await FileSystem.getInfoAsync(dir);
  if (!dirInfo.exists) {
    await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
  }
  if (existing.exists) {
    await FileSystem.deleteAsync(destPath, { idempotent: true });
  }
  await FileSystem.copyAsync({ from: asset.localUri, to: destPath });
  await FileSystem.writeAsStringAsync(hashPath, asset.hash ?? '');
}

async function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) {
    dbPromise = ensureDatabaseFile().then(() => SQLite.openDatabaseAsync(DB_NAME));
  }
  return dbPromise;
}

function dateStamp(date: Date): string {
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
}

// Service ids active on a given calendar date: the weekly pattern in `services`, adjusted
// by same-date exceptions in `calendar_dates` (type 2 removes a normally-running service,
// type 1 adds one that wouldn't otherwise run, e.g. public holidays).
async function getActiveServiceIds(db: SQLite.SQLiteDatabase, date: Date): Promise<number[]> {
  const dow = DOW_COLUMNS[date.getDay()];
  const ymd = dateStamp(date);
  const rows = await db.getAllAsync<{ id: number }>(
    `SELECT id FROM services WHERE ${dow} = 1 AND start_date <= ? AND end_date >= ?
       AND id NOT IN (SELECT service_id FROM calendar_dates WHERE date = ? AND exception_type = 2)
     UNION
     SELECT service_id AS id FROM calendar_dates WHERE date = ? AND exception_type = 1`,
    [ymd, ymd, ymd, ymd]
  );
  return rows.map((r) => r.id);
}

interface DepartureRow {
  trip_id: string;
  route_short_name: string | null;
  route_type: number | null;
  headsign: string | null;
  departure_seconds: number;
}

export async function getScheduledDeparturesForStop(stopId: string, now: Date = new Date()): Promise<ScheduledDeparture[]> {
  const db = await getDb();

  const stopRow = await db.getFirstAsync<{ id: number }>('SELECT id FROM stops WHERE stop_id = ?', [stopId]);
  if (!stopRow) return [];
  const stopIntId = stopRow.id;

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);

  const [todayServices, yesterdayServices] = await Promise.all([
    getActiveServiceIds(db, now),
    getActiveServiceIds(db, yesterday),
  ]);

  const nowSeconds = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);

  const results: ScheduledDeparture[] = [];

  async function queryWindow(serviceIds: number[], minSeconds: number, maxSeconds: number, secondsOffset: number) {
    if (serviceIds.length === 0) return;
    const placeholders = serviceIds.map(() => '?').join(',');
    const rows = await db.getAllAsync<DepartureRow>(
      `SELECT t.trip_id, r.short_name AS route_short_name, r.route_type, h.text AS headsign, d.departure_seconds
       FROM departures d
       LEFT JOIN routes r ON d.route_id = r.id
       LEFT JOIN headsigns h ON d.headsign_id = h.id
       LEFT JOIN trips t ON d.trip_id = t.id
       WHERE d.stop_id = ? AND d.service_id IN (${placeholders})
         AND d.departure_seconds BETWEEN ? AND ?
       ORDER BY d.departure_seconds
       LIMIT 20`,
      [stopIntId, ...serviceIds, minSeconds, maxSeconds]
    );
    for (const row of rows) {
      results.push({
        tripId: row.trip_id,
        routeShortName: row.route_short_name ?? '?',
        mode: modeFromRouteType(row.route_type ?? -1),
        headsign: row.headsign ?? '',
        departureTime: new Date(midnight.getTime() + (row.departure_seconds - secondsOffset) * 1000).toISOString(),
      });
    }
  }

  await queryWindow(todayServices, nowSeconds, nowSeconds + LOOKAHEAD_SECONDS, 0);
  // Yesterday's services can include "after midnight" trips (GTFS allows departure_seconds
  // past 24:00:00) that are actually running right now, in the early hours of today.
  await queryWindow(yesterdayServices, nowSeconds + 86400, nowSeconds + 86400 + LOOKAHEAD_SECONDS, 86400);

  return results.sort((a, b) => a.departureTime.localeCompare(b.departureTime));
}

// Every route short name that stops at any of the given (real AT) stop ids — used to
// find which routes actually serve a set of nearby stops, so route-wide service alerts
// (keyed by route_id, not stop_id) can be matched to "near me" too, not just alerts that
// happen to list one of these exact stops in their own informed_entity.
export async function getRouteShortNamesForStops(stopIds: string[]): Promise<string[]> {
  if (stopIds.length === 0) return [];
  const db = await getDb();
  const placeholders = stopIds.map(() => '?').join(',');
  const rows = await db.getAllAsync<{ short_name: string | null }>(
    `SELECT DISTINCT r.short_name AS short_name
     FROM departures d
     JOIN stops s ON s.id = d.stop_id
     JOIN routes r ON r.id = d.route_id
     WHERE s.stop_id IN (${placeholders})`,
    stopIds
  );
  return rows.map((r) => r.short_name).filter((name): name is string => !!name);
}

// AT often has two stops sharing the same name for opposite directions of travel (one on
// each side of the road) — with nothing to go on but the name, it's unclear which one to
// pick. This resolves each stop to its single most-frequently-scheduled headsign (the
// destination shown on the bus itself), so "towards Britomart" vs "towards Airport" can
// disambiguate two same-named stops in a list. One query for a whole batch of stop ids
// (e.g. a search-results page) rather than one round-trip per row.
export async function getPrimaryHeadsignsForStops(stopIds: string[]): Promise<Map<string, string>> {
  if (stopIds.length === 0) return new Map();
  const db = await getDb();
  const placeholders = stopIds.map(() => '?').join(',');
  const rows = await db.getAllAsync<{ stop_id: string; headsign: string | null; cnt: number }>(
    `SELECT s.stop_id AS stop_id, h.text AS headsign, COUNT(*) AS cnt
     FROM departures d
     JOIN stops s ON s.id = d.stop_id
     LEFT JOIN headsigns h ON d.headsign_id = h.id
     WHERE s.stop_id IN (${placeholders})
     GROUP BY s.stop_id, d.headsign_id
     ORDER BY s.stop_id, cnt DESC`,
    stopIds
  );
  const result = new Map<string, string>();
  for (const row of rows) {
    if (!result.has(row.stop_id) && row.headsign) result.set(row.stop_id, row.headsign);
  }
  return result;
}

export interface GtfsFeedInfo {
  startDate: string;
  endDate: string;
  version: string;
  // Negative once the bundled feed's calendar has run out — a rebuild (fresh gtfs.zip +
  // scripts/build-gtfs-db.py) is needed at that point, since scheduled departures for
  // dates past this simply won't exist in the database.
  daysUntilExpiry: number;
}

function parseYmd(ymd: string): Date {
  return new Date(Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)) - 1, Number(ymd.slice(6, 8)));
}

export async function getFeedInfo(): Promise<GtfsFeedInfo | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ feed_start_date: string; feed_end_date: string; feed_version: string }>(
    'SELECT feed_start_date, feed_end_date, feed_version FROM feed_info LIMIT 1'
  );
  if (!row?.feed_end_date) return null;
  const daysUntilExpiry = Math.round((parseYmd(row.feed_end_date).getTime() - Date.now()) / (24 * 60 * 60 * 1000));
  return { startDate: row.feed_start_date, endDate: row.feed_end_date, version: row.feed_version, daysUntilExpiry };
}

// --- Timetable Drift Check ---
// How many of the given live trip ids the bundled database still knows. Sampled (not the
// whole fleet) to stay under SQLite's bound-variable limit and keep the query cheap.
const DRIFT_SAMPLE_SIZE = 300;
export async function countKnownTrips(tripIds: string[]): Promise<{ matched: number; total: number }> {
  const sample = [...new Set(tripIds)].slice(0, DRIFT_SAMPLE_SIZE);
  if (sample.length === 0) return { matched: 0, total: 0 };
  const db = await getDb();
  const placeholders = sample.map(() => '?').join(',');
  const row = await db.getFirstAsync<{ n: number }>(
    `SELECT COUNT(*) AS n FROM trips WHERE trip_id IN (${placeholders})`,
    sample
  );
  return { matched: row?.n ?? 0, total: sample.length };
}

// Time window (seconds) a candidate trip's departure from the boarding stop must fall
// within to be considered a match at all — well outside this, it's a different trip
// entirely, not just a slightly-off schedule.
const TRIP_MATCH_TOLERANCE_SECONDS = 10 * 60;

interface TripStopRow {
  int_stop_id: number;
  stop_id: string;
  departure_seconds: number;
}

// Google's Routes API has no concept of AT's static trip_id — it only gives a route
// short name, a departure time, and the board/alight stop's own name+coordinates. This
// resolves those to a specific AT static trip (by nearest-departure-time match on the
// same route from the same stop, confirmed by the alight stop actually appearing later
// in that trip's own stop sequence) so every intermediate stop it passes can be read
// back out of the bundled database. Best-effort, like getShapeForTrip above — a route
// with an unmatched trip (a timing edge case, or a > 10 min schedule/live drift) simply
// returns no stops rather than guessing.
//
// departureStopIds/arrivalStopIds are every AT stop within match range of Google's own
// board/alight coordinate, not just one — a through-station (e.g. Glen Innes, where the
// Eastern Line's two directions meet) has a separate stop_id per platform, often only
// metres apart, so picking a single nearest one before even knowing which trip it is can
// silently pick the wrong platform. Checking a trip's sequence against the whole candidate
// set instead means whichever platform that specific trip actually uses is still found.
export async function getStopsForTransitStep(
  routeShortName: string,
  departureStopIds: string[],
  arrivalStopIds: string[],
  departureTimestamp: string
): Promise<string[]> {
  const db = await getDb();

  const departureDate = new Date(departureTimestamp);
  const yesterday = new Date(departureDate);
  yesterday.setDate(yesterday.getDate() - 1);
  const [todayServices, yesterdayServices] = await Promise.all([
    getActiveServiceIds(db, departureDate),
    getActiveServiceIds(db, yesterday),
  ]);

  const routeRows = await db.getAllAsync<{ id: number }>('SELECT id FROM routes WHERE short_name = ?', [routeShortName]);
  if (routeRows.length === 0) return [];
  const routeIds = routeRows.map((r) => r.id);

  async function resolveInternalIds(stopIds: string[]): Promise<number[]> {
    const placeholders = stopIds.map(() => '?').join(',');
    const rows = await db.getAllAsync<{ id: number }>(`SELECT id FROM stops WHERE stop_id IN (${placeholders})`, stopIds);
    return rows.map((r) => r.id);
  }
  const [departureStopIntIds, arrivalStopIntIds] = await Promise.all([
    resolveInternalIds(departureStopIds),
    resolveInternalIds(arrivalStopIds),
  ]);
  if (departureStopIntIds.length === 0 || arrivalStopIntIds.length === 0) return [];
  const arrivalStopIntIdSet = new Set(arrivalStopIntIds);

  const midnight = new Date(departureDate);
  midnight.setHours(0, 0, 0, 0);
  const targetSeconds = Math.round((departureDate.getTime() - midnight.getTime()) / 1000);
  const routePlaceholders = routeIds.map(() => '?').join(',');
  const departurePlaceholders = departureStopIntIds.map(() => '?').join(',');

  async function findCandidateTrips(serviceIds: number[], secondsOffset: number) {
    if (serviceIds.length === 0) return [];
    const servicePlaceholders = serviceIds.map(() => '?').join(',');
    const target = targetSeconds - secondsOffset;
    return db.getAllAsync<{ trip_id: number }>(
      `SELECT d.trip_id FROM departures d
       WHERE d.stop_id IN (${departurePlaceholders}) AND d.route_id IN (${routePlaceholders}) AND d.service_id IN (${servicePlaceholders})
         AND ABS(d.departure_seconds - ?) <= ?
       ORDER BY ABS(d.departure_seconds - ?) ASC
       LIMIT 5`,
      [...departureStopIntIds, ...routeIds, ...serviceIds, target, TRIP_MATCH_TOLERANCE_SECONDS, target]
    );
  }

  // Yesterday's services can include an "after midnight" trip (GTFS allows departure_seconds
  // past 24:00:00) that's actually the one running right now — same +86400 convention used
  // in getScheduledDeparturesForStop above.
  const [todayCandidates, yesterdayCandidates] = await Promise.all([
    findCandidateTrips(todayServices, 0),
    findCandidateTrips(yesterdayServices, -86400),
  ]);

  for (const candidate of [...todayCandidates, ...yesterdayCandidates]) {
    const rows = await db.getAllAsync<TripStopRow>(
      `SELECT d.stop_id AS int_stop_id, s.stop_id AS stop_id, d.departure_seconds AS departure_seconds
       FROM departures d JOIN stops s ON s.id = d.stop_id
       WHERE d.trip_id = ? ORDER BY d.departure_seconds ASC`,
      [candidate.trip_id]
    );
    const departureIndex = rows.findIndex((r) => departureStopIntIds.includes(r.int_stop_id));
    const arrivalIndex = rows.findIndex((r) => arrivalStopIntIdSet.has(r.int_stop_id));
    if (departureIndex !== -1 && arrivalIndex !== -1 && arrivalIndex > departureIndex) {
      return rows.slice(departureIndex, arrivalIndex + 1).map((r) => r.stop_id);
    }
  }

  return [];
}

export async function getShapeForTrip(tripId: string): Promise<{ latitude: number; longitude: number }[]> {
  const db = await getDb();

  const tripRow = await db.getFirstAsync<{ id: number }>('SELECT id FROM trips WHERE trip_id = ?', [tripId]);
  if (!tripRow) return [];

  const shapeRow = await db.getFirstAsync<{ shape_id: number }>(
    'SELECT shape_id FROM trip_shapes WHERE trip_id = ?',
    [tripRow.id]
  );
  if (!shapeRow) return [];

  const points = await db.getAllAsync<{ lat: number; lon: number }>(
    'SELECT lat, lon FROM shapes WHERE shape_id = ? ORDER BY seq',
    [shapeRow.shape_id]
  );
  return points.map((p) => ({ latitude: p.lat / 1_000_000, longitude: p.lon / 1_000_000 }));
}
