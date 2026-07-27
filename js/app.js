/** Wires the page together: inputs → planner → map, list and exports. */

import { plan, PlanError } from './planner.js';
import { geocode, reverseGeocode, RoutingError } from './routing.js';
import { DEFAULTS } from './vehicle.js';
import { initMap, drawPlan, clearPlan, watchMe, centreOnMe, hasFix } from './map.js';
import { addressLines, toPlainText, toCsv, googleMapsUrl, stopMapUrl, copyText, download } from './export.js';

const $ = (id) => document.getElementById(id);
const SETTINGS_KEY = 'electric-traveler.settings';

/** Settings held as percentages in the UI but fractions in the model. */
const FIELDS = {
  startSoc: { pct: true },
  reserveSoc: { pct: true },
  maxSoc: { pct: true },
  batteryKwh: {},
  maxChargeKw: {},
  temperatureC: {},
  speedFactor: {},
  stopOverheadMin: {},
};

let sites = [];
let start = null;
let end = null;
let current = null; // last computed plan

/* ------------------------------------------------------------------ utils */

const hm = (min) => {
  const t = Math.round(min);
  return `${Math.floor(t / 60)}h${String(t % 60).padStart(2, '0')}`;
};
const pct = (s) => `${Math.round(s * 100)}%`;

function say(message, isError = false) {
  const el = $('status');
  el.textContent = message;
  el.classList.toggle('error', isError);
}

/** Momentary feedback on a button that just did something. */
async function flash(button, text = 'Copied') {
  const original = button.textContent;
  button.textContent = text;
  button.disabled = true;
  setTimeout(() => {
    button.textContent = original;
    button.disabled = false;
  }, 1200);
}

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

/* --------------------------------------------------------------- settings */

function readSettings() {
  const out = { corridorKm: Number($('corridorKm').value) || 20 };
  for (const [key, meta] of Object.entries(FIELDS)) {
    const raw = Number($(key).value);
    if (!Number.isFinite(raw)) continue;
    out[key] = meta.pct ? raw / 100 : raw;
  }
  return out;
}

function writeSettings(values) {
  for (const [key, meta] of Object.entries(FIELDS)) {
    const v = values[key] ?? DEFAULTS[key];
    $(key).value = meta.pct ? Math.round(v * 100) : v;
  }
  $('corridorKm').value = values.corridorKm ?? 20;
}

function persistSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(readSettings()));
  } catch {
    /* private browsing — settings just won't persist */
  }
}

function loadSettings() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
  } catch {
    saved = {};
  }
  writeSettings({ ...DEFAULTS, corridorKm: 20, ...saved });
}

/* ------------------------------------------------------------ place inputs */

/** Wires one address box to Nominatim, with a suggestion dropdown. */
function setupPlaceInput(input, list, chosen, onPick) {
  const hide = () => {
    list.hidden = true;
    list.innerHTML = '';
  };

  const setChosen = (place) => {
    onPick(place);
    chosen.textContent = place ? `✓ ${place.label}` : '';
    chosen.hidden = !place;
  };

  const search = debounce(async () => {
    const q = input.value.trim();
    if (q.length < 3) return hide();
    try {
      const hits = await geocode(q);
      if (input.value.trim() !== q) return; // a newer keystroke won the race
      if (!hits.length) return hide();
      list.innerHTML = '';
      for (const hit of hits) {
        const li = document.createElement('li');
        li.textContent = hit.label;
        li.addEventListener('mousedown', (e) => {
          e.preventDefault(); // keep focus so blur doesn't hide us first
          input.value = hit.label;
          setChosen(hit);
          hide();
        });
        list.appendChild(li);
      }
      list.hidden = false;
    } catch {
      hide(); // search failing should never block typing
    }
  }, 350);

  input.addEventListener('input', () => {
    setChosen(null); // typing invalidates the previous pick
    search();
  });
  input.addEventListener('blur', () => setTimeout(hide, 120));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hide();
    if (e.key === 'Enter') {
      hide();
      $('plan').click();
    }
  });

  return { setChosen, input };
}

/* ------------------------------------------------------------- via points */

const vias = []; // ordered; screen order is the order they're driven

