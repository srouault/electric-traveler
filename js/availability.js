/**
 * Live stall availability, via the Google Places API (New).
 *
 * Why Google and not Tesla: Tesla's own location endpoints sit behind Akamai
 * and return 403 to anything that is not their app, and the availability API
 * they do have needs an authenticated Tesla account. supercharge.info and Open
 * Charge Map are registries — they know a site has 8 stalls, never how many are
 * free right now. Places API exposes `availableCount` per connector group with
 * a `availabilityLastUpdateTime`, which is the real thing.
 *
 * The key is yours, lives in your browser, and never leaves it except to
 * Google. Restrict it by HTTP referrer to your Pages URL.
 */

const KEY_STORE = 'electric-traveler.googleKey';
const ENDPOINT = 'https://places.googleapis.com/v1/places:searchNearby';

/** Search radius around a saved stop, in metres. Superchargers are big sites. */
const SEARCH_RADIUS_M = 350;
/** Don't re-ask Google for the same stop more often than this. Calls are billed. */
const MIN_REFETCH_MS = 45_000;

const cache = new Map(); // stop id -> { at, result }

export function getApiKey() {
  try {
    return localStorage.getItem(KEY_STORE) || '';
  } catch {
    return '';
  }
}

export function setApiKey(key) {
  try {
    if (key) localStorage.setItem(KEY_STORE, key.trim());
    else localStorage.removeItem(KEY_STORE);
    return true;
  } catch {
    return false;
  }
}

export class AvailabilityError extends Error {}

/** Straight-line metres, good enough for picking the right place out of five. */
function metresBetween(a, b) {
  const R = 6371000;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Of the charging stations Google found nearby, the one that is actually our
 * Supercharger: prefer a Tesla-looking name, then nearest.
 */
function pickPlace(places, stop) {
  const scored = places
    .map((p) => {
      const loc = p.location || {};
      const away = metresBetween(stop, { lat: loc.latitude, lon: loc.longitude });
      const name = p.displayName?.text || '';
      const tesla = /tesla|supercharger/i.test(name);
      return { place: p, away, tesla };
    })
    .filter((x) => Number.isFinite(x.away))
    .sort((a, b) => (b.tesla ? 1 : 0) - (a.tesla ? 1 : 0) || a.away - b.away);
  return scored[0]?.place || null;
}

/** Sums the connector groups into one free/total figure. */
function summarise(place) {
  const groups = place?.evChargeOptions?.connectorAggregation || [];
  if (!groups.length) return null;

  let available = 0;
  let total = 0;
  let outOfService = 0;
  let updated = null;
  let sawCount = false;

  for (const g of groups) {
    total += g.count ?? 0;
    outOfService += g.outOfServiceCount ?? 0;
    if (typeof g.availableCount === 'number') {
      available += g.availableCount;
      sawCount = true;
    }
    if (g.availabilityLastUpdateTime && (!updated || g.availabilityLastUpdateTime > updated)) {
      updated = g.availabilityLastUpdateTime;
    }
  }

  return {
    // Google reports connectorCount even where it has no live feed, so a total
    // without any availableCount is capacity, not availability — say so.
    available: sawCount ? available : null,
    total: total || place.evChargeOptions?.connectorCount || 0,
    outOfService,
    updated,
    name: place.displayName?.text || '',
  };
}

/**
 * Live availability for one stop, or null when Google has no live feed for it.
 * Throws AvailabilityError on a key or transport problem.
 */
export async function fetchAvailability(stop, apiKey, { force = false } = {}) {
  const hit = cache.get(stop.id);
  if (!force && hit && Date.now() - hit.at < MIN_REFETCH_MS) return hit.result;

  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'places.displayName,places.location,places.evChargeOptions',
      },
      body: JSON.stringify({
        includedTypes: ['electric_vehicle_charging_station'],
        maxResultCount: 5,
        locationRestriction: {
          circle: { center: { latitude: stop.lat, longitude: stop.lon }, radius: SEARCH_RADIUS_M },
        },
      }),
    });
  } catch (cause) {
    throw new AvailabilityError('Could not reach Google Places — check your connection.', { cause });
  }

  if (res.status === 403 || res.status === 401) {
    throw new AvailabilityError('Google rejected the key. Check Places API (New) is enabled and the referrer restriction allows this page.');
  }
  if (res.status === 429) {
    throw new AvailabilityError('Google is rate-limiting the key. Wait a moment before refreshing again.');
  }
  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.json())?.error?.message || '';
    } catch {
      /* keep the status code */
    }
    throw new AvailabilityError(`Google Places returned HTTP ${res.status}${detail ? `: ${detail}` : ''}.`);
  }

  const json = await res.json();
  const place = pickPlace(json.places || [], stop);
  const result = place ? summarise(place) : null;
  cache.set(stop.id, { at: Date.now(), result });
  return result;
}

/**
 * Traffic-light level for a stop.
 *
 * Thresholds are on the free *fraction*, not the count: two free bays out of
 * eight is a very different prospect from two out of forty.
 */
export function levelFor(av) {
  if (!av || av.available == null || !av.total) return 'unknown';
  if (av.available === 0) return 'red';
  const ratio = av.available / av.total;
  if (ratio < 0.2) return 'red';
  if (ratio < 0.45) return 'orange';
  return 'green';
}

export function describe(av) {
  if (!av) return 'No live data for this site';
  if (av.available == null) return `${av.total} stalls — no live feed`;
  let text = `${av.available} of ${av.total} free`;
  if (av.outOfService > 0) text += ` · ${av.outOfService} out of service`;
  return text;
}

/** "3 min ago" from an RFC3339 timestamp. */
export function ago(iso) {
  if (!iso) return '';
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 90) return 'just now';
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
}
