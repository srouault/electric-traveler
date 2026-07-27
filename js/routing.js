/**
 * Thin wrappers around the public OSRM and Nominatim endpoints.
 *
 * Both are free and CORS-enabled, which is what lets this whole thing run as a
 * static GitHub Pages site with no backend and no API key. They are also
 * demo/community servers, so we keep the request count low: one matrix call
 * and two route calls per plan, not one call per charger.
 */

const OSRM = 'https://router.project-osrm.org';
const NOMINATIM = 'https://nominatim.openstreetmap.org';

/** OSRM caps the table service at 100 coordinates per request. */
export const MAX_MATRIX_COORDS = 100;

class RoutingError extends Error {}

/**
 * Nominatim's usage policy wants an identifying User-Agent and rejects requests
 * that have none — which matters when this code runs under Node (scripts/).
 *
 * In a browser we must NOT set it. A custom User-Agent is not a CORS-safelisted
 * header, so it turns every call into a preflighted request, and OSRM's demo
 * server only allows `X-Requested-With, Content-Type` — the preflight fails and
 * the fetch never happens. Browsers send their own User-Agent regardless.
 */
const UA = 'electric-traveler/1.0 (+https://github.com/srouault/electric-traveler)';
const INIT = typeof window === 'undefined' ? { headers: { 'User-Agent': UA } } : {};

async function getJson(url, label) {
  let res;
  try {
    res = await fetch(url, INIT);
  } catch (cause) {
    throw new RoutingError(`${label} is unreachable — check your connection.`, { cause });
  }
  if (!res.ok) {
    // The demo server answers 429 when it is being hammered.
    if (res.status === 429) throw new RoutingError(`${label} is rate-limiting us. Wait a moment and try again.`);
    throw new RoutingError(`${label} returned HTTP ${res.status}.`);
  }
  const json = await res.json();
  if (json.code && json.code !== 'Ok') {
    throw new RoutingError(`${label}: ${json.message || json.code}`);
  }
  return json;
}

const coordList = (points) => points.map((p) => `${p.lon},${p.lat}`).join(';');

/**
 * Road route through the given points, in order.
 * Returns total distance/duration, per-leg figures and a decoded polyline.
 */
export async function route(points, { geometry = true, overview = 'full', alternatives = 0 } = {}) {
  const params = new URLSearchParams({
    overview: geometry ? overview : 'false',
    geometries: 'polyline6',
    annotations: 'false',
    steps: 'false',
  });
  if (alternatives) params.set('alternatives', String(alternatives));
  const json = await getJson(`${OSRM}/route/v1/driving/${coordList(points)}?${params}`, 'OSRM routing');
  if (!json.routes?.length) throw new RoutingError('No drivable route between those points.');

  const shape = (r) => ({
    km: r.distance / 1000,
    minutes: r.duration / 60,
    legs: (r.legs || []).map((l) => ({ km: l.distance / 1000, minutes: l.duration / 60 })),
    line: geometry ? decodePolyline(r.geometry, 6) : [],
  });
  const first = shape(json.routes[0]);
  // Alternatives ride along on the primary result rather than changing its shape.
  if (alternatives) first.alternatives = json.routes.slice(1).map(shape);
  return first;
}

/**
 * All-pairs driving distance and duration between `points`.
 * Entries are `null` where OSRM found no connection.
 */
export async function matrix(points) {
  if (points.length > MAX_MATRIX_COORDS) {
    throw new RoutingError(`Matrix request of ${points.length} points exceeds the ${MAX_MATRIX_COORDS} OSRM allows.`);
  }
  const json = await getJson(
    `${OSRM}/table/v1/driving/${coordList(points)}?annotations=duration,distance`,
    'OSRM matrix',
  );
  return {
    // Kilometres and minutes, to match the rest of the codebase.
    km: json.distances.map((row) => row.map((d) => (d == null ? null : d / 1000))),
    minutes: json.durations.map((row) => row.map((d) => (d == null ? null : d / 60))),
  };
}

/** Free-text address search, biased to the countries we carry charger data for. */
export async function geocode(query, limit = 5) {
  const params = new URLSearchParams({
    q: query,
    format: 'jsonv2',
    limit: String(limit),
    addressdetails: '1',
    countrycodes: 'fr,be,nl,lu,de',
  });
  const json = await getJson(`${NOMINATIM}/search?${params}`, 'Address search');
  return json.map((r) => ({
    label: r.display_name,
    lat: Number(r.lat),
    lon: Number(r.lon),
  }));
}

/** Turns the browser's GPS fix into something with a human-readable name. */
export async function reverseGeocode(lat, lon) {
  const params = new URLSearchParams({ lat: String(lat), lon: String(lon), format: 'jsonv2' });
  try {
    const json = await getJson(`${NOMINATIM}/reverse?${params}`, 'Reverse geocoding');
    return json.display_name || null;
  } catch {
    return null; // A missing label is cosmetic; never fail a plan over it.
  }
}

/** Decodes an encoded polyline into [{lat, lon}]. */
export function decodePolyline(str, precision = 5) {
  const factor = 10 ** precision;
  const points = [];
  let index = 0;
  let lat = 0;
  let lon = 0;

  while (index < str.length) {
    let shift = 0;
    let result = 0;
    let byte;
    do {
      byte = str.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    shift = 0;
    result = 0;
    do {
      byte = str.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lon += result & 1 ? ~(result >> 1) : result >> 1;

    points.push({ lat: lat / factor, lon: lon / factor });
  }
  return points;
}

export { RoutingError };
