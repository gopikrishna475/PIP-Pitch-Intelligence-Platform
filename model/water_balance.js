/**
 * PIP — Pitch water balance engine (JavaScript)
 * ============================================
 *
 * A faithful port of water_balance.py, so the same algorithm can run inside
 * Google Apps Script without a server, and so the daily alert does not depend on
 * a laptop being switched on.
 *
 * The Python version remains the REFERENCE IMPLEMENTATION and carries the test
 * suite. This port is verified against it day-by-day on a full winter of real
 * weather — see tools/verify_parity.js. If you change the physics, change BOTH files and
 * re-run that check.
 *
 * Signed root-zone store:
 *   sw > 0  water above field capacity, draining away  -> WATERLOGGING
 *   sw < 0  soil moisture deficit                      -> DROUGHT
 *
 * Runs in Node (for verification) and in Apps Script (for production).
 */

var DEFAULTS = {
  rootDepthM: 0.20,           // m      sports turf root zone
  thetaFc: 0.32,              // m3/m3  field capacity
  thetaWp: 0.14,              // m3/m3  wilting point
  thetaSat: 0.45,             // m3/m3  saturation
  kc: 0.95,                   // -      FAO-56 grass crop coefficient
  pDepletion: 0.55,           // -      FAO-56 depletion fraction
  drainageCapacityMmDay: 1.5, // mm/day THE parameter that decides everything
  fSatWatch: 0.35,            // UNPLAYED thresholds: NOT calibrated defaults
  fSatRisk: 0.60,
  fSatUnplayable: 0.80
};

var ADVICE = {
  UNPLAYABLE: 'Expect standing water and a surface that will not recover quickly.',
  HIGH: 'Surface is close to holding water. Protect it if you can.',
  WATCH: 'Ground is getting soft. Worth checking before Saturday.',
  LOW: 'No waterlogging concern at current conditions.'
};

function makeParams(over) {
  var p = {};
  for (var k in DEFAULTS) p[k] = DEFAULTS[k];
  if (over) for (var j in over) if (over[j] !== undefined && over[j] !== null) p[j] = over[j];
  if (!(p.thetaWp < p.thetaFc && p.thetaFc < p.thetaSat)) {
    throw new Error('require thetaWp < thetaFc < thetaSat');
  }
  return p;
}

function storeCapMm(p) { return (p.thetaSat - p.thetaFc) * 1000.0 * p.rootDepthM; }
function tawMm(p) { return (p.thetaFc - p.thetaWp) * 1000.0 * p.rootDepthM; }
function rawMm(p) { return p.pDepletion * tawMm(p); }

function thetaFromSw(p, sw) {
  var t = p.thetaFc + sw / (1000.0 * p.rootDepthM);
  return Math.min(p.thetaSat, Math.max(p.thetaWp, t));
}

/** How a SENSOR reading enters the model. */
function swFromTheta(p, theta) { return (theta - p.thetaFc) * 1000.0 * p.rootDepthM; }

function fSat(p, sw) {
  if (sw <= 0) return 0.0;
  return Math.min(1.0, sw / storeCapMm(p));
}

function riskOf(p, sw) {
  var f = fSat(p, sw);
  if (f >= p.fSatUnplayable) return 'UNPLAYABLE';
  if (f >= p.fSatRisk) return 'HIGH';
  if (f >= p.fSatWatch) return 'WATCH';
  return 'LOW';
}

/** FAO-56 Ks — throttles transpiration as the soil dries. */
function stressCoefficient(p, depletionMm) {
  var dr = Math.max(0.0, depletionMm);
  var raw = rawMm(p), taw = tawMm(p);
  if (dr <= raw) return 1.0;
  if (dr >= taw) return 0.0;
  return (taw - dr) / (taw - raw);
}

/** One day. Returns {sw, etc, ks, drainage, runoff}. */
function step(p, swPrev, precipMm, et0Mm, irrigationMm) {
  irrigationMm = irrigationMm || 0.0;
  var ks = stressCoefficient(p, swPrev < 0 ? -swPrev : 0.0);
  var etc = ks * p.kc * et0Mm;
  var sw = swPrev + (precipMm + irrigationMm - etc);

  var cap = storeCapMm(p), runoff = 0.0, drainage = 0.0;
  if (sw > cap) { runoff = sw - cap; sw = cap; }
  if (sw > 0.0) { drainage = Math.min(sw, p.drainageCapacityMmDay); sw -= drainage; }
  var taw = tawMm(p);
  if (sw < -taw) sw = -taw;

  return { sw: sw, etc: etc, ks: ks, drainage: drainage, runoff: runoff };
}

