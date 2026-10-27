/**
 * Lift Log sync — receives sessions from the Lift Log app and stores them in:
 *   - this Google Sheet: "Sessions" (one row per session), "Sets" (one row per set), "State" (current weights)
 *   - lift-log.json in the same Drive folder as this Sheet (full history, for the Claude project)
 * Also serves the coach plan, and (v1.3) weight from Home Assistant and Fitbit data from the Google Health API:
 * see HomeAssistant.gs, GoogleHealth.gs and Connections.gs, which live in this same Apps Script project.
 *
 * Setup: see README.md. Change SYNC_TOKEN below, run setup() once, then deploy as a web app.
 * Secrets (HA token, Google OAuth client) go in Script Properties, never in this file — the repo is public.
 */
const SYNC_TOKEN = 'CHANGE-ME';
const JSON_FILE_NAME = 'lift-log.json';
const PLAN_FILE_NAME = 'lift-log-plan.json';
const TZ = 'Australia/Perth';

function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return out_({ ok: false, error: 'Bad request' }); }
  if (SYNC_TOKEN === 'CHANGE-ME') return out_({ ok: false, error: 'Set SYNC_TOKEN in the script first' });
  if (!body || body.token !== SYNC_TOKEN) return out_({ ok: false, error: 'Wrong sync token' });

  const ss = spreadsheet_();
  if (body.action === 'ping') return out_({ ok: true, message: 'Connected to "' + ss.getName() + '"' });
  if (body.action === 'now') return out_(writeNowDoc_(ss, body.doc));
  const isUpsert = body.action === 'upsert' && body.session && body.session.id;
  const isDelete = body.action === 'delete' && body.id;
  if (!isUpsert && !isDelete) return out_({ ok: false, error: 'Unknown action — redeploy the latest Code.gs' });

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const id = isUpsert ? body.session.id : body.id;
    // Upserting with no rows removes the session's rows, which is exactly what delete needs.
    upsertRows_(ss, 'Sessions', id, isUpsert && body.sessionRow ? [body.sessionRow] : []);
    upsertRows_(ss, 'Sets', id, isUpsert ? body.setRows || [] : []);
    if (body.state) writeState_(ss, body.state);
    writeJson_(ss, id, isUpsert ? body.session : null, body.state);
    return out_({ ok: true, id: id });
  } catch (err) {
    return out_({ ok: false, error: String((err && err.message) || err) });
  } finally {
    lock.releaseLock();
  }
}

/**
 * GET endpoints, all needing &token=<SYNC_TOKEN>:
 *   action=plan                        lift-log-plan.json (written by the Brad's Fitness project), or {}
 *   action=weight&date=YYYY-MM-DD      that day's morning weigh-in from Home Assistant, or {}
 *   action=connections                 status of the weight, blood pressure and Google Health syncs
 *   action=auth&service=googlehealth   a fresh Google Health authorisation URL (JSON, for the app)
 *   action=authorize                   a page linking to a fresh authorisation URL (for the alert email)
 *   action=sync&service=homeassistant|bloodpressure|googlehealth   run that sync now (HA covers weight + BP)
 * No action is a health check.
 */
function doGet(e) {
  const p = (e && e.parameter) || {};
  if (!p.action) return out_({ ok: true, service: 'Lift Log sync' });
  if (SYNC_TOKEN === 'CHANGE-ME' || p.token !== SYNC_TOKEN) return out_({ ok: false, error: 'Wrong sync token' });
  try {
    switch (p.action) {
      case 'plan': {
        const plan = readDriveJson_(PLAN_FILE_NAME);
        if (plan === undefined) return out_({ ok: false, error: PLAN_FILE_NAME + ' is not valid JSON' });
        return out_(plan || {});
      }
      case 'weight': return out_(weighInFor_(p.date || ymd_(new Date())));
      case 'connections': return out_({ ok: true, services: connections_() });
      case 'auth':
        if (p.service !== 'googlehealth') return out_({ ok: false, error: 'Only googlehealth uses authorisation' });
        return out_({ ok: true, url: ghAuthUrl_() });
      case 'authorize':   // the link in alert emails: a page with a fresh Google authorisation link
        return HtmlService.createHtmlOutput('<p style="font:18px sans-serif;margin:24px">' +
          '<a href="' + ghAuthUrl_() + '" target="_top">Authorise Google Health for Lift Log</a></p>')
          .setTitle('Lift Log').addMetaTag('viewport', 'width=device-width, initial-scale=1');
      case 'sync':
        if (p.service === 'homeassistant' || p.service === 'bloodpressure') syncHomeAssistant();
        else if (p.service === 'googlehealth') syncGoogleHealth();
        else return out_({ ok: false, error: 'Unknown service' });
        return out_({ ok: true, services: connections_() });
      default: return out_({ ok: false, error: 'Unknown action — redeploy the latest script' });
    }
  } catch (err) {
    return out_({ ok: false, error: String((err && err.message) || err) });
  }
}

