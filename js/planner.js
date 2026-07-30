/**
 * Charging-stop optimiser.
 *
 * The goal is the fastest arrival, not the fewest stops — on a 130 kW car those
 * are different answers. Three extra short stops low in the charge curve
 * regularly beat two long ones dragged up past 80%.
 *
 * Method:
 *   1. route A→B, keep the geometry
 *   2. keep Superchargers within a corridor of that line, capped at what the
 *      OSRM matrix endpoint will accept, spread evenly along the route
 *   3. one matrix call for real road distances/times between every pair
 *   4. shortest path over (charger, state-of-charge) states, where the cost of
 *      an edge is driving time plus the time spent charging to afford it
 *
 * Step 4 is what makes it a true optimisation rather than a greedy "drive until
 * low, stop at the nearest charger" heuristic.
 */

import { matrix, route, MAX_MATRIX_COORDS } from './routing.js';
import { haversine, projectOntoRoute, simplify } from './geo.js';
import { DEFAULTS, chargeMinutes, energyFor, legMinutes, rangeAt } from './vehicle.js';

/** SoC is discretised for the search. 2% ≈ 1.3 kWh ≈ 6 km — finer than we can predict anyway. */
const SOC_STEP = 0.02;
const BUCKETS = Math.round(1 / SOC_STEP) + 1;
const socOf = (b) => b * SOC_STEP;
/** Always round *down*: never let rounding invent range the car does not have. */
const bucketOf = (soc) => Math.max(0, Math.min(BUCKETS - 1, Math.floor(soc / SOC_STEP + 1e-9)));

const MAX_CANDIDATES = MAX_MATRIX_COORDS - 2; // leave room for origin and destination

export class PlanError extends Error {}

/**
 * Picks which chargers to hand to the optimiser.
 *
 * A naive "closest N to the line" pick clusters around cities and leaves gaps
 * in open country, which is exactly where the search needs options. So we slice
 * the route into equal segments and take the best few from each.
 */
function selectCandidates(projected, corridorKm, limit = MAX_CANDIDATES) {
  if (projected.length <= limit) return projected;

  const score = (c) =>
    (Math.min(c.site.kw, 250) / 250) * 2 +
    Math.min(c.site.stalls, 20) / 20 -
    (c.detourKm / Math.max(corridorKm, 1)) * 2;

  const segments = Math.ceil(limit / 2);
  const totalKm = projected[projected.length - 1].progressKm || 1;
  const buckets = Array.from({ length: segments }, () => []);
  for (const c of projected) {
    const idx = Math.min(segments - 1, Math.floor((c.progressKm / totalKm) * segments));
    buckets[idx].push(c);
  }

  const picked = new Set();
  for (const bucket of buckets) {
    bucket.sort((a, b) => score(b) - score(a));
    for (const c of bucket.slice(0, 2)) picked.add(c);
  }
  // Spend any leftover slots on the best sites we passed over.
  if (picked.size < limit) {
    for (const c of [...projected].sort((a, b) => score(b) - score(a))) {
      if (picked.size >= limit) break;
      picked.add(c);
    }
  }
  return [...picked].sort((a, b) => a.progressKm - b.progressKm);
}

/**
 * Shortest path over (node, arrival SoC) states.
 * Nodes are ordered along the route, so edges only ever point forward and the
 * graph is a DAG — one sweep in order is enough, no priority queue needed.
 */
