export type TransportMode = 'bus' | 'train' | 'ferry' | 'unknown';

export type ThemeMode = 'light' | 'dark' | 'auto';

export type Language = 'en' | 'ko';

export interface Stop {
  id: string;
  name: string;
  code: string;
  lat: number;
  lon: number;
}

export interface Departure {
  tripId: string;
  routeId: string;
  routeShortName: string;
  mode: TransportMode;
  headsign: string;
  scheduledTime: string;
  estimatedTime: string;
  delayMinutes: number;
  cancelled: boolean;
  // False for a scheduled-only departure (from the bundled static GTFS timetable, no
  // realtime confirmation) — used to show "Scheduled" instead of an on-time/delay claim
  // we can't actually back up. Defaults to true (an ordinary realtime departure).
  isLive?: boolean;
}

export interface FavoriteStop {
  stopId: string;
  stopName: string;
  stopCode: string;
  notificationsEnabled: boolean;
  addedAt: number;
}

export interface VehiclePosition {
  vehicleId: string;
  tripId?: string;
  lat: number;
  lon: number;
  bearing?: number;
  routeShortName?: string;
  mode: TransportMode;
}

export interface ServiceAlert {
  id: string;
  headerText: string;
  descriptionText: string;
  routeIds: string[];
  stopIds: string[];
  // From the alert's own active_period start — GTFS-realtime alerts have no explicit
  // "posted at" field, so this is the closest available proxy (when the alert's effect
  // was set to begin). Absent if the alert has no active_period at all.
  postedAt?: string;
}

export interface PlaceSuggestion {
  placeId: string;
  mainText: string;
  secondaryText: string;
}

// A From/To endpoint for journey planning. Not every way of picking a location gives
// us a Google place ID (current location and map-picked points only have coordinates),
// so this covers both instead of forcing everything through placeId.
export type JourneyEndpoint =
  | { kind: 'place'; placeId: string; label: string; secondaryLabel: string }
  | { kind: 'coordinates'; lat: number; lon: number; label: string };

export interface FavoritePlace {
  id: string;
  endpoint: JourneyEndpoint;
  addedAt: number;
}

export interface RecentPlace {
  endpoint: JourneyEndpoint;
  searchedAt: number;
}

export interface TripEndpoints {
  from: JourneyEndpoint;
  to: JourneyEndpoint;
}

export interface RecentTrip extends TripEndpoints {
  searchedAt: number;
}

export interface FavoriteTrip extends TripEndpoints {
  id: string;
  addedAt: number;
}

export interface TransitStopLocation {
  name: string;
  lat: number;
  lon: number;
}

export interface TransitStep {
  kind: 'transit' | 'walk';
  mode?: TransportMode;
  instruction: string;
  durationText?: string;
  // Raw seconds (walk steps only, distinct from durationText's formatted "3 min" string) —
  // lets the UI compute a real arrival clock time for a walk after the last transit leg.
  durationSeconds?: number;
  departureTime?: string;
  arrivalTime?: string;
  // Raw ISO timestamps (distinct from the localized display text above), used to work
  // out which step a user is currently on during a live journey — transit is
  // fundamentally schedule-driven, which is far more reliable than trying to snap a
  // live GPS position onto the right segment of a multi-modal walk+transit polyline.
  departureTimestamp?: string;
  arrivalTimestamp?: string;
  lineName?: string;
  // Raw destination text (e.g. "Britomart"), kept separate from the combined display
  // string in `instruction` — used to disambiguate which live vehicle on a route is
  // actually serving this leg (a route can have vehicles running in both directions).
  headsign?: string;
  numStops?: number;
  // This step's own segment of the route polyline, so it can be drawn in a different
  // color per mode — the whole-route polyline on JourneyRoute is just for map bounds.
  encodedPolyline?: string;
  // Where this transit leg boards/alights, straight from Google's own transit data —
  // used to match this leg to AT's static GTFS trip so every intermediate stop it
  // passes can be looked up (see services/routeStops.ts).
  departureStop?: TransitStopLocation;
  arrivalStop?: TransitStopLocation;
}

