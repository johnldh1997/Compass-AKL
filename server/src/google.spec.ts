import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGoogleRequest, isGoogleEndpoint, PLACES_FIELD_MASK, type GoogleRequest } from './google';

function built(endpoint: Parameters<typeof buildGoogleRequest>[0], raw: unknown): GoogleRequest {
  const result = buildGoogleRequest(endpoint, raw);
  assert.ok('request' in result, `expected a request, got ${JSON.stringify(result)}`);
  return result.request;
}

function rejected(endpoint: Parameters<typeof buildGoogleRequest>[0], raw: unknown) {
  assert.ok('error' in buildGoogleRequest(endpoint, raw), `expected ${JSON.stringify(raw)} to be rejected`);
}

const SKY_TOWER = { lat: -36.8485, lon: 174.7633 };

// --- Endpoint Names ---
test('isGoogleEndpoint: only the five known names', () => {
  for (const name of ['autocomplete', 'search-text', 'search-nearby', 'place-location', 'route']) assert.equal(isGoogleEndpoint(name), true);
  for (const name of ['', 'geocode', 'route/../x', 'AUTOCOMPLETE']) assert.equal(isGoogleEndpoint(name), false);
});

// --- Autocomplete ---
test('autocomplete: builds the NZ-biased request and ignores anything else the caller sends', () => {
  const request = built('autocomplete', { input: 'Britomart', sessionToken: 'abcd1234-ef56', includedRegionCodes: ['us'], radius: 1 });
  assert.equal(request.url, 'https://places.googleapis.com/v1/places:autocomplete');
  const body = request.body as { input: string; includedRegionCodes: string[]; locationBias: { circle: { radius: number } } };
  assert.equal(body.input, 'Britomart');
  assert.deepEqual(body.includedRegionCodes, ['nz']);
  assert.equal(body.locationBias.circle.radius, 50_000);
});

test('autocomplete: empty, over-long or oddly-tokened requests are rejected', () => {
  rejected('autocomplete', { input: '', sessionToken: 'abcd1234-ef56' });
  rejected('autocomplete', { input: 'x'.repeat(101), sessionToken: 'abcd1234-ef56' });
  rejected('autocomplete', { input: 'Brito', sessionToken: 'short' });
  rejected('autocomplete', { input: 'Brito', sessionToken: 'has spaces and symbols!!' });
  rejected('autocomplete', {});
});

// --- Places Searches ---
test('search-text: the field mask is the server\'s, whatever the caller says', () => {
  const request = built('search-text', { textQuery: 'burger restaurant', ...SKY_TOWER, radiusMeters: 25_000, fieldMask: 'places.reviews' });
  assert.equal(request.fieldMask, PLACES_FIELD_MASK);
  assert.equal(request.url, 'https://places.googleapis.com/v1/places:searchText');
  const body = request.body as { maxResultCount: number; locationBias: { circle: { center: { latitude: number }; radius: number } } };
  assert.equal(body.maxResultCount, 20);
  assert.equal(body.locationBias.circle.center.latitude, SKY_TOWER.lat);
  assert.equal(body.locationBias.circle.radius, 25_000);
});

test('search-text: sizes are capped — more than 20 results or a radius beyond 50 km is refused, not trimmed', () => {
  rejected('search-text', { textQuery: 'cafe', ...SKY_TOWER, radiusMeters: 50_001 });
  rejected('search-text', { textQuery: 'cafe', ...SKY_TOWER, radiusMeters: 0 });
  rejected('search-text', { textQuery: 'cafe', ...SKY_TOWER, radiusMeters: 1000, maxResultCount: 21 });
  rejected('search-text', { textQuery: 'x'.repeat(101), ...SKY_TOWER, radiusMeters: 1000 });
  rejected('search-text', { textQuery: 'cafe', lat: 95, lon: 174, radiusMeters: 1000 });
});

