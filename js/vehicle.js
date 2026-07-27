/**
 * Energy and charging model for the BMW iX1 eDrive20.
 *
 * Two things the planner needs from this module:
 *   1. how many kWh a leg costs, given its distance and average speed
 *   2. how long it takes to move the battery from SoC a to SoC b
 *
 * Both are deliberately simple and fully driven by `DEFAULTS`, which the UI
 * exposes as editable settings — a model that is roughly right and tunable
 * beats one that is precise for exactly one car in exactly one season.
 */

export const DEFAULTS = {
  // iX1 eDrive20: 66.5 kWh gross, ~64.8 kWh usable.
  batteryKwh: 64.8,
  // Peak DC rate. The car, not the Supercharger, is the limit here — most EU
  // Superchargers are 250 kW.
  maxChargeKw: 130,
  // Consumption curve, see consumptionAt(). Calibrated so that the iX1 does
  // ~15.5 kWh/100km at 90 km/h and ~21.5 at 130 km/h.
  baseKwhPer100: 9.98,
  dragKwhPer100PerKmh2: 0.0006818,
  // Ambient temperature in °C. Cold hurts twice: chemistry and cabin heating.
  temperatureC: 15,
  // OSRM's car profile uses conservative free-flow speeds on ordinary roads —
  // it will call a two-lane N-road ~70 km/h when you would really sit at 90.
  // 1.0 relaxed, 1.15 normal, 1.3 fast.
  speedFactor: 1.15,
  // …but it goes the other way on motorways: OSRM scores German autobahn
  // tagged `maxspeed=none` at 140 km/h, so scaling that up again implies
  // 161 km/h. Nobody drives an iX1 like that, and it made German corridors
  // look faster than they are. Cap the speed we plan on.
  maxSpeedKmh: 130,
  // Never plan to arrive anywhere below this. This is the whole safety margin.
  reserveSoc: 0.10,
  // Charging above ~80% is slow enough that it is nearly always faster to stop
  // again. The planner may still exceed this if the next hop demands it.
  maxSoc: 0.80,
  // SoC at the start of the trip.
  startSoc: 0.90,
  // Minutes lost per stop to pulling in, plugging in, paying, leaving.
  stopOverheadMin: 4,
};

/**
 * Consumption in kWh/100km at a given average speed.
 *
 * Aero drag rises with the square of speed, so a quadratic fit tracks a real
 * EV's motorway consumption well. Below ~50 km/h the fit would keep falling,
 * which is wrong — town driving has its own losses — so we hold a floor.
 */
export function consumptionAt(speedKmh, cfg = DEFAULTS) {
  const v = Math.max(50, speedKmh);
  const raw = cfg.baseKwhPer100 + cfg.dragKwhPer100PerKmh2 * v * v;
  return raw * temperatureFactor(cfg.temperatureC);
}

/**
 * Cold-weather penalty. ~0% at 20°C, ~+30% at -5°C, a slight penalty in real
 * heat from air conditioning.
 */
export function temperatureFactor(tempC) {
  if (tempC >= 20) return 1 + Math.max(0, tempC - 25) * 0.006;
  return 1 + (20 - tempC) * 0.012;
}

/**
 * The speed you will really average on a leg the router thinks averages
 * `speedKmh`: its figure scaled by driving style, then capped at what you are
 * actually willing to drive.
 *
 * Everything downstream — consumption *and* journey time — runs off this, so a
 * corridor is never credited with a speed the driver would not use.
 */
export function effectiveSpeed(speedKmh, cfg = DEFAULTS) {
  return Math.min(speedKmh * (cfg.speedFactor ?? 1), cfg.maxSpeedKmh ?? Infinity);
}

/** Minutes to drive `km` at the effective speed for a router-predicted leg. */
export function legMinutes(km, routerSpeedKmh, cfg = DEFAULTS) {
  return (km / effectiveSpeed(routerSpeedKmh, cfg)) * 60;
}

/**
 * Energy in kWh to cover `km`, where `speedKmh` is the average speed the router
 * predicts for the leg.
 */
export function energyFor(km, speedKmh, cfg = DEFAULTS) {
  return (km * consumptionAt(effectiveSpeed(speedKmh, cfg), cfg)) / 100;
}

/**
 * Charging power curve as a fraction of the car's peak rate, by SoC.
 *
 * The iX1 holds close to its 130 kW peak to roughly 30%, then tapers steadily.
 * Points are (soc, fraction-of-peak) and interpolated linearly.
 */
const CURVE = [
  [0.00, 0.92],
  [0.10, 1.00],
  [0.30, 1.00],
  [0.40, 0.96],
  [0.50, 0.85],
  [0.60, 0.73],
  [0.70, 0.60],
  [0.80, 0.48],
  [0.90, 0.34],
  [1.00, 0.16],
];

/** Charging power in kW at a given SoC, capped by what the station can deliver. */
export function chargePowerAt(soc, stationKw, cfg = DEFAULTS) {
  const s = Math.min(1, Math.max(0, soc));
  let frac = CURVE[CURVE.length - 1][1];
  for (let i = 0; i < CURVE.length - 1; i++) {
    const [s0, f0] = CURVE[i];
    const [s1, f1] = CURVE[i + 1];
    if (s >= s0 && s <= s1) {
      frac = f0 + ((f1 - f0) * (s - s0)) / (s1 - s0);
      break;
    }
  }
  return Math.min(cfg.maxChargeKw * frac, stationKw);
}

/**
 * Minutes to charge from `fromSoc` to `toSoc` at a station of `stationKw`.
 *
 * Integrated in small SoC steps because power varies across the range — a flat
 * "kWh / peak kW" estimate understates a 20→80% stop by several minutes.
 * Excludes stop overhead; the planner adds that separately.
 */
export function chargeMinutes(fromSoc, toSoc, stationKw, cfg = DEFAULTS) {
  if (toSoc <= fromSoc) return 0;
  const STEP = 0.01;
  let minutes = 0;
  for (let s = fromSoc; s < toSoc; s += STEP) {
    const span = Math.min(STEP, toSoc - s);
    const kw = chargePowerAt(s + span / 2, stationKw, cfg);
    minutes += ((span * cfg.batteryKwh) / kw) * 60;
  }
  return minutes;
}

/** Usable range in km at `soc`, down to the reserve, at a typical speed. */
export function rangeAt(soc, speedKmh, cfg = DEFAULTS) {
  const kwh = Math.max(0, soc - cfg.reserveSoc) * cfg.batteryKwh;
  return (kwh / consumptionAt(speedKmh, cfg)) * 100;
}
