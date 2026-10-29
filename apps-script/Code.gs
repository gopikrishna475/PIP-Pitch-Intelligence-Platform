/**
 * PIP — Apps Script pipeline
 * ==========================
 *
 * Replaces the manual steps. Runs every day at 06:00 from Google's servers:
 *
 *   your READINGS sheet  ->  Open-Meteo weather  ->  water balance
 *          ->  LOG + STATUS sheets  ->  WhatsApp to the groundsman
 *          ->  dashboard view
 *
 * There is no server to pay for and no laptop to leave switched on. Deliberately
 * NOT GitHub Actions: scheduled workflows there are automatically disabled after
 * 60 days of repository inactivity, which would silently kill a winter alert.
 *
 * SETUP ORDER: run inspectSheet() first, then setupTriggers(), then runDaily().
 * See SETUP.md.
 */

// ===========================================================================
// CONFIG — the only part you edit
// ===========================================================================
var CONFIG = {
  SPREADSHEET_ID: 'PASTE_YOUR_SPREADSHEET_ID',

  SHEETS: {
    readings: 'READINGS',   // your existing sensor log (input)
    status:   'STATUS',     // one row per pitch, current state (output)
    log:      'LOG',        // one row per pitch per day (output)
    outcomes: 'OUTCOMES'    // what actually happened (input, from replies)
  },

  // Column names in your READINGS sheet. Run inspectSheet() if unsure —
  // it prints what it found and guesses these for you.
  READING_COLUMNS: {
    timestamp: 'timestamp',
    sensorId:  'sensor_id',
    theta:     'theta'        // volumetric water content m3/m3
    // , moisturePct: 'moisture'   <- if your sheet stores %, see pctToTheta()
  },

  // If your sensor logs a raw/percent value instead of m3/m3, set this.
  THETA_IS_PERCENT: false,

  PITCHES: [
    {
      id: 'pitch-1',
      name: 'Pitch 1',
      lat: 51.755,
      lon: -0.336,
      // drainageCapacityMmDay is THE parameter that decides whether a pitch
      // waterlogs. 1.5 = poorly drained clay, 10+ = pipe-drained.
      params: { drainageCapacityMmDay: 1.5, thetaFc: 0.32, rootDepthM: 0.20 }
    }
  ],

  SPINUP_DAYS: 60,          // history used to reach today's soil state
  FORECAST_DAYS: 7,
  ASSIMILATE_WEIGHT: 0.0,   // 0 = trust the model (measures its true error)

  ALERT_RISKS: ['WATCH', 'HIGH', 'UNPLAYABLE'],
  SEND_QUIET_DAYS: false,   // false = quiet days stay quiet
  STALE_HOURS: 24,          // sensor silence that triggers a fault warning

  WHATSAPP: {
    ENABLED: false,                       // flip to true once templates approved
    TOKEN: 'PASTE_META_PERMANENT_TOKEN',
    PHONE_NUMBER_ID: 'PASTE_PHONE_NUMBER_ID',
    RECIPIENTS: ['PASTE_YOUR_PHONE_NUMBER'],         // groundsman(s), international format
    TEMPLATE: 'pip_daily_alert',
    ALERT_TO: ['PASTE_YOUR_PHONE_NUMBER']            // you, for system faults
  },

  TIMEZONE: 'Europe/London',
  TEST_MODE: true           // true = write to sheets, print message, send nothing
};


// ===========================================================================
// 1. Run once: inspect your sheet
// ===========================================================================
/**
 * Prints every tab in the spreadsheet, its header row, and which columns look
 * like the timestamp / sensor id / moisture reading. Run this FIRST.
 */