function search(nodes, m, cfg, maxDepartSoc) {
  const n = nodes.length;
  const battery = cfg.batteryKwh;
  const reserveBucket = bucketOf(cfg.reserveSoc);
  const maxDepartBucket = bucketOf(maxDepartSoc + 1e-9);

  const best = new Float64Array(n * BUCKETS).fill(Infinity);
  const prevNode = new Int32Array(n * BUCKETS).fill(-1);
  const prevBucket = new Int32Array(n * BUCKETS).fill(-1);
  const viaDepart = new Int32Array(n * BUCKETS).fill(-1);

  best[0 * BUCKETS + bucketOf(cfg.startSoc)] = 0;

  // Prune hops no battery could cover. Deliberately optimistic — gentle speed,
  // no cold penalty — because this bound must never discard a leg that the
  // real, per-leg energy check below would have accepted.
  const fullRangeKm = rangeAt(1, 60, { ...cfg, speedFactor: 1, temperatureC: Math.max(cfg.temperatureC, 20) });
  // A "via" is a place the trip must pass through, so no edge may jump over
  // one. Capping each node's successors at the next via downstream enforces
  // that without any extra bookkeeping in the search itself.
  const nextVia = new Int32Array(n).fill(n - 1);
  for (let i = n - 2; i >= 0; i--) {
    nextVia[i] = nodes[i + 1].isVia ? i + 1 : nextVia[i + 1];
  }

  const successors = [];
  for (let i = 0; i < n; i++) {
    const list = [];
    const limit = Math.min(n - 1, nextVia[i]);
    for (let j = i + 1; j <= limit; j++) {
      const km = m.km[i][j];
      if (km != null && km <= fullRangeKm * 1.05) list.push(j);
    }
    successors.push(list);
  }

  // Cache charge times per (station, from, to) — the inner loop asks repeatedly.
  const chargeCache = new Map();
  const chargeTime = (nodeIdx, from, to) => {
    const key = nodeIdx * BUCKETS * BUCKETS + from * BUCKETS + to;
    let v = chargeCache.get(key);
    if (v === undefined) {
      v = chargeMinutes(socOf(from), socOf(to), nodes[nodeIdx].kw, cfg) + cfg.stopOverheadMin;
      chargeCache.set(key, v);
    }
    return v;
  };

  for (let i = 0; i < n - 1; i++) {
    const succ = successors[i];
    if (!succ.length) continue;
    // Neither the origin nor a via point is a charging opportunity.
    const isCharger = i > 0 && !nodes[i].isVia;
    for (let k = reserveBucket; k < BUCKETS; k++) {
      const arrivedAt = best[i * BUCKETS + k];
      if (!Number.isFinite(arrivedAt)) continue;

      const topBucket = isCharger ? maxDepartBucket : k;
      for (let d = k; d <= topBucket; d++) {
        const departTime = arrivedAt + (d > k ? chargeTime(i, k, d) : 0);
        const departSoc = socOf(d);

        for (const j of succ) {
          const km = m.km[i][j];
          const min = m.minutes[i][j];
          if (min == null || min <= 0) continue;
          // Cost the leg at the speed we'd really drive it, not the router's.
          const routerSpeed = km / (min / 60);
          const socArrive = departSoc - energyFor(km, routerSpeed, cfg) / battery;
          if (socArrive < cfg.reserveSoc - 1e-9) continue;

          const kb = bucketOf(socArrive);
          const total = departTime + legMinutes(km, routerSpeed, cfg);
          const idx = j * BUCKETS + kb;
          if (total < best[idx]) {
            best[idx] = total;
            prevNode[idx] = i;
            prevBucket[idx] = k;
            viaDepart[idx] = d;
          }
        }
      }
    }
  }

  // Best way to arrive at the destination, at any state of charge.
  let endBucket = -1;
  let endTime = Infinity;
  for (let k = reserveBucket; k < BUCKETS; k++) {
    const t = best[(n - 1) * BUCKETS + k];
    if (t < endTime) {
      endTime = t;
      endBucket = k;
    }
  }
  if (endBucket < 0) return null;

  const path = [];
  let node = n - 1;
  let bucket = endBucket;
  while (node > 0) {
    const idx = node * BUCKETS + bucket;
    path.push({ node, arriveBucket: bucket, departBucket: viaDepart[idx] });
    const pn = prevNode[idx];
    const pb = prevBucket[idx];
    node = pn;
    bucket = pb;
  }
  path.push({ node: 0, arriveBucket: bucketOf(cfg.startSoc), departBucket: bucketOf(cfg.startSoc) });
  path.reverse();
  return { path, minutes: endTime };
}

/**
 * Final schedule over the *actual* driven route.
 *
 * The search worked from matrix figures; the real multi-stop route differs
 * slightly. With a charge curve that only ever falls, the fastest way to drive
 * a fixed set of stops is to take the minimum charge needed to reach the next
 * one — time spent at a high, slow SoC is always better spent at the next
 * stop's low, fast one. So we re-derive charge amounts here rather than reuse
 * the search's buckets.
 */