/**
 * Run once from the editor (and again after adding new script files): authorises the script, creates the
 * tabs and installs the hourly trigger. Safe to re-run.
 */
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  PropertiesService.getScriptProperties().setProperty('SPREADSHEET_ID', ss.getId());
  ['Sessions', 'Sets', 'State', 'Weight', 'Blood Pressure', 'Health'].forEach(function (name) { if (!ss.getSheetByName(name)) ss.insertSheet(name); });
  const first = ss.getSheetByName('Sheet1');
  if (first && ss.getSheets().length > 1 && first.getLastRow() === 0) ss.deleteSheet(first);
  folder_(ss); // touches Drive so its permission is granted now
  installTriggers_();
  Logger.log('Setup complete for "%s". Google Health redirect URI: %s', ss.getName(), ghRedirectUri_());
}

const NOW_DOC_NAME = 'Lift Log Now';

/**
 * Writes the app's plain-English plan into the Google Doc "Lift Log Now", next to this Sheet, so Claude can read it
 * in chat and voice (its Drive connector reads Docs, not the app's data). `lines` = [{ t: 'h1'|'h2'|'h3'|'p'|'li', text }].
 */
function writeNowDoc_(ss, lines) {
  if (!Array.isArray(lines) || !lines.length || lines.length > 500) return { ok: false, error: 'Bad doc' };
  const props = PropertiesService.getScriptProperties();
  let doc = null;
  const id = props.getProperty('NOW_DOC_ID');
  if (id) { try { doc = DocumentApp.openById(id); } catch (err) { doc = null; } }
  if (!doc) {
    doc = DocumentApp.create(NOW_DOC_NAME);
    DriveApp.getFileById(doc.getId()).moveTo(folder_(ss));
    props.setProperty('NOW_DOC_ID', doc.getId());
  }
  const body = doc.getBody();
  body.clear();
  const H = { h1: DocumentApp.ParagraphHeading.HEADING1, h2: DocumentApp.ParagraphHeading.HEADING2, h3: DocumentApp.ParagraphHeading.HEADING3 };
  lines.forEach(function (l) {
    const text = String((l && l.text) || '').slice(0, 2000);
    if (l && l.t === 'li') body.appendListItem(text).setGlyphType(DocumentApp.GlyphType.BULLET);
    else { const p = body.appendParagraph(text); if (l && H[l.t]) p.setHeading(H[l.t]); }
  });
  // clear() leaves one empty paragraph at the top: drop it.
  const first = body.getChild(0);
  if (body.getNumChildren() > 1 && first.getType() === DocumentApp.ElementType.PARAGRAPH && first.asParagraph().getText() === '') body.removeChild(first);
  doc.saveAndClose();
  return { ok: true };
}

/** Run once from the editor after updating: grants the Google Docs permission and creates "Lift Log Now". */
function setupNowDoc() {
  writeNowDoc_(spreadsheet_(), [{ t: 'h1', text: NOW_DOC_NAME }, { t: 'p', text: 'Waiting for the Lift Log app to send its plan. Open the app to fill this in.' }]);
}

function spreadsheet_() {
  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
}

function folder_(ss) {
  const parents = DriveApp.getFileById(ss.getId()).getParents();
  return parents.hasNext() ? parents.next() : DriveApp.getRootFolder();
}

