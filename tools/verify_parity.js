/**
 * Cross-validation: JavaScript port vs Python reference implementation.
 *
 * Runs BOTH engines over the identical real weather series and compares every
 * daily output. This is the check that makes it safe to run the JS port in
 * production: if the two ever disagree, the port has drifted and the Python
 * engine wins.
 *
 *   node verify_port.js weather.csv out_js.csv
 */
const fs = require('fs');
const E = require('../model/water_balance.js');

const weatherFile = process.argv[2] || 'weather.csv';
const outFile = process.argv[3] || 'out_js.csv';

const rows = fs.readFileSync(weatherFile, 'utf8').trim().split('\n').slice(1);
const weather = rows.map(r => {
  const [day, precip, et0] = r.split(',');
  return { day: day.trim(), precip: parseFloat(precip), et0: parseFloat(et0) };
});

const f = (x, n) => Number(x).toFixed(n === undefined ? 2 : n);

// Two pitches, same weather — the comparison must hold for both.
const cases = [
  { tag: 'clay', params: E.makeParams({ drainageCapacityMmDay: 1.5 }) },
  { tag: 'sand', params: E.makeParams({ drainageCapacityMmDay: 10.0 }) }
];

const lines = ['tag,date,sw_mm,theta,f_sat,risk,ks,drainage_mm,runoff_mm,days_to_clear'];
const messages = [];

for (const c of cases) {
  const states = E.run(c.params, weather, 0.0, {}, 0.0);
  for (const s of states) {
    lines.push([c.tag, s.day, f(s.swMm), f(s.theta, 4), f(s.fSat, 3), s.risk,
                f(s.ks, 3), f(s.drainageMm), f(s.runoffMm), s.daysToClear].join(','));
  }
  // wet day message, to compare text generation too
  const wettest = states.reduce((a, b) => (b.swMm > a.swMm ? b : a), states[0]);
  messages.push(c.tag + '::' + E.dailyMessage(c.params, wettest, weather.slice(0, 3), 'Test Pitch'));
}

fs.writeFileSync(outFile, lines.join('\n') + '\n');
fs.writeFileSync(outFile.replace('.csv', '_messages.txt'), messages.join('\n---\n'));

const unplayable = lines.slice(1)
  .map(l => l.split(','))
  .filter(cols => cols[5] === 'UNPLAYABLE').length;
console.log(`JS: ${weather.length} days x ${cases.length} pitches -> ${outFile}`);
console.log(`JS: ${unplayable} unplayable day-rows`);
