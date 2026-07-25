# ⚡ Electric Traveler

Route planner for a **BMW iX1** that charges **only at Tesla Superchargers**, across
**France, Belgium, the Netherlands, Luxembourg and Germany**.

It optimises for the **fastest arrival**, shows the route on a map with your live
location, and — the actual point of the thing — hands you a clean, ordered list of
**postal addresses to type into the BMW route planner**.

Static site, no backend, no API keys. Runs on GitHub Pages.

---

## What it does

- Pulls every Supercharger in the five countries that is **open, non-Tesla accessible and has CCS2** (currently 666 sites).
- Routes A→B, then picks charging stops by shortest *total* time — driving **plus** charging.
- Gives you each stop's street address, power, stall count, arrival/departure charge and minutes plugged in.
- Copy one address, copy all of them, download a CSV, or open the trip in Google Maps.
- Tracks your current position on the map, and can use it as the starting point.

### Why "fastest" is not "fewest stops"

The iX1 peaks at ~130 kW and holds it to roughly 30% charge, then tapers hard —
past 80% it is slower than a hotel kettle. So three short stops taken low in the
curve routinely beat two long ones dragged up to 90%.

The planner therefore does not use the usual "drive until low, stop at the nearest
charger" heuristic. It builds a graph of **(charger, state-of-charge)** states and
runs a shortest-path search where each edge costs driving time *plus* the charging
time needed to afford that leg. Real road distances between every candidate pair
come from one OSRM matrix call, so detours are priced honestly rather than guessed
from straight-line distance.

---

## Using it

1. Type a start and a destination (or hit ◎ to start from where you are).
2. Open **Car & trip settings** and set at least your **charge at start** and the
   **outside temperature** — cold weather is worth several percent of range.
3. **Plan the route.**
4. Under **Addresses for the BMW planner**, hit **Copy all**, then enter them as
   waypoints in the My BMW app or iDrive, in order.

### Settings worth knowing

| Setting | Default | Why you'd change it |
|---|---|---|
| Charge at start | 90% | Match what the car actually has. |
| Reserve on arrival | 10% | The safety margin. The plan never dips below it. |
| Charge ceiling | 80% | Above this charging crawls. Raised automatically if a leg demands it. |
| Usable battery | 64.8 kWh | iX1 eDrive20. The xDrive30 is the same pack. |
| Peak DC charging | 130 kW | The car, not the Supercharger, is the limit here. |
| Outside temperature | 15 °C | Drives the cold-weather consumption penalty. |
| Driving style | Normal | Scales the router's speeds — see the caveat below. |
| Detour allowed | 20 km | How far off the direct line a charger may sit. |

Settings persist in your browser.

---

## Real-world caveats — please read before trusting a stop

**Using a Supercharger in a BMW.** In Europe most Supercharger sites are open to
non-Tesla cars, but you generally need the **Tesla app** to start and pay for a
session; per-kWh pricing is higher without a Tesla subscription. This tool only
includes sites flagged as open to other EVs, but that flag can lag reality.

**Cable length and parking.** Tesla stalls are laid out for a car with a **rear-left**
charge port. The iX1's port is on the **rear right**, so at some sites you will need
to reverse in or park across two bays. V4 stalls have longer cables and are easier.

**These are estimates.** Consumption is modelled from speed, temperature and a
generic iX1 charging curve — not from your car's real telemetry. Elevation, wind,
traffic, payload and a cold battery all move the numbers. Keep the reserve
meaningful and treat a plan as a starting point.

**Router speeds run low.** OSRM's car profile uses conservative free-flow speeds —
it will call a French autoroute ~95 km/h when you'd really sit at 120. The
**Driving style** setting scales those speeds before computing consumption
(1.15× by default). Set it to *Fast* if you cruise hard; underestimating speed
underestimates consumption, which is the dangerous direction.

**Availability is not checked.** The dataset has no live stall occupancy. On a
Friday in August, assume a queue.

---

## Hosting it on GitHub Pages

The deploy workflow is already in `.github/workflows/pages.yml`. One-time setup:

1. Push to `main`.
2. Repo **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. The workflow runs on every push to `main`; the URL appears in its summary
   (`https://srouault.github.io/electric-traveler/`).

Geolocation needs a secure context — it works on the `https://` Pages URL and on
`localhost`, but not over plain `http://` to another machine.

## Running it locally

```bash
npx http-server -p 8899 -c-1     # any static server; ES modules need http, not file://
open http://127.0.0.1:8899/
```

Plan a trip from the terminal, using the same modules the page does:

```bash
node scripts/plan-cli.mjs "Brussels" "Nice"
node scripts/plan-cli.mjs "Amsterdam" "Munich" --temp -5 --start-soc 0.7 --corridor 30
```

## Refreshing the charger data

```bash
node scripts/fetch-superchargers.mjs
```

`.github/workflows/refresh-data.yml` also does this every Monday and commits the
result if anything changed. Delete that file if you'd rather it didn't.

## Layout

```
index.html                       page shell
css/style.css
js/vehicle.js                    consumption + charging-curve model
js/geo.js                        distances, route corridor projection
js/routing.js                    OSRM + Nominatim clients
js/planner.js                    candidate selection + the optimiser
js/map.js                        Leaflet map, markers, live location
js/export.js                     addresses, CSV, Google Maps links
js/app.js                        UI wiring
data/superchargers.json          generated — do not hand-edit
scripts/fetch-superchargers.mjs  regenerates the dataset
scripts/plan-cli.mjs             headless planner, for testing
```

## Credits and limits

Charger data from [supercharge.info](https://supercharge.info), routing from the
public [OSRM](http://project-osrm.org) demo server, geocoding from
[Nominatim](https://nominatim.openstreetmap.org), map tiles from OpenStreetMap.

Those last three are free community services with rate limits and no uptime
guarantee. This app makes about three requests per plan, which is well within
fair use for personal use — but it is not built for traffic. If you ever hit
limits, self-host OSRM or swap in a keyed provider in `js/routing.js`.

Not affiliated with Tesla or BMW.
