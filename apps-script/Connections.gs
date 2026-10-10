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

/** Runs fn unless another sync holds the lock (then skips; the next run catches up). */
function withSyncLock_(fn) {
  const lock = LockService.getDocumentLock() || LockService.getScriptLock();
  if (!lock.tryLock(20000)) { Logger.log('Another sync is running; skipped.'); return; }
  try { return fn(); } finally { lock.releaseLock(); }
}