test('search-nearby: types and rank preference are checked, and the circle is a hard restriction', () => {
  const request = built('search-nearby', { includedTypes: ['hamburger_restaurant'], rankPreference: 'DISTANCE', ...SKY_TOWER, radiusMeters: 6000 });
  assert.equal(request.url, 'https://places.googleapis.com/v1/places:searchNearby');
  assert.equal(request.fieldMask, PLACES_FIELD_MASK);
  const body = request.body as { locationRestriction: { circle: { radius: number } }; rankPreference: string };
  assert.equal(body.locationRestriction.circle.radius, 6000);
  assert.equal(body.rankPreference, 'DISTANCE');
});

test('search-nearby: a malformed type, no types, too many types, or a made-up rank is refused', () => {
  const base = { rankPreference: 'DISTANCE', ...SKY_TOWER, radiusMeters: 1000 };
  rejected('search-nearby', { ...base, includedTypes: ['Hamburger Restaurant'] });
  rejected('search-nearby', { ...base, includedTypes: [] });
  rejected('search-nearby', { ...base, includedTypes: ['a_b', 'c_d', 'e_f', 'g_h', 'i_j'] });
  rejected('search-nearby', { ...base, includedTypes: ['cafe'], rankPreference: 'RELEVANCE' });
});

// --- Place Location ---
test('place-location: a GET for the location field only, and only for a plausible place id', () => {
  const request = built('place-location', { placeId: 'ChIJ-2b3c4d5e6f7g8h9i' });
  assert.equal(request.method, 'GET');
  assert.equal(request.fieldMask, 'location');
  assert.equal(request.url, 'https://places.googleapis.com/v1/places/ChIJ-2b3c4d5e6f7g8h9i');
  assert.equal(request.body, undefined);
  rejected('place-location', { placeId: '../routes' });
  rejected('place-location', { placeId: 'abc' });
  rejected('place-location', { placeId: 'ChIJ/with/slashes/abc' });
});

// --- Routes ---
test('route: each profile fixes its own travel mode and field mask', () => {
  const origin = { lat: -36.84, lon: 174.76 };
  const destination = { lat: -36.9, lon: 174.8 };
  const transit = built('route', { profile: 'journey-transit', origin, destination });
  assert.equal((transit.body as { travelMode: string }).travelMode, 'TRANSIT');
  assert.equal((transit.body as { computeAlternativeRoutes: boolean }).computeAlternativeRoutes, true);
  assert.match(transit.fieldMask!, /transitDetails/);

  const candidate = built('route', { profile: 'candidate-walk', origin, destination });
  assert.equal(candidate.fieldMask, 'routes.duration');
  assert.equal((candidate.body as { travelMode: string }).travelMode, 'WALK');
  assert.equal('computeAlternativeRoutes' in (candidate.body as object), false);

  const candidateTransit = built('route', { profile: 'candidate-transit', origin, destination });
  assert.match(candidateTransit.fieldMask!, /transitLine\.nameShort/);
  assert.equal(candidateTransit.fieldMask!.includes('polyline'), false);
});

test('route: a place id or coordinates both work as a waypoint, and a departure time is passed along', () => {
  const request = built('route', {
    profile: 'journey-transit',
    origin: { placeId: 'ChIJ-origin-place-id' },
    destination: { lat: -36.9, lon: 174.8 },
    departureTime: '2026-10-14T05:30:00.000Z',
  });
  const body = request.body as { origin: unknown; destination: unknown; departureTime: string };
  assert.deepEqual(body.origin, { placeId: 'ChIJ-origin-place-id' });
  assert.deepEqual(body.destination, { location: { latLng: { latitude: -36.9, longitude: 174.8 } } });
  assert.equal(body.departureTime, '2026-10-14T05:30:00.000Z');
});

test('route: an unknown profile (so an unknown field mask), a bad time or a bad waypoint is refused', () => {
  const ok = { origin: { lat: -36.84, lon: 174.76 }, destination: { lat: -36.9, lon: 174.8 } };
  rejected('route', { profile: 'everything', ...ok });
  rejected('route', { profile: 'journey-walk', ...ok, departureTime: 'tomorrow' });
  rejected('route', { profile: 'journey-walk', origin: { lat: 999, lon: 0 }, destination: ok.destination });
  rejected('route', { profile: 'journey-walk', origin: { placeId: 'x' }, destination: ok.destination });
  rejected('route', { profile: 'journey-walk', origin: ok.origin });
});
