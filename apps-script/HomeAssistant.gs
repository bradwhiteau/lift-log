/**
 * Weight (Withings integration) and blood pressure (HA companion app, from Health Connect / Omron Connect) from
 * Home Assistant, via HA's history API (reachable through Nabu Casa).
 * Script Properties: HA_URL (e.g. https://xxxx.ui.nabu.casa) and HA_TOKEN (a long-lived access token).
 * Writes the "Weight" and "Blood Pressure" tabs, and withings-weight.json / blood-pressure.json next to lift-log.json.
 */
const HA_ENTITIES = {
  'sensor.withings_weight': 'weight_kg',
  'sensor.withings_fat_ratio': 'fat_pct',
  'sensor.withings_muscle_mass': 'muscle_kg',
};
const WEIGHT_FILE_NAME = 'withings-weight.json';
const WEIGH_GROUP_MS = 2 * 60 * 1000;   // the three sensors update within moments of each other
const HA_FIRST_RUN_DAYS = 30;            // HA's recorder only keeps ~10 days; ask for more and take what's there

const BP_ENTITIES = {
  'sensor.ecto_8_systolic_blood_pressure': 'systolic',
  'sensor.ecto_8_diastolic_blood_pressure': 'diastolic',
};
const BP_FILE_NAME = 'blood-pressure.json';

/** Weight then blood pressure, one lock, one HA connection. Runs on the hourly trigger (see Connections.gs). */
function syncHomeAssistant() {
  return withSyncLock_(function () {
    const url = (props_().getProperty('HA_URL') || '').replace(/\/+$/, '');
    const token = props_().getProperty('HA_TOKEN');
    if (!url || !token) {
      markFailure_('homeassistant', 'HA_URL and HA_TOKEN script properties are not set', true);
      markFailure_('bloodpressure', 'Home Assistant is not set up', false);
      return;
    }
    syncWeight_(url, token);
    syncBloodPressure_(url, token);
  });
}

/**
 * GET HA state history for some entities since `start`. Returns {data} or {error, auth} (auth = token rejected).
 * `params` picks the response shape, e.g. '&minimal_response&no_attributes' for plain states.
 */
