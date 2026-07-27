#!/usr/bin/env node
/**
 * Plans a trip from the command line, using the same modules the web page does.
 * Useful for checking the optimiser without a browser.
 *
 *   node scripts/plan-cli.mjs "Brussels" "Nice" --temp 5 --start-soc 0.8
 */
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { plan } from '../js/planner.js';
import { geocode } from '../js/routing.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);

// Every flag here takes a value, so skip the token after one — otherwise flag
// values get mistaken for the from/to arguments.
const positional = [];
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) i++;
  else positional.push(args[i]);
}
const raw = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const flag = (name, fallback) => (raw(name) === undefined ? fallback : Number(raw(name)));

if (positional.length < 2) {
  console.error(
    'usage: plan-cli.mjs <from> <to> [--via "A;B"] [--temp C] [--start-soc 0-1] [--corridor km] [--max-soc 0-1]',
  );
  process.exit(1);
}

const { sites } = JSON.parse(await readFile(resolve(ROOT, 'data/superchargers.json'), 'utf8'));

const [fromHit] = await geocode(positional[0], 1);
const [toHit] = await geocode(positional[1], 1);
if (!fromHit || !toHit) {
  console.error('Could not geocode one of those places.');
  process.exit(1);
}
// Show what the geocoder picked — ambiguous place names are common in Europe.
console.error(`  from: ${fromHit.label.slice(0, 80)}`);
console.error(`  to:   ${toHit.label.slice(0, 80)}`);

const settings = {};
if (args.includes('--temp')) settings.temperatureC = flag('temp');
if (args.includes('--start-soc')) settings.startSoc = flag('start-soc');
if (args.includes('--max-soc')) settings.maxSoc = flag('max-soc');
if (args.includes('--reserve')) settings.reserveSoc = flag('reserve');

// --via "Luxembourg;Liège" — semicolon separated, in order.
const via = [];
for (const name of (raw('via') || '').split(';').map((s) => s.trim()).filter(Boolean)) {
  const [hit] = await geocode(name, 1);
  if (!hit) {
    console.error(`Could not geocode via point "${name}".`);
    process.exit(1);
  }
  via.push({ lat: hit.lat, lon: hit.lon, label: name });
}

const started = Date.now();
const result = await plan(
  { lat: fromHit.lat, lon: fromHit.lon, label: positional[0] },
  { lat: toHit.lat, lon: toHit.lon, label: positional[1] },
  sites,
  settings,
  { via, corridorKm: flag('corridor', 20), onProgress: (m) => console.error(`  … ${m}`) },
);

const hm = (min) => {
  const total = Math.round(min);
  return `${Math.floor(total / 60)}h${String(total % 60).padStart(2, '0')}`;
};
const pct = (s) => `${Math.round(s * 100)}%`;

console.log(`\n${positional[0]} → ${positional[1]}`);
console.log(`${result.totalKm.toFixed(0)} km · drive ${hm(result.driveMinutes)} · charge ${hm(result.chargeMinutes)} · total ${hm(result.totalMinutes)}`);
console.log(`${result.stops.length} stop(s), chosen from ${result.candidatesConsidered} candidates, solved in ${((Date.now() - started) / 1000).toFixed(1)}s\n`);

for (const [i, s] of result.stops.entries()) {
  console.log(`${i + 1}. ${s.name}  (${s.kw} kW, ${s.stalls} stalls)`);
  console.log(`   ${s.address}`);
  console.log(`   after ${s.legInKm.toFixed(0)} km: arrive ${pct(s.arriveSoc)} → leave ${pct(s.departSoc)}  (+${s.kwhAdded.toFixed(1)} kWh, ${Math.round(s.chargeMinutes)} min)`);
}
console.log(`\nArrive with ${pct(result.arrivalSoc)}.`);
for (const w of result.warnings) console.log(`! ${w}`);