function inspectSheet() {
  var ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  var out = ['Spreadsheet: ' + ss.getName(), ''];

  ss.getSheets().forEach(function (sh) {
    var lastRow = sh.getLastRow();
    var lastCol = sh.getLastColumn();
    out.push('TAB "' + sh.getName() + '"  rows=' + lastRow + ' cols=' + lastCol);
    if (lastRow < 1) { out.push('   (empty)'); return; }

    var header = sh.getRange(1, 1, 1, lastCol).getValues()[0];
    out.push('   header: ' + JSON.stringify(header));

    var sample = lastRow > 1 ? sh.getRange(2, 1, 1, lastCol).getValues()[0] : [];
    if (sample.length) out.push('   row 2 : ' + JSON.stringify(sample));
    if (lastRow > 2) {
      var last = sh.getRange(lastRow, 1, 1, lastCol).getValues()[0];
      out.push('   last  : ' + JSON.stringify(last));
    }

    // guess the mapping by header keyword
    var guess = {};
    header.forEach(function (h) {
      var k = String(h).toLowerCase();
      if (!guess.timestamp && /time|date|stamp|recorded|logged/.test(k)) guess.timestamp = h;
      if (!guess.sensorId && /sensor|device|node|id|probe/.test(k)) guess.sensorId = h;
      if (!guess.theta && /theta|moist|vwc|water|humidity/.test(k)) guess.theta = h;
    });
    out.push('   -> guessed READING_COLUMNS: ' + JSON.stringify(guess));
    out.push('');
  });

  var text = out.join('\n');
  Logger.log(text);
  return text;
}


// ===========================================================================
// 2. Run once: create the daily trigger
// ===========================================================================
function setupTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'runDaily') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('runDaily')
    .timeBased().atHour(6).nearMinute(0).everyDays(1)
    .inTimezone(CONFIG.TIMEZONE)
    .create();

  // Retry slot: if the 06:00 run fails, this one catches it.
  ScriptApp.newTrigger('runDaily')
    .timeBased().atHour(7).nearMinute(30).everyDays(1)
    .inTimezone(CONFIG.TIMEZONE)
    .create();

  ensureSheets_();
  Logger.log('Daily triggers created (06:00 and 07:30 ' + CONFIG.TIMEZONE + ').');
}


// ===========================================================================
// 3. THE DAILY RUN
// ===========================================================================
function runDaily() {
  var ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  ensureSheets_();
  var results = [];

  CONFIG.PITCHES.forEach(function (pitch) {
    try {
      var r = runPitch_(ss, pitch);
      results.push(r);
      if (r.message) Logger.log('\n' + r.message);
    } catch (err) {
      Logger.log('PITCH FAILED ' + pitch.id + ': ' + err);
      notifyFault_(pitch.name + ' failed: ' + err);
    }
  });

  return results;
}


function runPitch_(ss, pitch) {
  var params = makeParams(pitch.params);
  var today = tzDate_(new Date());

  // --- sensor input ------------------------------------------------------
  var sensor = readLatestSensor_(ss, pitch);

  // --- weather -----------------------------------------------------------
  var hist = fetchWeather_(ARCHIVE_URL, pitch, addDays(today, -CONFIG.SPINUP_DAYS), today);
  var rawFc = fetchWeather_(FORECAST_URL, pitch, null, null);
  var forecast = rawFc.filter(function (d) { return d.day >= today; });

  // --- spin the model up on history so today's store is realistic ---------
  var sensors = sensor.series || {};
  var spun = run(params, hist, 0.0, sensors, CONFIG.ASSIMILATE_WEIGHT);
  var todayStore = spun.length ? spun[spun.length - 1].swMm : 0.0;

  // --- project forward ---------------------------------------------------
  var projected = run(params, forecast, todayStore, sensors, 0.0);
  var state = projected.length ? projected[0] : spun[spun.length - 1];
  if (!state) throw new Error('no weather data returned');

  var future = projected.slice(1);
  state.daysToClear = daysToClear(params, state.swMm, future);
  state.risk = riskOf(params, state.swMm);

  // --- persist -----------------------------------------------------------
  writeLog_(ss, pitch, state, sensor);
  var previous = readStatus_(ss, pitch.id);
  var message = dailyMessage(params, state, future, pitch.name);
  var decision = shouldSend_(state, previous);

  if (decision.send && !CONFIG.TEST_MODE) {
    sendWhatsApp_(CONFIG.WHATSAPP.RECIPIENTS, message, pitch.name);
  }
  writeStatus_(ss, pitch, state, sensor, decision, previous);

  // --- sensor fault detection -------------------------------------------
  if (sensor.staleHours !== null && sensor.staleHours > CONFIG.STALE_HOURS) {
    notifyFault_(pitch.name + ': no sensor reading for ' +
                 Math.round(sensor.staleHours) + ' hours.');
  }

  return { pitch: pitch.id, date: today, risk: state.risk, swMm: state.swMm,
           sent: decision.send && !CONFIG.TEST_MODE, reason: decision.reason,
           message: message };
}


