/**
 * Getting the plan out of this page and into the car.
 *
 * The BMW route planner (My BMW app / iDrive) has no public import API, so the
 * practical path is typing or pasting postal addresses into it. Everything here
 * exists to make that as painless as possible: clean one-line addresses in the
 * right order, in the formats a nav system accepts.
 */

const pct = (s) => `${Math.round(s * 100)}%`;
const hm = (min) => {
  const t = Math.round(min);
  return `${Math.floor(t / 60)}h${String(t % 60).padStart(2, '0')}`;
};

/** Just the addresses, in order — what you actually type into the BMW. */
export function addressLines(plan) {
  return plan.stops.map((s) => s.address);
}

/** Numbered address list with the detail worth having on screen while driving. */
export function toPlainText(plan, start, end) {
  const lines = [
    `${start.label || 'Start'} → ${end.label || 'Destination'}`,
    `${plan.totalKm.toFixed(0)} km · driving ${hm(plan.driveMinutes)} · charging ${hm(plan.chargeMinutes)} · total ${hm(plan.totalMinutes)}`,
    '',
    'CHARGING STOPS (Tesla Superchargers, in order)',
    '',
  ];
  plan.stops.forEach((s, i) => {
    lines.push(`${i + 1}. ${s.address}`);
    lines.push(`   ${s.name} · ${s.kw} kW · ${s.stalls} stalls`);
    lines.push(
      `   after ${s.legInKm.toFixed(0)} km · arrive ${pct(s.arriveSoc)} → leave ${pct(s.departSoc)} · ${Math.round(s.chargeMinutes)} min`,
    );
    lines.push('');
  });
  lines.push(`Destination: ${end.label || ''}`);
  lines.push(`Arriving with about ${pct(plan.arrivalSoc)}.`);
  return lines.join('\n');
}

export function toCsv(plan, start, end) {
  const quote = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [
    ['order', 'name', 'address', 'street', 'zip', 'city', 'country', 'lat', 'lon', 'kw', 'stalls', 'leg_km', 'arrive_pct', 'leave_pct', 'charge_min'],
    ['start', start.label || 'Start', start.label || '', '', '', '', '', start.lat, start.lon, '', '', 0, '', '', ''],
  ];
  plan.stops.forEach((s, i) => {
    rows.push([
      i + 1, s.name, s.address, s.street, s.zip, s.city, s.cc, s.lat, s.lon, s.kw, s.stalls,
      s.legInKm.toFixed(1), Math.round(s.arriveSoc * 100), Math.round(s.departSoc * 100), Math.round(s.chargeMinutes),
    ]);
  });
  rows.push(['end', end.label || 'Destination', end.label || '', '', '', '', '', end.lat, end.lon, '', '', '', Math.round(plan.arrivalSoc * 100), '', '']);
  return rows.map((r) => r.map(quote).join(',')).join('\n');
}

/**
 * Google Maps directions link through every stop.
 * The URL API takes at most 9 intermediate waypoints; longer trips get a link
 * covering as many as will fit, and the caller warns about it.
 */
export function googleMapsUrl(plan, start, end) {
  const MAX_WAYPOINTS = 9;
  const at = (p) => `${p.lat.toFixed(6)},${p.lon.toFixed(6)}`;
  const params = new URLSearchParams({
    api: '1',
    origin: at(start),
    destination: at(end),
    travelmode: 'driving',
  });
  const stops = plan.stops.slice(0, MAX_WAYPOINTS);
  if (stops.length) params.set('waypoints', stops.map(at).join('|'));
  return {
    url: `https://www.google.com/maps/dir/?${params}`,
    truncated: plan.stops.length > MAX_WAYPOINTS,
  };
}

/** Single-stop link, for pulling one charger up on a phone. */
export function stopMapUrl(stop) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(stop.address)}`;
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard API needs a secure context and a user gesture; fall back to the
    // old execCommand path so this still works over plain http or in older WebViews.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    document.body.removeChild(ta);
    return ok;
  }
}

export function download(filename, content, mime = 'text/plain;charset=utf-8') {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