function schedule(stops, legs, cfg) {
  const battery = cfg.batteryKwh;
  const warnings = [];
  const out = [];
  let soc = cfg.startSoc;

  // legEnergy[i] is the leg *into* stop i; the last entry runs to the destination.
  const legEnergy = legs.map((leg) => energyFor(leg.km, leg.routerSpeed, cfg) / battery);

  for (let i = 0; i < stops.length; i++) {
    soc -= legEnergy[i];
    const arriveSoc = soc;
    const needed = legEnergy[i + 1] + cfg.reserveSoc;
    let departSoc = Math.min(1, Math.max(arriveSoc, needed));

    if (departSoc > cfg.maxSoc + 1e-9) {
      warnings.push(
        `Charging to ${Math.round(departSoc * 100)}% at ${stops[i].name} — above your ${Math.round(
          cfg.maxSoc * 100,
        )}% limit — because the next leg needs it.`,
      );
    }
    if (needed > 1 + 1e-9) {
      warnings.push(`The leg after ${stops[i].name} is beyond a full battery; the plan may not be drivable.`);
      departSoc = 1;
    }

    const minutes = chargeMinutes(arriveSoc, departSoc, stops[i].kw, cfg);
    out.push({
      ...stops[i],
      arriveSoc,
      departSoc,
      chargeMinutes: minutes,
      // Only bill the fixed overhead when we genuinely stop.
      stopMinutes: minutes > 0 ? minutes + cfg.stopOverheadMin : 0,
      kwhAdded: (departSoc - arriveSoc) * battery,
      legInKm: legs[i].km,
      legInMinutes: legs[i].minutes,
    });
    soc = departSoc;
  }

  return { stops: out, arrivalSoc: soc - legEnergy[legEnergy.length - 1], warnings };
}

/**
 * Collapses the routed legs onto the charging stops.
 *
 * Via points are waypoints in the driven route but not stops, so from the
 * energy schedule's point of view the legs either side of one are a single leg.
 */
function mergeLegs(full, waypoints) {
  if (full.legs.length !== waypoints.length + 1) {
    return [{ km: full.km, minutes: full.minutes }];
  }
  const merged = [];
  let km = 0;
  let minutes = 0;
  for (let i = 0; i < full.legs.length; i++) {
    km += full.legs[i].km;
    minutes += full.legs[i].minutes;
    // legs[i] arrives at waypoints[i]; the final leg arrives at the destination.
    if (i >= waypoints.length || waypoints[i].isStop) {
      merged.push({ km, minutes });
      km = 0;
      minutes = 0;
    }
  }
  return merged;
}

/**
 * Other Superchargers near a planned stop — what you drive to when you arrive
 * and the site is full, broken, or the queue is twenty minutes deep.
 *
 * Distances are straight-line, so they are labelled as such; a road detour is
 * always longer. Reachability is the part that matters: the plan plots arrival
 * at your reserve, so diverting anywhere spends the reserve itself.
 */
function nearbyAlternatives(stop, sites, cfg, radiusKm = 25, max = 3) {
  const near = [];
  for (const s of sites) {
    if (s.id === stop.id) continue;
    const awayKm = haversine(stop, s);
    if (awayKm <= radiusKm) near.push({ site: s, awayKm });
  }

  // Nearest first, but a big fast site earns a little distance forgiveness.
  const score = (x) => x.awayKm - Math.min(x.site.stalls, 24) * 0.15 - (x.site.kw >= 250 ? 1.5 : 0);
  near.sort((a, b) => score(a) - score(b));

  return near.slice(0, max).map(({ site, awayKm }) => {
    const roadKm = awayKm * 1.3; // crow-fly understates the drive
    const cost = energyFor(roadKm, 90, cfg) / cfg.batteryKwh;
    // The charge you'd actually roll in on. "Reachable" alone is no use here:
    // the plan arrives at your reserve, so almost anything inside 25 km is
    // technically reachable while leaving you on 1%.
    const socThere = stop.arriveSoc - cost;
    return { ...site, awayKm, socThere, reachable: socThere > 0.02, tight: socThere < 0.05 };
  });
}

/**
 * Restates each leg's duration at the speed we will actually drive, keeping the
 * router's own speed alongside it so the energy model can still see it.
 */
function adjustLegs(legs, cfg) {
  return legs.map((leg) => {
    const routerSpeed = leg.minutes > 0 ? leg.km / (leg.minutes / 60) : 90;
    return { km: leg.km, minutes: legMinutes(leg.km, routerSpeed, cfg), routerSpeed };
  });
}

/**
 * Plans a trip.
 *
 * @param {{lat,lon,label?}} start
 * @param {{lat,lon,label?}} end
 * @param {Array} sites   charger dataset
 * @param {object} settings  overrides for the vehicle/trip defaults
 * @param {{corridorKm?:number, via?:Array, onProgress?:Function}} options
 *   `via` is an ordered list of {lat, lon, label} the route must pass through.
 */
