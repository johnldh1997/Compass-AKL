import * as Location from 'expo-location';
import { JourneyEndpoint } from '../types';

// --- Location Permission ---
// Asking Android for a permission puts a system screen over the app, which pauses and resumes it. The old code asked on
// every call — even when the permission was already granted as "approximate" (so it kept asking to upgrade to
// "precise") — and on every return to the app, so on one phone the prompt opened and closed about twenty times a
// second until the app crashed. Now: a permission you already have (approximate counts) is never asked for again, a
// refused one that Android won't re-prompt is never asked for, and automatic callers ('once') share a single request per
// launch. Only something the user just tapped ('now') asks again.
let launchRequest: Promise<boolean> | null = null;

export async function ensureLocationPermission(ask: 'never' | 'once' | 'now'): Promise<boolean> {
  try {
    const current = await Location.getForegroundPermissionsAsync();
    if (current.granted) return true;
    if (ask === 'never' || !current.canAskAgain) return false;
    if (ask === 'now') return (await Location.requestForegroundPermissionsAsync()).granted;
    launchRequest ??= Location.requestForegroundPermissionsAsync().then(
      (result) => result.granted,
      () => false
    );
    return await launchRequest;
  } catch {
    return false;
  }
}

// --- Location Settings Dialog ---
// When the phone's network location is switched off, Android answers a position request with a Google "Location
// Accuracy" dialog. That's right after the user has tapped something that needs their location, and wrong when the app
// asks by itself (opening the map, the alerts badge, coming back to the app): declining it makes the app ask again,
// and the dialog returned every time — so the app looked stuck blinking, and the map never found you. Only requests
// made on a tap pass `askToTurnOnLocation`; every other request just fails quietly (null) when location isn't available.
export async function getCurrentCoordinates({
  askToTurnOnLocation = false,
}: { askToTurnOnLocation?: boolean } = {}): Promise<{ latitude: number; longitude: number } | null> {
  try {
    if (!(await ensureLocationPermission(askToTurnOnLocation ? 'now' : 'once'))) return null;

    const position = await Location.getCurrentPositionAsync({ mayShowUserSettingsDialog: askToTurnOnLocation });
    return { latitude: position.coords.latitude, longitude: position.coords.longitude };
  } catch {
    return null;
  }
}

// A GPS fix (getCurrentPositionAsync) can take several seconds; the OS's cached last-known
// position returns near-instantly and is usually close enough to start a map on. Falls
// back to a fresh fix only when no cached position exists (e.g. right after boot).
export async function getFastCoordinates(): Promise<{ latitude: number; longitude: number } | null> {
  try {
    if (!(await ensureLocationPermission('once'))) return null;

    const lastKnown = await Location.getLastKnownPositionAsync();
    if (lastKnown) {
      return { latitude: lastKnown.coords.latitude, longitude: lastKnown.coords.longitude };
    }
    const position = await Location.getCurrentPositionAsync({ mayShowUserSettingsDialog: false });
    return { latitude: position.coords.latitude, longitude: position.coords.longitude };
  } catch {
    return null;
  }
}

// Turns coordinates into a human-readable address via the device's own geocoder
// (no extra Google API involved). Returns null if the device can't resolve one.
export async function reverseGeocode(lat: number, lon: number): Promise<string | null> {
  try {
    const results = await Location.reverseGeocodeAsync({ latitude: lat, longitude: lon });
    const r = results[0];
    if (!r) return null;
    const street = [r.streetNumber, r.street].filter(Boolean).join(' ');
    const parts = [street || r.name, r.district || r.subregion || r.city].filter(Boolean);
    return parts.length > 0 ? parts.join(', ') : null;
  } catch {
    return null;
  }
}

// Every caller is something the user just asked for (a "Current Location" button, a "near me" chat message).
export async function getCurrentLocationEndpoint(): Promise<JourneyEndpoint | null> {
  const coords = await getCurrentCoordinates({ askToTurnOnLocation: true });
  if (!coords) return null;
  const address = await reverseGeocode(coords.latitude, coords.longitude);
  return {
    kind: 'coordinates',
    lat: coords.latitude,
    lon: coords.longitude,
    label: address ?? 'Current Location',
  };
}
