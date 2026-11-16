// --- Crowding ---
// AT's live vehicle feed carries a GTFS-realtime occupancy_status for most running vehicles. Pure and
// network-free (no Expo imports), so it runs under `node --test`.
export type CrowdingLevel = 'empty' | 'many' | 'few' | 'full';

// How many of the three bus icons are filled in for each level (see components/CrowdingIndicator.tsx).
export const CROWDING_FILLED_ICONS: Record<CrowdingLevel, number> = { empty: 0, many: 1, few: 2, full: 3 };

// GTFS-realtime OccupancyStatus: 0 EMPTY, 1 MANY_SEATS_AVAILABLE, 2 FEW_SEATS_AVAILABLE, 3 STANDING_ROOM_ONLY,
// 4 CRUSHED_STANDING_ROOM_ONLY, 5 FULL, 6 NOT_ACCEPTING_PASSENGERS. Standing room only already means no seat, so
// it counts as full. Missing or unknown means we say nothing.
export function crowdingLevel(status: number | undefined): CrowdingLevel | null {
  switch (status) {
    case 0:
      return 'empty';
    case 1:
      return 'many';
    case 2:
      return 'few';
    case 3:
    case 4:
    case 5:
    case 6:
      return 'full';
    default:
      return null;
  }
}
