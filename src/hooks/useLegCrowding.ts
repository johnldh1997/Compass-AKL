import { useEffect, useState } from 'react';
import { CrowdingLevel, crowdingLevel } from '../services/occupancy';
import { getTripIdForLeg } from '../services/routeStops';
import { getVehiclePositions } from '../services/vehicles';
import { TransitStep } from '../types';

const POLL_MS = 30_000;

// --- Crowding On Your Journey ---
// How full the bus for each transit leg is, keyed by the leg's index in `steps`. Each leg is matched to AT's
// trip (the same match that gives its stop list), and that trip to the live vehicle running it. A leg whose
// bus isn't on the road yet, can't be matched, or reports no occupancy is simply absent from the map.
export function useLegCrowding(steps: TransitStep[] | undefined): Map<number, CrowdingLevel> {
  const [tripIds, setTripIds] = useState<Map<number, string>>(new Map());
  const [levels, setLevels] = useState<Map<number, CrowdingLevel>>(new Map());

  useEffect(() => {
    let cancelled = false;
    setTripIds(new Map());
    setLevels(new Map());
    steps?.forEach((step, index) => {
      if (step.kind !== 'transit') return;
      getTripIdForLeg(step)
        .then((tripId) => {
          if (!cancelled && tripId) setTripIds((prev) => new Map(prev).set(index, tripId));
        })
        .catch(() => {});
    });
    return () => {
      cancelled = true;
    };
  }, [steps]);

  useEffect(() => {
    if (tripIds.size === 0) return;
    let cancelled = false;
    function load() {
      getVehiclePositions()
        .then((vehicles) => {
          if (cancelled) return;
          const byTrip = new Map(vehicles.filter((v) => v.tripId).map((v) => [v.tripId as string, v]));
          const next = new Map<number, CrowdingLevel>();
          tripIds.forEach((tripId, index) => {
            const level = crowdingLevel(byTrip.get(tripId)?.occupancy);
            if (level) next.set(index, level);
          });
          setLevels(next);
        })
        .catch(() => {});
    }
    load();
    const interval = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [tripIds]);

  return levels;
}
