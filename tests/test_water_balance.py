"""
Checks for the PIP water balance engine.

These are physics and boundary checks, not "does it run" checks. Each one pins
down a behaviour that a groundsman's trust depends on. Run with:

    python3 test_pip_waterbalance.py
"""

from __future__ import annotations

import math
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "model"))
import unittest
from datetime import date, timedelta

from water_balance import (
    PitchParams, build_sensor_series, calibrate, daily_message,
    days_to_clear, extraterrestrial_radiation, hargreaves_et0, run, step,
)

D0 = date(2026, 1, 1)


def series(rows, start=D0):
    """rows: list of (precip_mm, et0_mm) -> [(date, precip, et0)]"""
    return [(start + timedelta(days=i), p, e) for i, (p, e) in enumerate(rows)]


class TestDerivedCapacities(unittest.TestCase):

    def test_store_and_taw(self):
        p = PitchParams(root_depth_m=0.2, theta_fc=0.32, theta_wp=0.14, theta_sat=0.45)
        self.assertAlmostEqual(p.store_cap_mm, (0.45 - 0.32) * 1000 * 0.2, places=6)
        self.assertAlmostEqual(p.taw_mm, (0.32 - 0.14) * 1000 * 0.2, places=6)

    def test_theta_roundtrip(self):
        p = PitchParams()
        for sw in (-20.0, -5.0, 0.0, 3.0, 18.0):
            self.assertAlmostEqual(p.sw_from_theta(p.theta_from_sw(sw)), sw, places=6)

    def test_rejects_inconsistent_soil(self):
        with self.assertRaises(ValueError):
            PitchParams(theta_fc=0.40, theta_wp=0.20, theta_sat=0.35)
        with self.assertRaises(ValueError):
            PitchParams(drainage_capacity_mm_day=0)


class TestDrySide(unittest.TestCase):

    def test_no_rain_dries_and_settles_at_wilting_point(self):
        p = PitchParams(root_depth_m=0.2, drainage_capacity_mm_day=6.0)
        states = run(p, series([(0.0, 5.0)] * 40))
        final = states[-1].sw_mm
        self.assertLess(final, 0)
        self.assertGreaterEqual(final, -p.taw_mm - 1e-9,
                                "the store must never fall below wilting point")
        self.assertLess(abs(final + p.taw_mm), 0.5,
                        "a long dry spell should approach permanent wilting point")
        # Ks approaches zero asymptotically, so "no water" means effectively zero.
        self.assertLess(states[-1].ks, 1e-4,
                        "with no water left the grass cannot transpire")

    def test_deficit_is_reported_as_zero_saturation(self):
        p = PitchParams()
        s = run(p, series([(0.0, 4.0)] * 10))[-1]
        self.assertEqual(s.f_sat, 0.0)
        self.assertEqual(s.risk, "LOW")

    def test_stress_coefficient_throttles_transpiration(self):
        p = PitchParams()
        self.assertEqual(p.stress_coefficient(0.0), 1.0)
        self.assertEqual(p.stress_coefficient(p.raw_mm * 0.5), 1.0)
        self.assertEqual(p.stress_coefficient(p.taw_mm), 0.0)
        mid = p.stress_coefficient((p.raw_mm + p.taw_mm) / 2)
        self.assertTrue(0.0 < mid < 1.0)
        # and it is monotonic in depletion
        vals = [p.stress_coefficient(d) for d in
                (0, p.raw_mm, p.raw_mm + 5, p.taw_mm - 1, p.taw_mm)]
        self.assertEqual(vals, sorted(vals, reverse=True))

    def test_summer_dries_faster_than_winter(self):
        p = PitchParams()
        summer = run(p, series([(0.2, 4.5)] * 14))[-1]
        winter = run(p, series([(0.2, 0.4)] * 14))[-1]
        self.assertLess(summer.sw_mm, winter.sw_mm)


