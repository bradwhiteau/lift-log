/**
 * Fitbit data (Fitbit Air) from the Google Health API, using its own OAuth2 service via the apps-script-oauth2
 * library (added to this project with the identifier "OAuth2"). It can't use the script's own token: the API
 * rejects tokens carrying Apps Script's scopes (403 DISALLOWED_OAUTH_SCOPES).
 * Script Properties: GH_CLIENT_ID, GH_CLIENT_SECRET (the "Health Test" web client). The OAuth token is stored
 * in Script Properties too (oauth2.googlehealth), so triggers and the web app share it.
 * Writes the "Health" tab (one row per day) and health-daily.json next to lift-log.json.
 */
const GH_API = 'https://health.googleapis.com/v4/users/me/dataTypes/';
const GH_SCOPES = [
  'https://www.googleapis.com/auth/googlehealth.sleep.readonly',
  'https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly',
  'https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly',
];
const GH_BACKFILL_FROM = '2026-09-01';
const GH_REFRESH_DAYS = 3;            // re-pull the last few days each run: late watch syncs and revised data
const HEALTH_FILE_NAME = 'health-daily.json';
const SESSION_HR_MAX_AGE_DAYS = 14;   // stop retrying HR for a Lift Log session after this

// ---------- OAuth ----------
function ghService_() {
  const p = props_();
  return OAuth2.createService('googlehealth')
    .setAuthorizationBaseUrl('https://accounts.google.com/o/oauth2/auth')
    .setTokenUrl('https://oauth2.googleapis.com/token')
    .setClientId(p.getProperty('GH_CLIENT_ID'))
    .setClientSecret(p.getProperty('GH_CLIENT_SECRET'))
    .setCallbackFunction('authCallback')
    .setPropertyStore(p)
    .setCache(CacheService.getScriptCache())
    .setScope(GH_SCOPES.join(' '))
    .setParam('access_type', 'offline')
    .setParam('prompt', 'consent');
}

function ghRedirectUri_() { return 'https://script.google.com/macros/d/' + ScriptApp.getScriptId() + '/usercallback'; }
function ghAuthUrl_() { return ghService_().getAuthorizationUrl(); }
function ghHasToken_() {
  const p = props_();
  return !!(p.getProperty('GH_CLIENT_ID') && p.getProperty('GH_CLIENT_SECRET') && ghService_().getToken());
}

/** Editor helper: logs the redirect URI to add to the OAuth client, and a consent URL to open. */
function authorizeGoogleHealth() {
  Logger.log('Redirect URI for the OAuth client: %s', ghRedirectUri_());
  Logger.log('Open this URL to authorise (valid for an hour): %s', ghAuthUrl_());
}

/** OAuth redirect lands here (the /usercallback URL). */
function authCallback(request) {
  if (!ghService_().handleCallback(request)) {
    return HtmlService.createHtmlOutput('<p style="font:18px sans-serif;margin:24px">Authorisation was not completed. ' +
      'Try Re-authorise again from Lift Log.</p>');
  }
  const st = status_('googlehealth');
  st.needsAttention = false; st.alerted = false; st.lastError = null;
  saveStatus_('googlehealth', st);
  // Catch up on missed days in the background rather than making this page wait.
  ScriptApp.newTrigger('ghCatchUpOnce').timeBased().after(5000).create();
  return HtmlService.createHtmlOutput('<p style="font:18px sans-serif;margin:24px">Authorised. You can close this tab.</p>')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** Editor helper: rebuild every day from GH_BACKFILL_FROM (e.g. after a fix to how data is processed). */
function resyncGoogleHealthFromStart() {
  const st = status_('googlehealth');
  delete st.syncedThrough;
  saveStatus_('googlehealth', st);
  syncGoogleHealth();
  Logger.log('Rebuilt from %s. Last error: %s', GH_BACKFILL_FROM, status_('googlehealth').lastError || 'none');
}

function ghCatchUpOnce() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'ghCatchUpOnce') ScriptApp.deleteTrigger(t);
  });
  syncGoogleHealth();
}

