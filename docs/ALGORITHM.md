# PIP — the algorithm, built and running

**Status: working, tested, and already producing real numbers from real weather.**
Files: `pip_waterbalance.py` (engine + CLI) · `test_pip_waterbalance.py` (30 checks) · this document.

---

## 1. What it is

A **soil water balance** that tracks how much water is sitting in the top 20 cm of a
pitch and turns that into a playability risk. Not machine learning — and that is
deliberate, not a compromise.

There is no labelled data. Nobody has ever recorded "this pitch was unplayable"
alongside a moisture reading for your pitches. Every ML model needs that. A water
balance needs physics, and physics is available today.

## 2. The one design decision that matters

The standard FAO-56 water balance — the one in your build assessment — models the
**drying** side. It tracks how much water the soil has *lost*, and tells you when to
irrigate. Point it at a waterlogged pitch and it will report "no irrigation needed",
which is true and useless.

**Waterlogging is the other side of the same equation.** So the store is signed:

```
sw = water in the root zone relative to field capacity  (mm)

    sw > 0   water sitting above field capacity, draining away   <- WINTERLOGGING
    sw < 0   soil moisture deficit, drying out                   <- DROUGHT
```

One variable, both problems, and the winter problem — your problem — falls out
naturally instead of needing a separate model.

## 3. The daily step

```
Ks  = stress coefficient (FAO-56)          # limits ET when the soil is dry
ETc = Ks * Kc * ET0                        # water actually lost
sw  = sw_previous + rain + irrigation - ETc

if sw >  STORE_CAP:  excess runs off or ponds; sw = STORE_CAP
if sw >  0:          drainage = min(sw, drainage_capacity); sw -= drainage
if sw < -TAW:        sw = -TAW             # permanent wilting point
```

Then, per day:

| Output | Meaning |
|---|---|
| `f_sat` | fraction of drainable pore space filled, 0–1 |
| `risk` | `LOW` / `WATCH` / `HIGH` / `UNPLAYABLE` from `f_sat` |
| `days_to_clear` | how long the excess takes to drain, including forecast rain |
| `ks` | water-stress coefficient — the drought-side signal |

**The parameter that decides everything is `drainage_capacity_mm_day`.** It is how
fast a pitch sheds water, and it varies more between pitches than anything else in
the model. Poorly drained clay might be 1.5 mm/day; a pipe-drained sand pitch 10–16.

## 4. What it found on real data

Run against **actual Open-Meteo reanalysis weather** for Hertfordshire,
1 October 2025 – 31 March 2026 (182 days, 440 mm of rain). Only the drainage
capacity was changed between the two runs.

| | Poorly drained clay (1.5 mm/day) | Pipe-drained (10 mm/day) |
|---|---|---|
| Days `UNPLAYABLE` | **61 (33.5%)** | **0 (0%)** |
| Days `HIGH` or worse | 88 (48.4%) | 0 |
| Days `LOW` | 73 (40.1%) | 181 (99.5%) |
| Drained away | 216.6 mm | 331 mm |
| Lost to runoff / ponding | 96.8 mm | 33 mm |

**Same rain. Same soil. One parameter changed. The result inverts.**

This is the most useful thing the model has told us so far, and it is a real
business finding, not just a technical one:

- **The problem is drainage, not weather.** No amount of forecasting fixes a pitch
  that can only shed 1.5 mm a day through a wet English winter. That is why the
  problem is chronic and why councils cannot solve it with better decisions alone.
- **It explains why the honest product is a warning, not a cure.** PIP tells a
  groundsman on Thursday what Saturday looks like. It cannot drain the pitch.
- **It gives a way to qualify a site before you ever install a sensor.** Pitch
  construction and drainage history will tell you most of what you need.
- **It sharpens the sales conversation.** Pointing at a council's worst-drained
  pitch and showing 61 unplayable days is a far stronger opener than a moisture chart.

## 5. What is honest and what is not

**Real, not invented:**
- Weather inputs are live from the Open-Meteo archive and forecast APIs (free tier,
  CC BY 4.0, attribution required).
- The physics is standard FAO-56. Mass balance closes to **0.000000 mm** in-process
  over the test series.
- 30 checks pass, including water conservation under drought, extreme rain,
  irrigation and five drainage capacities.

**Defaulted, and must be replaced by measurement:**
- `drainage_capacity_mm_day`, `theta_fc`, `theta_wp`, `theta_sat`, `root_depth_m`
  are literature values for a loam. **The plan's own figures are not used here** —
  the only reason they are round numbers is that nobody has measured your pitch.
- The risk thresholds (`f_sat` 0.35 / 0.60 / 0.80) are **not calibrated**. They are
  informed guesses. Calibrating them against a groundsman's real "it was unplayable"
  calls is the single highest-value thing the pilot produces.

So: `61 days unplayable` is **the model's estimate under stated assumptions**, not a
measurement. Say it that way to a council, and say which assumption drives it. That
is what makes the number credible instead of dismissible.

## 6. Calibration — how the sensor earns its place

`calibrate()` grid-searches `drainage_capacity_mm_day` × `theta_fc` and scores each
combination by RMSE against your sensor's readings, then reports bias. A test proves
it recovers a known drainage capacity from synthetic observations generated at
0.30 field capacity and 3.0 mm/day.

**What you must supply: a CSV with columns `date,theta`.** One row per day, `theta`
in m³/m³. Everything else is here.

```bash
python3 pip_waterbalance.py backtest --start 2026-01-01 --end 2026-03-31 \
    --sensors readings.csv --calibrate --out calibrated.csv
```

`assimilate_weight` (0–1) blends the model with the sensor each day. Leave it at
**0** while calibrating so you can see the model's true error first. A model you
cannot measure the error of is not a model.

## 7. Running it

```bash
python3 pip_waterbalance.py backtest --start 2025-10-01 --end 2026-03-31 --out winter.csv
python3 pip_waterbalance.py backtest --drainage 1.5 --message-on 2025-11-14
python3 pip_waterbalance.py forecast --name "Pitch A"      # live, uses today's forecast
python3 test_pip_waterbalance.py                            # 30 checks
```

Pure Python standard library. No numpy, no pandas, no install step — it runs on any
machine with Python 3.8+, including a free Colab notebook or a £4/month VPS.

## 8. The honest gap

**The engine is done. What is missing is not code.**

1. **Your sensor data.** Nothing here has been tested against a real pitch. Until it
   is, every threshold is a guess.
2. **A ground-truth label.** "Unplayable" has to come from a person, not a formula.
   Ask the groundsman to text you when a pitch is called off. Twenty of those, with
   moisture readings, and this becomes genuinely predictive.
3. **A pitch.**

The build assessment said it already: *not code — a pitch, a permission, and a
groundsman's opinion of your message.* Building this was the right use of your time
because it is the thing you can lawfully do on your current visa, and because it
makes you credible the moment a club says yes. It does not replace the club.

## 9. Next three things to build, in order

1. **WhatsApp delivery** of `daily_message()` at 06:00 — the output is already the
   right shape; wire it to Meta's Cloud API once templates are approved.
2. **The 06:00 daily + threshold-crossing alert split**, so quiet days are quiet.
3. **Then** Sentinel-2 NDVI as a slow weekly trend — not before, and never as the
   early-warning layer. The sensor is ahead of the eye; a 10 m pixel under UK cloud
   is not.