class TestWetSide(unittest.TestCase):

    def test_drainage_is_capped_at_pitch_capacity(self):
        p = PitchParams(drainage_capacity_mm_day=2.0, kc=0.0)
        sw, diag = step(p, sw_prev=10.0, precip_mm=0.0, et0_mm=0.0)
        self.assertAlmostEqual(diag["drainage"], 2.0, places=9)
        self.assertAlmostEqual(sw, 8.0, places=9)

    def test_store_cannot_exceed_saturation_and_excess_becomes_runoff(self):
        p = PitchParams(root_depth_m=0.2, theta_fc=0.32, theta_sat=0.45,
                        drainage_capacity_mm_day=1.0, kc=0.0)
        sw, diag = step(p, sw_prev=0.0, precip_mm=500.0, et0_mm=0.0)
        self.assertLessEqual(sw, p.store_cap_mm + 1e-9)
        self.assertGreater(diag["runoff"], 0.0, "extreme rain must run off, not store")

    def test_heavy_rain_on_clay_goes_unplayable(self):
        p = PitchParams(drainage_capacity_mm_day=1.5)
        s = run(p, series([(30.0, 0.3)]))[0]
        self.assertEqual(s.risk, "UNPLAYABLE")
        self.assertGreater(s.f_sat, 0.8)

    def test_well_drained_pitch_copes_better_with_the_same_rain(self):
        """30 mm is a lot of rain; even a good pitch is soft the next morning.
        What must hold is that drainage capacity changes the outcome — and that
        the better pitch recovers first."""
        clay = PitchParams(drainage_capacity_mm_day=1.5)
        sand = PitchParams(drainage_capacity_mm_day=16.0)
        w = series([(30.0, 0.3)] + [(0.0, 0.3)] * 3)

        clay_states, sand_states = run(clay, w), run(sand, w)

        self.assertEqual(clay_states[0].risk, "UNPLAYABLE")
        self.assertLess(sand_states[0].f_sat, clay_states[0].f_sat)
        self.assertLess(sand_states[0].days_to_clear, clay_states[0].days_to_clear)
        self.assertEqual(sand_states[-1].risk, "LOW",
                         "the well-drained pitch should be clear after 3 dry days")
        self.assertNotEqual(clay_states[-1].risk, "LOW",
                            "the clay pitch should still be wet after 3 dry days")

    def test_wet_spell_accumulates_more_than_single_day(self):
        p = PitchParams(drainage_capacity_mm_day=1.5)
        one = run(p, series([(15.0, 0.2), (0.0, 0.2)]))[-1]
        spread = run(p, series([(7.5, 0.2), (7.5, 0.2)]))[-1]
        self.assertGreater(one.sw_mm, spread.sw_mm,
                           "concentrated rain should leave the ground wetter")

    def test_risk_ordering_is_monotonic(self):
        p = PitchParams()
        levels = [p.risk(sw) for sw in
                  (0.0, 2.0, 5.0, 10.0, 15.0, 20.0, 26.0, 40.0)]
        order = {"LOW": 0, "WATCH": 1, "HIGH": 2, "UNPLAYABLE": 3}
        self.assertEqual([order[x] for x in levels],
                         sorted(order[x] for x in levels))


