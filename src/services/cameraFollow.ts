// --- Follow-Me Camera: What To Move, And When ---
// The maps follow your location, and during a walking leg also turn to face the way you're going. Moving a
// native map camera on every GPS fix would jitter and burn battery, so this decides — from the last move and
// the new position/heading — whether a move is worth making and what it should be. Pure (no Expo imports) so
// it runs under `node --test`; hooks/useFollowCamera.ts applies it to a real map.
import { angleDifference, distanceMeters, type LatLon } from './geo.ts';

// Moves smaller than these aren't worth an animation: GPS wobbles by a few metres while you stand still, and
// heading wobbles by a few degrees while you walk straight.
export const MIN_MOVE_METERS = 4;
export const MIN_TURN_DEGREES = 6;

// Street-level zoom for a walking leg (Google map zoom: 18 is roughly a block and a half across the screen).
export const WALKING_ZOOM = 18;

export interface LastCamera {
  position: LatLon;
  // The heading the map was last rotated to, or null if it's north-up.
  heading: number | null;
}

export interface CameraTarget {
  center: LatLon;
  heading?: number;
  pitch?: number;
  zoom?: number;
}

export interface CameraPlanInput {
  last: LastCamera | null;
  position: LatLon;
  // The heading to face, or null for north-up.
  heading: number | null;
  // Whether to zoom to WALKING_ZOOM with this move — true on the first move after heading-up starts, so the map
  // zooms in once and then leaves the zoom alone for you to change.
  zoomIn: boolean;
}

// The move to make now, or null to leave the camera where it is.
export function planCameraMove({ last, position, heading, zoomIn }: CameraPlanInput): CameraTarget | null {
  const facing = heading !== null;
  const moved = !last || distanceMeters(last.position, position) >= MIN_MOVE_METERS;
  const turned = facing && (last?.heading == null || Math.abs(angleDifference(last.heading, heading)) >= MIN_TURN_DEGREES);
  // Heading-up has ended (the walk is over): turn the map back to north-up once.
  const resetToNorth = !facing && last?.heading != null;
  if (!moved && !turned && !resetToNorth) return null;

  const target: CameraTarget = { center: position };
  if (facing) {
    target.heading = heading;
    target.pitch = 0;
    if (zoomIn) target.zoom = WALKING_ZOOM;
  } else if (resetToNorth) {
    target.heading = 0;
    target.pitch = 0;
  }
  return target;
}

// What `last` becomes after a move was made.
export function afterMove(position: LatLon, heading: number | null): LastCamera {
  return { position, heading };
}