// ---------- API ----------
function ghFetch_(method, path, payload) {
  const service = ghService_();
  if (!service.hasAccess()) {
    const err = new Error('Google Health authorisation has expired or is missing' +
      (service.getLastError() ? ' (' + service.getLastError() + ')' : ''));
    err.auth = true; throw err;
  }
  const opts = { method: method, headers: { Authorization: 'Bearer ' + service.getAccessToken() }, muteHttpExceptions: true };
  if (payload) { opts.contentType = 'application/json'; opts.payload = JSON.stringify(payload); }
  const res = UrlFetchApp.fetch(GH_API + path, opts);
  const code = res.getResponseCode(), text = res.getContentText();
  if (code === 401) { const e = new Error('Google Health rejected the token (HTTP 401)'); e.auth = true; throw e; }
  if (code >= 400) {
    const e = new Error('Google Health ' + path.split('/')[0] + ': HTTP ' + code + ' ' + text.slice(0, 200));
    e.code = code; throw e;
  }
  return text ? JSON.parse(text) : {};
}

/**
 * Lists all data points matching a filter. Takes alternative spellings of the filter and uses the first one
 * the API accepts (the reference mixes camelCase and snake_case type names in its examples).
 */
function ghList_(type, filters, pageSize) {
  let lastErr;
  for (let i = 0; i < filters.length; i++) {
    try {
      const out = [];
      let token = '';
      do {
        const q = '?filter=' + encodeURIComponent(filters[i]) + (pageSize ? '&pageSize=' + pageSize : '') +
          (token ? '&pageToken=' + encodeURIComponent(token) : '');
        const j = ghFetch_('get', type + '/dataPoints' + q);
        (j.dataPoints || []).forEach(function (pt) { out.push(pt); });
        token = j.nextPageToken || '';
      } while (token);
      return out;
    } catch (e) {
      if (e.code === 400 && i < filters.length - 1) { lastErr = e; continue; }
      throw e;
    }
  }
  throw lastErr;
}

/** Daily steps via dailyRollUp, in chunks of at most 90 days. */
function ghStepsByDay_(from, toExcl) {
  const out = {};
  for (let start = from; start < toExcl;) {
    const end = [addDaysYmd_(start, 90), toExcl].sort()[0];
    let token = '';
    do {
      const body = { range: { start: civilDate_(start), end: civilDate_(end) }, windowSizeDays: 1 };
      if (token) body.pageToken = token;
      const j = ghFetch_('post', 'steps/dataPoints:dailyRollUp', body);
      (j.rollupDataPoints || []).forEach(function (pt) {
        const d = civilYmd_(pt.civilStartTime);
        if (d && pt.steps) out[d] = Number(pt.steps.countSum || 0);
      });
      token = j.nextPageToken || '';
    } while (token);
    start = end;
  }
  return out;
}

/** Heart-rate samples between two instants → per-minute (Perth) min/avg/max plus an overall summary. */
function ghHeartRate_(startIso, endIso) {
  const f = function (t) { return t + '.sample_time.physical_time >= "' + startIso + '" AND ' + t + '.sample_time.physical_time < "' + endIso + '"'; };
  const points = ghList_('heart-rate', [f('heartRate'), f('heart_rate')], 10000);
  const byMin = {};
  let all = [];
  points.forEach(function (pt) {
    const hr = pt.heartRate; if (!hr || !hr.sampleTime) return;
    const bpm = Number(hr.beatsPerMinute), t = Date.parse(hr.sampleTime.physicalTime);
    if (!bpm || !t) return;
    const key = Math.floor(t / 60000) * 60000;
    (byMin[key] = byMin[key] || []).push(bpm); all.push(bpm);
  });
  const stats = function (xs) {
    return { min: Math.min.apply(null, xs), avg: Math.round(xs.reduce(function (a, b) { return a + b; }, 0) / xs.length), max: Math.max.apply(null, xs) };
  };
  if (!all.length) return null;
  return {
    summary: stats(all),
    perMinute: Object.keys(byMin).map(Number).sort().map(function (k) {
      return Object.assign({ time: hm_(new Date(k)) }, stats(byMin[k]));
    }),
  };
}

