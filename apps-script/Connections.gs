/**
 * Connection status, alert emails and the schedule for the Home Assistant (weight) and Google Health (Fitbit)
 * syncs. Status lives in Script Properties as STATUS_<service> so the editor, triggers and web app all see it.
 */
const SERVICE_NAMES = { homeassistant: 'Home Assistant (weight)', googlehealth: 'Google Health (Fitbit)' };
const UNREACHABLE_GRACE_MS = 24 * 3600 * 1000;   // HA being down this long needs Brad's attention

function props_() { return PropertiesService.getScriptProperties(); }

function status_(service) {
  try { return JSON.parse(props_().getProperty('STATUS_' + service) || '{}'); } catch (e) { return {}; }
}
function saveStatus_(service, st) { props_().setProperty('STATUS_' + service, JSON.stringify(st)); }

/** A sync worked: clear any failure, and allow a future failure to email again. */
function markSuccess_(service, extra) {
  const now = new Date().toISOString();
  const st = Object.assign(status_(service), extra || {}, {
    lastSyncAt: now, lastSuccessAt: now, lastError: null, needsAttention: false, alerted: false, failingSince: null,
  });
  saveStatus_(service, st);
}

/**
 * A sync failed. `attention` = Brad has to do something (token revoked/expired, or HA down > 24 h).
 * The first failure that needs attention sends one email; it won't email again until a sync succeeds.
 */
function markFailure_(service, message, attention) {
  const now = new Date().toISOString();
  const st = status_(service);
  st.lastSyncAt = now; st.lastError = message; st.lastErrorAt = now;
  st.failingSince = st.failingSince || now;
  if (attention) st.needsAttention = true;
  if (st.needsAttention && !st.alerted) {
    try { sendAlert_(service, message); st.alerted = true; } catch (e) { st.lastError = message + ' (alert email failed: ' + e.message + ')'; }
  }
  saveStatus_(service, st);
  Logger.log('%s sync failed: %s', service, message);
}

function sendAlert_(service, message) {
  const to = props_().getProperty('ALERT_EMAIL') || Session.getEffectiveUser().getEmail();
  let body;
  if (service === 'googlehealth') {
    body = 'Lift Log: Google Health (Fitbit) needs re-authorising (' + message + '). ' +
      'Open this link on a device signed in to your Google account and allow access: ' + authorizeLink_() + '\n\n' +
      'You can also use Lift Log → Settings → Connections → Re-authorise. Missed days are caught up automatically afterwards.';
  } else {
    body = 'Lift Log: Home Assistant weight sync needs attention (' + message + '). ' +
      'Check Home Assistant is reachable through Nabu Casa; if the token was revoked, create a new long-lived access token ' +
      '(HA → Profile → Security) and paste it into the script property HA_TOKEN. Missed readings are picked up on the next sync ' +
      '(HA keeps about 10 days of history).';
  }
  MailApp.sendEmail(to, 'Lift Log: ' + SERVICE_NAMES[service] + ' needs attention', body);
}

/** Link that always produces a fresh Google authorisation URL (the URL itself expires after an hour). */
function authorizeLink_() {
  const base = ScriptApp.getService().getUrl();
  return base ? base + '?action=authorize&token=' + encodeURIComponent(SYNC_TOKEN) : ghAuthUrl_();
}

/** Status for the app's Connections card. */
function connections_() {
  const p = props_();
  const ha = status_('homeassistant'), gh = status_('googlehealth');
  return {
    homeassistant: {
      connected: !!(p.getProperty('HA_URL') && p.getProperty('HA_TOKEN')) && !ha.needsAttention,
      lastSyncAt: ha.lastSuccessAt || null, lastReadingAt: ha.lastReadingAt || null,
      lastError: ha.lastError || null, needsAttention: !!ha.needsAttention,
    },
    googlehealth: {
      connected: ghHasToken_() && !gh.needsAttention,
      lastSyncAt: gh.lastSuccessAt || null, lastReadingAt: gh.lastReadingAt || null,
      lastError: gh.lastError || null, needsAttention: !!gh.needsAttention,
    },
  };
}

/** One hourly trigger: weight every hour 5–10am Perth, Fitbit at 7am, and a catch-up of both at 9pm. */
function hourlyTick() {
  const h = perthHour_();
  if ((h >= 5 && h <= 10) || h === 21) syncHomeAssistant();
  if (h === 7 || h === 21) syncGoogleHealth();
}

function installTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'hourlyTick') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('hourlyTick').timeBased().everyHours(1).create();
}

/**
 * Editor helper: run it and read the execution log. Checks every v1.3 setup step and makes a live test call to
 * Home Assistant and Google Health. Never prints secret values.
 */
