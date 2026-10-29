# PIP pipeline — setup, tools, and the build spec

Everything runs on **Google's servers, free**, on a 06:00 daily trigger. No VPS, no
laptop left on, no service account, no API keys for Sheets — the spreadsheet is natively
accessible from Apps Script, which is exactly why this is the right architecture here.

**Why not GitHub Actions?** Its scheduled workflows are automatically disabled after
60 days of repository inactivity. A daily alert that silently stops mid-winter is worse
than no alert, because people stop trusting it. Apps Script triggers keep running.

---

## 1. What you need

| # | Thing | Cost | Notes |
|---|---|---|---|
| 1 | Google account + Sheet | Free | You already have this |
| 2 | Google Apps Script | Free | Built into Sheets: Extensions → Apps Script |
| 3 | Open-Meteo weather + ET₀ | Free **non-commercial only** | Attribution required (CC BY 4.0) |
| 4 | Meta WhatsApp Cloud API | Per delivered message | Business verification needed for production |
| 5 | Your sensor's own platform | Already in use | Where your readings come from today. Keep using it — there is nothing to rebuild. |
| 6 | Chart.js (dashboard) | Free | Loaded from CDN, already wired in |

That's the whole stack. **Nothing else is required**, and anything else is a distraction
until a pitch is live.

---

## 2. Fix your READINGS sheet first

Your existing sheet works, but three changes make it reliable:

1. **Append-only.** Never overwrite rows. Keep one row per reading, permanently.
2. **Standard headers.** The script auto-detects, but set these explicitly:
   `timestamp | sensor_id | theta | temperature | battery_v`
   - `theta` = volumetric water content **in m³/m³** (0.00–1.00). If your sensor reports
     percent, set `THETA_IS_PERCENT: true` in Code.gs rather than converting by hand.
3. **Store raw and derived separately.** Keep the raw sensor value in READINGS and put
   anything calculated (calibration offsets, corrected values) in a different tab, so a
   bad calibration formula can never destroy your raw data.

**Reject bad readings at the point of entry.** A value outside 0.01–0.60 m³/m³ is a
sensor fault, not a dry pitch. Better to have a gap than to teach the model nonsense.

Timestamps must include time and date, in a real date format — not text.

---

## 3. Install the pipeline

1. Open your spreadsheet → **Extensions → Apps Script**
2. Rename the project to `PIP`
3. Add the engine: **+ → Script**, name it `pip_waterbalance`, and paste the whole of
   `algorithm/pip_waterbalance.js`
4. Open `Code.gs` (the default file) and paste the whole of `pipeline/Code.gs`
5. **+ → HTML**, name it exactly `Dashboard`, and paste `pipeline/Dashboard.html`
6. In `Code.gs`, set `CONFIG.SPREADSHEET_ID` to your sheet's ID — the long string in the
   URL between `/d/` and `/edit`
7. Set your pitch `lat`, `lon`, `name`, and `params.drainageCapacityMmDay`

**Then run these, in this order, from the Apps Script editor:**

| Run | Why | Expect |
|---|---|---|
| `inspectSheet()` | Shows your tabs, headers and guessed column names | View → Logs. Fix `READING_COLUMNS` if the guess is wrong |
| `selftest()` | Verifies the engine ported correctly | All lines start with `PASS` |
| `ensureSheets_()` | Creates STATUS, LOG, OUTCOMES | Three new tabs |
| `runDaily()` | One full run, writing only (TEST_MODE is on) | A message in the log; a new LOG row |
| `setupTriggers()` | Creates the 06:00 and 07:30 triggers | "Daily triggers created" |

For step 4, `dashboard` needs **Deploy → New deployment → Web app**, *Execute as: me*,
*Who has access: anyone*. That URL is the dashboard.

Run things in this order deliberately: `selftest()` before `runDaily()` means you find a
port error in ten seconds instead of diagnosing it from a wrong number in a sheet.

---

## 4. WhatsApp — do this early, it has a lead time

1. Create a Meta Business account and a WhatsApp Business Account
2. Add the WhatsApp product in the Meta developer dashboard and link a phone number
3. **Create a utility template** named `pip_daily_alert` with one body variable
   (`{{1}}` = the message text). Approval typically takes **4–24 hours**
4. Business verification is required for production. **Test numbers have recipient
   limits — check the exact numbers in your Meta dashboard; I could not verify them
   from an authoritative source.**
5. Put the token and `PHONE_NUMBER_ID` into `CONFIG.WHATSAPP`

