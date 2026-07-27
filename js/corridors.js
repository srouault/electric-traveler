/**
 * Finding genuinely different road corridors between two places.
 *
 * The planner optimises charging *along* a route; it does not choose the route.
 * That matters more than it sounds: OSRM scores German autobahn tagged
 * `maxspeed=none` at 140 km/h, so on a run from Provence to the Netherlands it
 * will send you through Germany even though the Luxembourg–Liège line is the
 * same distance or shorter.
 *
 * OSRM's own `alternatives` are no help over long distances — on that trip it
 * offers exactly one, and it is 146 km worse. So we discover corridors instead:
 * push a waypoint out sideways from the direct route and see what road network
 * answers. Probes that merely nudge the same motorway are folded together;
 * what survives is a handful of real choices.
 */

import { route } from './routing.js';
import { plan } from './planner.js';
import { bearing, destination, pointAtProgress, routeDivergence, divergencePoint, haversine } from './geo.js';

/**
 * Fractions along the base route to push sideways from. The late probe matters:
 * corridors that share most of their length often split only near the end.
 */
const PROBE_AT = [0.4, 0.6, 0.78];
/** How far sideways to push, in km. Both directions are tried. */
const PROBE_OFFSETS = [70, 150];
/**
 * Two routes are the same corridor only if they never stray this far apart.
 * Judged on the widest gap, not the average — routes that run together for
 * 800 km and then split by 100 km average out to looking identical, which is
 * exactly the case worth telling apart.
 */
const SAME_CORRIDOR_KM = 40;
/** Ignore detours this much longer than the direct route — they are not options. */
const MAX_DETOUR_FACTOR = 1.35;

/** Names a corridor after the place where it strays furthest from the direct line. */
function label(candidate, base, sites) {
  if (candidate === base) return 'Direct';
  const at = divergencePoint(candidate.line, base.line);
  let nearest = null;
  let best = Infinity;
  for (const s of sites) {
    const km = haversine(at, s);
    if (km < best) {
      best = km;
      nearest = s;
    }
  }
  return nearest ? `via ${nearest.city}` : 'Alternative';
}

/**
 * Returns distinct corridors, the direct route first and the rest ordered by
 * driving time. Each is `{ label, route }` and can be handed to plan() as
 * `baseRoute`.
 *
 * Costs roughly ten routing calls, so treat it as an explicit action rather
 * than something to run on every keystroke.
 */
export async function findCorridors(start, end, sites, { limit = 4, onProgress } = {}) {
  const say = onProgress || (() => {});

  say('Finding the direct route…');
  const base = await route([start, end], { overview: 'simplified', alternatives: 3 });
  const found = [base, ...(base.alternatives || [])];

  const heading = bearing(start, end);
  const probes = [];
  for (const f of PROBE_AT) {
    const anchor = pointAtProgress(base.line, f);
    for (const offset of PROBE_OFFSETS) {
      for (const side of [-1, 1]) {
        probes.push(destination(anchor, heading + side * 90, offset));
      }
    }
  }

  say(`Probing ${probes.length} alternative corridors…`);
  const results = await Promise.allSettled(
    probes.map((p) => route([start, p, end], { overview: 'simplified' })),
  );
  for (const r of results) {
    if (r.status === 'fulfilled') found.push(r.value);
  }

  // Keep the shortest-driving representative of each distinct corridor.
  const kept = [];
  for (const cand of found.sort((a, b) => a.minutes - b.minutes)) {
    if (cand !== base && cand.km > base.km * MAX_DETOUR_FACTOR) continue;
    const duplicate = kept.some((k) => routeDivergence(cand.line, k.line).max < SAME_CORRIDOR_KM);
    if (!duplicate) kept.push(cand);
  }

  // The direct route always belongs in the list, and always leads it.
  const ordered = [base, ...kept.filter((k) => k !== base)].slice(0, limit);
  return ordered.map((r) => ({ label: label(r, base, sites), route: r }));
}

/**
 * Plans every distinct corridor and ranks them by arrival time.
 *
 * The plans are what decide the order, not the raw driving times — a corridor
 * with thinner charging can lose on charge time what it won on the road.
 * Returns `[{ label, plan }]`, fastest first, with failures dropped.
 */
export async function planCorridors(start, end, sites, settings = {}, options = {}) {
  const say = options.onProgress || (() => {});
  const corridors = await findCorridors(start, end, sites, { limit: options.limit ?? 4, onProgress: say });

  const planned = [];
  for (const [i, c] of corridors.entries()) {
    say(`Planning ${c.label} (${i + 1} of ${corridors.length})…`);
    try {
      planned.push({
        label: c.label,
        plan: await plan(start, end, sites, settings, { ...options, baseRoute: c.route, onProgress: () => {} }),
      });
    } catch (err) {
      // One unchargeable corridor should not sink the comparison.
      planned.push({ label: c.label, error: err.message });
    }
  }

  const ok = planned.filter((p) => p.plan).sort((a, b) => a.plan.totalMinutes - b.plan.totalMinutes);
  if (!ok.length) throw new Error(planned[0]?.error || 'No corridor could be planned.');
  return { routes: ok, failed: planned.filter((p) => p.error) };
}