// ===========================================================================
// Alert logic — never send the same warning 40 mornings running
// ===========================================================================
function shouldSend_(state, previous) {
  var risk = state.risk;
  if (previous && previous.date === state.day && previous.risk === risk) {
    return { send: false, reason: 'already sent today' };
  }
  if (previous && previous.risk !== risk) {
    return { send: true, reason: 'risk changed ' + previous.risk + ' -> ' + risk };
  }
  if (CONFIG.ALERT_RISKS.indexOf(risk) !== -1) {
    return { send: true, reason: 'active alert: ' + risk };
  }
  if (CONFIG.SEND_QUIET_DAYS) {
    return { send: true, reason: 'quiet-day digest' };
  }
  return { send: false, reason: 'quiet day, no alert level' };
}


// ===========================================================================
// Sheet input / output
// ===========================================================================
function ensureSheets_() {
  var ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  var defs = {};
  defs[CONFIG.SHEETS.status] = ['pitch_id', 'pitch_name', 'date', 'risk', 'sw_mm',
    'theta', 'f_sat', 'days_to_clear', 'sensor_last_seen', 'sensor_stale_hours',
    'last_sent_date', 'last_sent_risk', 'updated_at'];
  defs[CONFIG.SHEETS.log] = ['date', 'pitch_id', 'pitch_name', 'risk', 'sw_mm',
    'f_sat', 'theta', 'ks', 'precip_mm', 'et0_mm', 'etc_mm', 'drainage_mm',
    'runoff_mm', 'days_to_clear', 'sensor_theta'];
  defs[CONFIG.SHEETS.outcomes] = ['date', 'pitch_id', 'outcome', 'source', 'received_at'];

  Object.keys(defs).forEach(function (name) {
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    if (sh.getLastRow() === 0) {
      sh.getRange(1, 1, 1, defs[name].length).setValues([defs[name]])
        .setFontWeight('bold');
      sh.setFrozenRows(1);
    }
  });
}

/** Latest reading + the recent series the model assimilates. */
function readLatestSensor_(ss, pitch) {
  var sh = ss.getSheetByName(CONFIG.SHEETS.readings);
  if (!sh || sh.getLastRow() < 2) return { theta: null, day: null, staleHours: null, series: {} };

  var cols = CONFIG.READING_COLUMNS;
  var header = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var iTime = header.indexOf(cols.timestamp);
  var iTheta = header.indexOf(cols.theta);
  var iSensor = cols.sensorId ? header.indexOf(cols.sensorId) : -1;
  if (iTime < 0 || iTheta < 0) {
    throw new Error('READINGS sheet is missing "' + cols.timestamp + '" or "' +
                    cols.theta + '" — run inspectSheet() and fix READING_COLUMNS');
  }

  var n = sh.getLastRow() - 1;
  var firstRow = Math.max(2, sh.getLastRow() - 5000);
  var values = sh.getRange(firstRow, 1, n - (firstRow - 2), sh.getLastColumn()).getValues();

  var series = {}, latest = null, latestTime = null;
  values.forEach(function (row) {
    var t = row[iTime];
    if (!t) return;
    var d = (t instanceof Date) ? t : new Date(t);
    if (isNaN(d.getTime())) return;
    var day = tzDate_(d);
    var theta = Number(row[iTheta]);
    if (isNaN(theta)) return;
    if (CONFIG.THETA_IS_PERCENT) theta = theta / 100.0;

    // Keep the last reading of each day.
    if (!series[day] || d > series[day].at) {
      series[day] = { theta: theta, at: d };
    }
    if (!latestTime || d > latestTime) { latestTime = d; latest = { theta: theta, day: day }; }
  });

  var clean = {};
  Object.keys(series).forEach(function (k) { clean[k] = series[k].theta; });

  var staleHours = latestTime
    ? (new Date().getTime() - latestTime.getTime()) / 3600000
    : null;

  return {
    theta: latest ? latest.theta : null,
    day: latest ? latest.day : null,
    staleHours: staleHours,
    series: clean
  };
}