// ---------- civil (local) dates and times ----------
function civilDate_(ymd) {
  const a = ymd.split('-').map(Number);
  return { date: { year: a[0], month: a[1], day: a[2] } };
}
const pad2_ = function (n) { return ('0' + (n || 0)).slice(-2); };
/** CivilDateTime / Date (object or string) → YYYY-MM-DD */
function civilYmd_(v) {
  if (!v) return null;
  if (typeof v === 'string') return v.slice(0, 10);
  const d = v.date || v;
  return d.year ? d.year + '-' + pad2_(d.month) + '-' + pad2_(d.day) : null;
}
/** CivilDateTime (object or string) → HH:mm */
function civilHm_(v) {
  if (!v) return null;
  if (typeof v === 'string') return v.length > 10 ? v.slice(11, 16) : '00:00';
  const t = v.time || {};
  return pad2_(t.hours) + ':' + pad2_(t.minutes);
}
/** One end of an interval as {date, time, iso}: the API's civil time if given, else physical time + its UTC offset. */
function civilEnd_(interval, which) {
  const civil = interval[which === 'start' ? 'civilStartTime' : 'civilEndTime'];
  const iso = interval[which + 'Time'];
  if (civil) return { date: civilYmd_(civil), time: civilHm_(civil), iso: iso };
  const offsetSec = parseFloat(String(interval[which + 'UtcOffset'] || '0')) || 0;
  const local = new Date(Date.parse(iso) + offsetSec * 1000).toISOString();
  return { date: local.slice(0, 10), time: local.slice(11, 16), iso: iso };
}

// ---------- the sync ----------
function syncGoogleHealth() {
  return withSyncLock_(function () {
    const p = props_();
    if (!p.getProperty('GH_CLIENT_ID') || !p.getProperty('GH_CLIENT_SECRET')) {
      return markFailure_('googlehealth', 'GH_CLIENT_ID and GH_CLIENT_SECRET script properties are not set', true);
    }
    if (!ghService_().getToken()) return markFailure_('googlehealth', 'Not authorised yet — needs authorising', true);

    const st = status_('googlehealth');
    const today = ymd_(new Date());
    const from = st.syncedThrough ? [addDaysYmd_(st.syncedThrough, -GH_REFRESH_DAYS), GH_BACKFILL_FROM].sort().pop() : GH_BACKFILL_FROM;
    const toExcl = addDaysYmd_(today, 1);
    const doc = readDriveJson_(HEALTH_FILE_NAME) || {};
    const errors = [];
    const part = function (name, fn) {
      try { return fn(); } catch (e) {
        if (e.auth) throw e;
        errors.push(name + ': ' + e.message); return undefined;   // undefined = keep what we had for this part
      }
    };

    try {
      const between = function (field) { return field + ' >= "' + from + '" AND ' + field + ' < "' + toExcl + '"'; };
      const daily = function (type, key, pick) {
        const snake = key.replace(/[A-Z]/g, function (c) { return '_' + c.toLowerCase(); });
        const out = {};
        ghList_(type, [between(key + '.date'), between(snake + '.date')]).forEach(function (pt) {
          const v = pt[key]; if (v) out[civilYmd_(v.date)] = pick(v);
        });
        return out;
      };
      const parts = {
        sleep: part('sleep', function () { return ghSleep_(ghList_('sleep', [between('sleep.interval.civil_end_time')], 25)); }),
        restingHr: part('resting heart rate', function () {
          return daily('daily-resting-heart-rate', 'dailyRestingHeartRate', function (v) { return Number(v.beatsPerMinute); });
        }),
        hrv: part('HRV', function () {
          return daily('daily-heart-rate-variability', 'dailyHeartRateVariability', function (v) {
            return { rmssd: num_(v.averageHeartRateVariabilityMilliseconds), deep: num_(v.deepSleepRootMeanSquareOfSuccessiveDifferencesMilliseconds) };
          });
        }),
        respiratoryRate: part('respiratory rate', function () {
          return daily('daily-respiratory-rate', 'dailyRespiratoryRate', function (v) { return num_(v.breathsPerMinute); });
        }),
        steps: part('steps', function () { return ghStepsByDay_(from, toExcl); }),
        exercises: part('exercise', function () {
          return ghExercises_(ghList_('exercise', [between('exercise.interval.civil_start_time')], 25), doc.days || []);
        }),
      };
      const sessions = part('Lift Log session heart rate', function () { return ghSessionHeartRate_(doc.liftLogSessions || {}); });

      const days = mergeDays_(doc.days || [], parts, from, today);
      writeHealth_(days, sessions || doc.liftLogSessions || {});
      if (errors.length) {
        markFailure_('googlehealth', errors.join('; '), false);   // data problem, not an auth problem: retried next run
      } else {
        markSuccess_('googlehealth', { syncedThrough: today, lastReadingAt: latestReading_(days) });
      }
    } catch (e) {
      // syncedThrough is unchanged either way, so missed days are retried on the next run.
      if (e.auth) markFailure_('googlehealth', e.message + ' — needs re-authorising', true);
      else markFailure_('googlehealth', 'Unexpected error: ' + e.message, false);
      Logger.log(e.stack || e);
    }
  });
}

