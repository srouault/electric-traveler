#!/usr/bin/env node
/**
 * Regenerates data/superchargers.json from supercharge.info.
 *
 * We only keep sites a BMW iX1 can actually use:
 *   - status OPEN            (not permit/construction/closed)
 *   - otherEVs true          (open to non-Tesla vehicles)
 *   - at least one CCS2 plug (the iX1's DC connector in Europe)
 *   - in one of COUNTRIES
 *
 * Run: node scripts/fetch-superchargers.mjs
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE = 'https://supercharge.info/service/supercharge/allSites';
const COUNTRIES = ['France', 'Belgium', 'Netherlands', 'Luxembourg', 'Germany'];

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'data/superchargers.json');

// ISO codes so the exported addresses read the way a nav system expects.
const COUNTRY_CODE = {
  France: 'FR',
  Belgium: 'BE',
  Netherlands: 'NL',
  Luxembourg: 'LU',
  Germany: 'DE',
};

function round(n, places) {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

/** Full one-line postal address, the string that goes into the BMW planner. */
function formatAddress(site) {
  const a = site.address || {};
  const cityLine = [a.zip, a.city].filter(Boolean).join(' ');
  return [a.street, cityLine, COUNTRY_CODE[a.country] || a.country]
    .filter(Boolean)
    .join(', ');
}

function usable(site) {
  if (site.status !== 'OPEN') return false;
  if (site.otherEVs !== true) return false;
  if (!COUNTRIES.includes(site.address?.country)) return false;
  if (!((site.plugs?.ccs2 ?? 0) > 0)) return false;
  const { latitude, longitude } = site.gps || {};
  return Number.isFinite(latitude) && Number.isFinite(longitude);
}

/** Trim each record to what the planner and the UI actually read. */
function compact(site) {
  const a = site.address || {};
  return {
    id: site.id,
    name: site.name,
    lat: round(site.gps.latitude, 5),
    lon: round(site.gps.longitude, 5),
    // Peak power per stall in kW. Missing on a few old sites; 150 is the
    // conservative floor for a Supercharger and still above the iX1's 130 kW.
    kw: site.powerKilowatt || 150,
    stalls: site.stallCount || 0,
    street: a.street || '',
    city: a.city || '',
    zip: a.zip || '',
    cc: COUNTRY_CODE[a.country] || a.country,
    address: formatAddress(site),
    // Handy for "is this at a service area or a supermarket car park?"
    facility: site.facilityName || '',
  };
}

const res = await fetch(SOURCE, {
  headers: { 'user-agent': 'electric-traveler/1.0 (+github.com/srouault/electric-traveler)' },
});
if (!res.ok) throw new Error(`supercharge.info returned HTTP ${res.status}`);

const all = await res.json();
const sites = all.filter(usable).map(compact).sort((x, y) => x.cc.localeCompare(y.cc) || x.name.localeCompare(y.name));

if (sites.length < 400) {
  throw new Error(`Only ${sites.length} sites survived filtering — that looks wrong, refusing to overwrite the dataset.`);
}

const payload = {
  generated: new Date().toISOString().slice(0, 10),
  source: SOURCE,
  countries: COUNTRIES.map((c) => COUNTRY_CODE[c]),
  filter: 'status=OPEN, otherEVs=true, ccs2>0',
  count: sites.length,
  sites,
};

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify(payload, null, 0) + '\n');

const byCountry = {};
for (const s of sites) byCountry[s.cc] = (byCountry[s.cc] || 0) + 1;
console.log(`Wrote ${sites.length} sites to data/superchargers.json`);
for (const [cc, n] of Object.entries(byCountry).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${cc}: ${n}`);
}
