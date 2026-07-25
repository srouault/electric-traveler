/** Small geodesic helpers. Distances are kilometres. */

const R = 6371; // mean earth radius, km
const toRad = (d) => (d * Math.PI) / 180;

export function haversine(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Equirectangular projection around `origin`, in km.
 * Accurate enough over the tens of kilometres we use it for, and far cheaper
 * than haversine inside the point-to-segment loop.
 */
function planar(p, origin) {
  return {
    x: toRad(p.lon - origin.lon) * Math.cos(toRad(origin.lat)) * R,
    y: toRad(p.lat - origin.lat) * R,
  };
}

/** Shortest distance from point `p` to segment `a`–`b`, plus where it landed (0..1). */
function pointToSegment(p, a, b) {
  const P = planar(p, a);
  const B = planar(b, a);
  const len2 = B.x * B.x + B.y * B.y;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (P.x * B.x + P.y * B.y) / len2));
  const dx = P.x - B.x * t;
  const dy = P.y - B.y * t;
  return { km: Math.hypot(dx, dy), t };
}

/**
 * Thins a polyline to roughly one point every `everyKm`, always keeping the
 * endpoints. The corridor test runs over hundreds of chargers, so trimming a
 * 5000-point geometry to a few hundred matters and costs no useful accuracy.
 */
export function simplify(line, everyKm = 1) {
  if (line.length < 3) return line.map((p) => ({ ...p, progressKm: 0 }));
  const out = [{ ...line[0], progressKm: 0 }];
  let cumulative = 0;
  let sinceLast = 0;
  for (let i = 1; i < line.length; i++) {
    const step = haversine(line[i - 1], line[i]);
    cumulative += step;
    sinceLast += step;
    if (sinceLast >= everyKm || i === line.length - 1) {
      out.push({ ...line[i], progressKm: cumulative });
      sinceLast = 0;
    }
  }
  return out;
}

/**
 * For each site, its straight-line distance to the route and how far along the
 * route that happens — the ordering key the planner needs.
 * Sites further than `corridorKm` from the route are dropped.
 */
export function projectOntoRoute(sites, thinnedLine, corridorKm) {
  const out = [];
  // Cheap bounding-box reject before the per-segment loop.
  const pad = corridorKm / 70; // degrees, generous at these latitudes
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const p of thinnedLine) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
  }

  for (const site of sites) {
    if (site.lat < minLat - pad || site.lat > maxLat + pad) continue;
    if (site.lon < minLon - pad || site.lon > maxLon + pad) continue;

    let bestKm = Infinity;
    let bestProgress = 0;
    for (let i = 0; i < thinnedLine.length - 1; i++) {
      const a = thinnedLine[i];
      const b = thinnedLine[i + 1];
      const { km, t } = pointToSegment(site, a, b);
      if (km < bestKm) {
        bestKm = km;
        bestProgress = a.progressKm + t * (b.progressKm - a.progressKm);
      }
    }
    if (bestKm <= corridorKm) {
      out.push({ site, detourKm: bestKm, progressKm: bestProgress });
    }
  }
  return out.sort((a, b) => a.progressKm - b.progressKm);
}
