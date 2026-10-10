/**
 * Weight from Home Assistant's Withings integration, via HA's history API (reachable through Nabu Casa).
 * Script Properties: HA_URL (e.g. https://xxxx.ui.nabu.casa) and HA_TOKEN (a long-lived access token).
 * Writes the "Weight" tab and withings-weight.json next to lift-log.json.
 */
const HA_ENTITIES = {
  'sensor.withings_weight': 'weight_kg',
  'sensor.withings_fat_ratio': 'fat_pct',
  'sensor.withings_muscle_mass': 'muscle_kg',
};
const WEIGHT_FILE_NAME = 'withings-weight.json';
const WEIGH_GROUP_MS = 2 * 60 * 1000;   // the three sensors update within moments of each other
const HA_FIRST_RUN_DAYS = 30;            // HA's recorder only keeps ~10 days; ask for more and take what's there

function syncHomeAssistant() {
  return withSyncLock_(function () {
    const url = (props_().getProperty('HA_URL') || '').replace(/\/+$/, '');
    const token = props_().getProperty('HA_TOKEN');
    if (!url || !token) { markFailure_('homeassistant', 'HA_URL and HA_TOKEN script properties are not set', true); return; }

    const doc = readDriveJson_(WEIGHT_FILE_NAME) || {};
    const readings = doc.readings || [];
    // Start a little before the last reading so a sensor that updated a moment late still joins its group.
    const last = readings.length ? Date.parse(readings[readings.length - 1].timestamp) : 0;
    const start = new Date(last ? last - 10 * 60000 : Date.now() - HA_FIRST_RUN_DAYS * 86400000);
    const q = url + '/api/history/period/' + encodeURIComponent(start.toISOString()) +
      '?filter_entity_id=' + Object.keys(HA_ENTITIES).join(',') +
      '&end_time=' + encodeURIComponent(new Date().toISOString()) +
      '&minimal_response&no_attributes&skip_initial_state';

    let res;
    try {
      res = UrlFetchApp.fetch(q, { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
    } catch (e) {
      return haUnreachable_('Home Assistant unreachable (' + e.message.replace(/https?:\/\/\S+/g, '').trim().slice(0, 100) + ')');
    }
    const code = res.getResponseCode();
    if (code === 401 || code === 403) {
      return markFailure_('homeassistant', 'Home Assistant rejected the token (HTTP ' + code + ') — check HA token', true);
    }
    if (code !== 200) return haUnreachable_('Home Assistant returned HTTP ' + code);
    let data;
    try { data = JSON.parse(res.getContentText()); } catch (e) { return haUnreachable_('Home Assistant sent an unexpected response'); }

    const merged = mergeReadings_(readings, groupReadings_(parseHaHistory_(data)));
    writeWeight_(merged);
    markSuccess_('homeassistant', { lastReadingAt: merged.length ? merged[merged.length - 1].timestamp : null });
  });
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