function num_(v) { return v == null || v === '' ? null : Number(v); }

/** Main sleep per night, keyed by the Perth date it ended (the morning you woke up). */
function ghSleep_(points) {
  const byDate = {};
  points.forEach(function (pt) {
    const s = pt.sleep; if (!s || !s.interval) return;
    const md = s.metadata || {};
    if (md.nap) return;
    const start = civilEnd_(s.interval, 'start'), end = civilEnd_(s.interval, 'end');
    const sum = s.summary || {}, stage = {};
    (sum.stagesSummary || []).forEach(function (x) { stage[x.type] = Number(x.minutes || 0); });
    const asleep = num_(sum.minutesAsleep), awake = num_(sum.minutesAwake);
    const rec = {
      start: start.date + ' ' + start.time, end: end.date + ' ' + end.time,
      minutesAsleep: asleep, minutesAwake: awake,
      deepMin: stage.DEEP != null ? stage.DEEP : null, lightMin: stage.LIGHT != null ? stage.LIGHT : null,
      remMin: stage.REM != null ? stage.REM : null,
      efficiencyPct: asleep != null && awake != null && asleep + awake > 0 ? Math.round(asleep / (asleep + awake) * 100) : null,
      mainSleep: !!md.mainSleep, type: s.type || null,
    };
    const cur = byDate[end.date];
    if (!cur || (rec.mainSleep && !cur.mainSleep) || (rec.mainSleep === cur.mainSleep && (asleep || 0) > (cur.minutesAsleep || 0))) {
      byDate[end.date] = rec;
    }
  });
  return byDate;
}

/**
 * Exercise sessions by Perth start date, with max HR from the heart-rate samples in each window (reused from
 * the previous run when already known). autoDetected: the watch recorded it on its own rather than you
 * starting it (recordingMethod PASSIVELY_MEASURED / DERIVED) — the Air auto-detects false "Swim" sessions.
 */
function ghExercises_(points, oldDays) {
  const known = {};
  // Max HR is cached per time window (copies of a workout share one), from earlier runs and within this run.
  oldDays.forEach(function (d) { (d.exercises || []).forEach(function (x) { if (x.startIso) known[x.startIso + '|' + x.endIso] = x.maxHr; }); });
  const byDate = {};
  points.forEach(function (pt) {
    const e = pt.exercise; if (!e || !e.interval) return;
    const ms = e.metricsSummary || {};
    const start = civilEnd_(e.interval, 'start'), end = civilEnd_(e.interval, 'end');
    const rm = (pt.dataSource && pt.dataSource.recordingMethod) || null;
    const id = pt.name || (e.exerciseType + '@' + start.iso);
    const win = start.iso + '|' + end.iso;
    let maxHr = known[win];
    if (maxHr === undefined) {
      try {
        const hr = ghHeartRate_(start.iso, end.iso);
        maxHr = hr ? hr.summary.max : null;
      } catch (err) {
        if (err.auth) throw err;
        maxHr = null;   // no max HR is better than losing the exercise
      }
      known[win] = maxHr;
    }
    (byDate[start.date] = byDate[start.date] || []).push({
      id: id, type: e.exerciseType || null, name: e.displayName || null,
      start: start.date + ' ' + start.time, end: end.date + ' ' + end.time, startIso: start.iso, endIso: end.iso,
      durationMin: Math.round((Date.parse(end.iso) - Date.parse(start.iso)) / 60000),
      avgHr: num_(ms.averageHeartRateBeatsPerMinute), maxHr: maxHr,
      activeZoneMinutes: num_(ms.activeZoneMinutes), caloriesKcal: num_(ms.caloriesKcal), steps: num_(ms.steps),
      distanceKm: ms.distanceMillimeters ? Math.round(Number(ms.distanceMillimeters) / 10000) / 100 : null,
      recordingMethod: rm,
      autoDetected: rm === 'PASSIVELY_MEASURED' || rm === 'DERIVED' ? true : rm === 'ACTIVELY_MEASURED' || rm === 'MANUAL' ? false : null,
    });
  });
  Object.keys(byDate).forEach(function (d) { byDate[d] = dedupeExercises_(byDate[d]); });
  return byDate;
}

