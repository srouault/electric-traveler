/**
 * Saved routes, kept in localStorage.
 *
 * A saved route is a snapshot, not a live plan: the stops and their addresses
 * as they were when you saved them. That is deliberate — the point is to hand
 * the same list to the car every time, not to have it quietly change under you
 * because a charger opened somewhere.
 */

const KEY = 'electric-traveler.routes';

/** Route geometry is thinned before saving — localStorage is small. */
const LINE_EVERY_KM = 2;

function read() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function write(routes) {
  try {
    localStorage.setItem(KEY, JSON.stringify(routes));
    return true;
  } catch {
    // Quota exceeded, or private browsing.
    return false;
  }
}

/** Newest first. */
export function listRoutes() {
  return read().sort((a, b) => (a.saved < b.saved ? 1 : -1));
}

export function getRoute(id) {
  return read().find((r) => r.id === id) || null;
}

function thin(line) {
  if (!line?.length) return [];
  const R = 6371;
  const rad = (d) => (d * Math.PI) / 180;
  const dist = (a, b) => {
    const dLat = rad(b.lat - a.lat);
    const dLon = rad(b.lon - a.lon);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  };
  const out = [line[0]];
  let since = 0;
  for (let i = 1; i < line.length; i++) {
    since += dist(line[i - 1], line[i]);
    if (since >= LINE_EVERY_KM || i === line.length - 1) {
      out.push(line[i]);
      since = 0;
    }
  }
  // Round hard: five decimals is about a metre, and this is drawn at 1:1000000.
  return out.map((p) => ({ lat: Math.round(p.lat * 1e5) / 1e5, lon: Math.round(p.lon * 1e5) / 1e5 }));
}

/**
 * Stores a plan under `name`. Returns the saved record, or null if the browser
 * refused to store it.
 */
export function saveRoute(plan, start, end, name) {
  const record = {
    id: `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name: name?.trim() || `${start.label || 'Start'} → ${end.label || 'Destination'}`,
    saved: new Date().toISOString(),
    start: { lat: start.lat, lon: start.lon, label: start.label || '' },
    end: { lat: end.lat, lon: end.lon, label: end.label || '' },
    via: (plan.via || []).map((v) => ({ lat: v.lat, lon: v.lon, label: v.label || '' })),
    totalKm: plan.totalKm,
    driveMinutes: plan.driveMinutes,
    chargeMinutes: plan.chargeMinutes,
    totalMinutes: plan.totalMinutes,
    arrivalSoc: plan.arrivalSoc,
    line: thin(plan.line),
    stops: plan.stops.map((s) => ({
      id: s.id,
      name: s.name,
      address: s.address,
      city: s.city,
      lat: s.lat,
      lon: s.lon,
      kw: s.kw,
      stalls: s.stalls,
      arriveSoc: s.arriveSoc,
      departSoc: s.departSoc,
      chargeMinutes: s.chargeMinutes,
      legInKm: s.legInKm,
      alternatives: (s.alternatives || []).map((a) => ({
        id: a.id,
        name: a.name,
        address: a.address,
        lat: a.lat,
        lon: a.lon,
        kw: a.kw,
        stalls: a.stalls,
        awayKm: a.awayKm,
        socThere: a.socThere,
        reachable: a.reachable,
        tight: a.tight,
      })),
    })),
  };

  const routes = read();
  routes.push(record);
  return write(routes) ? record : null;
}

export function deleteRoute(id) {
  write(read().filter((r) => r.id !== id));
}

export function renameRoute(id, name) {
  const routes = read();
  const r = routes.find((x) => x.id === id);
  if (!r) return false;
  r.name = name.trim() || r.name;
  return write(routes);
}
