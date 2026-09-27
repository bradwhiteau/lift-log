(() => {
  'use strict';

  const APP_VERSION = '1.0.0';
  const P = window.PROGRAM;
  const $ = (sel, el = document) => el.querySelector(sel);

  // ---------- storage ----------
  const KEYS = {
    settings: 'll.settings', sessions: 'll.sessions', active: 'll.active',
    queue: 'll.syncQueue', sync: 'll.syncMeta', timer: 'll.timer',
  };
  function load(key, fallback) {
    try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); }
    catch (e) { return fallback; }
  }
  function save(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); }
    catch (e) { toast('Could not save on this device: ' + e.message); }
  }

  const DEFAULT_SETTINGS = {
    syncUrl: '', syncToken: '',
    programVersion: P.version,
    deadliftSets: P.sets, deadliftIncrement: P.lifts.deadlift.increment,
    microBench: false, microOhp: false,
    hiitRounds: P.hiit.rounds,
    rest: { ...P.rest },
    keepAwake: true, sound: true, vibrate: true,
    adjustments: [],   // manual working-weight changes: {lift, weight, at, note}
  };
  const settings = { ...DEFAULT_SETTINGS, ...load(KEYS.settings, {}) };
  settings.rest = { ...P.rest, ...(settings.rest || {}) };
  settings.adjustments = settings.adjustments || [];

  let sessions = load(KEYS.sessions, []);   // finished (completed / partial / skipped)
  let active = load(KEYS.active, null);     // in-progress session, saved on every tap
  let queue = load(KEYS.queue, []);         // session ids waiting to sync
  let syncMeta = load(KEYS.sync, {});       // id -> {state, at, error}
  let timer = load(KEYS.timer, null);

  const ui = { view: 'today', date: todayStr(), today: todayStr(), workoutOverride: {}, modal: null, preview: null };

  const saveSettings = () => save(KEYS.settings, settings);
  const saveSessions = () => save(KEYS.sessions, sessions);
  const saveActive = () => save(KEYS.active, active);

  // ---------- dates & formatting ----------
  function pad(n) { return String(n).padStart(2, '0'); }
  function ymd(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
  function parseYmd(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
  function addDays(s, n) { const d = parseYmd(s); d.setDate(d.getDate() + n); return ymd(d); }
  function todayStr() { return ymd(new Date()); }
  function daysBetween(a, b) { return Math.round((parseYmd(b) - parseYmd(a)) / 86400000); }
  function weekOf(s) { const n = daysBetween(P.startDate, s); return n < 0 ? 0 : Math.floor(n / 7) + 1; }
  function nowIso() { return new Date().toISOString(); }
  function localStamp(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return `${ymd(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }
  const fmtDay = s => parseYmd(s).toLocaleDateString('en-AU', { weekday: 'long' });
  const fmtDate = s => parseYmd(s).toLocaleDateString('en-AU', { day: 'numeric', month: 'long' });
  const fmtShort = s => parseYmd(s).toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' });
  const fmtTime = iso => new Date(iso).toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' });
  const fmtW = w => String(Math.round(w * 100) / 100);
  const roundW = w => Math.round(w * 100) / 100;
  const tz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) { return ''; } };
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function minutesBetween(a, b) { return a && b ? Math.round((Date.parse(b) - Date.parse(a)) / 60000) : ''; }
  const sessionTs = s => s.startedAt ? Date.parse(s.startedAt) : parseYmd(s.date).getTime() + 12 * 3600000;
  const bySessionTime = (a, b) => sessionTs(a) - sessionTs(b);
  const uid = (date, type) => `${date}-${type}-${Math.random().toString(36).slice(2, 6)}`;

  // ---------- program logic ----------
  const TYPE_LABEL = { lift: 'Lifting', walk: 'Treadmill walk', hiit: 'Treadmill HIIT', rest: 'Rest day', none: 'Before program start' };

  function plannedType(date) {
    if (date < P.startDate) return 'none';
    const t = P.schedule[parseYmd(date).getDay()] || 'rest';
    return t === 'hiit' && date < P.hiitFrom ? 'walk' : t;
  }

  function incFor(lift) {
    if (lift === 'deadlift') return Number(settings.deadliftIncrement) || P.lifts.deadlift.increment;
    if (lift === 'bench' && settings.microBench) return 1.25;
    if (lift === 'ohp' && settings.microOhp) return 1.25;
    return P.lifts[lift].increment;
  }
  function deloadWeight(w) {
    const r = P.deload.roundTo;
    return Math.max(P.barWeight, Math.round(w * (1 - P.deload.percent / 100) / r) * r);
  }

  // Replays history (plus manual adjustments) to get each lift's next working weight.
  // Each exercise stores the increment in force when it was performed, so changing
  // settings later doesn't rewrite the past.
  function progression() {
    const st = {};
    for (const [k, l] of Object.entries(P.lifts)) st[k] = { weight: l.start, failStreak: 0, last: null };
    const events = [];
    for (const s of sessions) if (s.type === 'lift' && s.status !== 'skipped') events.push({ ts: sessionTs(s), s });
    for (const a of settings.adjustments) events.push({ ts: Date.parse(a.at), a });
    events.sort((x, y) => x.ts - y.ts);
    for (const e of events) {
      if (e.a) { Object.assign(st[e.a.lift], { weight: e.a.weight, failStreak: 0, last: 'manual' }); continue; }
      for (const ex of e.s.exercises) {
        if (!ex.sets.some(x => x.result)) continue;           // lift not attempted
        const cur = st[ex.lift];
        if (ex.sets.every(x => x.result === 'done')) {
          Object.assign(cur, { weight: roundW(ex.weight + ex.increment), failStreak: 0, last: 'success' });
        } else if (ex.sets.some(x => x.result === 'failed')) {
          cur.failStreak++; cur.weight = ex.weight; cur.last = 'failed';
          if (cur.failStreak >= P.deload.afterFailedSessions) Object.assign(cur, { weight: deloadWeight(ex.weight), failStreak: 0, last: 'deload' });
        } else {
          cur.weight = ex.weight; cur.last = 'incomplete';     // ran out of sets without failing
        }
      }
    }
    return st;
  }

  const flip = t => (t === 'A' ? 'B' : 'A');
  function workoutFor(date) {
    if (ui.workoutOverride[date]) return ui.workoutOverride[date];
    const last = sessions.filter(s => s.type === 'lift' && s.status !== 'skipped' && s.date < date).sort(bySessionTime).pop();
    let type = last ? flip(last.workout) : 'A';
    let from = [ui.today, P.startDate].sort().pop();
    if (last && last.date >= from) from = addDays(last.date, 1);
    for (let d = from; d < date; d = addDays(d, 1)) if (plannedType(d) === 'lift') type = flip(type);
    return type;
  }

  function newSession(date, type, workout) {
    const base = {
      id: uid(date, type), date, type, week: weekOf(date), programVersion: settings.programVersion,
      status: 'in_progress', startedAt: null, endedAt: null, rpe: null, bodyweight: null, notes: '', tz: tz(),
    };
    if (type === 'lift') {
      const st = progression();
      base.workout = workout || workoutFor(date);
      base.exercises = P.workouts[base.workout].map(lift => {
        const n = lift === 'deadlift' ? Number(settings.deadliftSets) || P.sets : P.sets;
        return {
          lift, name: P.lifts[lift].name, plannedWeight: st[lift].weight, weight: st[lift].weight,
          targetReps: P.reps, increment: incFor(lift),
          sets: Array.from({ length: n }, (_, i) => ({ n: i + 1, result: null, effort: null, reps: null, at: null })),
        };
      });
    } else if (type === 'walk') {
      base.cardio = { minutes: P.walk.minutes };
    } else if (type === 'hiit') {
      const lastHiit = sessions.filter(s => s.type === 'hiit' && s.cardio).sort(bySessionTime).pop();
      const r = Number(settings.hiitRounds) || P.hiit.rounds;
      base.cardio = {
        plannedRounds: r, roundsCompleted: r, minutes: 10 + Math.round(r * (P.hiit.hardSec + P.hiit.easySec) / 60),
        hardMode: lastHiit ? lastHiit.cardio.hardMode : 'jog',
        hardSpeed: lastHiit ? lastHiit.cardio.hardSpeed : 7.5,
        hardIncline: lastHiit ? lastHiit.cardio.hardIncline : 0,
      };
    }
    return base;
  }

  function warmup(w) {
    const half = Math.round(w * 0.5 / 2.5) * 2.5;
    return half > P.barWeight ? `bar×5, ${fmtW(half)}×3` : 'bar×5, bar×3';
  }

  // ---------- rows for Sheet / CSV ----------
  const SESSION_COLS = ['session_id', 'date', 'session_type', 'workout', 'week', 'program_version', 'status', 'skip_reason',
    'start_time', 'end_time', 'duration_min', 'session_rpe', 'bodyweight_kg', 'sets_planned', 'sets_done', 'sets_failed',
    'exercises_summary', 'cardio_minutes', 'hiit_rounds_planned', 'hiit_rounds_completed', 'hiit_hard_mode',
    'hiit_hard_speed_kph', 'hiit_hard_incline_pct', 'timezone', 'notes'];
  const SET_COLS = ['session_id', 'date', 'start_time', 'end_time', 'program_version', 'week', 'workout', 'session_status',
    'exercise', 'lift', 'set_no', 'planned_weight_kg', 'actual_weight_kg', 'target_reps', 'actual_reps', 'result', 'effort',
    'logged_at', 'session_rpe', 'bodyweight_kg', 'notes'];
  const blank = v => (v == null ? '' : v);

  function exSummary(e) {
    return `${e.name} ${fmtW(e.weight)}kg [${e.sets.map(x => x.result === 'done' ? x.reps : x.result === 'failed' ? x.reps + 'F' : '-').join(',')}]`;
  }
  function sessionRow(s) {
    const sets = s.type === 'lift' ? s.exercises.flatMap(e => e.sets) : [];
    const c = s.cardio || {};
    const lifted = s.type === 'lift' && s.status !== 'skipped';
    return {
      session_id: s.id, date: s.date, session_type: s.type, workout: blank(s.workout), week: s.week,
      program_version: s.programVersion, status: s.status, skip_reason: blank(s.skipReason),
      start_time: localStamp(s.startedAt), end_time: localStamp(s.endedAt), duration_min: minutesBetween(s.startedAt, s.endedAt),
      session_rpe: blank(s.rpe), bodyweight_kg: blank(s.bodyweight),
      sets_planned: lifted ? sets.length : '', sets_done: lifted ? sets.filter(x => x.result === 'done').length : '',
      sets_failed: lifted ? sets.filter(x => x.result === 'failed').length : '',
      exercises_summary: lifted ? s.exercises.map(exSummary).join('; ') : '',
      cardio_minutes: blank(c.minutes), hiit_rounds_planned: blank(c.plannedRounds), hiit_rounds_completed: blank(c.roundsCompleted),
      hiit_hard_mode: blank(c.hardMode), hiit_hard_speed_kph: blank(c.hardSpeed), hiit_hard_incline_pct: blank(c.hardIncline),
      timezone: blank(s.tz), notes: blank(s.notes),
    };
  }
  function setRows(s) {
    if (s.type !== 'lift' || s.status === 'skipped') return [];
    return s.exercises.flatMap(e => e.sets.map(x => ({
      session_id: s.id, date: s.date, start_time: localStamp(s.startedAt), end_time: localStamp(s.endedAt),
      program_version: s.programVersion, week: s.week, workout: s.workout, session_status: s.status,
      exercise: e.name, lift: e.lift, set_no: x.n, planned_weight_kg: e.plannedWeight, actual_weight_kg: e.weight,
      target_reps: e.targetReps, actual_reps: blank(x.reps), result: x.result || 'not_done', effort: blank(x.effort),
      logged_at: localStamp(x.at), session_rpe: blank(s.rpe), bodyweight_kg: blank(s.bodyweight), notes: blank(s.notes),
    })));
  }
  function stateSnapshot() {
    const st = progression();
    return {
      as_of: localStamp(nowIso()), program_version: settings.programVersion, deadlift_sets: Number(settings.deadliftSets),
      lifts: Object.keys(P.lifts).map(k => ({
        lift: k, name: P.lifts[k].name, next_weight_kg: st[k].weight, fail_streak: st[k].failStreak,
        last_result: blank(st[k].last), increment_kg: incFor(k),
      })),
    };
  }

  // ---------- sync (Google Apps Script web app attached to the Lift Log sheet) ----------
  let syncing = false;
  function enqueue(id) {
    if (!queue.includes(id)) queue.push(id);
    syncMeta[id] = { state: 'pending' };
    save(KEYS.queue, queue); save(KEYS.sync, syncMeta);
  }
  async function post(body) {
    const res = await fetch(settings.syncUrl, {
      method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ token: settings.syncToken, ...body }),
    });
    const j = await res.json().catch(() => { throw new Error(`Unexpected response (HTTP ${res.status})`); });
    if (!j.ok) throw new Error(j.error || 'Rejected by sync script');
    return j;
  }
  async function syncNow(manual) {
    if (syncing || !queue.length) return;
    if (!settings.syncUrl) { if (manual) toast('Add the sync URL in Settings first'); return; }
    syncing = true; refreshSyncUi();
    let ok = 0;
    for (const id of [...queue]) {
      const s = sessions.find(x => x.id === id);
      if (s) {
        try {
          await post({ action: 'upsert', session: s, sessionRow: sessionRow(s), setRows: setRows(s), state: stateSnapshot() });
          syncMeta[id] = { state: 'ok', at: nowIso() }; ok++;
        } catch (e) {
          syncMeta[id] = { state: 'error', error: e.message, at: nowIso() };
          save(KEYS.sync, syncMeta);
          if (manual) toast('Sync failed: ' + e.message);
          break;
        }
      }
      queue = queue.filter(x => x !== id);
      save(KEYS.queue, queue); save(KEYS.sync, syncMeta);
    }
    syncing = false;
    if (manual && ok && !queue.length) toast(`Synced ${ok} session${ok > 1 ? 's' : ''} to Drive`);
    refreshSyncUi();
  }
  function syncBadge(id) {
    const m = syncMeta[id] || {};
    if (m.state === 'ok') return `<span class="badge ok">Synced to Drive</span>`;
    if (m.state === 'error') return `<span class="badge err" title="${esc(m.error)}">Sync failed — will retry</span>`;
    if (!settings.syncUrl) return `<span class="badge warn">Saved on phone · sync not set up</span>`;
    return `<span class="badge warn">${syncing ? 'Syncing…' : 'Waiting to sync'}</span>`;
  }
  function refreshSyncUi() { if (!ui.modal) render(); }

  // ---------- rest timer ----------
  let audioCtx = null;
  function unlockAudio() {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
    } catch (e) { /* no audio */ }
  }
  function beep() {
    if (!audioCtx) return;
    const t = audioCtx.currentTime;
    [0, 0.3, 0.6].forEach(o => {
      const osc = audioCtx.createOscillator(), g = audioCtx.createGain();
      osc.frequency.value = 880;
      g.gain.setValueAtTime(0.0001, t + o);
      g.gain.exponentialRampToValueAtTime(0.5, t + o + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + o + 0.22);
      osc.connect(g).connect(audioCtx.destination);
      osc.start(t + o); osc.stop(t + o + 0.25);
    });
  }
  function alarm() {
    if (settings.vibrate && navigator.vibrate) navigator.vibrate([400, 150, 400, 150, 700]);
    if (settings.sound) beep();
  }
  function startTimer(kind, fromIso, label, key) {
    const secs = Number(settings.rest[kind]) || P.rest[kind];
    const start = Date.parse(fromIso);
    timer = { kind, label, key, start, end: start + secs * 1000, fired: false };
    save(KEYS.timer, timer); tick();
  }
  function stopTimer() { timer = null; save(KEYS.timer, null); tick(); }
  function tick() {
    const bar = $('#timer');
    if (!timer) { bar.hidden = true; return; }
    const left = timer.end - Date.now();
    if (left <= 0 && !timer.fired) { timer.fired = true; save(KEYS.timer, timer); alarm(); }
    if (left < -20000) { stopTimer(); return; }
    bar.hidden = false;
    bar.classList.toggle('done', left <= 0);
    bar.dataset.kind = timer.kind;
    const s = Math.max(0, Math.ceil(left / 1000));
    $('.timer-time', bar).textContent = left > 0 ? `${Math.floor(s / 60)}:${pad(s % 60)}` : 'Go!';
    $('.timer-label', bar).textContent = left > 0 ? `Rest · ${timer.label}` : 'Rest over — next set';
    const frac = Math.min(1, Math.max(0, (Date.now() - timer.start) / (timer.end - timer.start)));
    $('.timer-fill', bar).style.width = `${frac * 100}%`;
  }

  // ---------- screen wake lock ----------
  let wakeLock = null;
  async function updateWakeLock() {
    const want = settings.keepAwake && active && active.startedAt && !document.hidden;
    try {
      if (want && !wakeLock && 'wakeLock' in navigator) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      } else if (!want && wakeLock) { await wakeLock.release(); wakeLock = null; }
    } catch (e) { /* not supported / denied */ }
  }

  // ---------- rendering ----------
  function render() {
    document.querySelectorAll('.tabs [data-view]').forEach(b => b.classList.toggle('on', b.dataset.view === ui.view));
    const app = $('#app');
    app.innerHTML = ui.view === 'history' ? renderHistory() : ui.view === 'settings' ? renderSettings() : renderDay();
    renderModal();
    tick();
    updateWakeLock();
  }

  function renderDay() {
    const date = ui.date, today = ui.today, planned = plannedType(date);
    const logged = sessions.filter(s => s.date === date).sort(bySessionTime);
    let h = `
      <header class="day">
        <button class="nav" data-action="day" data-delta="-1" aria-label="Previous day">‹</button>
        <div class="day-title">
          <div class="day-name">${fmtDay(date)}${date === today ? ' <span class="today-dot">Today</span>' : ''}</div>
          <div class="day-date">${fmtDate(date)}</div>
        </div>
        <button class="nav" data-action="day" data-delta="1" aria-label="Next day">›</button>
      </header>
      <div class="meta">${weekOf(date) ? `Week ${weekOf(date)}` : 'Pre-program'} · ${TYPE_LABEL[planned]}
        ${date !== today ? ` · <button class="link" data-action="go-today">Back to today</button>` : ''}</div>`;

    ui.preview = null;
    const showActive = active && date === today;
    if (showActive) h += editor(active, false);
    for (const s of logged) if (!(showActive && s.id === active.id)) h += summaryCard(s);

    const plannedDone = logged.some(s => s.type === planned);
    const workable = ['lift', 'walk', 'hiit'].includes(planned);
    if (!showActive && workable && !plannedDone) {
      if (date === today) {
        ui.preview = newSession(date, planned);
        h += editor(ui.preview, false);
      } else if (date > today) {
        h += editor(newSession(date, planned), true);
      } else {
        h += `<section class="card empty"><p>No ${TYPE_LABEL[planned].toLowerCase()} session logged.</p>
          <button class="btn" data-action="backfill" data-type="${planned}">Log it now</button></section>`;
      }
    }
    if (!workable && !logged.length && !showActive) {
      h += `<section class="card empty"><p>${planned === 'none'
        ? `The program starts on <b>${fmtShort(P.startDate)}</b> with Workout A.`
        : 'Rest day. Recover well.'}</p>${nextUp(date)}</section>`;
    }
    if (date === today && !active) {
      h += `<div class="other"><span>Log another session:</span>
        <button class="chip" data-action="start-other" data-type="lift">Lifting</button>
        <button class="chip" data-action="start-other" data-type="walk">Walk</button>
        <button class="chip" data-action="start-other" data-type="hiit">HIIT</button></div>`;
    }
    return h;
  }

  function nextUp(date) {
    for (let d = addDays(date, 1), i = 0; i < 14; d = addDays(d, 1), i++) {
      if (plannedType(d) === 'lift') {
        const w = workoutFor(d), st = progression();
        return `<p class="muted">Next lifting: <b>${fmtShort(d)}</b> · Workout ${w} — ${P.workouts[w].map(l => `${P.lifts[l].name} ${fmtW(st[l].weight)}`).join(', ')} kg</p>`;
      }
    }
    return '';
  }

  function editor(s, readOnly) {
    return s.type === 'lift' ? liftEditor(s, readOnly) : cardioEditor(s, readOnly);
  }

  function liftEditor(s, readOnly) {
    const started = !!s.startedAt;
    const anyLogged = s.exercises.some(e => e.sets.some(x => x.result));
    let h = `<section class="session ${readOnly ? 'readonly' : ''}">
      <div class="session-head">
        <h2>Workout ${s.workout}</h2>
        ${!readOnly && !anyLogged && !s._editing ? `<div class="seg small">
          <button class="${s.workout === 'A' ? 'on' : ''}" data-action="set-workout" data-w="A">A</button>
          <button class="${s.workout === 'B' ? 'on' : ''}" data-action="set-workout" data-w="B">B</button></div>` : ''}
      </div>
      ${s._editing ? `<p class="muted">Editing a saved session from ${fmtShort(s.date)}.</p>` : ''}
      ${s.date !== ui.today && !readOnly && !s._editing ? `<p class="muted">Session for ${fmtShort(s.date)}.</p>` : ''}
      ${readOnly ? '<p class="muted">Planned — weights update as you log sessions.</p>' :
        s.backfilled ? '<p class="muted">Logged after the fact, so no start/end times.</p>' :
        started ? `<p class="muted">Started ${fmtTime(s.startedAt)}</p>` :
        `<button class="btn primary wide" data-action="start">Start workout</button>`}`;

    s.exercises.forEach((e, i) => {
      const done = e.sets.filter(x => x.result === 'done').length;
      h += `<article class="card ex">
        <div class="ex-head">
          <div>
            <h3>${esc(e.name)}</h3>
            <div class="sub">${e.sets.length}×${e.targetReps} · warm-up ${warmup(e.weight)}</div>
            ${e.weight !== e.plannedWeight ? `<div class="sub changed">Planned ${fmtW(e.plannedWeight)} kg</div>` : ''}
          </div>
          <button class="weight" ${readOnly ? 'disabled' : `data-action="edit-weight" data-ex="${i}"`}>${fmtW(e.weight)}<small>kg</small></button>
        </div>
        <div class="sets">${e.sets.map((x, j) => {
          const cls = x.result === 'done' ? `done ${x.effort}` : x.result === 'failed' ? 'failed' : '';
          const label = x.result === 'failed' ? x.reps : e.targetReps;
          const aria = `Set ${x.n}: ${x.result ? `${x.result}${x.effort ? ' ' + x.effort : ''}` : 'not done'}`;
          return `<button class="set ${cls}" ${readOnly ? 'disabled' : `data-action="tap-set" data-ex="${i}" data-set="${j}"`} aria-label="${aria}">
            <span class="reps">${label}</span>${x.result === 'done' && x.effort === 'hard' ? '<span class="tag">hard</span>' : ''}${x.result === 'failed' ? '<span class="tag">fail</span>' : ''}</button>`;
        }).join('')}</div>
        ${readOnly ? '' : `<div class="ex-foot">${done}/${e.sets.length} sets</div>`}
      </article>`;
    });
    if (!readOnly) {
      h += `<p class="hint">Tap a set: ✓ easy → ✓ hard → ✗ failed. Rest ${fmtSecs(settings.rest.easy)} / ${fmtSecs(settings.rest.hard)} / ${fmtSecs(settings.rest.failed)}.</p>
        <div class="actions">
          <button class="btn primary" data-action="finish">Finish workout</button>
          ${s._editing ? `<button class="btn" data-action="discard">Cancel edit</button>` :
            `<button class="btn" data-action="skip">Skip session</button>
             ${active && active.id === s.id ? `<button class="btn ghost" data-action="discard">Discard</button>` : ''}`}
        </div>`;
    }
    return h + '</section>';
  }
  const fmtSecs = s => (s % 60 ? `${Math.floor(s / 60)}:${pad(s % 60)}` : `${s / 60} min`);

  function cardioEditor(s, readOnly) {
    const c = s.cardio, hiit = s.type === 'hiit';
    const steps = hiit
      ? [P.hiit.warmup, `${c.plannedRounds} rounds: ${P.hiit.hardSec} s hard + ${P.hiit.easySec} s easy`, P.hiit.hard, P.hiit.easy, P.hiit.cooldown]
      : P.walk.steps;
    let h = `<section class="session ${readOnly ? 'readonly' : ''}">
      <div class="session-head"><h2>${TYPE_LABEL[s.type]}</h2></div>
      <article class="card"><ul class="plan">${steps.map(x => `<li>${esc(x)}</li>`).join('')}</ul></article>`;
    if (readOnly) return h + '</section>';
    h += s.backfilled ? '<p class="muted">Logged after the fact, so no start/end times.</p>'
      : s.startedAt ? `<p class="muted">Started ${fmtTime(s.startedAt)}</p>` : `<button class="btn primary wide" data-action="start">Start session</button>`;
    h += `<article class="card form">
      ${field('Duration (min)', `<input type="number" inputmode="numeric" data-field="cardio.minutes" value="${esc(c.minutes)}">`)}`;
    if (hiit) {
      h += field('Rounds completed', stepper('cardio.roundsCompleted', c.roundsCompleted, `of ${c.plannedRounds}`))
        + field('Hard interval', `<div class="seg">
            <button class="${c.hardMode === 'jog' ? 'on' : ''}" data-action="hard-mode" data-mode="jog">Jog</button>
            <button class="${c.hardMode === 'incline' ? 'on' : ''}" data-action="hard-mode" data-mode="incline">Incline walk</button></div>`)
        + field('Hard speed (kph)', `<input type="number" inputmode="decimal" step="0.1" data-field="cardio.hardSpeed" value="${esc(c.hardSpeed)}">`)
        + field('Hard incline (%)', `<input type="number" inputmode="decimal" step="0.5" data-field="cardio.hardIncline" value="${esc(c.hardIncline)}">`);
    }
    h += `</article>
      <div class="actions">
        <button class="btn primary" data-action="finish">Finish session</button>
        ${s._editing ? `<button class="btn" data-action="discard">Cancel edit</button>` :
          `<button class="btn" data-action="skip">Skip session</button>
           ${active && active.id === s.id ? `<button class="btn ghost" data-action="discard">Discard</button>` : ''}`}
      </div></section>`;
    return h;
  }
  const field = (label, control) => `<label class="field"><span>${label}</span>${control}</label>`;
  const stepper = (path, value, suffix) => `<div class="stepper">
    <button data-action="step" data-field="${path}" data-delta="-1" aria-label="Decrease">−</button>
    <b>${esc(value)}</b><button data-action="step" data-field="${path}" data-delta="1" aria-label="Increase">+</button>
    ${suffix ? `<span class="muted">${suffix}</span>` : ''}</div>`;

  function summaryCard(s) {
    const statusCls = { completed: 'ok', partial: 'warn', skipped: 'err' }[s.status] || '';
    const title = s.type === 'lift' ? `Workout ${s.workout}` : TYPE_LABEL[s.type];
    let body = '';
    if (s.status === 'skipped') {
      body = `<p>Skipped${s.skipReason ? `: ${esc(s.skipReason)}` : ''}</p>`;
    } else if (s.type === 'lift') {
      body = `<table class="results">${s.exercises.map(e => `<tr>
        <td>${esc(e.name)}</td><td class="num">${fmtW(e.weight)} kg</td>
        <td class="reps-row">${e.sets.map(x => `<span class="r ${x.result || 'none'}">${x.result ? x.reps : '–'}</span>`).join('')}</td></tr>`).join('')}</table>`;
    } else {
      const c = s.cardio;
      body = `<p>${c.minutes} min${s.type === 'hiit' ? ` · ${c.roundsCompleted}/${c.plannedRounds} rounds · hard ${c.hardMode === 'incline' ? 'incline walk' : 'jog'} ${c.hardSpeed} kph${c.hardIncline ? ` @ ${c.hardIncline}%` : ''}` : ''}</p>`;
    }
    const isLatestLift = s.type === 'lift' && s.status !== 'skipped' &&
      sessions.filter(x => x.type === 'lift' && x.status !== 'skipped').sort(bySessionTime).pop() === s;
    let next = '';
    if (isLatestLift) {
      const st = progression(), w = flip(s.workout);
      next = `<div class="next"><b>Next time</b> (Workout ${w}): ${P.workouts[w].map(l => `${P.lifts[l].name} ${fmtW(st[l].weight)}`).join(' · ')} kg
        ${s.exercises.map(e => st[e.lift].last === 'deload' ? `<div class="warn-text">${e.name}: 3 failed sessions — deloaded to ${fmtW(st[e.lift].weight)} kg</div>` : '').join('')}</div>`;
    }
    return `<section class="card summary">
      <div class="sum-head"><h2>${title}</h2><span class="badge ${statusCls}">${s.status}</span></div>
      <p class="muted">${s.startedAt ? `${fmtTime(s.startedAt)} – ${s.endedAt ? fmtTime(s.endedAt) : '?'} (${minutesBetween(s.startedAt, s.endedAt)} min)` : fmtShort(s.date)}
        ${s.rpe ? ` · Intensity <b>${s.rpe}/10</b>` : ''}${s.bodyweight ? ` · ${s.bodyweight} kg bw` : ''}</p>
      ${body}
      ${s.notes ? `<p class="notes">${esc(s.notes)}</p>` : ''}
      ${next}
      <div class="sum-foot">${syncBadge(s.id)}${active ? '' : `<button class="link" data-action="edit" data-id="${s.id}">Edit</button>`}</div>
    </section>`;
  }

  function renderHistory() {
    const st = progression();
    const list = [...sessions].sort(bySessionTime).reverse();
    return `<h1>History</h1>
      <section class="card"><h3>Current working weights</h3>
        <table class="weights">${Object.keys(P.lifts).map(k => `<tr><td>${P.lifts[k].name}</td><td class="num">${fmtW(st[k].weight)} kg</td>
          <td class="muted">${st[k].failStreak ? `${st[k].failStreak} failed in a row` : ''}</td></tr>`).join('')}</table></section>
      ${list.length ? `<ul class="history">${list.map(s => `<li><button data-action="goto" data-date="${s.date}">
        <span class="h-date">${fmtShort(s.date)}</span>
        <span class="h-what">${s.type === 'lift' ? `Workout ${s.workout}` : TYPE_LABEL[s.type]}${s.type === 'lift' && s.status !== 'skipped' ? ` <span class="muted">${s.exercises.map(e => fmtW(e.weight)).join('/')}</span>` : ''}</span>
        <span class="h-status ${s.status}">${s.status}${s.rpe ? ` · ${s.rpe}` : ''}</span>
        <span class="h-sync ${(syncMeta[s.id] || {}).state || 'pending'}"></span></button></li>`).join('')}</ul>`
        : '<p class="muted">No sessions yet.</p>'}
      ${queue.length ? `<p class="muted">${queue.length} session(s) waiting to sync. <button class="link" data-action="sync-now">Sync now</button></p>` : ''}`;
  }

  function renderSettings() {
    const st = progression();
    const chk = (key, label) => `<label class="toggle"><input type="checkbox" data-setting="${key}" ${settings[key] ? 'checked' : ''}><span>${label}</span></label>`;
    const seg = (key, opts) => `<div class="seg">${opts.map(([v, l]) => `<button class="${String(settings[key]) === String(v) ? 'on' : ''}" data-action="seg-setting" data-key="${key}" data-value="${v}">${l}</button>`).join('')}</div>`;
    return `<h1>Settings</h1>
      <section class="card form"><h3>Google Drive sync</h3>
        ${field('Sync URL (Apps Script web app)', `<input type="url" data-setting="syncUrl" value="${esc(settings.syncUrl)}" placeholder="https://script.google.com/macros/s/…/exec">`)}
        ${field('Sync token', `<input type="password" data-setting="syncToken" value="${esc(settings.syncToken)}" autocomplete="off">`)}
        <div class="row"><button class="btn" data-action="test-sync">Test connection</button>
          <button class="btn" data-action="sync-now">Sync now</button></div>
        <p class="muted">${queue.length ? `${queue.length} session(s) waiting to sync.` : 'Nothing waiting to sync.'}</p>
      </section>

      <section class="card form"><h3>Program</h3>
        <p class="muted">${esc(P.name)} · started ${fmtShort(P.startDate)}</p>
        ${field('Program version (logged with each session)', `<input type="text" data-setting="programVersion" value="${esc(settings.programVersion)}">`)}
        ${field('Deadlift sets', seg('deadliftSets', [[5, '5×5'], [1, '1×5']]))}
        ${field('Deadlift increment', seg('deadliftIncrement', [[5, '+5 kg'], [2.5, '+2.5 kg']]))}
        ${chk('microBench', 'Bench micro-plates (+1.25 kg)')}
        ${chk('microOhp', 'OHP micro-plates (+1.25 kg)')}
        ${field('HIIT rounds', stepper('settings.hiitRounds', settings.hiitRounds))}
        <p class="muted">Settings changes apply to sessions started from now on.</p>
      </section>

      <section class="card"><h3>Working weights</h3>
        <p class="muted">Calculated from your logged sessions. Use Set to change a weight, e.g. after we agree a deload in the project.</p>
        <table class="weights">${Object.keys(P.lifts).map(k => `<tr><td>${P.lifts[k].name}</td><td class="num">${fmtW(st[k].weight)} kg</td>
          <td><button class="link" data-action="adjust" data-lift="${k}">Set</button></td></tr>`).join('')}</table>
      </section>

      <section class="card form"><h3>Rest timer</h3>
        ${field('After an easy set (s)', `<input type="number" inputmode="numeric" data-setting="rest.easy" value="${settings.rest.easy}">`)}
        ${field('After a hard set (s)', `<input type="number" inputmode="numeric" data-setting="rest.hard" value="${settings.rest.hard}">`)}
        ${field('After a failed set (s)', `<input type="number" inputmode="numeric" data-setting="rest.failed" value="${settings.rest.failed}">`)}
        ${chk('vibrate', 'Vibrate when rest is over')}
        ${chk('sound', 'Beep when rest is over')}
        ${chk('keepAwake', 'Keep screen on during a workout')}
        <button class="btn" data-action="test-alarm">Test alarm</button>
      </section>

      <section class="card"><h3>Data</h3>
        <p class="muted">Everything is stored on this phone first. These exports are a backup in case sync ever breaks.</p>
        <div class="row wrap">
          <button class="btn" data-action="export-sets">Export sets (CSV)</button>
          <button class="btn" data-action="export-sessions">Export sessions (CSV)</button>
          <button class="btn" data-action="export-json">Full backup (JSON)</button>
          <label class="btn">Restore backup<input type="file" accept="application/json,.json" data-action-change="restore" hidden></label>
          <button class="btn" data-action="resync-all">Re-sync everything</button>
        </div>
      </section>
      <p class="muted center">Lift Log ${APP_VERSION}</p>`;
  }

  // ---------- modals ----------
  function renderModal() {
    const root = $('#modal'), m = ui.modal;
    if (!m) { root.innerHTML = ''; root.hidden = true; return; }
    root.hidden = false;
    let inner = '';
    if (m.type === 'reps') {
      inner = `<h2>Set ${m.set + 1} failed</h2><p class="muted">How many reps did you get?</p>
        <div class="grid5">${[0, 1, 2, 3, 4].map(n => `<button class="btn big" data-action="pick-reps" data-n="${n}">${n}</button>`).join('')}</div>
        <div class="row">${m.canClear ? `<button class="btn" data-action="clear-set">Clear set</button>` : ''}<button class="btn ghost" data-action="close-modal">Cancel</button></div>`;
    } else if (m.type === 'weight') {
      const e = editing().exercises[m.ex];
      inner = `<h2>${esc(e.name)} weight</h2>
        <div class="weight-edit">
          <button class="btn" data-action="nudge" data-d="-2.5">−2.5</button><button class="btn" data-action="nudge" data-d="-1.25">−1.25</button>
          <input type="number" inputmode="decimal" step="0.25" id="w-input" value="${fmtW(m.value)}">
          <button class="btn" data-action="nudge" data-d="1.25">+1.25</button><button class="btn" data-action="nudge" data-d="2.5">+2.5</button>
        </div>
        <p class="muted">Planned ${fmtW(e.plannedWeight)} kg. Planned and actual weight are both logged.</p>
        <div class="row"><button class="btn primary" data-action="save-weight">Use this weight</button>
          <button class="btn" data-action="reset-weight">Reset to planned</button>
          <button class="btn ghost" data-action="close-modal">Cancel</button></div>`;
    } else if (m.type === 'finish') {
      const s = editing();
      let status = '';
      if (s.type === 'lift') {
        const sets = s.exercises.flatMap(e => e.sets);
        const n = k => sets.filter(x => x.result === k).length;
        status = `<p>${n('done')} done · ${n('failed')} failed · ${sets.length - n('done') - n('failed')} not done</p>`;
      }
      inner = `<h2>${s._editing ? 'Save changes' : 'Finish'}</h2>${status}
        ${field('Session', `<div class="seg" data-group="status">
          <button class="${m.status === 'completed' ? 'on' : ''}" data-action="modal-pick" data-key="status" data-value="completed">Completed</button>
          <button class="${m.status === 'partial' ? 'on' : ''}" data-action="modal-pick" data-key="status" data-value="partial">Partial</button></div>`)}
        <div class="field"><span>Perceived intensity (1 = very easy, 10 = max effort)</span>
          <div class="rpe" data-group="rpe">${[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(n => `<button class="${m.rpe === n ? 'on' : ''}" data-action="modal-pick" data-key="rpe" data-value="${n}">${n}</button>`).join('')}</div></div>
        ${field('Bodyweight (kg, optional)', `<input type="number" inputmode="decimal" step="0.1" id="f-bw" value="${esc(s.bodyweight || '')}">`)}
        ${field('Notes (optional)', `<textarea id="f-notes" rows="3" placeholder="How did it feel? Anything to flag?">${esc(s.notes || '')}</textarea>`)}
        <div class="row"><button class="btn primary" data-action="save-finish" ${m.rpe ? '' : 'disabled'}>Save</button>
          <button class="btn ghost" data-action="close-modal">Back</button></div>`;
    } else if (m.type === 'skip') {
      inner = `<h2>Skip session</h2>
        ${field('Reason', `<textarea id="f-reason" rows="3" placeholder="e.g. sick, travel, work ran late">${esc(editing().skipReason || '')}</textarea>`)}
        <div class="row"><button class="btn primary" data-action="save-skip">Mark as skipped</button>
          <button class="btn ghost" data-action="close-modal">Back</button></div>`;
    } else if (m.type === 'adjust') {
      inner = `<h2>Set ${P.lifts[m.lift].name} weight</h2>
        ${field('Next working weight (kg)', `<input type="number" inputmode="decimal" step="0.25" id="f-adj" value="${fmtW(m.value)}">`)}
        ${field('Reason (optional)', `<input type="text" id="f-adj-note" placeholder="e.g. deload agreed in project">`)}
        <div class="row"><button class="btn primary" data-action="save-adjust">Save</button>
          <button class="btn ghost" data-action="close-modal">Cancel</button></div>`;
    }
    root.innerHTML = `<div class="sheet" role="dialog" aria-modal="true">${inner}</div>`;
  }
  function openModal(m) { ui.modal = m; renderModal(); }
  function closeModal() { ui.modal = null; render(); }

  // ---------- actions ----------
  // The session being worked on: the active one, or today's preview promoted to active.
  function editing() {
    if (!active && ui.preview) { active = ui.preview; ui.preview = null; saveActive(); }
    return active;
  }
  function getPath(obj, path) { return path.split('.').reduce((o, k) => o[k], obj); }
  function setPath(obj, path, v) { const ks = path.split('.'), last = ks.pop(); ks.reduce((o, k) => o[k], obj)[last] = v; }

  function finalize(s) {
    if (!s._editing) s.endedAt = s.backfilled ? null : nowIso();
    if (!s.startedAt && s.endedAt && s.status !== 'skipped') {
      const mins = s.cardio ? Number(s.cardio.minutes) || 0 : 0;
      if (mins) s.startedAt = new Date(Date.parse(s.endedAt) - mins * 60000).toISOString();
    }
    delete s._editing;
    sessions = sessions.filter(x => x.id !== s.id).concat(s);
    saveSessions();
    active = null; saveActive();
    stopTimer();
    enqueue(s.id);
    ui.modal = null; ui.date = s.date;
    render();
    syncNow();
  }

  const actions = {
    day(el) { ui.date = addDays(ui.date, Number(el.dataset.delta)); render(); },
    'go-today'() { ui.date = ui.today; render(); },
    goto(el) { ui.date = el.dataset.date; ui.view = 'today'; render(); window.scrollTo(0, 0); },
    view(el) { ui.view = el.dataset.view; if (ui.view === 'today') ui.date = ui.today; render(); window.scrollTo(0, 0); },

    'set-workout'(el) {
      ui.workoutOverride[ui.date] = el.dataset.w;
      if (active && !active.exercises.some(e => e.sets.some(x => x.result))) {
        const started = active.startedAt;
        active = newSession(active.date, 'lift', el.dataset.w); active.startedAt = started; saveActive();
      }
      render();
    },
    start() { const s = editing(); if (!s.startedAt && !s.backfilled) s.startedAt = nowIso(); saveActive(); render(); },
    'start-other'(el) {
      active = newSession(ui.today, el.dataset.type); saveActive(); render();
    },
    backfill(el) {
      active = newSession(ui.date, el.dataset.type); active.backfilled = true;
      saveActive(); ui.date = ui.today; render();
    },
    discard() {
      if (active._editing || confirm('Discard this session? Nothing from it will be saved.')) {
        active = null; saveActive(); stopTimer(); render();
      }
    },
    edit(el) {
      const s = sessions.find(x => x.id === el.dataset.id);
      active = JSON.parse(JSON.stringify(s)); active._editing = true; saveActive();
      ui.date = ui.today; render(); window.scrollTo(0, 0);
    },

    'tap-set'(el) {
      const s = editing(), i = +el.dataset.ex, j = +el.dataset.set, e = s.exercises[i], x = e.sets[j];
      if (!s.startedAt && !s.backfilled) s.startedAt = nowIso();
      const key = `${i}-${j}`, label = `${e.name} set ${x.n}`;
      if (!x.result) {
        Object.assign(x, { result: 'done', effort: 'easy', reps: e.targetReps, at: nowIso() });
        startTimer('easy', x.at, label, key);
      } else if (x.result === 'done' && x.effort === 'easy') {
        x.effort = 'hard';
        startTimer('hard', x.at, label, key);
      } else {
        saveActive();
        return openModal({ type: 'reps', ex: i, set: j, canClear: x.result === 'failed' });
      }
      saveActive(); render();
    },
    'pick-reps'(el) {
      const m = ui.modal, e = editing().exercises[m.ex], x = e.sets[m.set];
      Object.assign(x, { result: 'failed', effort: null, reps: Number(el.dataset.n), at: x.at || nowIso() });
      startTimer('failed', x.at, `${e.name} set ${x.n}`, `${m.ex}-${m.set}`);
      saveActive(); closeModal();
    },
    'clear-set'() {
      const m = ui.modal, x = editing().exercises[m.ex].sets[m.set];
      Object.assign(x, { result: null, effort: null, reps: null, at: null });
      if (timer && timer.key === `${m.ex}-${m.set}`) stopTimer();
      saveActive(); closeModal();
    },

    'edit-weight'(el) { const e = editing().exercises[+el.dataset.ex]; openModal({ type: 'weight', ex: +el.dataset.ex, value: e.weight }); },
    nudge(el) { const inp = $('#w-input'); inp.value = fmtW(Math.max(0, (parseFloat(inp.value) || 0) + Number(el.dataset.d))); },
    'save-weight'() {
      const v = parseFloat($('#w-input').value);
      if (!(v >= 0)) return toast('Enter a weight');
      editing().exercises[ui.modal.ex].weight = roundW(v); saveActive(); closeModal();
    },
    'reset-weight'() { const e = editing().exercises[ui.modal.ex]; e.weight = e.plannedWeight; saveActive(); closeModal(); },

    'hard-mode'(el) { editing().cardio.hardMode = el.dataset.mode; saveActive(); render(); },
    step(el) {
      const path = el.dataset.field, d = Number(el.dataset.delta);
      if (path.startsWith('settings.')) {
        const k = path.slice(9); settings[k] = Math.max(1, (Number(settings[k]) || 0) + d); saveSettings();
      } else {
        const s = editing(); setPath(s, path, Math.max(0, (Number(getPath(s, path)) || 0) + d)); saveActive();
      }
      render();
    },

    finish() {
      const s = editing();
      let status = s.status === 'partial' || s.status === 'completed' ? s.status : 'completed';
      if (s.type === 'lift' && !s._editing) status = s.exercises.every(e => e.sets.every(x => x.result)) ? 'completed' : 'partial';
      if (s.type === 'hiit' && !s._editing && s.cardio.roundsCompleted < s.cardio.plannedRounds) status = 'partial';
      openModal({ type: 'finish', status, rpe: s.rpe });
    },
    'modal-pick'(el) {
      const k = el.dataset.key;
      ui.modal[k] = k === 'rpe' ? Number(el.dataset.value) : el.dataset.value;
      el.parentElement.querySelectorAll('button').forEach(b => b.classList.toggle('on', b === el));
      const btn = $('[data-action="save-finish"]'); if (btn) btn.disabled = !ui.modal.rpe;
    },
    'save-finish'() {
      const s = editing(), m = ui.modal;
      const bw = parseFloat($('#f-bw').value);
      Object.assign(s, { status: m.status, rpe: m.rpe, bodyweight: bw > 0 ? bw : null, notes: $('#f-notes').value.trim(), skipReason: null });
      finalize(s);
      toast('Session saved');
    },
    skip() { openModal({ type: 'skip' }); },
    'save-skip'() {
      const s = editing(), reason = $('#f-reason').value.trim();
      if (!reason) return toast('Add a short reason');
      Object.assign(s, { status: 'skipped', skipReason: reason, rpe: null });
      if (s.type === 'lift') s.exercises.forEach(e => e.sets.forEach(x => Object.assign(x, { result: null, effort: null, reps: null, at: null })));
      s.startedAt = null;
      finalize(s);
    },
    'close-modal'() { closeModal(); },

    'timer-add'() { if (timer) { timer.end += 30000; timer.fired = false; save(KEYS.timer, timer); tick(); } },
    'timer-stop'() { stopTimer(); },
    'test-alarm'() { unlockAudio(); alarm(); },

    'seg-setting'(el) { settings[el.dataset.key] = Number(el.dataset.value); saveSettings(); render(); },
    adjust(el) { openModal({ type: 'adjust', lift: el.dataset.lift, value: progression()[el.dataset.lift].weight }); },
    'save-adjust'() {
      const v = parseFloat($('#f-adj').value);
      if (!(v > 0)) return toast('Enter a weight');
      settings.adjustments.push({ lift: ui.modal.lift, weight: roundW(v), at: nowIso(), note: $('#f-adj-note').value.trim() });
      saveSettings(); closeModal(); toast('Weight updated');
    },
    async 'test-sync'() {
      if (!settings.syncUrl || !settings.syncToken) return toast('Enter the sync URL and token first');
      toast('Testing…');
      try { const j = await post({ action: 'ping' }); toast(j.message || 'Connected'); }
      catch (e) { toast('Failed: ' + e.message); }
    },
    'sync-now'() { syncNow(true); },
    'resync-all'() {
      if (!confirm(`Send all ${sessions.length} sessions to Drive again? Existing rows are replaced, not duplicated.`)) return;
      sessions.forEach(s => enqueue(s.id)); syncNow(true);
    },
    'export-sets'() { download(`lift-log-sets-${ui.today}.csv`, toCsv(sessions.sort(bySessionTime).flatMap(setRows), SET_COLS), 'text/csv'); },
    'export-sessions'() { download(`lift-log-sessions-${ui.today}.csv`, toCsv(sessions.sort(bySessionTime).map(sessionRow), SESSION_COLS), 'text/csv'); },
    'export-json'() {
      download(`lift-log-backup-${ui.today}.json`, JSON.stringify({ app: 'lift-log', version: APP_VERSION, exportedAt: nowIso(), settings: { ...settings, syncToken: undefined }, sessions }, null, 2), 'application/json');
    },
  };

  async function restore(file) {
    try {
      const data = JSON.parse(await file.text());
      if (!Array.isArray(data.sessions)) throw new Error('Not a Lift Log backup');
      if (!confirm(`Restore ${data.sessions.length} sessions from this backup? Sessions with the same id are replaced.`)) return;
      const byId = new Map(sessions.map(s => [s.id, s]));
      data.sessions.forEach(s => byId.set(s.id, s));
      sessions = [...byId.values()]; saveSessions();
      if (data.settings && Array.isArray(data.settings.adjustments)) {
        const seen = new Set(settings.adjustments.map(a => a.at + a.lift));
        data.settings.adjustments.forEach(a => { if (!seen.has(a.at + a.lift)) settings.adjustments.push(a); });
        saveSettings();
      }
      toast('Backup restored'); render();
    } catch (e) { toast('Restore failed: ' + e.message); }
  }

  function toCsv(rows, cols) {
    const cell = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    return [cols.join(','), ...rows.map(r => cols.map(c => cell(r[c])).join(','))].join('\n');
  }
  function download(name, text, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  let toastTimer;
  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 3000);
  }

  // ---------- events ----------
  document.addEventListener('pointerdown', unlockAudio, { passive: true });
  document.addEventListener('click', e => {
    const el = e.target.closest('[data-action]');
    if (el && !el.disabled && actions[el.dataset.action]) actions[el.dataset.action](el, e);
    else if (e.target.id === 'modal') closeModal();
  });
  document.addEventListener('change', e => {
    const el = e.target;
    if (el.dataset.actionChange === 'restore' && el.files[0]) { restore(el.files[0]); el.value = ''; return; }
    if (el.dataset.setting) {
      const v = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value.trim();
      setPath(settings, el.dataset.setting, v); saveSettings();
      if (el.dataset.setting === 'syncUrl' && v) syncNow();
    } else if (el.dataset.field) {
      const s = editing(); setPath(s, el.dataset.field, el.value === '' ? null : Number(el.value)); saveActive();
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    const t = todayStr();
    if (t !== ui.today) { if (ui.date === ui.today) ui.date = t; ui.today = t; if (!ui.modal) render(); }
    tick(); updateWakeLock(); syncNow();
  });
  window.addEventListener('online', () => syncNow());
  setInterval(tick, 500);
  setInterval(() => { if (queue.length && navigator.onLine) syncNow(); }, 60000);

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

  render();
  syncNow();
})();