function haHistory_(url, token, start, entityIds, params) {
  const q = url + '/api/history/period/' + encodeURIComponent(start.toISOString()) +
    '?filter_entity_id=' + entityIds.join(',') +
    '&end_time=' + encodeURIComponent(new Date().toISOString()) + params;
  let res;
  try {
    res = UrlFetchApp.fetch(q, { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
  } catch (e) {
    return { error: 'Home Assistant unreachable (' + e.message.replace(/https?:\/\/\S+/g, '').trim().slice(0, 100) + ')' };
  }
  const code = res.getResponseCode();
  if (code === 401 || code === 403) return { error: 'Home Assistant rejected the token (HTTP ' + code + ') — check HA token', auth: true };
  if (code !== 200) return { error: 'Home Assistant returned HTTP ' + code };
  try { return { data: JSON.parse(res.getContentText()) }; } catch (e) { return { error: 'Home Assistant sent an unexpected response' }; }
}

function syncWeight_(url, token) {
  const doc = readDriveJson_(WEIGHT_FILE_NAME) || {};
  const readings = doc.readings || [];
  // Start a little before the last reading so a sensor that updated a moment late still joins its group.
  const last = readings.length ? Date.parse(readings[readings.length - 1].timestamp) : 0;
  const start = new Date(last ? last - 10 * 60000 : Date.now() - HA_FIRST_RUN_DAYS * 86400000);
  const r = haHistory_(url, token, start, Object.keys(HA_ENTITIES), '&minimal_response&no_attributes&skip_initial_state');
  if (r.auth) return markFailure_('homeassistant', r.error, true);
  if (r.error) return haUnreachable_(r.error);

  const merged = mergeReadings_(readings, groupReadings_(parseHaHistory_(r.data)));
  writeWeight_(merged);
  markSuccess_('homeassistant', { lastReadingAt: merged.length ? merged[merged.length - 1].timestamp : null });
}

/** Unreachable is normal for short spells (HA restarting, internet down); only flag it after 24 h. */
function haUnreachable_(message) {
  const st = status_('homeassistant');
  const since = Date.parse(st.lastSuccessAt || st.failingSince || new Date().toISOString());
  markFailure_('homeassistant', message, Date.now() - since > UNREACHABLE_GRACE_MS);
}

/** HA history → [{field, ts, value}] sorted by time, skipping "unavailable"/"unknown" and other non-numbers. */
function parseHaHistory_(data) {
  const out = [];
  (data || []).forEach(function (series) {
    if (!series || !series.length) return;
    const field = HA_ENTITIES[series[0].entity_id];   // with minimal_response only the first state names the entity
    if (!field) return;
    series.forEach(function (st) {
      const v = parseFloat(st.state);
      const ts = Date.parse(st.last_changed || st.last_updated || '');
      if (isFinite(v) && ts) out.push({ field: field, ts: ts, value: Math.round(v * 100) / 100 });
    });
  });
  return out.sort(function (a, b) { return a.ts - b.ts; });
}

/** Groups the three sensors' changes into weigh-ins by matching timestamps (within a couple of minutes). */
function groupReadings_(events) {
  const groups = [];
  let g = null;
  events.forEach(function (e) {
    if (!g || e.ts - g.ts > WEIGH_GROUP_MS || g[e.field] !== undefined) { g = { ts: e.ts }; groups.push(g); }
    g[e.field] = e.value;
  });
  return groups;
}

/** Adds new weigh-ins, merging into an existing one at (nearly) the same time; dedupes on timestamp. */
function mergeReadings_(existing, groups) {
  const list = existing.slice();
  groups.forEach(function (g) {
    let r = list.find(function (x) { return Math.abs(Date.parse(x.timestamp) - g.ts) <= WEIGH_GROUP_MS; });
    if (!r) {
      const d = new Date(g.ts);
      r = { timestamp: d.toISOString(), date: ymd_(d), time: hm_(d), weight_kg: null, fat_pct: null, muscle_kg: null };
      list.push(r);
    }
    ['weight_kg', 'fat_pct', 'muscle_kg'].forEach(function (f) { if (g[f] !== undefined) r[f] = g[f]; });
  });
  return list.sort(function (a, b) { return Date.parse(a.timestamp) - Date.parse(b.timestamp); });
}

/** Morning weigh-in = the first reading of each Perth day. */
function dailyWeighIns_(readings) {
  const seen = {}, out = [];
  readings.forEach(function (r) { if (!seen[r.date] && r.weight_kg != null) { seen[r.date] = true; out.push(r); } });
  return out;
}

function writeWeight_(readings) {
  const daily = dailyWeighIns_(readings);
  writeDriveJson_(WEIGHT_FILE_NAME, {
    description: 'Body composition from Brad\'s Withings scale, via Home Assistant (sensor.withings_weight, ' +
      'sensor.withings_fat_ratio, sensor.withings_muscle_mass). "readings" has every weigh-in: date and time are ' +
      'Australia/Perth (when Home Assistant received the reading), timestamp is ISO UTC, weight_kg and muscle_kg in kg, ' +
      'fat_pct in %. A field is null if that sensor did not change at that weigh-in. "daily" has the first reading of ' +
      'each Perth day, i.e. the morning weigh-in. Home Assistant only keeps ~10 days of history, so older readings ' +
      'exist only because they were synced at the time.',
    updated_at: new Date().toISOString(),
    timezone: TZ,
    daily: daily.map(function (r) { return { date: r.date, time: r.time, weight_kg: r.weight_kg, fat_pct: r.fat_pct, muscle_kg: r.muscle_kg }; }),
    readings: readings,
  });
  const headers = ['date', 'time', 'weight_kg', 'fat_pct', 'muscle_kg', 'timestamp'];
  writeTable_('Weight', headers, readings.map(function (r) {
    return headers.map(function (h) { return r[h] == null ? '' : r[h]; });
  }));
}

/** For doGet?action=weight: that day's morning weigh-in, or {} if there wasn't one. */
function weighInFor_(date) {
  const doc = readDriveJson_(WEIGHT_FILE_NAME) || {};
  const r = (doc.daily || []).find(function (x) { return x.date === date; });
  return r ? { date: r.date, time: r.time, weight_kg: r.weight_kg, fat_pct: r.fat_pct, muscle_kg: r.muscle_kg } : {};
}

// ---------- blood pressure ----------

/**
 * Blood pressure readings. The measurement time is the state's `date` attribute (ISO UTC), not last_changed
 * (that's only when HA heard about it). So attributes are kept, and significant_changes_only=0 makes HA include a
 * new reading whose value happens to equal the previous one (only its `date` attribute changed).
 * Token/reachability problems are flagged on the Home Assistant row; this row only records its own last error.
 */
function syncBloodPressure_(url, token) {
  const doc = readDriveJson_(BP_FILE_NAME) || {};
  const readings = doc.readings || [];
  // Readings can reach HA a while after they're taken (Omron → Health Connect → phone), so look back a day.
  const last = readings.length ? Date.parse(readings[readings.length - 1].timestamp) : 0;
  const start = new Date(last ? last - 86400000 : Date.now() - HA_FIRST_RUN_DAYS * 86400000);
  const r = haHistory_(url, token, start, Object.keys(BP_ENTITIES), '&skip_initial_state&significant_changes_only=0');
  if (r.error) return markFailure_('bloodpressure', r.error, false);

  const merged = mergeBp_(readings, parseBpHistory_(r.data));
  writeBp_(merged);
  const latest = merged[merged.length - 1];
  markSuccess_('bloodpressure', {
    lastReadingAt: latest ? latest.timestamp : null,
    lastValue: latest && latest.systolic != null && latest.diastolic != null ? latest.systolic + '/' + latest.diastolic : null,
  });
}

/** HA history → [{ts, systolic?, diastolic?, source?}], paired by the `date` attribute; skips unavailable/unknown. */
function parseBpHistory_(data) {
  const byTime = {};
  (data || []).forEach(function (series) {
    (series || []).forEach(function (st) {
      const field = BP_ENTITIES[st.entity_id || (series[0] && series[0].entity_id)];
      const a = st.attributes || {};
      const v = parseFloat(st.state), ts = Date.parse(a.date || '');
      if (!field || !isFinite(v) || !ts) return;
      const r = byTime[ts] = byTime[ts] || { ts: ts };
      r[field] = Math.round(v);
      if (a.source) r.source = a.source;
    });
  });
  return Object.keys(byTime).map(function (k) { return byTime[k]; });
}

/** Adds new readings and completes half-paired ones; dedupes on measurement time. */
function mergeBp_(existing, found) {
  const byTs = {};
  existing.forEach(function (r) { byTs[r.timestamp] = Object.assign({}, r); });
  found.forEach(function (f) {
    const d = new Date(f.ts), key = d.toISOString();
    const r = byTs[key] = byTs[key] || { timestamp: key, date: ymd_(d), time: hm_(d), systolic: null, diastolic: null, source: null };
    ['systolic', 'diastolic', 'source'].forEach(function (k) { if (f[k] != null) r[k] = f[k]; });
  });
  return Object.keys(byTs).sort().map(function (k) { return byTs[k]; });
}

function writeBp_(readings) {
  writeDriveJson_(BP_FILE_NAME, {
    description: 'Brad\'s blood pressure readings (Omron monitor → Omron Connect → Health Connect → Home Assistant companion ' +
      'app sensors sensor.ecto_8_systolic_blood_pressure / sensor.ecto_8_diastolic_blood_pressure). One entry per measurement: ' +
      'timestamp = when the reading was taken (ISO UTC, from the sensor\'s "date" attribute); date and time = the same moment ' +
      'in Australia/Perth; systolic and diastolic in mmHg (null if that half has not arrived yet); source = the app that ' +
      'recorded it, e.g. jp.co.omron.healthcare.omron_connect. Home Assistant only keeps ~10 days of history, so older ' +
      'readings exist only because they were synced at the time.',
    updated_at: new Date().toISOString(),
    timezone: TZ,
    readings: readings,
  });
  const headers = ['date', 'time', 'systolic', 'diastolic', 'source'];
  writeTable_('Blood Pressure', headers, readings.map(function (r) {
    return headers.map(function (h) { return r[h] == null ? '' : r[h]; });
  }));
}
