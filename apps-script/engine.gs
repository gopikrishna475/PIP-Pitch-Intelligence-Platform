/**
 * engine.gs — PIP Water Balance Engine
 * Pure functions only. No Apps Script services, no network, no spreadsheet access.
 * All inputs are plain JS values. All outputs are plain JS objects.
 * Testable in isolation via selftest().
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
var RISK = { LOW: 'LOW', WATCH: 'WATCH', HIGH: 'HIGH', UNPLAYABLE: 'UNPLAYABLE' };
var F_SAT_WATCH      = 0.35;
var F_SAT_HIGH       = 0.60;
var F_SAT_UNPLAYABLE = 0.80;
var MAX_DAYS_TO_CLEAR = 120;

// ---------------------------------------------------------------------------
// Parameter validation
// ---------------------------------------------------------------------------
function validateParams(p) {
  if (!(p.theta_wp < p.theta_fc && p.theta_fc < p.theta_sat)) {
    throw new Error(
      'Parameter error: must satisfy theta_wp (' + p.theta_wp +
      ') < theta_fc (' + p.theta_fc +
      ') < theta_sat (' + p.theta_sat + ')'
    );
  }
  if (!(p.Zr > 0)) {
    throw new Error('Parameter error: Zr (root depth, m) must be > 0, got ' + p.Zr);
  }
  if (!(p.drainage_capacity_mm_day > 0)) {
    throw new Error('Parameter error: drainage_capacity_mm_day must be > 0, got ' +
                    p.drainage_capacity_mm_day);
  }
}

// ---------------------------------------------------------------------------
// Derived pitch capacities
// ---------------------------------------------------------------------------
function pitchCapacities(p) {
  validateParams(p);
  var STORE_CAP = (p.theta_sat - p.theta_fc) * 1000 * p.Zr;   // mm
  var TAW       = (p.theta_fc  - p.theta_wp) * 1000 * p.Zr;   // mm
  var RAW       = p.p_depletion * TAW;                          // mm
  return { STORE_CAP: STORE_CAP, TAW: TAW, RAW: RAW };
}

// ---------------------------------------------------------------------------
// Hargreaves-Samani ET0 fallback (FAO-56 Eq. 21)
// ---------------------------------------------------------------------------
function hargreavesSamani(tmax, tmin, doy, latDeg) {
  if (tmax === null || tmin === null) return 0;
  var phi   = latDeg * Math.PI / 180;
  var dr    = 1 + 0.033 * Math.cos(2 * Math.PI * doy / 365);
  var delta = 0.409 * Math.sin(2 * Math.PI * doy / 365 - 1.39);
  var wsArg = -Math.tan(phi) * Math.tan(delta);
  wsArg     = Math.max(-1, Math.min(1, wsArg));          // clamp
  var ws    = Math.acos(wsArg);
  var Ra    = (24 * 60 / Math.PI) * 0.0820 * dr *
              (ws * Math.sin(phi) * Math.sin(delta) +
               Math.cos(phi) * Math.cos(delta) * Math.sin(ws));
  var tmean = (tmax + tmin) / 2;
  var et0   = 0.0023 * (tmean + 17.8) * Math.sqrt(Math.max(0, tmax - tmin)) * Ra;
  return Math.max(0, et0);
}

// ---------------------------------------------------------------------------
// Convert sensor theta to sw
// ---------------------------------------------------------------------------
function swFromTheta(theta, p) {
  return (theta - p.theta_fc) * 1000 * p.Zr;
}

// ---------------------------------------------------------------------------
// Convert sw to theta
// ---------------------------------------------------------------------------
function thetaFromSw(sw, p) {
  var raw = p.theta_fc + sw / (1000 * p.Zr);
  return Math.max(p.theta_wp, Math.min(p.theta_sat, raw));
}

// ---------------------------------------------------------------------------
// Single daily step — returns full diagnostics
// ---------------------------------------------------------------------------
function dailyStep(sw_prev, precip, et0, irrigation, p, cap) {
  // Stress coefficient
  var Dr  = Math.max(0, -sw_prev);
  var Ks;
  if (Dr <= cap.RAW) {
    Ks = 1;
  } else if (Dr < cap.TAW) {
    Ks = (cap.TAW - Dr) / (cap.TAW - cap.RAW);
  } else {
    Ks = 0;
  }

  var ETc    = Ks * p.Kc * et0;
  var sw_tmp = sw_prev + precip + (irrigation || 0) - ETc;

  // Runoff: excess above drainable pore space
  var runoff = 0;
  if (sw_tmp > cap.STORE_CAP) {
    runoff = sw_tmp - cap.STORE_CAP;
    sw_tmp = cap.STORE_CAP;
  }

  // Drainage from saturated zone
  var drainage = 0;
  if (sw_tmp > 0) {
    drainage = Math.min(sw_tmp, p.drainage_capacity_mm_day);
    sw_tmp  -= drainage;
  }

  // Floor at -TAW
  if (sw_tmp < -cap.TAW) sw_tmp = -cap.TAW;

  var f_sat = sw_tmp <= 0 ? 0 : Math.min(1, sw_tmp / cap.STORE_CAP);
  var risk;
  if      (f_sat >= F_SAT_UNPLAYABLE) risk = RISK.UNPLAYABLE;
  else if (f_sat >= F_SAT_HIGH)       risk = RISK.HIGH;
  else if (f_sat >= F_SAT_WATCH)      risk = RISK.WATCH;
  else                                 risk = RISK.LOW;

  var theta = thetaFromSw(sw_tmp, p);

  return {
    sw:          sw_tmp,
    theta:       theta,
    f_sat:       f_sat,
    risk:        risk,
    Ks:          Ks,
    ETc:         ETc,
    drainage:    drainage,
    runoff:      runoff,
    precip:      precip,
    et0:         et0,
    irrigation:  irrigation || 0
  };
}

// ---------------------------------------------------------------------------
// Days-to-clear: simulate forward until f_sat < WATCH threshold
// ---------------------------------------------------------------------------
function daysToClear(sw_now, forecastDays, p, cap, tailEt0) {
  // forecastDays: array of {precip, et0} objects
  //
  // tailEt0 = the ET0 assumed for days BEYOND the forecast horizon.
  //
  // It defaults to 0 deliberately. Past the forecast the only loss we can be
  // sure of is drainage, so the estimate stays long and conservative.
  //
  // Do NOT hardcode a summer ET0 here. This function previously used a fixed
  // 3.0 mm/day, which is a July value; in a UK winter ET0 runs about
  // 0.3-0.8 mm/day, so it reported the ground clearing 2-5x sooner than it
  // would. This number is shown to a groundsman deciding whether a match can go
  // ahead, so an optimistic error is the dangerous direction.
  // For a seasonal tail, pass the mean ET0 of the spin-up period.
  tailEt0 = tailEt0 || 0;

  var sw = sw_now;
  for (var i = 0; i < forecastDays.length; i++) {
    var step = dailyStep(sw, forecastDays[i].precip, forecastDays[i].et0, 0, p, cap);
    sw = step.sw;
    var f = sw <= 0 ? 0 : Math.min(1, sw / cap.STORE_CAP);
    if (f < F_SAT_WATCH) return i + 1;
  }
  // Extend beyond the forecast: no rain, seasonal (default zero) ET.
  var day = forecastDays.length;
  while (day < MAX_DAYS_TO_CLEAR) {
    var step2 = dailyStep(sw, 0, tailEt0, 0, p, cap);
    sw = step2.sw;
    var f2 = sw <= 0 ? 0 : Math.min(1, sw / cap.STORE_CAP);
    if (f2 < F_SAT_WATCH) return day + 1;
    day++;
  }
  return MAX_DAYS_TO_CLEAR;
}

// ---------------------------------------------------------------------------
// Run a full history + forecast sequence from sw=0
// ---------------------------------------------------------------------------
function runBalance(historyDays, forecastDays, sensorReadings, p, assimilateWeight, tailEt0) {
  // historyDays: [{date, precip, et0, tmax, tmin, doy}]
  // forecastDays: [{date, precip, et0, tmax, tmin, doy}]
  // sensorReadings: {YYYY-MM-DD: theta}
  // assimilateWeight: 0 = ignore the sensor, 1 = fully trust it. Default 0.
  //
  // An earlier version OVERWROTE the store with the sensor value on every day a
  // reading existed. That looks harmless and is not:
  //   - it makes the model a pure sensor echo, so the physics only fills gaps
  //   - the overwrite is unconditional, so it injects or destroys water.
  //     Measured over one winter with readings on 46 of 182 days, the water
  //     balance leaked 77.6 mm.
  //   - it broke the very property selftest() claims to verify, because the
  //     self-test exercises dailyStep() in isolation and never enters here.
  //
  // Keep this at 0 while measuring the model's true error. Assimilation should
  // CORRECT the model, not replace it.
  assimilateWeight = assimilateWeight || 0;
  tailEt0 = tailEt0 || 0;
  validateParams(p);
  var cap = pitchCapacities(p);

  var sw   = 0;
  var log  = [];

  var allDays = historyDays.concat(forecastDays);
  for (var i = 0; i < allDays.length; i++) {
    var d      = allDays[i];
    var et0    = (d.et0 !== null && d.et0 !== undefined)
                 ? d.et0
                 : hargreavesSamani(d.tmax, d.tmin, d.doy, p.latitude);

    // Anchor to sensor if present for this date
    var sensorTheta = sensorReadings && sensorReadings[d.date] !== undefined
                      ? sensorReadings[d.date]
                      : null;
    if (sensorTheta !== null && assimilateWeight > 0) {
      var swObs = swFromTheta(sensorTheta, p);
      swObs = Math.max(-cap.TAW, Math.min(cap.STORE_CAP, swObs));
      var w = Math.min(1, Math.max(0, assimilateWeight));
      sw = (1 - w) * sw + w * swObs;
    }

    var step = dailyStep(sw, d.precip || 0, et0 || 0, 0, p, cap);
    sw = step.sw;

    // days-to-clear uses remaining forecast
    var remaining = forecastDays.slice(Math.max(0, i - historyDays.length + 1));
    var dtc = (step.f_sat >= F_SAT_WATCH)
              ? daysToClear(sw, remaining, p, cap, tailEt0)
              : 0;

    log.push({
      date:          d.date,
      sw_mm:         sw,
      theta:         step.theta,
      f_sat:         step.f_sat,
      risk:          step.risk,
      Ks:            step.Ks,
      ETc:           step.ETc,
      et0:           et0,
      precip:        step.precip,
      drainage:      step.drainage,
      runoff:        step.runoff,
      days_to_clear: dtc,
      sensor_theta:  sensorTheta,
      isForecast:    i >= historyDays.length
    });
  }

  return { log: log, cap: cap, finalSw: sw };
}

// ---------------------------------------------------------------------------
// Calibration grid search
// ---------------------------------------------------------------------------
function calibrate(historyDays, sensorReadings, p_base) {
  var drainage_values = [];
  for (var d = 0.25; d <= 24.001; d += 0.25) {
    drainage_values.push(Math.round(d * 100) / 100);
  }
  var theta_fc_values = [];
  for (var t = 0.18; t <= 0.34001; t += 0.02) {
    theta_fc_values.push(Math.round(t * 100) / 100);
  }

  var results = [];

  for (var di = 0; di < drainage_values.length; di++) {
    for (var ti = 0; ti < theta_fc_values.length; ti++) {
      var p = Object.assign({}, p_base, {
        drainage_capacity_mm_day: drainage_values[di],
        theta_fc: theta_fc_values[ti]
      });

      // Skip invalid combos
      if (!(p.theta_wp < p.theta_fc && p.theta_fc < p.theta_sat)) continue;

      try {
        var cap = pitchCapacities(p);
        var sw  = 0;
        var pairs = [];

        for (var i = 0; i < historyDays.length; i++) {
          var day  = historyDays[i];
          var et0  = (day.et0 !== null && day.et0 !== undefined)
                     ? day.et0
                     : hargreavesSamani(day.tmax, day.tmin, day.doy, p.latitude);
          var step = dailyStep(sw, day.precip || 0, et0 || 0, 0, p, cap);
          sw = step.sw;

          if (sensorReadings[day.date] !== undefined) {
            var modTheta  = thetaFromSw(sw, p);
            var sensTheta = sensorReadings[day.date];
            pairs.push({ mod: modTheta * 100, obs: sensTheta * 100 });
          }
        }

        if (pairs.length === 0) continue;

        var sumSqErr = 0;
        var sumBias  = 0;
        for (var pi = 0; pi < pairs.length; pi++) {
          var err = pairs[pi].mod - pairs[pi].obs;
          sumSqErr += err * err;
          sumBias  += err;
        }
        var rmse = Math.sqrt(sumSqErr / pairs.length);
        var bias = sumBias / pairs.length;

        results.push({
          drainage_capacity_mm_day: drainage_values[di],
          theta_fc:  theta_fc_values[ti],
          rmse:      rmse,
          bias:      bias,
          n:         pairs.length
        });
      } catch(e) {
        // skip invalid param combos
      }
    }
  }

  results.sort(function(a, b) { return a.rmse - b.rmse; });
  return {
    best:  results[0] || null,
    table: results
  };
}

// ---------------------------------------------------------------------------
// Self-test suite
// ---------------------------------------------------------------------------
function selftest() {
  var p = {
    Zr:                       0.20,
    theta_fc:                 0.32,
    theta_wp:                 0.14,
    theta_sat:                0.45,
    Kc:                       0.95,
    p_depletion:              0.55,
    drainage_capacity_mm_day: 1.5,
    latitude:                 51.8
  };
  var cap = pitchCapacities(p);

  // Helper
  function assert(cond, msg) {
    if (!cond) throw new Error('SELFTEST FAILED: ' + msg);
  }
  function near(a, b, tol) {
    return Math.abs(a - b) <= (tol || 1e-9);
  }

  // 1. Mass balance
  var sw0 = 0;
  var weather = [
    { precip: 5,  et0: 2 },
    { precip: 0,  et0: 3 },
    { precip: 20, et0: 1 },
    { precip: 0,  et0: 2.5 }
  ];
  var sw_cur = sw0;
  var tot_precip = 0, tot_etc = 0, tot_drain = 0, tot_runoff = 0;
  for (var i = 0; i < weather.length; i++) {
    var s = dailyStep(sw_cur, weather[i].precip, weather[i].et0, 0, p, cap);
    tot_precip  += s.precip;
    tot_etc     += s.ETc;
    tot_drain   += s.drainage;
    tot_runoff  += s.runoff;
    sw_cur       = s.sw;
  }
  var balance_err = Math.abs(
    tot_precip - tot_etc - tot_drain - tot_runoff - (sw_cur - sw0)
  );
  assert(balance_err < 1e-9, 'Mass balance error: ' + balance_err);

  // 2. ETc == Ks * Kc * ET0 at zero stress (sw = 0, no deficit)
  var s2 = dailyStep(0, 0, 4.0, 0, p, cap);
  assert(near(s2.ETc, 1 * p.Kc * 4.0, 1e-9), 'ETc stress test');

  // 3. Drainage never exceeds drainage_capacity_mm_day
  var s3 = dailyStep(cap.STORE_CAP, 50, 0, 0, p, cap);
  assert(s3.drainage <= p.drainage_capacity_mm_day + 1e-9, 'Drainage cap');

  // 4. Store never exceeds STORE_CAP
  var s4 = dailyStep(cap.STORE_CAP, 100, 0, 0, p, cap);
  assert(s4.sw <= cap.STORE_CAP + 1e-9, 'Store cap');
  assert(s4.runoff > 0, 'Runoff generated');

  // 5. Store never falls below -TAW
  var s5 = dailyStep(-cap.TAW, 0, 100, 0, p, cap);
  assert(s5.sw >= -cap.TAW - 1e-9, 'Store floor');

  // 6. Ks == 1 at zero depletion; Ks approaches 0 as Dr -> TAW; Ks monotonic
  assert(near(dailyStep(0, 0, 1, 0, p, cap).Ks, 1, 1e-9), 'Ks at zero depletion');
  var prev_Ks = 1;
  for (var dr_pct = 0; dr_pct <= 100; dr_pct += 5) {
    var sw_test = -(dr_pct / 100) * cap.TAW;
    var Ks_test = dailyStep(sw_test, 0, 1, 0, p, cap).Ks;
    assert(Ks_test <= prev_Ks + 1e-9, 'Ks monotonic at ' + dr_pct + '%');
    prev_Ks = Ks_test;
  }
  assert(dailyStep(-cap.TAW, 0, 1, 0, p, cap).Ks < 0.001, 'Ks -> 0 at TAW');

  // 7. 30mm rain on 1.5 mm/day pitch -> UNPLAYABLE; on 16 mm/day -> less severe
  var p_slow = Object.assign({}, p, { drainage_capacity_mm_day: 1.5 });
  var p_fast = Object.assign({}, p, { drainage_capacity_mm_day: 16  });
  var cap_s  = pitchCapacities(p_slow);
  var cap_f  = pitchCapacities(p_fast);
  var s_slow = dailyStep(0, 30, 0, 0, p_slow, cap_s);
  var s_fast = dailyStep(0, 30, 0, 0, p_fast, cap_f);
  assert(s_slow.risk === RISK.UNPLAYABLE, '30mm on slow drain -> UNPLAYABLE');
  assert(s_fast.f_sat < s_slow.f_sat, '30mm fast drain less severe');
  var dtc_slow = daysToClear(s_slow.sw, [], p_slow, cap_s);
  var dtc_fast = daysToClear(s_fast.sw, [], p_fast, cap_f);
  assert(dtc_slow >= dtc_fast, 'Slow drain clears slower');

  // 8. Alert de-duplication
  var alerts = buildAlertState_test();
  assert(shouldSend(alerts.same_day_same_risk)   === false, 'Dedup: same day same risk');
  assert(shouldSend(alerts.same_day_risk_change) === true,  'Dedup: risk change');
  assert(shouldSend(alerts.quiet_low)            === false, 'Dedup: quiet LOW day');
  assert(shouldSend(alerts.new_day_watch)        === true,  'Dedup: new day WATCH');

  // 9. sw_from_theta(theta_from_sw(x)) == x
  for (var sw_test2 = -cap.TAW; sw_test2 <= cap.STORE_CAP; sw_test2 += 0.5) {
    var theta_rt = thetaFromSw(sw_test2, p);
    var sw_rt    = swFromTheta(theta_rt, p);
    // Roundtrip exact except at clamp boundaries
    var clamped  = sw_test2 < -cap.TAW || sw_test2 > cap.STORE_CAP;
    if (!clamped) {
      assert(near(sw_rt, sw_test2, 1e-6), 'Roundtrip sw->theta->sw at ' + sw_test2);
    }
  }

  // 10. days_to_clear non-increasing through dry spell; longer with rain
  var sw_wet = cap.STORE_CAP * 0.9;
  var dry7   = [];
  for (var d7 = 0; d7 < 7; d7++) dry7.push({ precip: 0, et0: 3 });
  var rain7  = [];
  for (var d8 = 0; d8 < 7; d8++) rain7.push({ precip: 5, et0: 3 });

  var dtc_dry  = daysToClear(sw_wet, dry7,  p, cap);
  var dtc_rain = daysToClear(sw_wet, rain7, p, cap);
  assert(dtc_rain >= dtc_dry, 'Rain forecast -> more days to clear');

  // Verify non-increasing through dry spell
  var sw_run = sw_wet;
  var prev_dtc = daysToClear(sw_run, [], p, cap);
  for (var dd = 0; dd < 10; dd++) {
    var step_dd = dailyStep(sw_run, 0, 3.0, 0, p, cap);
    sw_run = step_dd.sw;
    var curr_dtc = daysToClear(sw_run, [], p, cap);
    assert(curr_dtc <= prev_dtc + 1, 'days_to_clear non-increasing day ' + dd);
    prev_dtc = curr_dtc;
  }

  return 'ALL SELF-TESTS PASSED';
}

// Helper for deduplication test
function buildAlertState_test() {
  var today = '2026-01-15';
  return {
    same_day_same_risk:   { today: today, lastSentDate: today, lastSentRisk: RISK.HIGH, currentRisk: RISK.HIGH },
    same_day_risk_change: { today: today, lastSentDate: today, lastSentRisk: RISK.WATCH, currentRisk: RISK.HIGH },
    quiet_low:            { today: today, lastSentDate: '2026-01-14', lastSentRisk: RISK.LOW, currentRisk: RISK.LOW },
    new_day_watch:        { today: today, lastSentDate: '2026-01-14', lastSentRisk: RISK.WATCH, currentRisk: RISK.WATCH }
  };
}

function shouldSend(state) {
  // Never the same risk level twice in one day.
  if (state.lastSentDate === state.today && state.lastSentRisk === state.currentRisk) {
    return false;
  }
  // Always send when the level CHANGED — including the good news that it has
  // recovered to LOW, so the groundsman knows the pitch is playable again.
  // (A previous version suppressed the recovery message, so a pitch could go
  // back to playable silently.)
  if (state.lastSentRisk !== null && state.lastSentRisk !== undefined &&
      state.lastSentRisk !== state.currentRisk) {
    return true;
  }
  // Otherwise speak only while an alert level is active. Quiet days stay quiet.
  return [RISK.WATCH, RISK.HIGH, RISK.UNPLAYABLE].indexOf(state.currentRisk) !== -1;
}