/**
 * A workout started on the watch (ACTIVELY_MEASURED) also arrives as one or two PASSIVELY_MEASURED copies with the
 * same start and end. Keep one per window, preferring the one Brad started (then the one with the most data), and
 * only call it auto-detected when every copy was passive.
 */
function dedupeExercises_(list) {
  const started = function (x) { return x.recordingMethod === 'ACTIVELY_MEASURED' || x.recordingMethod === 'MANUAL'; };
  const filled = function (x) { return ['avgHr', 'maxHr', 'activeZoneMinutes', 'caloriesKcal', 'steps'].filter(function (k) { return x[k] != null; }).length; };
  const groups = {};
  list.forEach(function (x) { (groups[x.start + '|' + x.end] = groups[x.start + '|' + x.end] || []).push(x); });
  return Object.keys(groups).sort().map(function (k) {
    const g = groups[k].sort(function (a, b) { return (started(b) - started(a)) || (filled(b) - filled(a)); });
    const keep = Object.assign({}, g[0]);
    if (g.some(started)) keep.autoDetected = false;
    else if (keep.autoDetected === false) keep.autoDetected = null;
    if (keep.maxHr == null) keep.maxHr = g.map(function (x) { return x.maxHr; }).filter(function (v) { return v != null; })[0] || null;
    if (g.length > 1) keep.copies = g.length;
    return keep;
  });
}

/** Per-minute heart rate for Lift Log sessions (start/end from lift-log.json, the same data as the Sessions tab). */
function ghSessionHeartRate_(existing) {
  const out = Object.assign({}, existing);
  const log = readDriveJson_(JSON_FILE_NAME) || {};
  const cutoff = Date.now() - SESSION_HR_MAX_AGE_DAYS * 86400000;
  (log.sessions || []).forEach(function (s) {
    if (!s.startedAt || !s.endedAt || s.date < GH_BACKFILL_FROM) return;
    const endMs = Date.parse(s.endedAt);
    if (endMs > Date.now() - 20 * 60000) return;                 // give the watch time to sync
    const have = out[s.id];
    if (have && have.startIso === s.startedAt && have.endIso === s.endedAt) return;
    if (!have && endMs < cutoff) return;                          // too old to keep retrying
    const hr = ghHeartRate_(s.startedAt, s.endedAt);
    if (!hr) return;                                              // nothing yet: try again next run
    out[s.id] = {
      date: s.date, type: s.type, workout: s.workout || null,
      start: ymd_(new Date(s.startedAt)) + ' ' + hm_(new Date(s.startedAt)), end: ymd_(new Date(s.endedAt)) + ' ' + hm_(new Date(s.endedAt)),
      startIso: s.startedAt, endIso: s.endedAt, summary: hr.summary, perMinute: hr.perMinute,
    };
  });
  return out;
}

/** Rebuilds the days in [from, today] from this run's results; a part that failed keeps its previous values. */
function mergeDays_(oldDays, parts, from, today) {
  const byDate = {};
  oldDays.forEach(function (d) { byDate[d.date] = d; });
  for (let date = from; date <= today; date = addDaysYmd_(date, 1)) {
    const d = Object.assign({ date: date }, byDate[date] || {});
    if (parts.sleep) d.sleep = parts.sleep[date] || null;
    if (parts.restingHr) d.restingHr = parts.restingHr[date] != null ? parts.restingHr[date] : null;
    if (parts.hrv) {
      d.hrvRmssdMs = parts.hrv[date] ? parts.hrv[date].rmssd : null;
      d.hrvDeepSleepRmssdMs = parts.hrv[date] ? parts.hrv[date].deep : null;
    }
    if (parts.respiratoryRate) d.respiratoryRate = parts.respiratoryRate[date] != null ? parts.respiratoryRate[date] : null;
    if (parts.steps) d.steps = parts.steps[date] != null ? parts.steps[date] : null;
    if (parts.exercises) {
      d.exercises = parts.exercises[date] || [];
      d.activeZoneMinutes = d.exercises.reduce(function (t, x) { return t + (x.activeZoneMinutes || 0); }, 0);
    }
    byDate[date] = d;
  }
  return Object.keys(byDate).sort().map(function (k) { return byDate[k]; });
}

