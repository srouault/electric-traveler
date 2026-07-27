#!/usr/bin/env node
/**
 * Plans the same trip several ways and puts the results side by side.
 *
 *   node scripts/compare-routes.mjs "Saint-Raphaël" "Zwolle" \
 *     --route "Direct|" \
 *     --route "Luxembourg|Luxembourg" \
 *     --route "Lux + Liège|Luxembourg;Liège"
 *
 * Each --route is "Label|via;via;…". Settings flags match plan-cli.mjs.
 */
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { plan } from '../js/planner.js';
import { planCorridors } from '../js/corridors.js';
import { geocode } from '../js/routing.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);

const positional = [];
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) i++;
  else positional.push(args[i]);
}
const raw = (n) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const num = (n, d) => (raw(n) === undefined ? d : Number(raw(n)));
const routes = args.map((a, i) => (a === '--route' ? args[i + 1] : null)).filter(Boolean);

const auto = args.includes('--auto');

if (positional.length < 2 || (!routes.length && !auto)) {
  console.error('usage: compare-routes.mjs <from> <to> (--auto | --route "Label|via;via" …) [--temp C] [--start-soc 0-1]');
  console.error('  --auto  discover distinct road corridors automatically instead of naming vias');
  process.exit(1);
}

const { sites } = JSON.parse(await readFile(resolve(ROOT, 'data/superchargers.json'), 'utf8'));

const settings = {};
if (raw('temp') !== undefined) settings.temperatureC = num('temp');
if (raw('start-soc') !== undefined) settings.startSoc = num('start-soc');
if (raw('max-soc') !== undefined) settings.maxSoc = num('max-soc');
if (raw('reserve') !== undefined) settings.reserveSoc = num('reserve');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Nominatim asks for at most one request a second, and we look up the same
// place names repeatedly across variants — so cache and pace.
const placeCache = new Map();
async function place(name) {
  if (placeCache.has(name)) return placeCache.get(name);
  await sleep(1100);
  const [hit] = await geocode(name, 1);
  if (!hit) throw new Error(`Could not geocode "${name}"`);
  // Echo what the geocoder actually chose. Place names repeat all over Europe
  // — "Saint-Raphaël" alone resolves to a hamlet in the Dordogne, not the Var.
  process.stderr.write(`  "${name}" → ${hit.label.slice(0, 80)}  [${hit.lat.toFixed(4)}, ${hit.lon.toFixed(4)}]\n`);
  const p = { lat: hit.lat, lon: hit.lon, label: name };
  placeCache.set(name, p);
  return p;
}

const from = await place(positional[0]);
const to = await place(positional[1]);

const hm = (min) => {
  const t = Math.round(min);
  return `${Math.floor(t / 60)}h${String(t % 60).padStart(2, '0')}`;
};
const pct = (s) => `${Math.round(s * 100)}%`;

const results = [];

if (auto) {
  const { routes: found, failed } = await planCorridors(from, to, sites, settings, {
    corridorKm: num('corridor', 20),
    limit: num('limit', 4),
    onProgress: (m) => process.stderr.write(`  … ${m}\n`),
  });
  for (const f of found) results.push({ label: f.label, viaNames: [], r: f.plan });
  for (const f of failed) results.push({ label: f.label, viaNames: [], error: f.error });
}

for (const spec of routes) {
  const [label, viaSpec = ''] = spec.split('|');
  const viaNames = viaSpec.split(';').map((s) => s.trim()).filter(Boolean);
  process.stderr.write(`planning ${label}…\n`);
  try {
    const via = [];
    for (const n of viaNames) via.push(await place(n));
    const r = await plan(from, to, sites, settings, { via, corridorKm: num('corridor', 20) });
    results.push({ label, viaNames, r });
  } catch (err) {
    results.push({ label, viaNames, error: err.message });
  }
  await sleep(700); // be gentle with the OSRM demo server
}

const ok = results.filter((x) => x.r).sort((a, b) => a.r.totalMinutes - b.r.totalMinutes);
const fastest = ok[0]?.r.totalMinutes;

console.log(`\n${positional[0]} → ${positional[1]}`);
const s = { ...settings };
console.log(`start ${pct(s.startSoc ?? 0.9)} · ${s.temperatureC ?? 15}°C · iX1 eDrive20\n`);

const pad = (v, n) => String(v).padEnd(n);
const lpad = (v, n) => String(v).padStart(n);
console.log(`${pad('ROUTE', 26)}${lpad('KM', 6)}${lpad('DRIVE', 8)}${lpad('CHARGE', 8)}${lpad('TOTAL', 8)}${lpad('STOPS', 7)}${lpad('vs BEST', 9)}`);
console.log('─'.repeat(72));
for (const { label, r } of ok) {
  const delta = r.totalMinutes - fastest;
  console.log(
    pad(label, 26) +
      lpad(r.totalKm.toFixed(0), 6) +
      lpad(hm(r.driveMinutes), 8) +
      lpad(hm(r.chargeMinutes), 8) +
      lpad(hm(r.totalMinutes), 8) +
      lpad(r.stops.length, 7) +
      lpad(delta < 1 ? '—' : `+${hm(delta)}`, 9),
  );
}
for (const { label, error } of results.filter((x) => x.error)) {
  console.log(`${pad(label, 26)}  failed: ${error}`);
}

for (const { label, r } of ok) {
  console.log(`\n\n═══ ${label} ═══  ${r.totalKm.toFixed(0)} km · ${hm(r.totalMinutes)} total · ${r.stops.length} stops`);
  r.stops.forEach((st, i) => {
    console.log(`${i + 1}. ${st.address}`);
    console.log(`   ${st.name} · ${st.kw} kW · ${st.stalls} stalls · after ${st.legInKm.toFixed(0)} km · ${pct(st.arriveSoc)}→${pct(st.departSoc)} · ${Math.round(st.chargeMinutes)} min`);
  });
  console.log(`   arrive ${pct(r.arrivalSoc)}`);
  for (const w of r.warnings) console.log(`   ! ${w}`);
}