/** Adds a "via" box between the start and destination fields. */
function addVia() {
  const row = document.createElement('div');
  row.className = 'field';
  row.innerHTML = `
    <label>Via</label>
    <div class="input-row">
      <input type="text" placeholder="Town or address to route through" autocomplete="off" spellcheck="false">
      <button class="icon-btn" type="button" title="Remove this via point">✕</button>
    </div>
    <ul class="suggestions" hidden></ul>
    <p class="chosen" hidden></p>`;
  $('vias').appendChild(row);

  const entry = { row, place: null };
  entry.ctl = setupPlaceInput(
    row.querySelector('input'),
    row.querySelector('.suggestions'),
    row.querySelector('.chosen'),
    (p) => {
      entry.place = p;
    },
  );
  row.querySelector('.input-row button').addEventListener('click', () => {
    row.remove();
    vias.splice(vias.indexOf(entry), 1);
  });
  vias.push(entry);
  row.querySelector('input').focus();
}

/** Resolves every via box that has text in it, in screen order. */
async function resolveVias() {
  const out = [];
  for (const v of vias) {
    if (v.place) {
      out.push(v.place);
      continue;
    }
    const typed = v.ctl.input.value.trim();
    if (!typed) continue;
    const [hit] = await geocode(typed, 1);
    if (!hit) throw new PlanError(`Could not find the via point "${typed}".`);
    v.ctl.setChosen(hit);
    out.push(hit);
  }
  return out;
}

/**
 * Makes sure both endpoints are resolved, geocoding whatever is typed if the
 * user never picked from the dropdown.
 */
async function resolveEndpoints(fromCtl, toCtl) {
  if (!start && fromCtl.input.value.trim()) {
    const [hit] = await geocode(fromCtl.input.value.trim(), 1);
    if (hit) fromCtl.setChosen(hit);
  }
  if (!end && toCtl.input.value.trim()) {
    const [hit] = await geocode(toCtl.input.value.trim(), 1);
    if (hit) toCtl.setChosen(hit);
  }
}

/* --------------------------------------------------------------- rendering */

function renderPlan(result) {
  $('stat-km').textContent = `${result.totalKm.toFixed(0)} km`;
  $('stat-drive').textContent = hm(result.driveMinutes);
  $('stat-charge').textContent = hm(result.chargeMinutes);
  $('stat-total').textContent = hm(result.totalMinutes);

  const n = result.stops.length;
  $('stat-arrive').textContent = n
    ? `${n} charging stop${n === 1 ? '' : 's'} · arriving with about ${pct(result.arrivalSoc)}`
    : `No charging needed — arriving with about ${pct(result.arrivalSoc)}`;

  const warnBox = $('warnings');
  warnBox.innerHTML = '';
  warnBox.hidden = !result.warnings.length;
  for (const w of result.warnings) {
    const p = document.createElement('p');
    p.textContent = w;
    warnBox.appendChild(p);
  }

  const list = $('stops');
  list.innerHTML = '';
  for (const [i, s] of result.stops.entries()) {
    const li = document.createElement('li');
    li.className = 'stop';

    const num = document.createElement('span');
    num.className = 'num';
    num.textContent = String(i + 1);

    const body = document.createElement('div');
    const addr = document.createElement('div');
    addr.className = 'addr';
    addr.textContent = s.address;
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent =
      `${s.name} · ${s.kw} kW · ${s.stalls} stalls — after ${s.legInKm.toFixed(0)} km, ` +
      `arrive ${pct(s.arriveSoc)} → leave ${pct(s.departSoc)} (${Math.round(s.chargeMinutes)} min)`;
    const link = document.createElement('a');
    link.href = stopMapUrl(s);
    link.target = '_blank';
    link.rel = 'noopener';
    link.className = 'meta';
    link.textContent = 'open in maps';
    body.append(addr, meta, link);

    const copy = document.createElement('button');
    copy.className = 'copy';
    copy.type = 'button';
    copy.textContent = 'Copy';
    copy.addEventListener('click', async () => {
      await copyText(s.address);
      flash(copy, '✓');
    });

    li.append(num, body, copy);
    list.appendChild(li);
  }

  const { url, truncated } = googleMapsUrl(result, start, end);
  $('gmaps').href = url;
  $('gmaps-note').hidden = !truncated;
  if (truncated) {
    $('gmaps-note').textContent = 'Google Maps links carry at most 9 stops — the link above covers the first 9.';
  }

  $('results').hidden = false;
}