**The one operational rule that matters:** you can only send free-form text inside a
**24-hour customer service window** — that is, within 24 hours of the customer's last
message. Your 06:00 alert is business-initiated, so outside the window it **must** use the
approved template.

That gives you a design opportunity: the message already asks the groundsman to reply
`PLAYED` or `OFF`. **Their reply both captures your training label and opens a 24-hour
window, which makes the next day's message free.** One action, two benefits — build it
that way rather than treating labels and cost as separate problems.

---

## 5. What the algorithm delivers against what you promised clients

| Promised | Delivered by | Status |
|---|---|---|
| Early warning a pitch is heading to unplayable | Water balance → WhatsApp alert | **Working** |
| Timestamped record of the pitch across the season | `LOG` sheet | **Working** |
| Status view across all pitches | Dashboard web app | **Working** |
| Audit trail (predicted vs actual) | `LOG` + `OUTCOMES` + dashboard | **Working once replies arrive** |
| End-of-season condition report | Dashboard season summary | **Working** |
| "Exact water needed" | Not built — needs per-pitch calibration | **Do not claim yet** |

That last row is the promise you must not make. From one sensor at one depth you cannot
truthfully say "apply 8 mm" until that pitch's field capacity, wilting point and rootzone
depth are known. Directional accuracy is defensible today; absolute volumes are not.

---

## 6. Verification checklist

Run this before you rely on the numbers for a decision:

- [ ] `selftest()` — every line `PASS`, including `mass balance closes`
- [ ] `node verify_port.js` — Python and JavaScript rows identical (already confirmed:
      364/364 rows, messages identical)
- [ ] `python3 test_pip_waterbalance.py` — 30 checks pass
- [ ] LOG has one row per pitch per day, and no gaps
- [ ] Dashboard shows a `staleHours` warning when a sensor goes quiet
- [ ] Send yourself a real WhatsApp and confirm it arrives
- [ ] Trigger `runDaily()` twice in one day — the second must **not** re-send

That last check is the one people skip and regret. It is what stops the groundsman
receiving the same warning forty mornings in a row and muting you.

---

## 7. The build spec (paste this into any AI tool to rebuild or extend)

> Build a daily pitch-waterlogging alert for grass sports pitches, running free on Google
> Apps Script with no external server.
>
> **Data in:** (a) sensor readings from a Google Sheet — timestamp, sensor id, volumetric
> water content in m³/m³; (b) Open-Meteo daily `precipitation_sum` and
> `et0_fao_evapotranspiration` for the pitch coordinates, archive for spin-up and
> forecast for the next 7 days.
>
> **Model:** FAO-56 dual-sided root-zone water balance over a signed store `sw` in mm
> relative to field capacity — positive means waterlogging, negative means deficit. Each
> day: apply `Ks × Kc × ET0` as loss, where `Ks` is the FAO-56 water-stress coefficient;
> cap the store at drainable capacity with excess as runoff; drain at a per-pitch
> `drainageCapacityMmDay` only while the store is positive; floor at permanent wilting
> point. Expose risk levels from the fraction of drainable pore space filled. Mass balance
> must close to machine precision.
>
> **Out:** a WhatsApp message stating risk, mm above field capacity, drainage observed,
> days-to-clear including forecast rain, and the next 3 days' rainfall — plus a
> request for the recipient to reply PLAYED or OFF.
>
> **Behaviour:** run daily at 06:00 local, unattended; send on risk change or while an
> alert level is active, never the same message twice in a day; detect a sensor that has
> gone quiet and raise a fault instead of silently predicting; write one row per pitch per
> day to an append-only log; capture the replies as ground-truth labels.
>
> **Constraints:** pure JavaScript, no third-party runtime dependencies; parameters
> configurable per pitch; all thresholds explicitly marked as uncalibrated defaults until
> real outcomes are collected; never claim a specific millimetre application volume.

---

## 8. Honest gaps

- **Never run against a real pitch.** Every soil parameter is a literature default for a
  loam and the risk thresholds are uncalibrated guesses.
- **The `drainageCapacityMmDay` you set decides the answer.** 1.5 gives 61 unplayable days
  a winter on last year's real weather; 10 gives none. Measure it, then set it.
- **Your visa still governs use.** Building and testing against your own number is fine.
  Sending alerts to a client is trading, which you cannot do until you hold permission
  that allows self-employment. Keep `TEST_MODE: true` until your adviser confirms.
