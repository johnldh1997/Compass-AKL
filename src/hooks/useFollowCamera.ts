import { RefObject, useCallback, useEffect, useRef, useState } from 'react';
import MapView from 'react-native-maps';
import { MY_LOCATION_ZOOM_DELTA } from '../mapStyle';
import { afterMove, LastCamera, planCameraMove } from '../services/cameraFollow';
import { LatLon } from '../services/geo';
import { getFastCoordinates } from '../services/location';
import { useAppActive } from './useAppActive';

interface Options {
  mapRef: RefObject<MapView | null>;
  mapReady: boolean;
  // Whether this map should be following at all (e.g. it's on screen, or a journey is under way).
  enabled: boolean;
  // Where you are. Null until the first fix.
  position: LatLon | null;
  // The direction to face (degrees, 0 = north), or null to keep the map north-up.
  heading?: number | null;
}

// --- Follow-Me Camera ---
// Keeps a map centred on you as you move — and, when `heading` is given, turned to face the way you're going.
// It follows until you take over by dragging the map (`disengage`), and starts again when you press the
// locate button (`engage`) or come back to the app after leaving it, which also jumps back to you.
export function useFollowCamera({ mapRef, mapReady, enabled, position, heading = null }: Options) {
  const [following, setFollowing] = useState(true);
  const followingRef = useRef(true);
  const lastRef = useRef<LastCamera | null>(null);
  // Zoom in once when heading-up starts, then leave the zoom to the user.
  const zoomInRef = useRef(true);
  const positionRef = useRef(position);
  positionRef.current = position;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const { resumedAt } = useAppActive();

  const engage = useCallback(() => {
    followingRef.current = true;
    setFollowing(true);
    lastRef.current = null;
    zoomInRef.current = true;
  }, []);

  const disengage = useCallback(() => {
    if (!followingRef.current) return;
    followingRef.current = false;
    setFollowing(false);
  }, []);

  useEffect(() => {
    if (!enabled || !following || !mapReady || !position) return;
    const target = planCameraMove({ last: lastRef.current, position, heading, zoomIn: zoomInRef.current });
    if (!target) return;
    mapRef.current?.animateCamera(target, { duration: 600 });
    lastRef.current = afterMove(position, heading);
    if (target.zoom !== undefined) zoomInRef.current = false;
    if (heading === null) zoomInRef.current = true;
  }, [position?.latitude, position?.longitude, heading, following, enabled, mapReady, mapRef]);

  // Coming back to the app: follow again, and jump to wherever you are now at the usual "my location" zoom.
  useEffect(() => {
    if (resumedAt === 0 || !enabledRef.current) return;
    engage();
    let cancelled = false;
    (async () => {
      const fresh = await getFastCoordinates().catch(() => null);
      const here = fresh ? { latitude: fresh.latitude, longitude: fresh.longitude } : positionRef.current;
      if (cancelled || !here) return;
      mapRef.current?.animateToRegion(
        { ...here, latitudeDelta: MY_LOCATION_ZOOM_DELTA, longitudeDelta: MY_LOCATION_ZOOM_DELTA },
        500
      );
    })();
    return () => {
      cancelled = true;
    };
    // Only a new resume should re-run this, not changes to the things it reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resumedAt]);

  return { following, engage, disengage };
}
