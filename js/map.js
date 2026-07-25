/** Leaflet map: the route line, the stops, and where you are right now. */

/* global L */

const TILES = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
const ATTRIB = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · routing by OSRM · chargers by supercharge.info';

let map;
let routeLayer;
let stopLayer;
let meMarker;
let meAccuracy;
let watchId = null;

export function initMap(elementId) {
  map = L.map(elementId, { zoomControl: true, attributionControl: true }).setView([50.5, 4.5], 6);
  L.tileLayer(TILES, { maxZoom: 19, attribution: ATTRIB }).addTo(map);
  routeLayer = L.layerGroup().addTo(map);
  stopLayer = L.layerGroup().addTo(map);
  return map;
}

function pin(className, label, title) {
  return L.divIcon({
    className: '',
    html: `<span class="pin ${className}" title="${title}">${label}</span>`,
    iconSize: [26, 26],
    iconAnchor: [13, 13],
  });
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Draws a planned trip and zooms to it. */
export function drawPlan(plan, start, end) {
  routeLayer.clearLayers();
  stopLayer.clearLayers();

  const latlngs = plan.line.map((p) => [p.lat, p.lon]);
  if (latlngs.length) {
    // A wide dark casing under the bright line keeps it legible over any tile.
    L.polyline(latlngs, { color: '#0b1020', weight: 8, opacity: 0.35 }).addTo(routeLayer);
    L.polyline(latlngs, { color: '#2f7de1', weight: 4, opacity: 0.95 }).addTo(routeLayer);
  }

  L.marker([start.lat, start.lon], { icon: pin('pin-start', 'A', 'Start') })
    .bindPopup(`<b>Start</b><br>${esc(start.label || '')}`)
    .addTo(stopLayer);
  L.marker([end.lat, end.lon], { icon: pin('pin-end', 'B', 'Destination') })
    .bindPopup(`<b>Destination</b><br>${esc(end.label || '')}`)
    .addTo(stopLayer);

  plan.stops.forEach((s, i) => {
    L.marker([s.lat, s.lon], { icon: pin('pin-stop', String(i + 1), s.name) })
      .bindPopup(
        `<b>${i + 1}. ${esc(s.name)}</b><br>${esc(s.address)}<br><br>` +
          `${s.kw} kW · ${s.stalls} stalls<br>` +
          `Arrive ${Math.round(s.arriveSoc * 100)}% → leave ${Math.round(s.departSoc * 100)}%<br>` +
          `Charge ${Math.round(s.chargeMinutes)} min (+${s.kwhAdded.toFixed(1)} kWh)`,
      )
      .addTo(stopLayer);
  });

  if (latlngs.length) map.fitBounds(L.latLngBounds(latlngs), { padding: [40, 40] });
}

export function clearPlan() {
  routeLayer?.clearLayers();
  stopLayer?.clearLayers();
}

/**
 * Starts following the browser's GPS. `onFix` receives {lat, lon, accuracy}.
 * Returns false when the browser will not do geolocation at all.
 */
export function watchMe(onFix, onError) {
  if (!navigator.geolocation) {
    onError?.('This browser has no geolocation.');
    return false;
  }
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);

  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      const { latitude: lat, longitude: lon, accuracy } = pos.coords;
      if (!meMarker) {
        meAccuracy = L.circle([lat, lon], { radius: accuracy, color: '#18a558', fillOpacity: 0.12, weight: 1 }).addTo(map);
        meMarker = L.marker([lat, lon], { icon: pin('pin-me', '●', 'You are here') })
          .bindPopup('You are here')
          .addTo(map);
      } else {
        meMarker.setLatLng([lat, lon]);
        meAccuracy.setLatLng([lat, lon]).setRadius(accuracy);
      }
      onFix?.({ lat, lon, accuracy });
    },
    (err) => {
      // Position errors are routine indoors — surface them, don't throw.
      const reasons = {
        1: 'Location permission denied.',
        2: 'Location unavailable right now.',
        3: 'Timed out getting a location fix.',
      };
      onError?.(reasons[err.code] || err.message);
    },
    { enableHighAccuracy: true, maximumAge: 15000, timeout: 20000 },
  );
  return true;
}

export function stopWatching() {
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
}

export function centreOnMe() {
  if (meMarker) map.setView(meMarker.getLatLng(), Math.max(map.getZoom(), 12));
}

export function hasFix() {
  return Boolean(meMarker);
}
