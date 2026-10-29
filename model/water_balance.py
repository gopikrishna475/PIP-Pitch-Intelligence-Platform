"""
PIP — Pitch water balance engine
================================

Turns weather data (and, once calibrated, sensor readings) into a playability
risk forecast for a single grass pitch.

WHY NOT MACHINE LEARNING
------------------------
There is no labelled data yet. "Unplayable" is a judgement a groundsman makes,
and we have zero labelled examples. A water balance is deterministic, inspectable
and can be calibrated on ONE pitch with a few weeks of sensor data. Prediction
comes later, on top of this, once the pilot has produced labels.

THE MODEL
---------
A single signed root-zone water store:

    sw = water in the root zone relative to FIELD CAPACITY  (mm)
       sw > 0  ->  water above field capacity, draining away   (WATERLOGGING side)
       sw < 0  ->  soil moisture deficit, drying out           (DROUGHT side)

Daily step:
    sw = sw_prev + precip + irrigation - ETc
    ETc = Kc * ET0                       (FAO-56 crop evapotranspiration)
    if sw > 0:  drain = min(sw, drainage_capacity_mm_day); sw -= drain
    sw is floored at -TAW (permanent wilting point) and capped at +STORE_CAP
    (anything beyond STORE_CAP is surface ponding / runoff)

This dual-sided store matters. The standard FAO-56 irrigation balance models
only the DRYING side (depletion reaching zero == irrigate now). Winter
waterlogging on a community pitch is the OTHER side: water arriving faster than
the pitch can drain. Modelling only depletion will never flag a waterlogged
pitch, which is the whole problem we are solving.

Pure Python standard library only, so this runs anywhere Python runs — no
numpy, no pandas, no install step.

Usage
-----
  python3 pip_waterbalance.py backtest  --lat 51.755 --lon -0.336 \
      --start 2025-10-01 --end 2026-03-31 --out winter.csv
  python3 pip_waterbalance.py forecast  --lat 51.755 --lon -0.336
  python3 pip_waterbalance.py selftest
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import sys
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field, replace
from datetime import date, timedelta
from typing import Iterable, Optional, Sequence

ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive"
FORECAST_URL = "https://api.open-meteo.com/v1/forecast"


# ---------------------------------------------------------------------------
# Parameters
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class PitchParams:
    """Everything that is specific to one pitch.

    The first six values are soil/plant physics with published default ranges.
    `drainage_capacity_mm_day` is the one that actually decides whether a pitch
    waterlogs, and it varies enormously between pitches. It is the primary
    calibration target.
    """

    root_depth_m: float = 0.20        # m   — sports turf root zone, 0.10-0.30
    theta_fc: float = 0.32            # m3/m3 — field capacity (loam 0.28-0.36)
    theta_wp: float = 0.14            # m3/m3 — wilting point (loam 0.10-0.16)
    theta_sat: float = 0.45           # m3/m3 — saturation (loam 0.43-0.50)
    kc: float = 0.95                  # -   — FAO-56 grass crop coefficient
    p_depletion: float = 0.55         # -   — FAO-56 depletion fraction (grass/turf)
    drainage_capacity_mm_day: float = 1.5   # mm/day — POORLY DRAINED CLAY default

    # Risk thresholds, expressed as a fraction of drainable pore space filled.
    # These are literature-informed DEFAULTS, not calibrated. Calibrating them
    # against a groundsman's real "it was unplayable" calls is the single most
    # valuable output of the pilot.
    f_sat_watch: float = 0.35
    f_sat_risk: float = 0.60
    f_sat_unplayable: float = 0.80

    def __post_init__(self) -> None:
        if not (self.theta_wp < self.theta_fc < self.theta_sat):
            raise ValueError("require theta_wp < theta_fc < theta_sat")
        if self.root_depth_m <= 0:
            raise ValueError("root_depth_m must be > 0")
        if self.drainage_capacity_mm_day <= 0:
            raise ValueError("drainage_capacity_mm_day must be > 0")

    # -- derived capacities ------------------------------------------------
    @property
    def store_cap_mm(self) -> float:
        """Drainable water held between field capacity and saturation (mm)."""
        return (self.theta_sat - self.theta_fc) * 1000.0 * self.root_depth_m

    @property
    def taw_mm(self) -> float:
        """Total available water between field capacity and wilting point (mm)."""
        return (self.theta_fc - self.theta_wp) * 1000.0 * self.root_depth_m

    @property
    def raw_mm(self) -> float:
        """Readily available water: depletion allowed before the grass is
        stressed (FAO-56)."""
        return self.p_depletion * self.taw_mm

    def stress_coefficient(self, depletion_mm: float) -> float:
        """FAO-56 Ks — throttles transpiration as the soil dries.

        Without this, the model happily evaporates water the soil does not
        contain, which drives the store below wilting point and breaks mass
        balance. Ks = 1 while the crop is unstressed, then falls linearly to 0
        at permanent wilting point.
        """
        dr = max(0.0, depletion_mm)
        if dr <= self.raw_mm:
            return 1.0
        if dr >= self.taw_mm:
            return 0.0
        return (self.taw_mm - dr) / (self.taw_mm - self.raw_mm)

    def theta_from_sw(self, sw: float) -> float:
        """Volumetric water content implied by a store value (m3/m3)."""
        theta = self.theta_fc + sw / (1000.0 * self.root_depth_m)
        return min(self.theta_sat, max(self.theta_wp, theta))

    def sw_from_theta(self, theta: float) -> float:
        """Inverse of theta_from_sw — how a SENSOR reading enters the model."""
        return (theta - self.theta_fc) * 1000.0 * self.root_depth_m

    def f_sat(self, sw: float) -> float:
        """Fraction of drainable pore space currently filled, 0..1."""
        if sw <= 0:
            return 0.0
        return min(1.0, sw / self.store_cap_mm)

    def risk(self, sw: float) -> str:
        f = self.f_sat(sw)
        if f >= self.f_sat_unplayable:
            return "UNPLAYABLE"
        if f >= self.f_sat_risk:
            return "HIGH"
        if f >= self.f_sat_watch:
            return "WATCH"
        return "LOW"


# ---------------------------------------------------------------------------
# States
# ---------------------------------------------------------------------------

@dataclass
class DayState:
    day: date
    precip_mm: float
    et0_mm: float
    sw_mm: float                     # store AFTER this day's drainage
    theta: float
    f_sat: float
    risk: str
    etc_mm: float = 0.0              # Ks * Kc * ET0, the water actually lost
    ks: float = 1.0                  # FAO-56 water stress coefficient
    sw_at_start_mm: float = 0.0      # store BEFORE this day's inputs
    drainage_mm: float = 0.0
    runoff_mm: float = 0.0
    days_to_clear: int = 0           # days for the excess to drain away
    sensor_theta: Optional[float] = None


# ---------------------------------------------------------------------------
# Core engine
# ---------------------------------------------------------------------------

def step(params: PitchParams, sw_prev: float, precip_mm: float,
         et0_mm: float, irrigation_mm: float = 0.0) -> tuple[float, dict]:
    """Advance the root-zone store by one day.

    Returns (sw_after_drainage, diagnostics).
    """
    # Actual ET is limited by the water available (FAO-56 Ks).
    ks = params.stress_coefficient(-sw_prev if sw_prev < 0 else 0.0)
    etc = ks * params.kc * et0_mm
    net = precip_mm + irrigation_mm - etc

    sw = sw_prev + net

    # Cap at saturation: further water ponds or runs off rather than storing.
    runoff = 0.0
    if sw > params.store_cap_mm:
        runoff = sw - params.store_cap_mm
        sw = params.store_cap_mm

    # Drain only when there is water above field capacity.
    drainage = 0.0
    if sw > 0.0:
        drainage = min(sw, params.drainage_capacity_mm_day)
        sw -= drainage

    # Floor at permanent wilting point.
    if sw < -params.taw_mm:
        sw = -params.taw_mm

    return sw, {"etc": etc, "net": net, "drainage": drainage, "runoff": runoff,
                "ks": ks}


def run(params: PitchParams, weather: Sequence[tuple[date, float, float]],
        sw0: float = 0.0, irrigation: float = 0.0,
        sensors: Optional[dict[date, float]] = None,
        assimilate_weight: float = 0.0) -> list[DayState]:
    """Run the balance across a weather series.

    weather : sequence of (day, precip_mm, et0_mm)
    sensors : optional {day: observed_theta}. When present and
              assimilate_weight > 0, the model store is nudged toward the
              sensor-implied store each day. assimilate_weight=0 ignores them
              (so you can measure raw model error, as the build assessment asks).
    """
    sensors = sensors or {}
    out: list[DayState] = []
    sw = sw0

    for i, (day, precip, et0) in enumerate(weather):
        sw_before = sw
        sw, diag = step(params, sw, precip, et0, irrigation)

        obs_theta = sensors.get(day)
        if obs_theta is not None and assimilate_weight > 0.0:
            sw_obs = params.sw_from_theta(obs_theta)
            sw_obs = min(params.store_cap_mm, max(-params.taw_mm, sw_obs))
            w = min(1.0, max(0.0, assimilate_weight))
            sw = (1.0 - w) * sw + w * sw_obs

        state = DayState(
            day=day,
            precip_mm=precip,
            et0_mm=et0,
            sw_mm=sw,
            theta=params.theta_from_sw(sw),
            f_sat=params.f_sat(sw),
            risk=params.risk(sw),
            etc_mm=diag["etc"],
            ks=diag["ks"],
            sw_at_start_mm=sw_before,
            drainage_mm=diag["drainage"],
            runoff_mm=diag["runoff"],
            days_to_clear=days_to_clear(params, sw),
            sensor_theta=obs_theta,
        )
        out.append(state)

    return out


def days_to_clear(params: PitchParams, sw: float,
                  forecast: Sequence[tuple[date, float, float]] = ()) -> int:
    """Days until the excess drains below the WATCH threshold.

    With no forecast this is simply the current excess divided by drainage
    capacity. With a forecast it continues draining while accounting for rain
    that is still to arrive, which is what makes the number honest after a wet
    spell.
    """
    target = params.f_sat_watch * params.store_cap_mm
    if sw <= target:
        return 0

    sim = sw
    days = 0
    for _day, precip, et0 in list(forecast) + [(None, 0.0, 0.0)] * 60:
        sim, _ = step(params, sim, precip, et0)
        days += 1
        if sim <= target:
            return days
        if days > 120:
            break
    # Fall back to a closed form so the number is always present.
    return min(days, math.ceil(max(0.0, sw) / params.drainage_capacity_mm_day))


def risk_timeline(params: PitchParams, states: Sequence[DayState]) -> list[tuple[date, str]]:
    return [(s.day, s.risk) for s in states]


# ---------------------------------------------------------------------------
# Calibration
# ---------------------------------------------------------------------------

def calibrate(params: PitchParams,
              weather: Sequence[tuple[date, float, float]],
              sensors: dict[date, float],
              drainage_grid: Optional[Iterable[float]] = None,
              theta_fc_grid: Optional[Iterable[float]] = None
              ) -> tuple[PitchParams, float, list[dict]]:
    """Grid-search the two parameters that dominate behaviour.

    Objective: RMSE between modelled and observed volumetric water content, in
    percentage points. Deliberately a coarse grid rather than an optimiser —
    with a few weeks of data, a fine-tuned fit is false precision, and a grid
    result is inspectable by a human.

    Returns (best_params, best_rmse_pct, full_result_table).
    """
    if not sensors:
        raise ValueError("calibration needs at least one sensor observation")

    drainage_grid = list(drainage_grid or [0.25, 0.5, 0.75, 1.0, 1.5, 2.0, 3.0,
                                          4.0, 6.0, 8.0, 12.0, 16.0, 24.0])
    theta_fc_grid = list(theta_fc_grid or
                         [round(params.theta_wp + 0.04 + 0.02 * i, 3) for i in range(0, 9)])

    results: list[dict] = []
    best: Optional[tuple[float, PitchParams]] = None

    for dc in drainage_grid:
        for fc in theta_fc_grid:
            if not (params.theta_wp < fc < params.theta_sat):
                continue
            cand = replace(params, drainage_capacity_mm_day=dc, theta_fc=fc)
            states = run(cand, weather, sw0=0.0, sensors=sensors, assimilate_weight=0.0)
            errs = []
            for s in states:
                if s.day in sensors:
                    errs.append((s.theta - sensors[s.day]) * 100.0)
            if not errs:
                continue
            rmse = math.sqrt(sum(e * e for e in errs) / len(errs))
            bias = sum(errs) / len(errs)
            results.append({"drainage_capacity_mm_day": dc, "theta_fc": fc,
                            "rmse_pp": round(rmse, 4), "bias_pp": round(bias, 4),
                            "n": len(errs)})
            if best is None or rmse < best[0]:
                best = (rmse, cand)

    if best is None:
        raise ValueError("no candidate could be scored — check the sensor dates "
                         "overlap the weather series")

    results.sort(key=lambda r: r["rmse_pp"])
    return best[1], best[0], results


def build_sensor_series(rows: Iterable[dict],
                        theta_key: str = "theta",
                        date_key: str = "date") -> dict[date, float]:
    """Turn CSV-style rows ({'date': '2026-01-05', 'theta': 0.38}) into the
    {date: theta} mapping the engine expects."""
    out: dict[date, float] = {}
    for r in rows:
        d = r[date_key]
        out[d if isinstance(d, date) else date.fromisoformat(str(d)[:10])] = float(r[theta_key])
    return out


# ---------------------------------------------------------------------------
# Messaging
# ---------------------------------------------------------------------------

_ADVICE = {
    "UNPLAYABLE": "Expect standing water and a surface that will not recover quickly.",
    "HIGH":       "Surface is close to holding water. Protect it if you can.",
    "WATCH":      "Ground is getting soft. Worth checking before Saturday.",
    "LOW":        "No waterlogging concern at current conditions.",
}


def daily_message(params: PitchParams, state: DayState,
                  forecast: Sequence[tuple[date, float, float]] = (),
                  pitch_name: str = "pitch") -> str:
    """One WhatsApp message: what is happening, what to do, why."""
    rain_3d = sum(p for _d, p, _e in list(forecast)[:3])
    lines = [
        f"PIP — {pitch_name}",
        state.day.strftime("%a %d %b"),
        "",
        f"RISK: {state.risk}",
    ]

    excess = max(0.0, state.sw_mm)
    if excess > 0:
        lines.append(f"Water above field capacity: {excess:.1f} mm "
                     f"({state.f_sat * 100:.0f}% of drainable pore space).")
    else:
        lines.append(f"Soil moisture deficit: {abs(state.sw_mm):.1f} mm below field capacity.")

    if state.drainage_mm > 0:
        lines.append(f"Drained today: {state.drainage_mm:.1f} mm.")
    if state.days_to_clear > 0:
        lines.append(f"Estimated days to clear at current drainage rate: {state.days_to_clear}.")

    lines.append(f"Next 3 days rain: {rain_3d:.1f} mm.")

    if state.sensor_theta is not None:
        lines.append(f"Sensor reading: {state.sensor_theta:.3f} m3/m3.")

    lines += ["", _ADVICE[state.risk]]
    lines += ["", "Reply PLAYED or OFF after the next match — it improves the forecast."]
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Weather ingestion
# ---------------------------------------------------------------------------

def _get_json(url: str, params: dict) -> dict:
    query = urllib.parse.urlencode(params)
    full = f"{url}?{query}"
    req = urllib.request.Request(full, headers={"User-Agent": "PIP-waterbalance/0.1"})
    with urllib.request.urlopen(req, timeout=45) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _parse_daily(payload: dict) -> list[tuple[date, float, float]]:
    daily = payload["daily"]
    days = daily["time"]
    precip = daily.get("precipitation_sum", [0.0] * len(days))
    et0 = daily.get("et0_fao_evapotranspiration", [None] * len(days))
    tmax = daily.get("temperature_2m_max", [None] * len(days))
    tmin = daily.get("temperature_2m_min", [None] * len(days))

    out: list[tuple[date, float, float]] = []
    for i, d in enumerate(days):
        p = precip[i] if precip[i] is not None else 0.0
        e = et0[i]
        if e is None:
            # Hargreaves-Samani fallback if the API omits ET0 for a day.
            e = hargreaves_et0(tmin[i], tmax[i], d)
        out.append((date.fromisoformat(d), float(p), float(e)))
    return out


def fetch_archive(lat: float, lon: float, start: str, end: str) -> dict:
    return _get_json(ARCHIVE_URL, {
        "latitude": lat, "longitude": lon,
        "start_date": start, "end_date": end,
        "daily": "precipitation_sum,et0_fao_evapotranspiration,"
                 "temperature_2m_max,temperature_2m_min",
        "timezone": "Europe/London",
    })


def fetch_forecast(lat: float, lon: float, days: int = 7) -> dict:
    return _get_json(FORECAST_URL, {
        "latitude": lat, "longitude": lon,
        "daily": "precipitation_sum,et0_fao_evapotranspiration,"
                 "temperature_2m_max,temperature_2m_min",
        "forecast_days": days,
        "timezone": "Europe/London",
    })


def hargreaves_et0(tmin: Optional[float], tmax: Optional[float], day: date) -> float:
    """Hargreaves-Samani reference ET (mm/day) — fallback only.

    ET0 = 0.0023 * (Tmean + 17.8) * sqrt(Tmax - Tmin) * Ra
    Ra (extraterrestrial radiation) is derived from latitude and day of year.
    """
    if tmin is None or tmax is None:
        return 0.0
    tmean = (tmax + tmin) / 2.0
    trange = max(0.0, tmax - tmin)
    ra = extraterrestrial_radiation(51.755, day.timetuple().tm_yday)   # MJ/m2/day
    return max(0.0, 0.0023 * (tmean + 17.8) * math.sqrt(trange) * ra)


def extraterrestrial_radiation(lat_deg: float, doy: int) -> float:
    """FAO-56 Eq. 21. Returns MJ/m2/day."""
    gsc = 0.0820                      # solar constant MJ/m2/min
    phi = math.radians(lat_deg)
    dr = 1 + 0.033 * math.cos(2 * math.pi * doy / 365)
    delta = 0.409 * math.sin(2 * math.pi * doy / 365 - 1.39)
    ws = math.acos(max(-1.0, min(1.0, -math.tan(phi) * math.tan(delta))))
    return (24 * 60 / math.pi) * gsc * dr * (
        ws * math.sin(phi) * math.sin(delta)
        + math.cos(phi) * math.cos(delta) * math.sin(ws))


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _write_csv(path: str, states: Sequence[DayState]) -> None:
    with open(path, "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["date", "precip_mm", "et0_mm", "etc_mm", "ks", "sw_mm", "theta",
                    "f_sat", "risk", "drainage_mm", "runoff_mm",
                    "days_to_clear", "sensor_theta"])
        for s in states:
            w.writerow([s.day.isoformat(), f"{s.precip_mm:.2f}", f"{s.et0_mm:.2f}",
                        f"{s.etc_mm:.2f}", f"{s.ks:.3f}", f"{s.sw_mm:.2f}",
                        f"{s.theta:.4f}", f"{s.f_sat:.3f}", s.risk,
                        f"{s.drainage_mm:.2f}", f"{s.runoff_mm:.2f}",
                        s.days_to_clear,
                        "" if s.sensor_theta is None else f"{s.sensor_theta:.4f}"])


def _summarise(states: Sequence[DayState], params: PitchParams, label: str) -> None:
    counts: dict[str, int] = {}
    for s in states:
        counts[s.risk] = counts.get(s.risk, 0) + 1
    total = len(states)
    rain = sum(s.precip_mm for s in states)
    etc = sum(s.etc_mm for s in states)
    drained = sum(s.drainage_mm for s in states)
    runoff = sum(s.runoff_mm for s in states)

    print(f"\n=== {label} ===")
    print(f"period            {states[0].day} -> {states[-1].day}  ({total} days)")
    print(f"drainage capacity {params.drainage_capacity_mm_day} mm/day")
    print(f"drainable store   {params.store_cap_mm:.1f} mm  "
          f"(theta_fc {params.theta_fc} -> theta_sat {params.theta_sat})")
    print(f"rainfall          {rain:.1f} mm")
    print(f"ETc (Kc*ET0)      {etc:.1f} mm")
    print(f"drained away      {drained:.1f} mm")
    print(f"runoff / ponding  {runoff:.1f} mm")
    print("risk breakdown:")
    for level in ("UNPLAYABLE", "HIGH", "WATCH", "LOW"):
        n = counts.get(level, 0)
        if n:
            pct = 100.0 * n / total
            print(f"  {level:<11} {n:>3} days  ({pct:>5.1f}%)  "
                  f"{'#' * max(1, round(pct / 2))}")


def cmd_backtest(args: argparse.Namespace) -> int:
    payload = fetch_archive(args.lat, args.lon, args.start, args.end)
    weather = _parse_daily(payload)
    params = _pitch_from_args(args)

    sensors = {}
    if args.sensors:
        with open(args.sensors, newline="") as fh:
            sensors = build_sensor_series(list(csv.DictReader(fh)))

    if args.calibrate and sensors:
        best, rmse, table = calibrate(params, weather, sensors)
        print(f"\n=== CALIBRATION ===")
        print(f"scored {len(table)} parameter combinations against "
              f"{table[0]['n']} sensor days")
        print(f"best  drainage_capacity_mm_day={best.drainage_capacity_mm_day}  "
              f"theta_fc={best.theta_fc}   RMSE={rmse:.2f} pp")
        print("top 5:")
        for r in table[:5]:
            print(f"  dc={r['drainage_capacity_mm_day']:>5} fc={r['theta_fc']:.3f} "
                  f"rmse={r['rmse_pp']:.2f}pp bias={r['bias_pp']:+.2f}pp")
        params = best

    states = run(params, weather, sw0=args.sw0, sensors=sensors,
                 assimilate_weight=args.assimilate)
    _summarise(states, params, "BACKTEST")

    if args.out:
        _write_csv(args.out, states)
        print(f"\nwritten: {args.out}")

    worst = sorted(states, key=lambda s: -s.sw_mm)[:5]
    print("\n5 wettest days:")
    for s in worst:
        print(f"  {s.day}  sw={s.sw_mm:>6.1f}mm  f_sat={s.f_sat:.2f}  {s.risk}")

    if args.message_on:
        target = date.fromisoformat(args.message_on)
        match = [s for s in states if s.day == target]
        if match:
            print("\n" + daily_message(params, match[0],
                                       forecast=[(d, p, e) for d, p, e in weather
                                                 if d > target][:3]))
    return 0


def cmd_forecast(args: argparse.Namespace) -> int:
    params = _pitch_from_args(args)
    hist = fetch_archive(args.lat, args.lon, args.start or _days_ago(45),
                         _yesterday())
    fc = fetch_forecast(args.lat, args.lon, args.days)
    weather = _parse_daily(hist)
    future = _parse_daily(fc)

    # Spin the model up on recent history so today's store is realistic.
    states = run(params, weather, sw0=args.sw0)
    today_store = states[-1].sw_mm if states else args.sw0

    projected = run(params, future, sw0=today_store)
    state = projected[0] if projected else states[-1]
    state.days_to_clear = days_to_clear(params, state.sw_mm, future)
    state.risk = params.risk(state.sw_mm)

    _summarise(states, params, "RECENT HISTORY (spin-up)")
    print("\n=== TODAY ===")
    print(daily_message(params, state, future, args.name))
    return 0


def cmd_selftest(_args: argparse.Namespace) -> int:
    ok = run_selftest()
    return 0 if ok else 1


def _days_ago(n: int) -> str:
    return (date.today() - timedelta(days=n)).isoformat()


def _yesterday() -> str:
    return (date.today() - timedelta(days=1)).isoformat()


def _pitch_from_args(a: argparse.Namespace) -> PitchParams:
    return PitchParams(
        root_depth_m=a.root_depth,
        theta_fc=a.theta_fc,
        theta_wp=a.theta_wp,
        theta_sat=a.theta_sat,
        kc=a.kc,
        drainage_capacity_mm_day=a.drainage,
    )


def _add_pitch_args(p: argparse.ArgumentParser) -> None:
    p.add_argument("--lat", type=float, default=51.755)
    p.add_argument("--lon", type=float, default=-0.336)
    p.add_argument("--name", default="pitch")
    p.add_argument("--root-depth", type=float, default=0.20)
    p.add_argument("--theta-fc", type=float, default=0.32)
    p.add_argument("--theta-wp", type=float, default=0.14)
    p.add_argument("--theta-sat", type=float, default=0.45)
    p.add_argument("--kc", type=float, default=0.95)
    p.add_argument("--drainage", type=float, default=1.5,
                   help="drainage capacity mm/day — the key pitch parameter")
    p.add_argument("--sw0", type=float, default=0.0)
    p.add_argument("--start", default=None)
    p.add_argument("--sensors", default=None,
                   help="CSV with columns date,theta")
    p.add_argument("--assimilate", type=float, default=0.0,
                   help="0 = ignore sensors (measure raw model error)")


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="PIP pitch water balance engine")
    sub = p.add_subparsers(dest="cmd", required=True)

    b = sub.add_parser("backtest", help="run the balance over a past period")
    _add_pitch_args(b)
    b.add_argument("--end", default=_yesterday())
    b.add_argument("--out", default=None)
    b.add_argument("--calibrate", action="store_true")
    b.add_argument("--message-on", default=None)
    b.set_defaults(func=cmd_backtest)

    f = sub.add_parser("forecast", help="spin up on recent history, then project")
    _add_pitch_args(f)
    f.add_argument("--days", type=int, default=7)
    f.set_defaults(func=cmd_forecast)

    s = sub.add_parser("selftest", help="run the built-in checks")
    s.set_defaults(func=cmd_selftest)
    return p


# ---------------------------------------------------------------------------
# Self-test (also exercised by test_pip_waterbalance.py)
# ---------------------------------------------------------------------------

def run_selftest() -> bool:
    from test_pip_waterbalance import run_all
    return run_all(verbose=True)


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except urllib.error.URLError as exc:
        print(f"network error fetching weather: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