export interface JourneyRoute {
  durationText: string;
  steps: TransitStep[];
  encodedPolyline?: string;
  // Total walking time for the route-options list. Cost is deliberately absent —
  // Google returns no fare data for Auckland (verified live).
  walkSummary?: string;
}

export type RootStackParamList = {
  // focusStop is set when returning from Search Stops (or anywhere else) wanting the map
  // centered on a specific stop — requestedAt (not just the coordinate) so picking the
  // same stop twice in a row still re-triggers the camera move. restoredFrom/restoredTo
  // carry a picked endpoint back from ChooseOnMap/Favorites — Home's own inline form is
  // the only place From/To are ever editable, so it's the only return target they need.
  Home:
    | {
        focusStop?: { lat: number; lon: number; requestedAt: number };
        restoredFrom?: JourneyEndpoint;
        restoredTo?: JourneyEndpoint;
      }
    | undefined;
  // One combined list of favourite stops + places. pickingFor/currentFrom/currentTo are
  // only present when opened from a From/To field (Home's inline form, or the editable
  // fields on the Journey Planner results page) to pick an endpoint; absent when opened
  // from the hamburger menu to just browse/manage favourites. returnTo says which of those
  // two forms receives the pick — Home when absent.
  Favorites:
    | {
        pickingFor: 'from' | 'to';
        currentFrom?: JourneyEndpoint;
        currentTo?: JourneyEndpoint;
        returnTo?: 'Home' | 'JourneyPlanner';
      }
    | undefined;
  // Current location / choose on map / search a stop, place, or address — the result is
  // added directly to the relevant favourites store and the screen pops back to Favorites.
  AddFavorite: undefined;
  StopDetail: { stopId: string; stopName: string; stopCode: string };
  Settings: undefined;
  About: undefined;
  // restoredFrom/restoredTo carry the From/To pair picked on Home's inline form (the only
  // place they're editable) so this screen's results reflect it, plus (from ChooseOnMap/
  // Favorites) so a re-search after adjusting the departure time below still has both ends.
  // restoredDepartureTime (ISO string) carries the time picked on Home's own inline form
  // through to the auto-run search below, rather than it silently reverting to "now".
  // autoSearch additionally kicks off the search immediately (used by My Trips and Home's
  // inline form, where tapping should jump straight to results, not just refill the form).
  JourneyPlanner:
    | {
        restoredFrom?: JourneyEndpoint;
        restoredTo?: JourneyEndpoint;
        restoredDepartureTime?: string;
        autoSearch?: boolean;
      }
    | undefined;
  // Three independent uses: picking a From/To endpoint (returns to whichever form opened
  // it — Home's inline form, or the Journey Planner results page via returnTo), picking a
  // location to add as a favourite (returns to Favorites), or picking a home address
  // (returns to SetHomeAddress, which then returns to Settings).
  ChooseOnMap:
    | {
        mode: 'journey';
        pickingFor: 'from' | 'to';
        currentFrom?: JourneyEndpoint;
        currentTo?: JourneyEndpoint;
        returnTo?: 'Home' | 'JourneyPlanner';
      }
    | { mode: 'favourite' }
    | { mode: 'home' };
  // Favourite/recent whole From→To trips, promoted out of the Journey Planner form into
  // their own destination — reachable from the hamburger menu.
  MyTrips: undefined;
  // Plain "look up a stop to view it" — no favouriting framing, unlike AddFavorite.
  SearchStops: undefined;
  // Every currently-active service alert network-wide, not narrowed to one stop/route.
  Alerts: undefined;
  // Search an address/place directly to set as the Home quick-pick — separate from
  // AddFavorite since a home address isn't necessarily meant to also be favourited, and
  // doesn't need stop search (a home address is always a place, never a bus stop).
  SetHomeAddress: undefined;
  // Free-text "what's nearby" search (e.g. "Japanese food within 20 minutes"). Selecting a
  // result hands off to JourneyPlanner the same way Home/MyTrips do — restoredFrom/To +
  // autoSearch — rather than injecting a route directly, since a place isn't a JourneyRoute.
  NearbySearch: undefined;
};
