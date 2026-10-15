import * as Location from 'expo-location';
import { useEffect, useState } from 'react';
import { LatLon } from '../services/geo';

export interface UserLocation extends LatLon {
  // Direction of travel in degrees (0 = north) and speed in m/s — null when the phone doesn't know them.
  heading: number | null;
  speedMps: number | null;
}

// --- Your Location, While You're Looking ---
// A live feed of where you are, for maps that follow you. It only runs while `enabled` (the caller passes
// "this map is on screen and the app is in the foreground"), so a hidden map or a pocketed phone isn't
// holding the GPS open. Balanced accuracy and a few-metre filter: enough to follow someone walking or riding
// without the battery cost of the journey tracker's high-accuracy watch.
export function useUserLocation(enabled: boolean): UserLocation | null {
  const [location, setLocation] = useState<UserLocation | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let subscription: Location.LocationSubscription | null = null;

    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted' || cancelled) return;
      const sub = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.Balanced, timeInterval: 3000, distanceInterval: 4 },
        (position) => {
          setLocation({
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            heading: position.coords.heading != null && position.coords.heading >= 0 ? position.coords.heading : null,
            speedMps: position.coords.speed != null && position.coords.speed >= 0 ? position.coords.speed : null,
          });
        }
      );
      if (cancelled) sub.remove();
      else subscription = sub;
    })().catch(() => {});

    return () => {
      cancelled = true;
      subscription?.remove();
    };
  }, [enabled]);

  return location;
}