class TestRecovery(unittest.TestCase):

    def test_days_to_clear_is_length_of_remaining_wet_spell(self):
        p = PitchParams(drainage_capacity_mm_day=2.0, f_sat_watch=0.35)
        states = run(p, series([(20.0, 0.2)] + [(0.0, 0.2)] * 20))
        self.assertGreater(states[0].days_to_clear, 0)
        # after the excess has gone, the count returns to zero
        self.assertEqual(states[-1].days_to_clear, 0)
        # and it is non-increasing through the dry spell
        clears = [s.days_to_clear for s in states
                  if s.sw_mm > 0]
        self.assertEqual(clears, sorted(clears, reverse=True))

    def test_faster_drainage_clears_sooner(self):
        w = series([(20.0, 0.2)] + [(0.0, 0.2)] * 20)
        slow = days_to_clear(PitchParams(drainage_capacity_mm_day=1.0), 18.0)
        fast = days_to_clear(PitchParams(drainage_capacity_mm_day=8.0), 18.0)
        self.assertGreater(slow, fast)

    def test_forecast_rain_delays_recovery(self):
        p = PitchParams(drainage_capacity_mm_day=2.0)
        dry = [(D0 + timedelta(days=i), 0.0, 0.3) for i in range(1, 10)]
        wet = [(D0 + timedelta(days=i), 12.0, 0.3) for i in range(1, 10)]
        self.assertGreater(days_to_clear(p, 15.0, wet),
                           days_to_clear(p, 15.0, dry),
                           "more rain forecast must not shorten the wet spell")


class TestSensorsAndCalibration(unittest.TestCase):

    def test_sensor_theta_maps_into_store(self):
        p = PitchParams(root_depth_m=0.2, theta_fc=0.32)
        self.assertAlmostEqual(p.sw_from_theta(0.42), 0.10 * 1000 * 0.2, places=6)
        self.assertLess(p.sw_from_theta(0.30), 0.0)

    def test_build_sensor_series_parses_rows(self):
        rows = [{"date": "2026-01-05", "theta": "0.381"},
                {"date": "2026-01-06", "theta": "0.402"}]
        out = build_sensor_series(rows)
        self.assertEqual(len(out), 2)
        self.assertAlmostEqual(out[date(2026, 1, 5)], 0.381, places=6)

    def test_assimilation_pulls_model_toward_sensor(self):
        p = PitchParams(drainage_capacity_mm_day=1.5)
        w = series([(0.0, 0.2)] * 5)
        sensors = {D0 + timedelta(days=4): 0.44}
        free = run(p, w, sensors=sensors, assimilate_weight=0.0)[-1]
        pulled = run(p, w, sensors=sensors, assimilate_weight=1.0)[-1]
        self.assertGreater(pulled.sw_mm, free.sw_mm,
                           "a wet sensor reading must raise the store")

    def test_calibration_recovers_a_known_drainage_capacity(self):
        """Synthetic ground truth: generate readings from a known pitch, then
        check the grid search finds it back."""
        truth = PitchParams(drainage_capacity_mm_day=3.0, theta_fc=0.30,
                            kc=0.95, root_depth_m=0.2)
        weather = series([(p, e) for p, e in
                          [(0, .5), (12, .4), (0, .6), (3, .5), (0, .8),
                           (18, .3), (4, .4), (0, .6), (0, .9), (9, .4),
                           (2, .5), (0, .7), (6, .4), (0, .8), (1, .6),
                           (0, .9), (14, .3), (5, .5), (0, .7), (0, .8)]] * 3)
        observed = {s.day: s.theta for s in run(truth, weather)}

        best, rmse, table = calibrate(
            PitchParams(drainage_capacity_mm_day=1.0, theta_fc=0.36),
            weather, observed)

        self.assertEqual(best.theta_fc, 0.30, "should recover the true theta_fc")
        self.assertLess(rmse, 0.5, f"rmse {rmse} pp is too high")
        self.assertEqual(table[0]["rmse_pp"], min(r["rmse_pp"] for r in table))

    def test_calibration_needs_observations(self):
        with self.assertRaises(ValueError):
            calibrate(PitchParams(), series([(1.0, 1.0)]), {})


class TestWeatherHelpers(unittest.TestCase):

    def test_extraterrestrial_radiation_peaks_in_summer(self):
        summer = extraterrestrial_radiation(51.755, 172)
        winter = extraterrestrial_radiation(51.755, 355)
        self.assertGreater(summer, winter)
        self.assertGreater(winter, 0.0)

    def test_hargreaves_is_non_negative_and_larger_when_warmer(self):
        cold = hargreaves_et0(-2.0, 3.0, date(2026, 1, 10))
        warm = hargreaves_et0(12.0, 24.0, date(2026, 7, 10))
        self.assertGreaterEqual(cold, 0.0)
        self.assertGreater(warm, cold)

    def test_hargreaves_handles_missing_temperature(self):
        self.assertEqual(hargreaves_et0(None, None, D0), 0.0)