function checkSetup() {
  const p = props_(), lines = [];
  const ok = function (cond, text, fix) { lines.push((cond ? '✓ ' : '✗ ') + text + (cond || !fix ? '' : '  →  ' + fix)); return cond; };

  lines.push('— Script —');
  ok(SYNC_TOKEN !== 'CHANGE-ME', 'Passphrase set (SYNC_TOKEN near the top of Code.gs)', 'replace CHANGE-ME with your passphrase, keeping the quotes');
  ok(typeof syncHomeAssistant === 'function', 'HomeAssistant file present', 'add a script file named HomeAssistant and paste HomeAssistant.gs');
  ok(typeof syncGoogleHealth === 'function', 'GoogleHealth file present', 'add a script file named GoogleHealth and paste GoogleHealth.gs');
  ok(typeof weighInFor_ === 'function' && typeof ghAuthUrl_ === 'function', 'Code.gs is the v1.3 version', 'paste the latest Code.gs');
  ok(typeof OAuth2 !== 'undefined', 'OAuth2 library added (identifier "OAuth2")', 'Libraries → + → Script ID 1B7FSrk5Zi6L1rSxxTDgDEUsPzlukDsi4KGuTMorsTQHhGBzBkMun4iDF');
  ok(!!p.getProperty('SPREADSHEET_ID'), 'setup has been run', 'run setup');
  ok(ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'hourlyTick'; }), 'Hourly trigger installed', 'run setup');
  ok(!!ScriptApp.getService().getUrl(), 'Web app deployed', 'Deploy → Manage deployments → edit → New version → Deploy');

  lines.push('— Home Assistant —');
  const haUrl = (p.getProperty('HA_URL') || '').trim(), haToken = (p.getProperty('HA_TOKEN') || '').trim();
  const urlOk = ok(/^https:\/\/[^/]+(\/)?$/.test(haUrl), 'HA_URL set (https://…, no path)',
    haUrl ? 'it should be just the Nabu Casa address, e.g. https://abcd1234.ui.nabu.casa' : 'add Script Property HA_URL');
  const tokOk = ok(haToken.length > 100, 'HA_TOKEN set (' + haToken.length + ' characters)', haToken ? 'a long-lived token is ~180 characters; check it was copied in full' : 'add Script Property HA_TOKEN');
  if (urlOk && tokOk) {
    try {
      const base = haUrl.replace(/\/+$/, '');
      const res = UrlFetchApp.fetch(base + '/api/', { headers: { Authorization: 'Bearer ' + haToken }, muteHttpExceptions: true });
      const code = res.getResponseCode();
      if (ok(code === 200, 'Home Assistant reachable and token accepted (HTTP ' + code + ')',
        code === 401 ? 'token rejected: create a new long-lived token' : 'check the Nabu Casa address and that remote access is on')) {
        Object.keys(HA_ENTITIES).forEach(function (id) {
          const r = UrlFetchApp.fetch(base + '/api/states/' + id, { headers: { Authorization: 'Bearer ' + haToken }, muteHttpExceptions: true });
          const st = r.getResponseCode() === 200 ? JSON.parse(r.getContentText()).state : null;
          ok(r.getResponseCode() === 200, id + (st != null ? ' = ' + st : ''), 'entity not found: check its id in HA (Settings → Entities)');
        });
      }
    } catch (e) { ok(false, 'Home Assistant reachable', e.message.replace(/https?:\/\/\S+/g, '')); }
  }

  lines.push('— Google Health —');
  const cid = (p.getProperty('GH_CLIENT_ID') || '').trim();
  ok(/\.apps\.googleusercontent\.com$/.test(cid), 'GH_CLIENT_ID set', cid ? 'should end in .apps.googleusercontent.com' : 'add Script Property GH_CLIENT_ID');
  ok(!!(p.getProperty('GH_CLIENT_SECRET') || '').trim(), 'GH_CLIENT_SECRET set', 'add Script Property GH_CLIENT_SECRET');
  lines.push('  Redirect URI that must be on the "Health Test" client: ' + ghRedirectUri_());
  if (typeof OAuth2 !== 'undefined' && cid) {
    const svc = ghService_();
    if (ok(!!svc.getToken(), 'Authorised (token stored)', 'run authorizeGoogleHealth and open the link it logs')) {
      if (ok(svc.hasAccess(), 'Token valid / refreshes', 'needs re-authorising: ' + (svc.getLastError() || 'run authorizeGoogleHealth'))) {
        try {
          const y = addDaysYmd_(ymd_(new Date()), -1);
          const j = ghFetch_('post', 'steps/dataPoints:dailyRollUp', { range: { start: civilDate_(y), end: civilDate_(ymd_(new Date())) }, windowSizeDays: 1 });
          const pt = (j.rollupDataPoints || [])[0];
          ok(true, 'Health API call works (steps yesterday: ' + (pt && pt.steps ? pt.steps.countSum : 'none') + ')');
        } catch (e) { ok(false, 'Health API call works', e.message); }
      }
    }
  }

  lines.push('— Last syncs —');
  ['homeassistant', 'googlehealth'].forEach(function (s) {
    const st = status_(s);
    lines.push('  ' + SERVICE_NAMES[s] + ': ' + (st.lastSuccessAt ? 'last success ' + st.lastSuccessAt : 'never succeeded') +
      (st.lastError ? ' · last error: ' + st.lastError : ''));
  });
  Logger.log('\n' + lines.join('\n'));
}

/** Runs fn unless another sync holds the lock (then skips; the next run catches up). */
function withSyncLock_(fn) {
  const lock = LockService.getDocumentLock() || LockService.getScriptLock();
  if (!lock.tryLock(20000)) { Logger.log('Another sync is running; skipped.'); return; }
  try { return fn(); } finally { lock.releaseLock(); }
}