function writeLog_(ss, pitch, state, sensor) {
  var sh = ss.getSheetByName(CONFIG.SHEETS.log);
  sh.appendRow([state.day, pitch.id, pitch.name, state.risk,
    round_(state.swMm, 2), round_(state.fSat, 3), round_(state.theta, 4),
    round_(state.ks, 3), round_(state.precipMm, 2), round_(state.et0Mm, 2),
    round_(state.etcMm, 2), round_(state.drainageMm, 2), round_(state.runoffMm, 2),
    state.daysToClear,
    sensor.theta === null ? '' : round_(sensor.theta, 4)]);
}

function readStatus_(ss, pitchId) {
  var sh = ss.getSheetByName(CONFIG.SHEETS.status);
  if (sh.getLastRow() < 2) return null;
  var values = sh.getRange(2, 1, sh.getLastRow() - 1,
    Math.min(13, sh.getLastColumn())).getValues();
  for (var i = 0; i < values.length; i++) {
    if (values[i][0] === pitchId) {
      return { date: String(values[i][2]).slice(0, 10),
               risk: values[i][3],
               lastSentDate: values[i][10],
               lastSentRisk: values[i][11] };
    }
  }
  return null;
}

function writeStatus_(ss, pitch, state, sensor, decision, previous) {
  var sh = ss.getSheetByName(CONFIG.SHEETS.status);
  var now = new Date();
  var lastSentDate = (decision.send ? state.day : (previous ? previous.lastSentDate : ''));
  var lastSentRisk = (decision.send ? state.risk : (previous ? previous.lastSentRisk : ''));

  var row = [pitch.id, pitch.name, state.day, state.risk, round_(state.swMm, 2),
    round_(state.theta, 4), round_(state.fSat, 3), state.daysToClear,
    sensor.day || '', sensor.staleHours === null ? '' : round_(sensor.staleHours, 1),
    lastSentDate, lastSentRisk, now];

  var values = sh.getLastRow() > 1
    ? sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues() : [];
  for (var i = 0; i < values.length; i++) {
    if (values[i][0] === pitch.id) { sh.getRange(i + 2, 1, 1, row.length).setValues([row]); return; }
  }
  sh.appendRow(row);
}


// ===========================================================================
// Weather
// ===========================================================================
var ARCHIVE_URL = 'https://archive-api.open-meteo.com/v1/archive';
var FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';