class TestMessaging(unittest.TestCase):

    def test_message_names_the_risk_and_the_reason(self):
        p = PitchParams(drainage_capacity_mm_day=1.5)
        s = run(p, series([(25.0, 0.3)]))[0]
        msg = daily_message(p, s, pitch_name="Test Pitch")
        self.assertIn("PIP — Test Pitch", msg)
        self.assertIn("RISK: UNPLAYABLE", msg)
        self.assertIn("mm", msg)
        self.assertGreater(len(msg.splitlines()), 4)

    def test_message_is_short_enough_for_whatsapp_reading(self):
        p = PitchParams()
        s = run(p, series([(5.0, 1.0)]))[0]
        msg = daily_message(p, s)
        self.assertLess(len(msg.splitlines()), 15,
                        "the whole point is that it gets read on a phone")


class TestMassBalance(unittest.TestCase):
    """The single most important property of a water balance: water is neither
    created nor destroyed. If this drifts, every number downstream is wrong."""

    def _residual(self, params, weather, sw0=0.0):
        states = run(params, weather, sw0=sw0)
        p = sum(s.precip_mm for s in states)
        etc = sum(s.etc_mm for s in states)
        drained = sum(s.drainage_mm for s in states)
        runoff = sum(s.runoff_mm for s in states)
        expected_change = p - etc - drained - runoff
        actual_change = states[-1].sw_mm - sw0
        return expected_change - actual_change

    def test_etc_is_kc_times_et0(self):
        p = PitchParams(kc=0.8)
        s = run(p, series([(0.0, 5.0)]))[0]
        self.assertAlmostEqual(s.etc_mm, 4.0, places=9)
        self.assertAlmostEqual(s.et0_mm, 5.0, places=9)

    def test_closes_on_a_wet_winter(self):
        weather = series([(p, e) for p, e in
                          [(8, .3), (0, .5), (14, .2), (2, .6), (0, .4),
                           (21, .2), (5, .5), (0, .7), (11, .3), (0, .6)]] * 12)
        for dc in (0.5, 1.5, 4.0, 12.0, 30.0):
            r = self._residual(PitchParams(drainage_capacity_mm_day=dc), weather)
            self.assertAlmostEqual(r, 0.0, places=6,
                                   msg=f"drainage={dc} mm/day leaks water")

    def test_closes_on_a_long_drought(self):
        weather = series([(0.0, 6.0)] * 60)
        r = self._residual(PitchParams(), weather)
        self.assertAlmostEqual(r, 0.0, places=6)

    def test_closes_with_irrigation_and_extreme_rain(self):
        weather = series([(0.0, 2.0), (120.0, 0.1), (0.0, 3.0), (60.0, 0.2)] * 5)
        for dc in (1.0, 8.0):
            states = run(PitchParams(drainage_capacity_mm_day=dc), weather,
                         irrigation=2.0)
            p = sum(s.precip_mm for s in states) + 2.0 * len(states)
            etc = sum(s.etc_mm for s in states)
            drained = sum(s.drainage_mm for s in states)
            runoff = sum(s.runoff_mm for s in states)
            self.assertAlmostEqual(p - etc - drained - runoff,
                                   states[-1].sw_mm, places=6)


def run_all(verbose: bool = False) -> bool:
    suite = unittest.TestLoader().loadTestsFromModule(sys.modules[__name__])
    result = unittest.TextTestRunner(verbosity=2 if verbose else 1).run(suite)
    return result.wasSuccessful()


if __name__ == "__main__":
    raise SystemExit(0 if run_all(verbose=True) else 1)