/** Replace any rows for this session id, then append the new rows. Columns are matched by header name. */
function upsertRows_(ss, name, id, rows) {
  const sh = ss.getSheetByName(name) || ss.insertSheet(name);
  const lastCol = sh.getLastColumn();
  const headers = lastCol ? sh.getRange(1, 1, 1, lastCol).getValues()[0].filter(String) : [];
  rows.forEach(function (r) { Object.keys(r).forEach(function (k) { if (headers.indexOf(k) < 0) headers.push(k); }); });
  if (!headers.length) return;
  if (sh.getMaxColumns() < headers.length) sh.insertColumnsAfter(sh.getMaxColumns(), headers.length - sh.getMaxColumns());
  sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
  sh.setFrozenRows(1);

  const keyCol = headers.indexOf('session_id');
  const lastRow = sh.getLastRow();
  let data = lastRow > 1 ? sh.getRange(2, 1, lastRow - 1, headers.length).getValues() : [];
  data = data.filter(function (row) { return String(row[keyCol]) !== String(id); });
  rows.forEach(function (r) {
    data.push(headers.map(function (h) { return r[h] === undefined || r[h] === null ? '' : r[h]; }));
  });

  const dateCol = headers.indexOf('date');
  const t = function (v) { return v instanceof Date ? v.getTime() : new Date(v).getTime() || 0; };
  if (dateCol >= 0) data.sort(function (a, b) { return t(a[dateCol]) - t(b[dateCol]); });

  if (lastRow > 1) sh.getRange(2, 1, lastRow - 1, sh.getLastColumn()).clearContent();
  if (data.length) sh.getRange(2, 1, data.length, headers.length).setValues(data);
}

function writeState_(ss, state) {
  const sh = ss.getSheetByName('State') || ss.insertSheet('State');
  const headers = ['lift', 'name', 'next_weight_kg', 'fail_streak', 'last_result', 'increment_kg'];
  const rows = state.lifts.map(function (l) { return headers.map(function (h) { return l[h] === undefined ? '' : l[h]; }); });
  sh.clearContents();
  sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
  sh.getRange(2, 1, rows.length, headers.length).setValues(rows);
  sh.getRange(rows.length + 3, 1, 3, 2).setValues([
    ['as_of', state.as_of], ['program_version', state.program_version], ['deadlift_sets', state.deadlift_sets]]);
}

/** Replaces (or, when session is null, removes) the session with this id in lift-log.json. */
function writeJson_(ss, id, session, state) {
  const folder = folder_(ss);
  const files = folder.getFilesByName(JSON_FILE_NAME);
  const file = files.hasNext() ? files.next() : null;
  let doc = {};
  if (file) { try { doc = JSON.parse(file.getBlob().getDataAsString()); } catch (e) { doc = {}; } }

  const list = (doc.sessions || []).filter(function (s) { return s.id !== id; });
  if (session) list.push(session);
  list.sort(function (a, b) {
    const ka = a.date + (a.startedAt || ''), kb = b.date + (b.startedAt || '');
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });

  const out = {
    description: 'Lift Log workout history, written automatically by the Lift Log app. One entry per session ' +
      '(type lift/walk/hiit; status completed/partial/skipped). Lift sessions list each exercise with planned ' +
      'and actual weight (kg) and every set (result done/failed, effort easy/hard, reps). Times are ISO UTC; ' +
      '"tz" is the phone time zone. current_state holds the next working weight for each lift.',
    updated_at: new Date().toISOString(),
    current_state: state || doc.current_state || null,
    sessions: list,
  };
  const content = JSON.stringify(out, null, 2);
  if (file) file.setContent(content);
  else folder.createFile(JSON_FILE_NAME, content, 'application/json');
}

/** Parsed JSON file from this Sheet's folder: null if missing, undefined if not valid JSON. */
function readDriveJson_(name) {
  const files = folder_(spreadsheet_()).getFilesByName(name);
  if (!files.hasNext()) return null;
  try { return JSON.parse(files.next().getBlob().getDataAsString()); } catch (e) { return undefined; }
}

function writeDriveJson_(name, obj) {
  const folder = folder_(spreadsheet_());
  const files = folder.getFilesByName(name);
  const content = JSON.stringify(obj, null, 2);
  if (files.hasNext()) files.next().setContent(content);
  else folder.createFile(name, content, 'application/json');
}

/** Rewrites a whole tab: header row plus rows (arrays in header order). */
function writeTable_(name, headers, rows) {
  const ss = spreadsheet_();
  const sh = ss.getSheetByName(name) || ss.insertSheet(name);
  sh.clearContents();
  if (sh.getMaxColumns() < headers.length) sh.insertColumnsAfter(sh.getMaxColumns(), headers.length - sh.getMaxColumns());
  sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
  sh.setFrozenRows(1);
  if (rows.length) sh.getRange(2, 1, rows.length, headers.length).setValues(rows);
}

/** Dates and times in Perth. */
function ymd_(d) { return Utilities.formatDate(d, TZ, 'yyyy-MM-dd'); }
function hm_(d) { return Utilities.formatDate(d, TZ, 'HH:mm'); }
function perthHour_(d) { return Number(Utilities.formatDate(d || new Date(), TZ, 'H')); }
function addDaysYmd_(s, n) {
  const d = new Date(s + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
