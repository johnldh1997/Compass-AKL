import { useEffect, useRef, useState } from 'react';
import { matchBoardedVehicle, trimTrail, TrailFix } from '../services/boardedVehicle';
import { LatLon } from '../services/geo';
import { VehiclePosition } from '../types';

interface Options {
  // The route short name of the transit leg you're on right now; null when you're not on one (walking, or no
  // journey) — nothing is matched then.
  lineName: string | null;
  // Every live vehicle on the journey's lines, refreshed by the journey screen's own poll.
  liveVehicles: VehiclePosition[];
  // Where you are, replaced with a new object on every GPS fix.
  position: LatLon | null;
}

// --- The Bus You're Riding ---
// Works out which live vehicle is carrying you (see services/boardedVehicle.ts for how) and returns it, or null
// while you're waiting, walking or the match isn't sure yet. This hook keeps what the matcher needs between
// renders: the trail of your recent GPS fixes, and the bus matched last time (so a match doesn't flicker).
export function useBoardedVehicle({ lineName, liveVehicles, position }: Options): VehiclePosition | null {
  const trailRef = useRef<TrailFix[]>([]);
  const previousRef = useRef<{ vehicleId: string; lineName: string; lastSeenAt: number } | null>(null);
  const lastVehicleRef = useRef<VehiclePosition | null>(null);
  const [boarded, setBoarded] = useState<VehiclePosition | null>(null);

  // Declared before the matching effect so, within one render, the newest fix is in the trail before matching.
  useEffect(() => {
    if (!position) return;
    const now = Date.now();
    trailRef.current = trimTrail([...trailRef.current, { latitude: position.latitude, longitude: position.longitude, t: now }], now);
  }, [position]);

  useEffect(() => {
    if (!lineName) {
      previousRef.current = null;
      lastVehicleRef.current = null;
      setBoarded(null);
      return;
    }
    const now = Date.now();
    const match = matchBoardedVehicle({ trail: trailRef.current, vehicles: liveVehicles, lineName, now, previous: previousRef.current });
    if (!match) {
      previousRef.current = null;
      lastVehicleRef.current = null;
      setBoarded(null);
      return;
    }
    const seen = liveVehicles.find((v) => v.vehicleId === match.vehicleId) ?? null;
    if (seen) lastVehicleRef.current = seen;
    previousRef.current = {
      vehicleId: match.vehicleId,
      lineName,
      // A bus missing from this refresh keeps its old "last seen" time, so it can age out (KEEP_MISSING_MS).
      lastSeenAt: seen ? now : previousRef.current?.vehicleId === match.vehicleId ? previousRef.current.lastSeenAt : now,
    };
    setBoarded(seen ?? lastVehicleRef.current);
  }, [liveVehicles, position, lineName]);

  return boarded;
}
