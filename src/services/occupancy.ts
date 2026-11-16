// --- Crowding ---
// AT's live vehicle feed carries a GTFS-realtime occupancy_status for roughly half the fleet (the rest report
// none). Pure and network-free (no Expo imports), so it runs under `node --test`.
export type CrowdingLevel = 'many' | 'few' | 'standing' | 'full';

// GTFS-realtime OccupancyStatus: 0 EMPTY, 1 MANY_SEATS_AVAILABLE, 2 FEW_SEATS_AVAILABLE, 3 STANDING_ROOM_ONLY,
// 4 CRUSHED_STANDING_ROOM_ONLY, 5 FULL, 6 NOT_ACCEPTING_PASSENGERS. Missing or unknown means we say nothing.
export function crowdingLevel(status: number | undefined): CrowdingLevel | null {
  switch (status) {
    case 0:
    case 1:
      return 'many';
    case 2:
      return 'few';
    case 3:
      return 'standing';
    case 4:
    case 5:
    case 6:
      return 'full';
    default:
      return null;
  }
}
