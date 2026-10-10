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
3. On line 8, replace `CHANGE-ME` with a long passphrase of your own, e.g. `squat-rack-purple-4417-kettle`. You'll type it into the phone once.
4. Click **Save**. Choose `setup` in the function dropdown and click **Run**. Google will ask for permission. Choose your account, then **Advanced → Go to Lift Log (unsafe) → Allow**. The warning appears because this is your own unverified script.
5. **Deploy → New deployment →** click the gear icon and choose **Web app**:
   - Execute as: **Me**
   - Who has access: **Anyone** (the passphrase is what protects it)
6. Click **Deploy** and copy the **Web app URL** (it ends in `/exec`).

> If you change `Code.gs` later (e.g. v1.1 added delete support, v1.2 the coach plan): paste the new code over the old, **Save**, then **Deploy → Manage deployments →** edit (pencil icon) **→ Version: New version → Deploy**. The URL stays the same.

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

## Changing the program

Edit `program.js`, bump `version` (e.g. `SL5x5-v2`) and bump `CACHE` in `sw.js` (e.g. `lift-log-v2`). Commit and push in GitHub Desktop.
The phone picks up the new version the next time the app is opened twice.
Quick switches such as deadlift 1×5, the deadlift increment, micro-plates, HIIT rounds and rest times are in the app's Settings; you don't need to edit code for those.

## Data written to Drive

| Where | Contents |
|---|---|
| Sheet → **Sessions** | One row per session: type, workout, week, program version, status/skip reason, start/end, duration, RPE, bodyweight, set counts, per-exercise summary, HIIT details, notes, plan_id (the coach plan in force when the session started) |
| Sheet → **Sets** | One row per set: planned/actual weight, target/actual reps, result (done/failed/not_done), effort (easy/hard), time logged |
| Sheet → **State** | Current next working weight and failure streak for each lift |
| `lift-log.json` | Full history in one file, with a description of the fields, for the Claude project |

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
