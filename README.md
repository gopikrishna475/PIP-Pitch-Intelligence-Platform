# PIP — Pitch Intelligence Platform

**A deterministic soil water balance that forecasts whether a grass pitch will be playable — and how long until it clears — from free weather data and one optional soil sensor.**

> The pitch is telling you. PIP is the system that listens.

**Status:** working prototype — model, tests and a full-winter backtest are complete and reproducible. Field validation against real called-off fixtures has **not** been done yet; that is the next stage.

**Tests:** 30 passing · **Dependencies:** none (Python standard library only) · **Licence:** MIT

---

## The problem

Across England there are tens of thousands of grass pitches, and almost all of them are looked after by volunteers. When the surface is wet, the groundsman walks out, prods it with a fork, looks at the forecast, and decides.

He has no data on the pitch. And when he asks a funder for drainage money, he has no evidence — no record of how many days the pitch actually lost, or why.

This is not primarily a drainage problem. It is an information problem.

## What this repository is

The **engine**: a signed root-zone water balance following FAO-56, in two cross-validated implementations, with the test suite and the winter backtest data behind every number quoted here.

It is deliberately not a dashboard, not a mobile app, and not machine learning. See [Why not machine learning](#why-not-machine-learning).

---

## How it works

```
  Weather API                    Soil sensor (optional)
  rainfall, ET0                  volumetric moisture
        |                                |
        +---------------+----------------+
                        |
                        v
            FAO-56 water balance
            signed root-zone store
            (+ waterlogging / - drought)
                        |
                        v
        risk level · water above field capacity
        · days until the pitch clears
                        |
                        v
              WhatsApp message
        (delivery layer — see apps-script/)
```

The sensor is a **commercial, off-the-shelf** probe. Readings arrive through the sensor vendor's own platform into a Google Sheet; this project does not build or claim the hardware or its telemetry chain. The model runs on **weather alone** and blends sensor readings when they are present.

## Example output

Real engine output for a heavy clay pitch on the wettest modelled day of the 2025/26 winter:

```
PIP — Test Pitch
Fri 14 Nov

RISK: UNPLAYABLE
Water above field capacity: 24.5 mm (94% of drainable pore space).
Drained today: 1.5 mm.
Estimated days to clear at current drainage rate: 11.
Next 3 days rain: 18.0 mm.

Expect standing water and a surface that will not recover quickly.

Reply PLAYED or OFF after the next match — it improves the forecast.
```

---

## Evidence

Same weather. Same location. Same dates. Only the soil changes:

| Surface | Drainage capacity | LOW | WATCH | HIGH | UNPLAYABLE |
|---|---|---|---|---|---|
| Heavy clay | 1.5 mm/day | 73 | 21 | 27 | **61** |
| Free-draining sand | 10 mm/day | 181 | 1 | 0 | **0** |

182 days, 1 Oct 2025 – 31 Mar 2026, Open-Meteo reanalysis weather.

Now hold the soil fixed and vary drainage alone:

| Drainage capacity | Days unplayable |
|---|---|
| 1.5 mm/day | 61 days (33% of the season) |
| 3 mm/day | 6 days |
| 10 mm/day | 0 days |

**One parameter decides whether a pitch loses a third of its season or none of it — and almost nobody measures it.** That number is what a drainage grant turns on, and it is what PIP produces for a pitch it has never visited.

## Reproduce it

```bash
# 30 automated tests, no dependencies
python3 -m unittest discover -s tests -v

# JavaScript port against the Python reference, day by day
node tools/verify_parity.js data/backtest_winter_2025/weather.csv /tmp/out.csv
```

The parity check runs both implementations over the identical weather series and compares every daily output. It reports `182 days x 2 pitches` and, for clay, **61 unplayable day-rows** — the same figure the Python backtest produces.

---

## Repository layout

```
model/water_balance.py      FAO-56 water balance — reference implementation
model/water_balance.js      JavaScript port, cross-validated against Python
tests/test_water_balance.py 30 automated tests, including mass balance
tools/verify_parity.js      Python vs JavaScript day-by-day comparison
data/backtest_winter_2025/  Reanalysis weather + both backtest outputs
docs/ALGORITHM.md           Design, equations, parameters, known limits
apps-script/                Google Apps Script delivery layer (reference)
examples/alert_example.txt  Verbatim engine output
```

## The model in brief

A single signed store `sw` = water in the root zone relative to field capacity (mm):

```
STORE_CAP = (theta_sat - theta_fc) * 1000 * Zr
TAW       = (theta_fc  - theta_wp) * 1000 * Zr
RAW       = p * TAW
Ks        = clamp((TAW - |sw|) / ((1 - p) * TAW), 0, 1)
ETc       = Ks * Kc * ET0
sw(t+1)   = clamp(sw + P - ETc - runoff - drainage, -TAW, +STORE_CAP)
drainage  = min(drainage_capacity, max(0, sw))
f_sat     = sw / STORE_CAP
```

`sw > 0` is water above field capacity (the waterlogging side). `sw < 0` is a deficit (the drought side). One equation set handles both.

Default risk bands on `f_sat`: **LOW** < 0.35 ≤ **WATCH** < 0.60 ≤ **HIGH** < 0.80 ≤ **UNPLAYABLE**.

Full derivation, parameter table and worked examples: [docs/ALGORITHM.md](docs/ALGORITHM.md).

## Why not machine learning

There is no labelled dataset. "Unplayable" is a judgement a groundsman makes, and the labelled examples number zero. Training a model on that would produce confident-looking output with no basis.

The water balance is deterministic, inspectable, and calibratable from one pitch with a few weeks of sensor data. Prediction can be layered on later, once a pilot has produced real PLAYED/OFF labels. Until then, physics is the honest choice.

## Status

Done and reproducible:
- Signed-store FAO-56 engine, Python and JavaScript
- 30 automated tests, including mass-balance checks
- Full winter backtest, two soil types
- Daily delivery via Google Apps Script → WhatsApp Cloud API
- Commercial soil sensor collecting readings into Google Sheets

Not done:
- Validation against real called-off fixtures
- Threshold calibration from groundsman decisions
- Any measurement of water or cost savings

## Limitations

Stated plainly, because a forecast is only useful if its error is understood:

- **These are model outputs, not field measurements.** Thresholds are informed defaults, not calibrated to actual cancellations.
- **Drainage capacity is the highest-leverage unknown.** It dominates the result and is currently estimated, not measured.
- **One sensor at one depth cannot characterise a whole pitch.** Readings are treated as an input to the physical model, not as truth.
- **Reanalysis weather is a grid estimate,** not a rain gauge on site.
- **The model forecast leads the fixture, it does not fix it.** 61 lost days is a fact about the pitch, not something software repairs.
- **It will not tell you how much to irrigate.** One probe at one depth cannot support that claim, so no such output exists.

## Related work

This sits between three existing worlds and serves none of them directly: agricultural soil-moisture telemetry (instrumented, expensive, aimed at growers), elite sports-turf systems (well funded, installed by contractors), and manual groundskeeping (free, skilled, uninstrumented). The gap is the volunteer-run community pitch.

## Licence

MIT — see [LICENSE](LICENSE). Copyright 2026 Gopikrishna Goud Godishala.

## Contact

**Gopikrishna Goud Godishala** — MSc Data Science, University of Hertfordshire
godishalagopikrishnagoud@gmail.com

Finalist, QBE Foundation × Social Shifters Global Innovation Challenge 2026 (Climate Resilience track).
