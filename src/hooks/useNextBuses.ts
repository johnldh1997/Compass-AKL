import { useEffect, useState } from 'react';
import { mergeDepartures } from '../services/departures';
import { getScheduledDeparturesForStop } from '../services/gtfsStatic';
import { pickNextBuses } from '../services/nextBusPick';
import { CrowdingLevel, crowdingLevel } from '../services/occupancy';
import { getDeparturesForStop } from '../services/realtime';
import { getVehiclePositions } from '../services/vehicles';
import { Departure } from '../types';

const POLL_MS = 30_000;

export interface NextBus {
  departure: Departure;
  crowding: CrowdingLevel | null;
}

// --- Next Buses ---
// The next few buses of `lineName` from `stopId` (live times where there are any, the timetable otherwise),
// each with how full it is — so you can tell whether to take the one coming now or wait for a seat on the next.
// Refreshed every 30 s. Empty while loading, with no stop, or when nothing is running.
export function useNextBuses(lineName: string | undefined, stopId: string | undefined): NextBus[] {
  const [buses, setBuses] = useState<NextBus[]>([]);

  useEffect(() => {
    if (!lineName || !stopId) {
      setBuses([]);
      return;
    }
    let cancelled = false;
    function load() {
      Promise.all([
        getDeparturesForStop(stopId as string),
        // The two sources are independent: a timetable failure must not take down the live times.
        getScheduledDeparturesForStop(stopId as string).catch(() => []),
        getVehiclePositions().catch(() => []),
      ])
        .then(([live, scheduled, vehicles]) => {
          if (cancelled) return;
          const occupancyByTrip = new Map(vehicles.filter((v) => v.tripId).map((v) => [v.tripId as string, v.occupancy]));
          const picked = pickNextBuses(mergeDepartures(live, scheduled), lineName as string, Date.now());
          setBuses(picked.map((departure) => ({ departure, crowding: crowdingLevel(occupancyByTrip.get(departure.tripId)) })));
        })
        .catch(() => {});
    }
    load();
    const interval = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [lineName, stopId]);

  return buses;
}
