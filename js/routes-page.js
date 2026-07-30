/** Saved-routes page: pick a route, see live stall availability on its stops. */

/* global L */

import { listRoutes, getRoute, deleteRoute } from './storage.js';
import { initMap } from './map.js';
import { copyText } from './export.js';
import {
  getApiKey,
  setApiKey,
  fetchAvailability,
  levelFor,
  describe,
  ago,
  AvailabilityError,
} from './availability.js';

const $ = (id) => document.getElementById(id);

let map;
let layer;
let selected = null;
let live = new Map(); // stop id -> availability summary (or null)
/** Which stops have their backup panel expanded — survives a re-render. */
const openBackups = new Set();

const hm = (min) => {
  const t = Math.round(min || 0);
  return `${Math.floor(t / 60)}h${String(t % 60).padStart(2, '0')}`;
};
const pct = (s) => `${Math.round((s || 0) * 100)}%`;

function say(message, isError = false) {
  const el = $('avail-status');
  el.textContent = message;
  el.classList.toggle('error', isError);
}

/* ------------------------------------------------------------------- list  */

function renderList() {
  const routes = listRoutes();
  const list = $('route-list');
  list.innerHTML = '';
  $('no-routes').hidden = routes.length > 0;
  $('route-count').textContent = routes.length ? `${routes.length} saved` : '';

  for (const r of routes) {
    const li = document.createElement('li');
    li.className = 'saved-item';
    li.tabIndex = 0;
    li.setAttribute('role', 'button');
    if (selected?.id === r.id) li.classList.add('active');

    const name = document.createElement('b');
    name.textContent = r.name;
    const meta = document.createElement('span');
    const when = new Date(r.saved);
    meta.textContent =
      `${r.totalKm.toFixed(0)} km · ${hm(r.totalMinutes)} · ${r.stops.length} stop${r.stops.length === 1 ? '' : 's'}` +
      ` · saved ${when.toLocaleDateString()}`;

    li.append(name, meta);
    const open = () => select(r.id);
    li.addEventListener('click', open);
    li.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        open();
      }
    });
    list.appendChild(li);
  }
}

/* ----------------------------------------------------------------- detail  */

function stopMarker(stop, index, level) {
  return L.divIcon({
    className: '',
    html: `<span class="pin pin-stop lvl-${level}" title="${stop.name}">${index + 1}</span>`,
    iconSize: [26, 26],
    iconAnchor: [13, 13],
  });
}

function drawMap(route) {
  layer.clearLayers();
  const latlngs = (route.line || []).map((p) => [p.lat, p.lon]);
  if (latlngs.length) {
    L.polyline(latlngs, { color: '#0b1020', weight: 8, opacity: 0.35 }).addTo(layer);
    L.polyline(latlngs, { color: '#2f7de1', weight: 4, opacity: 0.95 }).addTo(layer);
  }

  route.stops.forEach((s, i) => {
    const av = live.get(s.id);
    const level = levelFor(av);
    L.marker([s.lat, s.lon], { icon: stopMarker(s, i, level) })
      .bindPopup(
        `<b>${i + 1}. ${s.name}</b><br>${s.address}<br><br>` +
          `${s.kw} kW · ${s.stalls} stalls<br>` +
          `<b>${describe(av)}</b>${av?.updated ? `<br>updated ${ago(av.updated)}` : ''}`,
      )
      .addTo(layer);
  });

  const bounds = latlngs.length ? L.latLngBounds(latlngs) : L.latLngBounds(route.stops.map((s) => [s.lat, s.lon]));
  if (bounds.isValid()) map.fitBounds(bounds, { padding: [40, 40] });
}

function renderStops(route) {
  const list = $('detail-stops');
  list.innerHTML = '';

  route.stops.forEach((s, i) => {
    const av = live.get(s.id);
    const level = levelFor(av);

    const li = document.createElement('li');
    li.className = 'stop';

    const num = document.createElement('span');
    num.className = `num lvl-${level}`;
    num.textContent = String(i + 1);

    const body = document.createElement('div');
    const addr = document.createElement('div');
    addr.className = 'addr';
    addr.textContent = s.address;

    const avail = document.createElement('div');
    avail.className = `avail lvl-${level}`;
    const dot = document.createElement('i');
    dot.className = 'dot';
    const text = document.createElement('span');
    text.textContent = describe(av);
    avail.append(dot, text);
    if (av?.updated) {
      const stamp = document.createElement('em');
      stamp.textContent = ` · ${ago(av.updated)}`;
      avail.appendChild(stamp);
    }

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent =
      `${s.name} · ${s.kw} kW · ${s.stalls} stalls — after ${(s.legInKm || 0).toFixed(0)} km, ` +
      `arrive ${pct(s.arriveSoc)} → leave ${pct(s.departSoc)}`;

    body.append(addr, avail, meta);

    if (s.alternatives?.length) {
      const backups = document.createElement('details');
      backups.className = 'backups';
      backups.open = openBackups.has(s.id);
      backups.addEventListener('toggle', () => {
        if (backups.open) openBackups.add(s.id);
        else openBackups.delete(s.id);
      });
      const sum = document.createElement('summary');
      sum.textContent = `${s.alternatives.length} backup${s.alternatives.length === 1 ? '' : 's'} nearby`;
      backups.appendChild(sum);
      const ul = document.createElement('ul');
      for (const alt of s.alternatives) {
        const alv = live.get(alt.id);
        const li2 = document.createElement('li');
        const a1 = document.createElement('span');
        a1.className = 'b-addr';
        a1.textContent = alt.address;
        const a2 = document.createElement('span');
        a2.className = `b-meta lvl-${levelFor(alv)}`;
        a2.textContent = `${alt.awayKm.toFixed(0)} km · ${alt.kw} kW · ${alt.stalls} stalls · ${describe(alv)}`;
        li2.append(a1, a2);
        ul.appendChild(li2);
      }
      const check = document.createElement('button');
      check.type = 'button';
      check.className = 'link-btn check-backups';
      check.textContent = 'Check these too';
      check.addEventListener('click', async () => {
        const key = getApiKey();
        if (!key) {
          say('No Google API key set — open the panel above and add one.', true);
          return;
        }
        check.disabled = true;
        check.textContent = 'Checking…';
        try {
          for (const alt of s.alternatives) {
            live.set(alt.id, await fetchAvailability(alt, key, { force: true }));
          }
          renderStops(selected);
          drawMap(selected);
        } catch (err) {
          say(err instanceof AvailabilityError ? err.message : `Lookup failed: ${err.message}`, true);
          check.disabled = false;
          check.textContent = 'Check these too';
        }
      });
      backups.append(ul, check);
      body.appendChild(backups);
    }

    const copy = document.createElement('button');
    copy.className = 'copy';
    copy.type = 'button';
    copy.textContent = 'Copy';
    copy.addEventListener('click', async () => {
      await copyText(s.address);
      copy.textContent = '✓';
      setTimeout(() => {
        copy.textContent = 'Copy';
      }, 1200);
    });

    li.append(num, body, copy);
    list.appendChild(li);
  });
}

