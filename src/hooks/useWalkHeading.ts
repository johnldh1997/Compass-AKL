import { useMemo, useRef } from 'react';
import { LatLon } from '../services/geo';
import { chooseWalkHeading, smoothHeading } from '../services/walkHeading';

interface Options {
  // True while you're on a walking leg and the map should face your way.
  enabled: boolean;
  // The walking leg's path.
  path: LatLon[];
  position: LatLon | null;
  gpsHeading?: number | null;
  speedMps?: number | null;
}

// --- Walking Direction ---
// The heading (degrees, 0 = north) the map should face while you walk, eased so it turns smoothly rather than
// snapping at every GPS fix; null while not walking, so the map stays north-up. When there's nothing to go on
// for a moment (off the path and standing still) it holds the last heading instead of spinning back to north.
export function useWalkHeading({ enabled, path, position, gpsHeading, speedMps }: Options): number | null {
  const smoothed = useRef<number | null>(null);

  return useMemo(() => {
    if (!enabled || !position) {
      smoothed.current = null;
      return null;
    }
    const raw = chooseWalkHeading({ path, position, gpsHeading, speedMps });
    if (raw === null) return smoothed.current;
    smoothed.current = smoothHeading(smoothed.current, raw);
    return smoothed.current;
    // position is compared by its coordinates: the same fix delivered in a new object isn't a new reading.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, path, position?.latitude, position?.longitude, gpsHeading, speedMps]);
}
