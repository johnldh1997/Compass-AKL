import { VehiclePosition } from '../types';
import { atFetch, hasApiKey } from './atClient';
import { getRouteInfo } from './gtfs';

interface VehicleTripDescriptor {
  trip_id: string;
  route_id: string;
}

interface VehiclePositionData {
  trip?: VehicleTripDescriptor;
  // speed is in km/h, despite the GTFS-realtime spec saying m/s: comparing it with how far ~550 buses actually
  // moved between two reports, the measured speed was 0.26x the reported one (a km/h-to-m/s factor is 0.28).
  position: { latitude: number; longitude: number; bearing?: string | number; speed?: number };
  // Seconds since epoch — when the vehicle reported the position above.
  timestamp?: number | string;
  vehicle: { id: string };
}

interface VehicleEntity {
  vehicle?: VehiclePositionData;
  is_deleted?: boolean;
}

interface VehicleLocationsResponse {
  status: string;
  response: { entity: VehicleEntity[] };
}

// Short-TTL cache (same pattern as alerts.ts/realtime.ts) — VehicleMap's own poll,
// JourneyPlannerScreen's live-vehicle poll, and journeyNotification.ts's boarding-arrival
// check can all end up calling this within moments of each other (e.g. an active journey
// open alongside the notification's own background poll); without this each one
// independently re-fetched and re-resolved route info for the entire live fleet. 10s is
// shorter than every poll interval that reads this (15s+ everywhere), so each poll loop
// still gets its own fresh fetch on its own cadence — this only dedupes near-simultaneous
// callers, not the normal per-poll refresh.
const CACHE_TTL_MS = 10_000;
let cache: VehiclePosition[] | null = null;
let cacheAt = 0;
let inFlight: Promise<VehiclePosition[]> | null = null;

export async function getVehiclePositions(): Promise<VehiclePosition[]> {
  if (!hasApiKey()) return [];
  if (cache && Date.now() - cacheAt < CACHE_TTL_MS) return cache;
  if (!inFlight) {
    inFlight = atFetch<VehicleLocationsResponse>('/realtime/legacy/vehiclelocations')
      .then(async (response) => {
        // Vehicles with no trip assignment (~half the feed: out of service, deadheading,
        // or between runs) aren't useful to riders, so they're excluded from the map
        // entirely.
        const entities = response.response.entity.filter((e) => !e.is_deleted && e.vehicle?.trip);
        const result = await Promise.all(
          entities.map(async (entity) => {
            const v = entity.vehicle as VehiclePositionData;
            const trip = v.trip as VehicleTripDescriptor;
            const route = await getRouteInfo(trip.route_id);

            return {
              vehicleId: v.vehicle.id,
              tripId: trip.trip_id,
              lat: v.position.latitude,
              lon: v.position.longitude,
              bearing: v.position.bearing !== undefined ? Number(v.position.bearing) : undefined,
              ...(v.timestamp != null && Number.isFinite(Number(v.timestamp)) ? { timestampMs: Number(v.timestamp) * 1000 } : {}),
              ...(typeof v.position.speed === 'number' ? { speedMps: v.position.speed / 3.6 } : {}),
              routeShortName: route?.shortName,
              mode: route?.mode ?? 'unknown',
            };
          })
        );
        cache = result;
        cacheAt = Date.now();
        return result;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}