export async function plan(start, end, sites, settings = {}, options = {}) {
  const cfg = { ...DEFAULTS, ...settings };
  const corridorKm = options.corridorKm ?? 20;
  const via = options.via ?? [];
  const say = options.onProgress || (() => {});

  if (cfg.startSoc <= cfg.reserveSoc) {
    throw new PlanError('Starting charge is at or below your reserve — nothing to drive on.');
  }

  // A caller comparing corridors already has the base route and passes it in,
  // so we neither refetch it nor lose the corridor it describes.
  let direct = options.baseRoute;
  if (!direct) {
    say(via.length ? 'Finding the route through your via points…' : 'Finding the direct route…');
    direct = await route([start, ...via, end]);
  }

  // Can we simply drive it? Then no amount of cleverness helps.
  const directSpeed = direct.km / (direct.minutes / 60);
  const directEnergy = energyFor(direct.km, directSpeed, cfg) / cfg.batteryKwh;
  if (cfg.startSoc - directEnergy >= cfg.reserveSoc) {
    const directMinutes = legMinutes(direct.km, directSpeed, cfg);
    return {
      stops: [],
      legs: [{ km: direct.km, minutes: directMinutes, routerSpeed: directSpeed }],
      line: direct.line,
      totalKm: direct.km,
      driveMinutes: directMinutes,
      chargeMinutes: 0,
      totalMinutes: directMinutes,
      arrivalSoc: cfg.startSoc - directEnergy,
      via,
      candidatesConsidered: 0,
      warnings: [],
      cfg,
    };
  }

  say('Selecting Superchargers along the way…');
  const thinned = simplify(direct.line, 1);
  const projected = projectOntoRoute(sites, thinned, corridorKm);
  if (!projected.length) {
    throw new PlanError(
      `No usable Superchargers within ${corridorKm} km of this route. Widen the corridor, or the route may leave the covered countries (FR, BE, NL, LU, DE).`,
    );
  }
  const candidates = selectCandidates(projected, corridorKm, MAX_CANDIDATES - via.length);

  say(`Measuring ${candidates.length} candidates…`);
  // Via points ride in the same ordered node list as the chargers, so the
  // search sees one sequence and the "don't skip a via" rule is just an
  // ordering constraint.
  const viaNodes = via.map((v) => ({
    ...v,
    name: v.label || 'Via',
    kw: 0,
    isVia: true,
    progressKm: projectOntoRoute([v], thinned, Infinity)[0]?.progressKm ?? 0,
  }));
  const middle = [
    ...candidates.map((c) => ({ ...c.site, detourKm: c.detourKm, progressKm: c.progressKm })),
    ...viaNodes,
  ].sort((a, b) => a.progressKm - b.progressKm);

  const nodes = [
    { ...start, name: start.label || 'Start', kw: 0 },
    ...middle,
    { ...end, name: end.label || 'Destination', kw: 0 },
  ];
  const m = await matrix(nodes);

  say('Optimising stops…');
  let result = search(nodes, m, cfg, cfg.maxSoc);
  let relaxed = false;
  if (!result) {
    // Nothing worked inside the user's charge ceiling; retry allowing a full battery.
    result = search(nodes, m, cfg, 1);
    relaxed = true;
  }
  if (!result) {
    throw new PlanError(
      'No drivable chain of Superchargers found. Try a wider corridor, a higher starting charge, or a lower reserve.',
    );
  }

  // The search may thread the path through a charger without charging at it,
  // simply because it sits on the fastest road. Those are not stops — but via
  // points still have to be waypoints in the final route.
  const waypoints = result.path
    .slice(1, -1)
    .filter((p) => nodes[p.node].isVia || p.departBucket > p.arriveBucket)
    .map((p) => ({ node: nodes[p.node], isStop: !nodes[p.node].isVia }));
  const chosen = waypoints.filter((w) => w.isStop).map((w) => w.node);

  say('Building the final route…');
  const full = await route([start, ...waypoints.map((w) => w.node), end]);
  const legs = adjustLegs(mergeLegs(full, waypoints), cfg);
  const { stops: scheduled, arrivalSoc, warnings } = schedule(chosen, legs, cfg);
  const stops = scheduled.map((s) => ({ ...s, alternatives: nearbyAlternatives(s, sites, cfg) }));

  if (relaxed) {
    warnings.unshift(`Had to charge past ${Math.round(cfg.maxSoc * 100)}% to make this route work.`);
  }

  const chargeTotal = stops.reduce((sum, s) => sum + s.stopMinutes, 0);
  const driveTotal = legs.reduce((sum, l) => sum + l.minutes, 0);
  return {
    stops,
    legs,
    line: full.line,
    totalKm: full.km,
    driveMinutes: driveTotal,
    chargeMinutes: chargeTotal,
    totalMinutes: driveTotal + chargeTotal,
    arrivalSoc,
    via,
    candidatesConsidered: candidates.length,
    warnings,
    cfg,
  };
}