function latestReading_(days) {
  for (let i = days.length - 1; i >= 0; i--) {
    const d = days[i];
    if (d.sleep) return d.sleep.end.replace(' ', 'T') + ':00+08:00';   // Perth has no daylight saving
    if (d.steps) return d.date + 'T00:00:00+08:00';
  }
  return null;
}

function writeHealth_(days, sessions) {
  writeDriveJson_(HEALTH_FILE_NAME, {
    description: 'Daily health data from Brad\'s Fitbit Air via the Google Health API, synced each morning (Australia/Perth). ' +
      '"days": one entry per Perth date. sleep = the main sleep that ENDED that morning (start/end local "YYYY-MM-DD HH:mm", ' +
      'minutesAsleep/minutesAwake, deepMin/lightMin/remMin, efficiencyPct = asleep / (asleep + awake)). restingHr = daily resting ' +
      'heart rate (bpm). hrvRmssdMs = nightly HRV as RMSSD in ms (Fitbit\'s daily HRV); hrvDeepSleepRmssdMs = RMSSD during deep ' +
      'sleep. respiratoryRate = breaths/min during the main sleep. steps = daily total. exercises = workouts that started that day: ' +
      'type, local start/end, durationMin, avgHr/maxHr (bpm), activeZoneMinutes, calories, steps, distanceKm. Duplicates of the ' +
      'same workout (same start/end, arriving from several sources) are merged into one; "copies" says how many there were. ' +
      'autoDetected=true means the watch logged it on its own (only passive recordings, no copy that Brad started) and these ' +
      'can be false (e.g. "Swim" sessions that never happened); false = Brad started it on the watch; null = unknown. ' +
      'activeZoneMinutes on the day = sum over exercises. ' +
      'Null means no data. "liftLogSessions": heart rate during each Lift Log session, keyed by the Lift Log session id ' +
      '(see lift-log.json): summary min/avg/max bpm and perMinute (local HH:mm).',
    updated_at: new Date().toISOString(),
    timezone: TZ,
    days: days,
    liftLogSessions: sessions,
  });
  const headers = ['date', 'sleep_start', 'sleep_end', 'minutes_asleep', 'minutes_awake', 'deep_min', 'light_min', 'rem_min',
    'sleep_efficiency_pct', 'resting_hr', 'hrv_rmssd_ms', 'hrv_deep_sleep_rmssd_ms', 'respiratory_rate', 'steps',
    'active_zone_minutes', 'exercise_count', 'auto_detected_exercises', 'exercises'];
  const v = function (x) { return x == null ? '' : x; };
  writeTable_('Health', headers, days.map(function (d) {
    const s = d.sleep || {}, ex = d.exercises || [];
    return [d.date, v(s.start), v(s.end), v(s.minutesAsleep), v(s.minutesAwake), v(s.deepMin), v(s.lightMin), v(s.remMin),
      v(s.efficiencyPct), v(d.restingHr), v(d.hrvRmssdMs), v(d.hrvDeepSleepRmssdMs), v(d.respiratoryRate), v(d.steps),
      v(d.activeZoneMinutes), ex.length, ex.filter(function (x) { return x.autoDetected; }).length,
      ex.map(function (x) {
        return (x.type || x.name) + ' ' + x.start.slice(11) + '–' + x.end.slice(11) + ' (' + x.durationMin + ' min' +
          (x.avgHr ? ', avg ' + x.avgHr : '') + (x.maxHr ? ', max ' + x.maxHr : '') +
          (x.activeZoneMinutes ? ', AZM ' + x.activeZoneMinutes : '') + ')' + (x.autoDetected ? ' auto' : '');
      }).join('; ')];
  }));
}
