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

/** Initial bearing from `a` to `b`, in degrees. */
export function bearing(a, b) {
  const φ1 = toRad(a.lat);
  const φ2 = toRad(b.lat);
  const Δλ = toRad(b.lon - a.lon);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** The point `km` away from `origin` on the given bearing. */
export function destination(origin, bearingDeg, km) {
  const δ = km / R;
  const θ = toRad(bearingDeg);
  const φ1 = toRad(origin.lat);
  const λ1 = toRad(origin.lon);
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
  return { lat: (φ2 * 180) / Math.PI, lon: (((λ2 * 180) / Math.PI + 540) % 360) - 180 };
}

/** The point a given fraction (0–1) of the way along a polyline, by distance. */
export function pointAtProgress(line, fraction) {
  if (line.length < 2) return line[0];
  let total = 0;
  for (let i = 1; i < line.length; i++) total += haversine(line[i - 1], line[i]);
  const target = total * Math.min(1, Math.max(0, fraction));
  let acc = 0;
  for (let i = 1; i < line.length; i++) {
    const step = haversine(line[i - 1], line[i]);
    if (acc + step >= target) return line[i];
    acc += step;
  }
  return line[line.length - 1];
}

/**
 * How far apart two routes run, in km: the mean distance from samples of `a` to
 * the nearest point on `b`. Used to tell a genuinely different corridor from
 * the same road with a slightly different exit.
 */
export function routeDivergence(a, b, samples = 24) {
  const thinB = simplify(b, 5);
  let sum = 0;
  let n = 0;
  let worst = 0;
  for (let i = 0; i <= samples; i++) {
    const p = pointAtProgress(a, i / samples);
    let best = Infinity;
    for (let j = 0; j < thinB.length - 1; j++) {
      const { km } = pointToSegment(p, thinB[j], thinB[j + 1]);
      if (km < best) best = km;
    }
    sum += best;
    if (best > worst) worst = best;
    n++;
  }
  return { mean: sum / n, max: worst };
}

/** Where along `a` it strays furthest from `b` — the point that characterises it. */
export function divergencePoint(a, b, samples = 40) {
  const thinB = simplify(b, 5);
  let worst = -1;
  let at = a[0];
  for (let i = 0; i <= samples; i++) {
    const p = pointAtProgress(a, i / samples);
    let best = Infinity;
    for (let j = 0; j < thinB.length - 1; j++) {
      const { km } = pointToSegment(p, thinB[j], thinB[j + 1]);
      if (km < best) best = km;
    }
    if (best > worst) {
      worst = best;
      at = p;
    }
  }
  return at;
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