/**
 * Run the balance across a weather series.
 * weather: [{day:'YYYY-MM-DD', precip:Number, et0:Number}]
 * sensors: optional { 'YYYY-MM-DD': theta }
 */
function run(p, weather, sw0, sensors, assimilateWeight) {
  sw0 = sw0 || 0.0;
  sensors = sensors || {};
  assimilateWeight = assimilateWeight || 0.0;

  var out = [], sw = sw0, cap = storeCapMm(p), taw = tawMm(p);
  for (var i = 0; i < weather.length; i++) {
    var w = weather[i], swBefore = sw;
    var r = step(p, sw, w.precip, w.et0, 0.0);
    sw = r.sw;

    var obs = sensors[w.day];
    if (obs !== undefined && obs !== null && assimilateWeight > 0.0) {
      var swObs = Math.min(cap, Math.max(-taw, swFromTheta(p, obs)));
      var wt = Math.min(1.0, Math.max(0.0, assimilateWeight));
      sw = (1.0 - wt) * sw + wt * swObs;
    }

    out.push({
      day: w.day, precipMm: w.precip, et0Mm: w.et0, etcMm: r.etc, ks: r.ks,
      swMm: sw, swAtStartMm: swBefore, drainageMm: r.drainage, runoffMm: r.runoff,
      theta: thetaFromSw(p, sw), fSat: fSat(p, sw), risk: riskOf(p, sw),
      daysToClear: daysToClear(p, sw, null),
      sensorTheta: (obs === undefined ? null : obs)
    });
  }
  return out;
}

/** Days until the excess drains below the WATCH threshold. */
function daysToClear(p, sw, forecast) {
  var target = p.fSatWatch * storeCapMm(p);
  if (sw <= target) return 0;
  var sim = sw, days = 0, fc = forecast || [];
  for (var i = 0; i < fc.length + 60; i++) {
    var precip = i < fc.length ? fc[i].precip : 0.0;
    var et0 = i < fc.length ? fc[i].et0 : 0.0;
    sim = step(p, sim, precip, et0, 0.0).sw;
    days++;
    if (sim <= target) return days;
    if (days > 120) break;
  }
  return Math.min(days, Math.ceil(Math.max(0.0, sw) / p.drainageCapacityMmDay));
}