function select(id) {
  selected = getRoute(id);
  if (!selected) return;
  live = new Map();
  openBackups.clear();
  $('detail').hidden = false;
  $('detail-name').textContent = selected.name;
  $('detail-summary').textContent =
    `${selected.totalKm.toFixed(0)} km · driving ${hm(selected.driveMinutes)} · ` +
    `charging ${hm(selected.chargeMinutes)} · total ${hm(selected.totalMinutes)}`;
  say(getApiKey() ? 'Hit Refresh for live stall counts.' : 'Add a Google API key above to see live stall counts.');
  renderList();
  renderStops(selected);
  drawMap(selected);
}

/* ------------------------------------------------------------------- live  */

async function refresh() {
  if (!selected) return;
  const key = getApiKey();
  if (!key) {
    say('No Google API key set — open the panel above and add one.', true);
    $('key-card').open = true;
    return;
  }

  const button = $('refresh');
  button.disabled = true;

  // Planned stops only. Every lookup is a billed Google call, and a route's
  // backups outnumber its stops three to one — those are fetched on demand,
  // per stop, when you actually need them.
  const targets = [...selected.stops];

  let done = 0;
  let withFeed = 0;
  try {
    for (const t of targets) {
      say(`Checking ${done + 1} of ${targets.length}…`);
      const av = await fetchAvailability(t, key, { force: true });
      live.set(t.id, av);
      if (av?.available != null) withFeed++;
      done++;
      renderStops(selected);
      drawMap(selected);
    }
    say(
      withFeed
        ? `Updated ${withFeed} of ${targets.length} sites with live counts — ${new Date().toLocaleTimeString()}.`
        : 'Google has no live stall feed for any of these sites right now.',
    );
  } catch (err) {
    const known = err instanceof AvailabilityError;
    say(known ? err.message : `Availability lookup failed: ${err.message}`, true);
    if (!known) console.error(err);
  } finally {
    button.disabled = false;
  }
}

/* ------------------------------------------------------------------- init  */

function showKeyState() {
  const key = getApiKey();
  $('key-state').hidden = !key;
  $('key-state').textContent = key ? `✓ key saved (…${key.slice(-6)})` : '';
  $('api-key').value = '';
  $('api-key').placeholder = key ? '•••••••• saved' : 'AIza…';
}

function main() {
  map = initMap('map');
  layer = L.layerGroup().addTo(map);

  renderList();
  showKeyState();
  if (!getApiKey()) $('key-card').open = true;

  $('save-key').addEventListener('click', () => {
    const value = $('api-key').value.trim();
    if (!value) {
      setApiKey('');
      showKeyState();
      say('Key cleared.');
      return;
    }
    setApiKey(value);
    showKeyState();
    say('Key saved in this browser. Hit Refresh on a route.');
  });
  $('api-key').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('save-key').click();
  });

  $('refresh').addEventListener('click', refresh);

  $('copy-addresses').addEventListener('click', async (e) => {
    if (!selected) return;
    await copyText(selected.stops.map((s) => s.address).join('\n'));
    const b = e.target;
    b.textContent = 'Copied ✓';
    setTimeout(() => {
      b.textContent = 'Copy addresses';
    }, 1200);
  });

  $('delete-route').addEventListener('click', () => {
    if (!selected) return;
    if (!confirm(`Delete "${selected.name}"? This cannot be undone.`)) return;
    deleteRoute(selected.id);
    selected = null;
    live = new Map();
    $('detail').hidden = true;
    layer.clearLayers();
    renderList();
  });

  // Deep link: routes.html#<id>
  const wanted = location.hash.slice(1);
  if (wanted) select(wanted);
}

main();