function fetchWeather_(base, pitch, start, end) {
  var q = '?latitude=' + pitch.lat + '&longitude=' + pitch.lon +
    '&daily=precipitation_sum,et0_fao_evapotranspiration,temperature_2m_max,temperature_2m_min' +
    '&timezone=' + encodeURIComponent(CONFIG.TIMEZONE);
  if (base === ARCHIVE_URL) {
    q += '&start_date=' + start + '&end_date=' + end;
  } else {
    q += '&forecast_days=' + CONFIG.FORECAST_DAYS;
  }

  var res = UrlFetchApp.fetch(base + q, { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) {
    throw new Error('weather API ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 200));
  }
  var d = JSON.parse(res.getContentText()).daily;
  var out = [];
  for (var i = 0; i < d.time.length; i++) {
    var et0 = d.et0_fao_evapotranspiration[i];
    if (et0 === null || et0 === undefined) {
      et0 = hargreavesEt0(d.temperature_2m_min[i], d.temperature_2m_max[i], d.time[i]);
    }
    out.push({ day: d.time[i], precip: Number(d.precipitation_sum[i]) || 0, et0: Number(et0) || 0 });
  }
  return out;
}


// ===========================================================================
// WhatsApp (Meta Cloud API)
// ===========================================================================
function sendWhatsApp_(recipients, text, pitchName) {
  var w = CONFIG.WHATSAPP;
  if (!w.ENABLED) { Logger.log('WhatsApp disabled (TEST_MODE or ENABLED=false)'); return; }
  var url = 'https://graph.facebook.com/v21.0/' + w.PHONE_NUMBER_ID + '/messages';

  recipients.forEach(function (to) {
    var payload = {
      messaging_product: 'whatsapp',
      to: to,
      type: 'text',
      text: { preview_url: false, body: text }
    };
    // NOTE: free-form text only works inside the 24-hour customer service
    // window. Outside it you must use an approved template. See SETUP.md.
    var res = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + w.TOKEN },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
    var code = res.getResponseCode();
    if (code !== 200) {
      Logger.log('WhatsApp send failed ' + code + ': ' + res.getContentText().slice(0, 300));
    }
  });
}

function notifyFault_(text) {
  Logger.log('FAULT: ' + text);
  if (!CONFIG.TEST_MODE && CONFIG.WHATSAPP.ENABLED) {
    try { sendWhatsApp_(CONFIG.WHATSAPP.ALERT_TO, 'PIP system: ' + text); } catch (e) {}
  }
}


// ===========================================================================
// Incoming replies -> ground truth (this is the training data)
// ===========================================================================
/**
 * Deploy: Deploy > New deployment > Web app > Execute as me, Access: anyone.
 * Paste the URL into Meta > WhatsApp > Configuration > Webhook URL.
 */
function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    var msgs = (body.entry || []).map(function (en) { return en.changes; })
      .reduce(function (a, b) { return a.concat(b || []); }, [])
      .map(function (ch) { return ((ch.value || {}).messages || [])[0]; })
      .filter(function (m) { return !!m; });

    var ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    msgs.forEach(function (m) {
      var text = String(((m.text || {}).body) || '').trim().toUpperCase();
      var outcome = null;
      if (/^(YES|PLAYED|ON|OK|1|PLAYED ON)$/.test(text)) outcome = 'PLAYED';
      if (/^(NO|OFF|CANCELLED|CALLED OFF|0|UNPLAYABLE)$/.test(text)) outcome = 'OFF';
      if (!outcome) return;
      ss.getSheetByName(CONFIG.SHEETS.outcomes).appendRow([
        tzDate_(new Date()), CONFIG.PITCHES[0].id, outcome, 'whatsapp', new Date()]);
    });
  } catch (err) {
    Logger.log('doPost error: ' + err);
  }
  return ContentService.createTextOutput('ok');
}


// ===========================================================================
// Dashboard (web app) + data feed
// ===========================================================================
function doGet() {
  return HtmlService.createHtmlOutputFromFile('Dashboard')
    .setTitle('PIP dashboard')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** Called by Dashboard.html. Returns everything the view needs, in one trip. */
function getDashboardData() {
  var ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  var log = readTable_(ss.getSheetByName(CONFIG.SHEETS.log));
  var outcomes = readTable_(ss.getSheetByName(CONFIG.SHEETS.outcomes));
  var pitches = {};

  CONFIG.PITCHES.forEach(function (p) {
    var rows = log.filter(function (r) { return r.pitch_id === p.id; });
    rows.sort(function (a, b) { return String(a.date) < String(b.date) ? -1 : 1; });

    var counts = { LOW: 0, WATCH: 0, HIGH: 0, UNPLAYABLE: 0 };
    rows.forEach(function (r) { if (counts[r.risk] !== undefined) counts[r.risk]++; });

    var series = rows.slice(-60).map(function (r) {
      return { date: String(r.date).slice(0, 10),
               precip: Number(r.precip_mm) || 0,
               sw: Number(r.sw_mm) || 0,
               risk: r.risk };
    });

    var latest = rows.length ? rows[rows.length - 1] : null;
    var lastSensor = null;
    for (var i = rows.length - 1; i >= 0; i--) {
      if (rows[i].sensor_theta !== '' && rows[i].sensor_theta !== null) {
        lastSensor = rows[i]; break;
      }
    }
    var staleHours = null;
    if (lastSensor) {
      staleHours = (new Date().getTime() -
        new Date(String(lastSensor.date) + 'T06:00:00Z').getTime()) / 3600000;
    }

    pitches[p.id] = {
      id: p.id, name: p.name, drainage: p.params.drainageCapacityMmDay,
      latest: latest ? {
        date: String(latest.date).slice(0, 10),
        risk: latest.risk,
        swMm: Number(latest.sw_mm) || 0,
        fSat: Number(latest.f_sat) || 0,
        theta: Number(latest.theta) || 0,
        daysToClear: Number(latest.days_to_clear) || 0,
        sensorTheta: lastSensor ? Number(lastSensor.sensor_theta) : null,
        precip: Number(latest.precip_mm) || 0,
        et0: Number(latest.et0_mm) || 0
      } : null,
      series: series,
      counts: counts,
      daysLogged: rows.length,
      unplayableDays: counts.UNPLAYABLE,
      pctUnplayable: rows.length ? Math.round(100 * counts.UNPLAYABLE / rows.length) : 0,
      staleHours: staleHours,
      outcomes: outcomes.filter(function (o) { return o.pitch_id === p.id; }).slice(-20)
    };
  });

  return {
    generatedAt: Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'dd MMM yyyy HH:mm'),
    testMode: CONFIG.TEST_MODE,
    whatsappEnabled: CONFIG.WHATSAPP.ENABLED,
    thresholds: { watch: DEFAULTS.fSatWatch, risk: DEFAULTS.fSatRisk,
                  unplayable: DEFAULTS.fSatUnplayable },
    pitches: pitches
  };
}