function addDays(iso, n) {
  var d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Calibration: grid-search the two parameters that dominate behaviour,
 * scoring by RMSE against sensor readings. Coarse grid on purpose — with a few
 * weeks of data a fine-tuned fit is false precision.
 */
function calibrate(p, weather, sensors, drainageGrid, thetaFcGrid) {
  drainageGrid = drainageGrid || [0.25, 0.5, 0.75, 1.0, 1.5, 2.0, 3.0, 4.0, 6.0, 8.0, 12.0, 16.0, 24.0];
  thetaFcGrid = thetaFcGrid || [0.18, 0.20, 0.22, 0.24, 0.26, 0.28, 0.30, 0.32, 0.34];
  var results = [], best = null;

  for (var a = 0; a < drainageGrid.length; a++) {
    for (var b = 0; b < thetaFcGrid.length; b++) {
      var fc = thetaFcGrid[b];
      if (!(p.thetaWp < fc && fc < p.thetaSat)) continue;
      var cand = makeParams({ thetaFc: fc, drainageCapacityMmDay: drainageGrid[a] });
      var states = run(cand, weather, 0.0, sensors, 0.0);
      var sq = 0.0, sum = 0.0, n = 0;
      for (var i = 0; i < states.length; i++) {
        var s = states[i];
        if (sensors[s.day] === undefined) continue;
        var e = (s.theta - sensors[s.day]) * 100.0;
        sq += e * e; sum += e; n++;
      }
      if (!n) continue;
      var rmse = Math.sqrt(sq / n);
      results.push({ drainage: drainageGrid[a], thetaFc: fc, rmse: rmse, bias: sum / n, n: n });
      if (best === null || rmse < best.rmse) best = { rmse: rmse, params: cand };
    }
  }
  if (best === null) throw new Error('no candidate could be scored — check sensor dates overlap the weather series');
  results.sort(function (x, y) { return x.rmse - y.rmse; });
  return { params: best.params, rmse: best.rmse, table: results };
}

/** One WhatsApp message: what is happening, what to do, why. */
function dailyMessage(p, state, forecast, pitchName) {
  pitchName = pitchName || 'pitch';
  forecast = forecast || [];
  var rain3 = 0.0;
  for (var i = 0; i < Math.min(3, forecast.length); i++) rain3 += forecast[i].precip;

  var lines = ['PIP — ' + pitchName, prettyDate(state.day), '', 'RISK: ' + state.risk];
  var excess = Math.max(0.0, state.swMm);
  if (excess > 0) {
    lines.push('Water above field capacity: ' + excess.toFixed(1) + ' mm (' +
               Math.round(state.fSat * 100) + '% of drainable pore space).');
  } else {
    lines.push('Soil moisture deficit: ' + Math.abs(state.swMm).toFixed(1) + ' mm below field capacity.');
  }
  if (state.drainageMm > 0) lines.push('Drained today: ' + state.drainageMm.toFixed(1) + ' mm.');
  if (state.daysToClear > 0) lines.push('Estimated days to clear at current drainage rate: ' + state.daysToClear + '.');
  lines.push('Next 3 days rain: ' + rain3.toFixed(1) + ' mm.');
  if (state.sensorTheta !== null && state.sensorTheta !== undefined) {
    lines.push('Sensor reading: ' + state.sensorTheta.toFixed(3) + ' m3/m3.');
  }
  lines.push('', ADVICE[state.risk]);
  lines.push('', 'Reply PLAYED or OFF after the next match — it improves the forecast.');
  return lines.join('\n');
}

var DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function prettyDate(iso) {
  var d = new Date(iso + 'T00:00:00Z');
  return DOW[d.getUTCDay()] + ' ' + (d.getUTCDate() < 10 ? '0' : '') + d.getUTCDate() + ' ' + MON[d.getUTCMonth()];
}

/** Hargreaves-Samani fallback ET0 if the API omits et0 for a day. */
function hargreavesEt0(tmin, tmax, iso) {
  if (tmin === null || tmax === null || tmin === undefined || tmax === undefined) return 0.0;
  var tmean = (tmax + tmin) / 2.0;
  var trange = Math.max(0.0, tmax - tmin);
  var doy = Math.floor((new Date(iso + 'T00:00:00Z') - new Date(Date.UTC(new Date(iso + 'T00:00:00Z').getUTCFullYear(), 0, 0))) / 86400000);
  return Math.max(0.0, 0.0023 * (tmean + 17.8) * Math.sqrt(trange) * extraterrestrialRadiation(51.755, doy));
}

function extraterrestrialRadiation(latDeg, doy) {
  var gsc = 0.0820, phi = latDeg * Math.PI / 180.0;
  var dr = 1 + 0.033 * Math.cos(2 * Math.PI * doy / 365);
  var delta = 0.409 * Math.sin(2 * Math.PI * doy / 365 - 1.39);
  var x = -Math.tan(phi) * Math.tan(delta);
  var ws = Math.acos(Math.max(-1.0, Math.min(1.0, x)));
  return (24 * 60 / Math.PI) * gsc * dr *
    (ws * Math.sin(phi) * Math.sin(delta) + Math.cos(phi) * Math.cos(delta) * Math.sin(ws));
}

// --- exports: Node for verification, globals for Apps Script -----------------
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    DEFAULTS: DEFAULTS, makeParams: makeParams, storeCapMm: storeCapMm, tawMm: tawMm,
    rawMm: rawMm, thetaFromSw: thetaFromSw, swFromTheta: swFromTheta, fSat: fSat,
    riskOf: riskOf, stressCoefficient: stressCoefficient, step: step, run: run,
    daysToClear: daysToClear, calibrate: calibrate, dailyMessage: dailyMessage,
    hargreavesEt0: hargreavesEt0, extraterrestrialRadiation: extraterrestrialRadiation,
    addDays: addDays
  };
}
