/**
 * Lift Log sync — receives sessions from the Lift Log app and stores them in:
 *   - this Google Sheet: "Sessions" (one row per session), "Sets" (one row per set), "State" (current weights)
 *   - lift-log.json in the same Drive folder as this Sheet (full history, for the Claude project)
 *
 * Setup: see README.md. Change SYNC_TOKEN below, run setup() once, then deploy as a web app.
 */
const SYNC_TOKEN = 'CHANGE-ME';
const JSON_FILE_NAME = 'lift-log.json';

function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return out_({ ok: false, error: 'Bad request' }); }
  if (SYNC_TOKEN === 'CHANGE-ME') return out_({ ok: false, error: 'Set SYNC_TOKEN in the script first' });
  if (!body || body.token !== SYNC_TOKEN) return out_({ ok: false, error: 'Wrong sync token' });

  const ss = spreadsheet_();
  if (body.action === 'ping') return out_({ ok: true, message: 'Connected to "' + ss.getName() + '"' });
  if (body.action !== 'upsert' || !body.session || !body.session.id) return out_({ ok: false, error: 'Unknown action' });

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const id = body.session.id;
    upsertRows_(ss, 'Sessions', id, body.sessionRow ? [body.sessionRow] : []);
    upsertRows_(ss, 'Sets', id, body.setRows || []);
    if (body.state) writeState_(ss, body.state);
    writeJson_(ss, body.session, body.state);
    return out_({ ok: true, id: id });
  } catch (err) {
    return out_({ ok: false, error: String((err && err.message) || err) });
  } finally {
    lock.releaseLock();
  }
}

function doGet() {
  return out_({ ok: true, service: 'Lift Log sync' });
}

/** Run once from the editor: authorises the script and creates the tabs. */
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  PropertiesService.getScriptProperties().setProperty('SPREADSHEET_ID', ss.getId());
  ['Sessions', 'Sets', 'State'].forEach(function (name) { if (!ss.getSheetByName(name)) ss.insertSheet(name); });
  const first = ss.getSheetByName('Sheet1');
  if (first && ss.getSheets().length > 1 && first.getLastRow() === 0) ss.deleteSheet(first);
  folder_(ss); // touches Drive so its permission is granted now
  Logger.log('Setup complete for "%s"', ss.getName());
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

function writeJson_(ss, session, state) {
  const folder = folder_(ss);
  const files = folder.getFilesByName(JSON_FILE_NAME);
  const file = files.hasNext() ? files.next() : null;
  let doc = {};
  if (file) { try { doc = JSON.parse(file.getBlob().getDataAsString()); } catch (e) { doc = {}; } }

  const list = (doc.sessions || []).filter(function (s) { return s.id !== session.id; });
  list.push(session);
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

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
