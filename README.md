# Lift Log

An offline-first phone app (PWA) for tracking Stronglifts 5x5, treadmill walks and HIIT sessions.
Results sync to a Google Sheet and `lift-log.json` in `My Drive/06 Interests/Fitness`, where the "Brad's Fitness" Claude project can read them.

## How it fits together

```
Phone (Lift Log PWA)  ──POST──►  Apps Script web app  ──►  "Lift Log" Google Sheet  (Sessions / Sets / State tabs)
  saves every tap locally          (attached to the Sheet)   └► lift-log.json in the same Drive folder
  queues + retries sync
```

## One-time setup

### 1. Create the Sheet and sync script (about 5 minutes, on the PC)

1. In Google Drive, open **My Drive → 06 Interests → Fitness**, then **New → Google Sheets**. Name it **Lift Log**.
2. In the Sheet: **Extensions → Apps Script**. Delete the sample code and paste in everything from `apps-script/Code.gs`.
   From v1.3 the project has four files: also add `Connections.gs`, `HomeAssistant.gs` and `GoogleHealth.gs` (**+ → Script**, same names, without `.gs`). See [Weight and Fitbit sync](#1a-weight-and-fitbit-sync-v13).
3. On line 8, replace `CHANGE-ME` with a long passphrase of your own, e.g. `squat-rack-purple-4417-kettle`. You'll type it into the phone once.
4. Click **Save**. Choose `setup` in the function dropdown and click **Run**. Google will ask for permission. Choose your account, then **Advanced → Go to Lift Log (unsafe) → Allow**. The warning appears because this is your own unverified script.
5. **Deploy → New deployment →** click the gear icon and choose **Web app**:
   - Execute as: **Me**
   - Who has access: **Anyone** (the passphrase is what protects it)
6. Click **Deploy** and copy the **Web app URL** (it ends in `/exec`).

> If you change the script later (e.g. v1.1 added delete support, v1.2 the coach plan, v1.3 weight and Fitbit): paste the new code over the old in each file (keep your passphrase in `SYNC_TOKEN` near the top of `Code.gs`), **Save**, then **Deploy → Manage deployments →** edit (pencil icon) **→ Version: New version → Deploy**. The URL stays the same.

### 1a. Weight and Fitbit sync (v1.3)

This adds the same Apps Script project's sync of your Withings weight (through Home Assistant) and your Fitbit Air data (through the Google Health API).
Secrets go in **Script Properties** only (Apps Script → ⚙ **Project Settings → Script Properties**), never in the code, because the repository is public.

**a. Add the files and the OAuth2 library**
1. In the Apps Script editor, add three script files with **+ → Script**: `Connections`, `HomeAssistant` and `GoogleHealth`. Paste in the matching file from `apps-script/`, and update `Code.gs` too.
2. **Libraries → +**, Script ID `1B7FSrk5Zi6L1rSxxTDgDEUsPzlukDsi4KGuTMorsTQHhGBzBkMun4iDF` → **Look up**. Pick the latest version, keep the identifier **OAuth2**, then **Add**.

**b. Home Assistant (weight and blood pressure)**
1. In Home Assistant: click your name (**Profile**) → **Security** tab → **Long-lived access tokens → Create token**. Name it `Lift Log`, then copy the token. HA only shows it once.
2. Add two Script Properties:
   - `HA_URL`: your Nabu Casa remote URL, e.g. `https://abcdefgh1234.ui.nabu.casa` (no trailing slash needed)
   - `HA_TOKEN`: the token from step 1

   The script reads `sensor.withings_weight`, `sensor.withings_fat_ratio` and `sensor.withings_muscle_mass` (Withings integration).
   For blood pressure it reads `sensor.ecto_8_systolic_blood_pressure` and `sensor.ecto_8_diastolic_blood_pressure` (mmHg), the HA companion app sensors fed from Health Connect / Omron Connect.
   Each reading's time comes from the sensors' `date` attribute, which is when it was measured, not from when HA received it.
   Systolic and diastolic are paired by that time. Nothing else needs setting up: blood pressure uses the same `HA_URL` and `HA_TOKEN`.

**c. Google Health (Fitbit)**
1. Run `setup` once from the editor. Approve the new permissions, which add external requests, email and triggers. The execution log shows **this script's redirect URI**: `https://script.google.com/macros/d/<THIS_SCRIPT_ID>/usercallback`.
   You can also find the Script ID under ⚙ **Project Settings → IDs**.
2. In Google Cloud Console, open the **Meal Planner** project → **APIs & Services → Credentials** → the **Health Test** OAuth client. Under **Authorized redirect URIs**, **Add URI** and paste that redirect URI, then **Save**.
3. Copy the client's **Client ID** and **Client secret** into this script's Script Properties as `GH_CLIENT_ID` and `GH_CLIENT_SECRET`.
   They're the same values your test script keeps in its Script Properties. Use whatever it calls them, e.g. `CLIENT_ID` / `CLIENT_SECRET`.
4. Optional: `ALERT_EMAIL` if alerts should go somewhere other than the Google account that owns the script.
5. Authorise: run `authorizeGoogleHealth` from the editor and open the URL it logs, or use Lift Log → Settings → Connections → **Re-authorise** after deploying.
   Sign in with the Google account that has your Fitbit data, and allow access. The tab says *Authorised. You can close this tab.*, and a catch-up sync starts. The first one backfills from 1 September 2026.

**d. Triggers**: `setup` installs a single hourly trigger (`hourlyTick`) and is safe to re-run. It syncs weight and blood pressure every hour from 5–10am Perth, Fitbit at 7am, and does a catch-up of all three at 9pm.

**e. Deploy** a **New version** of the web app, as in the note above.

**f. Check it**: run `checkSetup` from the editor and read the execution log. It checks each step above with ✓ or ✗ and says how to fix anything missing. It makes a live test call to Home Assistant and the Health API, and never prints secret values.

**Re-authorising**
- Google expires refresh tokens after 7 days while an OAuth app is in **Testing** mode. When a refresh fails, the Google Health row in **Settings → Connections** shows *⚠ Needs re-authorising*, a warning chip appears on Today, and you get one email with a link.
  Tap **Re-authorise** (or the email link), allow access, and the missed days are caught up automatically.
  Publishing the OAuth app to **In production** in the Cloud Console avoids the weekly expiry.
- Home Assistant shows *⚠ Check HA token* if HA rejects the token (create a new one and update `HA_TOKEN`), or if HA has been unreachable for more than 24 hours. HA only keeps about 10 days of history, so a long outage can lose readings.
- Each failure sends one email; nothing more is sent until a sync works again. Every row also has **Sync now**.

### 2. Host the app on GitHub Pages

1. In GitHub Desktop: **File → Add local repository**, pick this `lift-log` folder, and create a repository when prompted. Then **Publish repository**. Untick "Keep this code private", because free GitHub Pages needs a public repository. No secrets are stored in the code: the sync URL and passphrase stay on your phone.
2. On github.com, open the repository and go to **Settings → Pages**. Set Source to **Deploy from a branch**, Branch to **main / (root)**, then **Save**.
3. After a minute the app is live at `https://<your-username>.github.io/lift-log/`.

### 3. Install it on the phone

1. Open the GitHub Pages URL in **Chrome** on your Android phone.
2. Open the **⋮ menu** and choose **Add to Home screen** (or **Install app**).
3. Open Lift Log and go to **Settings**. Paste the **Sync URL**, enter the **Sync token** (your passphrase), and tap **Test connection**. It should say *Connected to "Lift Log"*.

## Using it

- **Today** shows the date, program week and the planned session. Arrows move between days; future days show the plan.
- Tap **Start workout** when you begin (this records the start time for matching Fitbit heart-rate data), then tap each set:
  empty → **✓ easy** (90 s rest) → **✓ hard** (3 min) → **✗ failed** (asks how many reps, 5 min rest).
  On the "how many reps" sheet, **Cancel** (or tapping outside it) completes the cycle back to empty, so a mis-tap is easy to undo.
  Tap a failed set again to change its reps or clear it.
- Tap the **weight** on an exercise to change it for today. Planned and actual weights are both logged.
- **Treadmill walk / HIIT:** tap **Start session** and the app guides you segment by segment (big countdown, current speed, what's next).
  It buzzes and beeps at every change, with a 3-2-1 countdown before each one. HIIT hard intervals turn the screen red.
  Pause and Next segment are there if you need them. When the plan ends, Finish opens with the duration and rounds already filled in.
  If you closed the app mid-session, it carries on from the right point when you reopen it.
- **Finish** asks for Perceived Intensity (1–10), plus optional bodyweight and notes. **Skip session** records a reason.
- **Sessions belong to their day.** If you leave one unfinished, a banner on later days says so. Tap it to go back to that day and finish, skip or discard it.
  It never blocks today's session. For a past day with nothing logged, use **Log it now** or **Mark as skipped**.
- **Edit / Delete** are on every saved session. Deleting also removes it from the Sheet and `lift-log.json`.
- **Coach notes** from the Brad's Fitness project (see `lift-log-plan.json` below) appear at the top of the session screen.
  Treadmill sessions also have a Notes box while you train; whatever you type there is carried into Finish.
- Next session's weights are calculated automatically. Settings → Working weights lets you override one, e.g. after the project agrees a deload.
- **Bodyweight** is pre-filled from this morning's Withings weigh-in when there is one (it says so at Finish), and you can still change it.
- **Settings → Connections** shows the weight, blood pressure and Google Health syncs, with **Sync now** and **Re-authorise**. A warning chip on Today means one needs attention.
  The blood pressure row shows the last reading (e.g. 126/80), when it was taken, and when it last synced. A Home Assistant token problem shows on the weight row, since both use the same token.

## Changing the program

Edit `program.js`, bump `version` (e.g. `SL5x5-v2`) and bump `CACHE` in `sw.js` (e.g. `lift-log-v2`). Commit and push in GitHub Desktop.
The phone picks up the new version the next time the app is opened twice.
Quick switches such as deadlift 1×5, the deadlift increment, micro-plates, HIIT rounds and rest times are in the app's Settings; you don't need to edit code for those.

### Updating the script for "Lift Log Now" (v1.5)

1. In the Lift Log Sheet: **Extensions → Apps Script**, open **Code.gs**, and replace it with the latest `apps-script/Code.gs` from this repo.
   Keep your own `SYNC_TOKEN` value on line 11. Click **Save**.
2. Choose **setupNowDoc** in the function dropdown and click **Run**. Google asks for one new permission (Google Docs):
   **Review permissions** → your account → **Advanced → Go to Lift Log (unsafe) → Allow**. This creates the **Lift Log Now** doc next to the Sheet.
3. **Deploy → Manage deployments →** edit (pencil) **→ Version: New version → Deploy**. The URL stays the same.
4. Open Lift Log on the phone; within a moment the doc fills in. Then add a line to your Claude profile preferences,
   e.g. *"For my training plan, read the Google Doc 'Lift Log Now'."*

## Data written to Drive

| Where | Contents |
|---|---|
| Sheet → **Sessions** | One row per session: type, workout, week, program version, status/skip reason, start/end, duration, RPE, bodyweight, set counts, per-exercise summary, HIIT details, notes, plan_id (the coach plan in force when the session started) |
| Sheet → **Sets** | One row per set: planned/actual weight, target/actual reps, result (done/failed/not_done), effort (easy/hard), time logged |
| Sheet → **State** | Current next working weight and failure streak for each lift |
| `lift-log.json` | Full history in one file, with a description of the fields, for the Claude project |
| Google Doc **Lift Log Now** | Plain-English plan for Claude in chat and voice (its Drive connector reads Docs, not the app's data): the next 8 days by date (planned session, exact weights for the next lifting day, the coach's notes, what's been done), current working weights and the last session. Sent by the app (v1.5) when it changes, and at least once a day it's opened |
| Sheet → **Weight** | One row per Withings weigh-in (via Home Assistant): date, time (Perth), weight_kg, fat_pct, muscle_kg, timestamp (UTC, used to avoid duplicates) |
| `withings-weight.json` | All weigh-ins plus a `daily` series (first reading of each Perth day = the morning weigh-in), with a field description |
| Sheet → **Blood Pressure** | One row per reading (Omron, via Home Assistant): date, time (Perth local, when measured), systolic, diastolic (mmHg), source |
| `blood-pressure.json` | All blood pressure readings with Perth date/time plus the UTC `timestamp` of the measurement (used to avoid duplicates), and a field description. Home Assistant keeps only ~10 days of history, so readings are kept from when they were synced |
| Sheet → **Health** | One row per day from the Fitbit Air: main sleep (start/end, asleep/awake, deep/light/REM minutes, efficiency), resting HR, HRV (RMSSD), respiratory rate, steps, active zone minutes, exercises (auto-detected ones marked) |
| `health-daily.json` | The same days in full, including every exercise (type, times, avg/max HR, active zone minutes, `autoDetected`; duplicate copies of a workout are merged), plus `liftLogSessions`: per-minute heart rate (min/avg/max) for each Lift Log session, keyed by session id. Includes a field description |

Re-syncing or editing a session replaces its rows, so nothing is duplicated. Settings → Data also has CSV exports and a full JSON backup/restore.

### Coach plan: `lift-log-plan.json` (written by the Claude project, read by the app)

The Brad's Fitness project sets next-session targets by writing **`lift-log-plan.json`** in the same Drive folder as the Lift Log Sheet.
It must be a plain JSON file, not a Google Doc. The app fetches it through the sync script (`doGet?action=plan`) when it opens and on every sync.
Settings → Google Drive sync shows when the plan was last updated, plus a **Refresh** link.

```json
{
  "planId": "3f2b9c1e-…",
  "updatedAt": "2026-10-12T09:00:00+08:00",
  "note": "General note, shown on every session",
  "hiit": { "hardMode": "jog", "hardSpeed": 8.0, "hardIncline": 0, "rounds": 8, "note": "…" },
  "walk": { "note": "…" },
  "lifts": { "ohp": { "nextWeightKg": 32.5, "incrementKg": 1.25, "note": "…" } }
}
```

Every section and field is optional.

| Field | Effect |
|---|---|
| `planId` | Unique id for this version of the plan. **Use a new one every time the lift targets change**, because lift overrides apply once per `planId`. |
| `updatedAt` | Shown in Settings. |
| `note` | Shown at the top of every session screen. |
| `hiit.hardMode` / `hardSpeed` / `hardIncline` / `rounds` | Used for every new HIIT session while the plan is in place, instead of the previous session's values. `hardMode` is `jog` or `incline`. |
| `hiit.note`, `walk.note` | Shown on that type of session. |
| `lifts.<lift>.nextWeightKg` | Sets that lift's next working weight, applied once per `planId`. After that, normal progression carries on from it. |
| `lifts.<lift>.incrementKg` | Sets that lift's increment from now on (e.g. 1.25 for micro-plates). It stays until a later plan changes it, or the matching setting in the app is changed by hand. |
| `lifts.<lift>.note` | Shown on sessions that include that lift. |

Lift keys are `squat`, `bench`, `row`, `ohp` and `deadlift`. If a plan arrives in the middle of a lifting workout, its lift changes wait until that workout is saved.
Each session records the `planId` that was in force, in `lift-log.json` and the Sessions `plan_id` column.