/* ------------------------------------------------------------------- plan  */

async function runPlan(fromCtl, toCtl) {
  const button = $('plan');
  button.disabled = true;
  try {
    await resolveEndpoints(fromCtl, toCtl);
    if (!start || !end) {
      say('Enter a start and a destination.', true);
      return;
    }

    persistSettings();
    const settings = readSettings();
    const { corridorKm, ...vehicle } = settings;

    if (vehicle.reserveSoc >= vehicle.startSoc) {
      say('Your reserve is at or above your starting charge — nothing to drive on.', true);
      return;
    }

    const via = await resolveVias();
    const result = await plan(start, end, sites, vehicle, { via, corridorKm, onProgress: (m) => say(m) });
    current = result;
    renderPlan(result);
    drawPlan(result, start, end);
    say(
      result.stops.length
        ? `Done — ${result.stops.length} stop${result.stops.length > 1 ? 's' : ''}, chosen from ${result.candidatesConsidered} candidates.`
        : 'Done — this one is within range without charging.',
    );
  } catch (err) {
    clearPlan();
    $('results').hidden = true;
    const known = err instanceof PlanError || err instanceof RoutingError;
    say(known ? err.message : `Something went wrong: ${err.message}`, true);
    if (!known) console.error(err);
  } finally {
    button.disabled = false;
  }
}

/* -------------------------------------------------------------------- init */

async function main() {
  initMap('map');
  loadSettings();

  const fromCtl = setupPlaceInput($('from'), $('from-results'), $('from-chosen'), (p) => {
    start = p;
  });
  const toCtl = setupPlaceInput($('to'), $('to-results'), $('to-chosen'), (p) => {
    end = p;
  });
  $('add-via').addEventListener('click', () => addVia());

  try {
    const res = await fetch(new URL('../data/superchargers.json', import.meta.url));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    sites = data.sites;
    $('data-meta').textContent = `${data.count} sites open to non-Teslas, ${data.generated}`;
  } catch (err) {
    say(`Could not load the Supercharger data: ${err.message}`, true);
    $('plan').disabled = true;
    return;
  }

  $('plan').addEventListener('click', () => runPlan(fromCtl, toCtl));

  $('swap').addEventListener('click', () => {
    const a = $('from').value;
    const b = $('to').value;
    $('from').value = b;
    $('to').value = a;
    const oldStart = start;
    fromCtl.setChosen(end);
    toCtl.setChosen(oldStart);
  });

  $('use-location').addEventListener('click', () => {
    say('Getting your location…');
    const ok = watchMe(
      async ({ lat, lon }) => {
        $('centre-me').hidden = false;
        // Only seed the "From" box on the first fix — after that the user may
        // have typed something else and we must not stomp on it.
        if (!start || start.fromGps) {
          const label = (await reverseGeocode(lat, lon)) || `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
          if (!start || start.fromGps) {
            start = { lat, lon, label, fromGps: true };
            $('from').value = label;
            $('from-chosen').textContent = `✓ ${label}`;
            $('from-chosen').hidden = false;
            say('Using your current location as the start.');
          }
        }
      },
      (message) => say(message, true),
    );
    if (ok && !hasFix()) say('Waiting for a GPS fix…');
  });

  $('centre-me').addEventListener('click', centreOnMe);

  $('copy-all').addEventListener('click', async (e) => {
    if (!current) return;
    await copyText(addressLines(current).join('\n'));
    flash(e.target, 'Copied ✓');
  });

  $('copy-detailed').addEventListener('click', async (e) => {
    if (!current) return;
    await copyText(toPlainText(current, start, end));
    flash(e.target, 'Copied ✓');
  });

  $('download-csv').addEventListener('click', () => {
    if (!current) return;
    download('electric-traveler-route.csv', toCsv(current, start, end), 'text/csv;charset=utf-8');
  });

  $('reset-settings').addEventListener('click', () => {
    writeSettings({ ...DEFAULTS, corridorKm: 20 });
    persistSettings();
  });

  for (const key of [...Object.keys(FIELDS), 'corridorKm']) {
    $(key).addEventListener('change', persistSettings);
  }
}

main();