function readTable_(sh) {
  if (!sh || sh.getLastRow() < 2) return [];
  var header = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var values = sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues();
  return values.map(function (row) {
    var o = {};
    header.forEach(function (h, i) { o[h] = row[i]; });
    return o;
  });
}


// ===========================================================================
// Helpers + in-sheet self test
// ===========================================================================
function tzDate_(d) {
  return Utilities.formatDate(d, CONFIG.TIMEZONE, 'yyyy-MM-dd');
}
function round_(x, n) {
  var f = Math.pow(10, n);
  return Math.round(Number(x) * f) / f;
}

/** Run this after any edit to the engine. Throws on failure. */
function selftest() {
  var checks = [];
  function ok(name, cond) { checks.push((cond ? 'PASS  ' : 'FAIL  ') + name); if (!cond) throw new Error('selftest failed: ' + name); }

  var p = makeParams({ drainageCapacityMmDay: 1.5 });
  ok('store capacity', Math.abs(storeCapMm(p) - 26.0) < 1e-9);
  ok('TAW', Math.abs(tawMm(p) - 36.0) < 1e-9);

  // drainage capped at pitch capacity
  var s = step(p, 10.0, 0.0, 0.0, 0.0);
  ok('drainage capped', Math.abs(s.drainage - 1.5) < 1e-9 && Math.abs(s.sw - 8.5) < 1e-9);

  // Ks throttles transpiration as it dries
  ok('Ks wet', stressCoefficient(p, 0) === 1.0);
  ok('Ks wilting', stressCoefficient(p, tawMm(p)) === 0.0);

  // mass balance over a real-ish series
  var wx = [], d = '2026-01-01';
  for (var i = 0; i < 40; i++) {
    wx.push({ day: addDays('2026-01-01', i), precip: (i % 3 === 0 ? 12 : 0.4), et0: 0.9 });
  }
  var st = run(p, wx, 0.0, {}, 0.0);
  var P = 0, ET = 0, D = 0, RO = 0;
  st.forEach(function (x) { P += x.precipMm; ET += x.etcMm; D += x.drainageMm; RO += x.runoffMm; });
  var resid = (P - ET - D - RO) - (st[st.length - 1].swMm - 0.0);
  ok('mass balance closes (' + resid.toExponential(2) + ')', Math.abs(resid) < 1e-9);

  // clay waterlogs, drained pitch does not
  var wClay = run(makeParams({ drainageCapacityMmDay: 1.5 }),
    [{ day: '2026-01-01', precip: 30, et0: 0.3 }], 0, {}, 0)[0];
  var wSand = run(makeParams({ drainageCapacityMmDay: 16 }),
    [{ day: '2026-01-01', precip: 30, et0: 0.3 }], 0, {}, 0)[0];
  ok('clay goes unplayable', wClay.risk === 'UNPLAYABLE');
  ok('drained pitch does not', wSand.fSat < wClay.fSat);

  var text = checks.join('\n');
  Logger.log(text);
  return text;
}
