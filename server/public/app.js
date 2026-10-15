import { lineChart, columnChart } from './charts.js';
import { DEMO_KEY, demoFromLocation, redactReview, isDrinkingChart } from './demo.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

function setStatus(node, message, kind = '') {
  node.textContent = message;
  node.className = `status ${kind}`;
}

const state = { today: null, day: null, range: 30, demo: false };

// ---------------- demo mode ----------------
// Hides drinking and CBD on screen for showing the app to others (see demo.js). Saved in this browser only.
function applyDemo(on) {
  state.demo = on;
  document.body.classList.toggle('demo', on);
  $('#demo-mode').checked = on;
}
function setupDemo() {
  let storage = null;
  try {
    storage = window.localStorage;
  } catch {
    // storage blocked: demo mode starts off unless ?demo=1
  }
  applyDemo(demoFromLocation(location.search, storage));
  $('#demo-mode').addEventListener('change', (e) => {
    applyDemo(e.target.checked);
    try {
      localStorage.setItem(DEMO_KEY, e.target.checked ? '1' : '0');
    } catch {
      // private browsing: the switch still works until the page is closed
    }
    route();
  });
}

// ---------------- routing ----------------
const VIEWS = ['today', 'training', 'health', 'meds', 'labs', 'reviews', 'prompt', 'activity'];
let currentView = null;
function route() {
  if (location.hash === '#history') return location.replace('#health'); // the old name of the Health tab
  // A view can carry a detail after a slash (#reviews/2026-10-03 picks a past review).
  const name = location.hash.slice(1).split('/')[0];
  const view = VIEWS.includes(name) ? name : 'today';
  // Choosing another week on the Reviews tab re-renders from the reviews already loaded.
  if (view === 'reviews' && currentView === 'reviews' && reviewsView.list) return renderReviews();
  currentView = view;
  for (const v of VIEWS) $(`#view-${v}`).hidden = v !== view;
  $$('.top nav a').forEach((a) => (a.getAttribute('href') === `#${view}` ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
  ({ today: loadDay, training: loadTrainingTab, health: loadHealthTab, meds: loadMeds, labs: loadLabs, reviews: loadReviews, prompt: loadSections, activity: loadActivity })[view]();
}

// ---------------- 1 to 10 scales ----------------
function scale(container, field, label, hint) {
  const wrap = document.createElement('div');
  wrap.className = 'scale';
  const head = document.createElement('div');
  head.className = 'scale-label';
  const name = document.createElement('span');
  name.textContent = label;
  const hintNode = document.createElement('span');
  hintNode.className = 'small';
  hintNode.textContent = hint ?? '';
  head.append(name, hintNode);
  const buttons = document.createElement('div');
  buttons.className = 'scale-buttons';
  buttons.setAttribute('role', 'group');
  buttons.setAttribute('aria-label', label);
  buttons.dataset.field = field;
  for (let i = 1; i <= 10; i++) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = String(i);
    b.setAttribute('aria-pressed', 'false');
    b.addEventListener('click', () => {
      const on = b.getAttribute('aria-pressed') === 'true';
      $$('button', buttons).forEach((x) => x.setAttribute('aria-pressed', 'false'));
      if (!on) b.setAttribute('aria-pressed', 'true');
    });
    buttons.append(b);
  }
  wrap.append(head, buttons);
  container.append(wrap);
}
const scaleValue = (form, field) => {
  const on = $(`.scale-buttons[data-field="${field}"] button[aria-pressed="true"]`, form);
  return on ? Number(on.textContent) : null;
};
const setScale = (form, field, value) => {
  $$(`.scale-buttons[data-field="${field}"] button`, form).forEach((b) => b.setAttribute('aria-pressed', String(Number(b.textContent) === value)));
};

// ---------------- today ----------------
const CHECKIN_SCALES = [
  ['readiness', 'Morning readiness', '1 low, 10 high'],
  ['energy', 'Energy'],
  ['mood', 'Mood'],
  ['stress', 'Stress', '1 calm, 10 very stressed'],
  ['nutrition', 'Nutrition quality'],
];
const BODY = ['weight_lbs', 'body_fat_pct', 'muscle_mass_lbs', 'visceral_fat'];
const DRINKS = [['beers', 'Beer'], ['wine', 'Wine'], ['bourbon', 'Bourbon'], ['other', 'Other mixed'], ['cbd', 'CBD']];
const ALCOHOL = ['beers', 'wine', 'bourbon', 'other'];
const counts = {};

function buildTodayForms() {
  for (const [f, label, hint] of CHECKIN_SCALES) scale($('#checkin-scales'), f, label, hint);
  scale($('#drink-scales'), 'mood_before', 'Mood before drinking');
  scale($('#drink-scales'), 'mood_after', 'Mood after drinking');

  for (const [f, label] of DRINKS) {
    counts[f] = 0;
    const row = document.createElement('div');
    row.className = 'counter';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = label;
    const minus = document.createElement('button');
    minus.type = 'button';
    minus.textContent = '−';
    minus.setAttribute('aria-label', `One less ${label}`);
    const n = document.createElement('span');
    n.className = 'n';
    n.dataset.field = f;
    n.textContent = '0';
    const plus = document.createElement('button');
    plus.type = 'button';
    plus.textContent = '+';
    plus.setAttribute('aria-label', `One more ${label}`);
    minus.addEventListener('click', () => setCount(f, counts[f] - 1));
    plus.addEventListener('click', () => setCount(f, counts[f] + 1));
    row.append(name, minus, n, plus);
    $('#drink-counters').append(row);
  }

  $('#day').addEventListener('change', () => loadDay());
  $('#day-prev').addEventListener('click', () => stepDay(-1));
  $('#day-next').addEventListener('click', () => stepDay(1));
  $('#day-today').addEventListener('click', () => { $('#day').value = state.today; loadDay(); });
  $('#checkin').addEventListener('submit', saveCheckin);
  $('#drinking').addEventListener('submit', saveDrinking);
  $$('[data-delete]').forEach((b) => b.addEventListener('click', () => deleteEntry(b.dataset.delete)));
  $('#sync-now').addEventListener('click', syncNow);
  $('#doses').addEventListener('submit', saveDoses);
  $('#doses-all').addEventListener('click', () => $$('#dose-list input[type="checkbox"]').forEach((c) => { c.checked = true; }));
  $('#doses-clear').addEventListener('click', clearDoses);
}

// ---------------- daily check-off ----------------
const SLOT_ORDER = ['morning', 'afternoon', 'before_workout', 'during_workout', 'after_workout', 'before_bed', 'daily'];

// The day shown in the check-off, with any one-day adjustments made in the editor (dose, movedTo) before saving.
let doseDay = null;
let doseEditing = null; // 'medicationId|timing' of the open editor

/** Keeps the checkboxes' current state in doseDay before the list is redrawn. */
function keepDoseChecks() {
  for (const c of $$('#dose-list input[type="checkbox"]')) {
    const slot = doseDay.items.find((m) => m.id === Number(c.dataset.med))?.slots.find((s) => s.timing === c.dataset.timing);
    if (slot) slot.taken = c.checked;
  }
}

/** The inline editor for one slot: dose and slot for this day only, defaults from the Meds tab. */
function doseEditor(m, s) {
  const close = () => { doseEditing = null; renderDoses(doseDay, { keep: true }); };
  const dose = h('input', { type: 'text', maxlength: '100', value: s.dose ?? '', placeholder: s.defaultDose ? `Default: ${s.defaultDose}` : 'Dose taken', 'aria-label': `Dose of ${m.name} taken on this day` });
  const slot = h('select', { 'aria-label': `When ${m.name} was taken on this day` },
    SLOT_ORDER.map((t) => h('option', { value: t, selected: (s.movedTo ?? s.timing) === t }, `${TIMING_LABELS[t]}${t === s.timing ? ' (scheduled)' : ''}`)));
  return h('div', { class: 'dose-editor' },
    h('div', { class: 'grid2' }, h('label', {}, 'Dose taken', dose), h('label', {}, 'Taken', slot)),
    h('p', { class: 'muted small' }, 'For this day only. Change the default on the ', h('a', { href: '#meds' }, 'Meds'), ' tab.'),
    h('div', { class: 'actions' },
      h('button', { type: 'button', onclick: () => { s.dose = dose.value.trim() || null; s.movedTo = slot.value === s.timing ? null : slot.value; close(); } }, 'Apply'),
      h('button', { type: 'button', class: 'ghost', onclick: () => { s.dose = null; s.movedTo = null; close(); } }, 'Reset to default'),
      h('button', { type: 'button', class: 'ghost', onclick: close }, 'Cancel')));
}

function renderDoses(day, { keep = false } = {}) {
  if (keep) keepDoseChecks();
  else doseEditing = null; // a freshly loaded day starts with no editor open
  doseDay = day;
  const list = $('#dose-list');
  const form = $('#doses');
  const status = $('.status', form);
  list.replaceChildren();
  const hasItems = day.items.length > 0;
  $('button[type="submit"]', form).hidden = !hasItems;
  $('#doses-all').hidden = !hasItems;
  $('#doses-clear').hidden = !day.saved;
  if (!hasItems) {
    list.append(h('p', { class: 'muted small' }, 'Nothing in effect on this day. Add what you take on the ', h('a', { href: '#meds' }, 'Meds'), ' tab.'));
    setStatus(status, '');
    return;
  }
  // Grouped by the slot each was actually taken in (a one-day move), otherwise its scheduled slot.
  for (const slot of SLOT_ORDER) {
    const rows = day.items.flatMap((m) => m.slots.filter((s) => (s.movedTo ?? s.timing) === slot).map((s) => ({ m, s })));
    if (!rows.length) continue;
    list.append(h('div', { class: 'dose-group' }, h('div', { class: 'dose-slot' }, TIMING_LABELS[slot]),
      rows.map(({ m, s }) => {
        const key = `${m.id}|${s.timing}`;
        // defaultDose is the period's dose, or its ingredients as one line ("Alpha 5 mg + Beta 10 mg").
        const shownDose = s.dose ?? s.defaultDose;
        const notes = [s.dose && s.defaultDose ? `default ${s.defaultDose}` : s.dose ? 'adjusted' : null, s.movedTo ? `moved from ${TIMING_LABELS[s.timing]}` : null].filter(Boolean);
        return h('div', { class: `dose-row${notes.length ? ' adjusted' : ''}` },
          h('label', { class: 'check dose' },
            h('input', { type: 'checkbox', checked: s.taken === true, 'data-med': String(m.id), 'data-timing': s.timing }),
            h('span', {}, m.name, shownDose ? h('span', { class: `${s.dose ? '' : 'muted'}${m.ingredients && !s.dose ? ' ingredients-line' : ''}` }, ` ${shownDose}`) : null,
              notes.length ? h('span', { class: 'muted small' }, ` (${notes.join('; ')})`) : null)),
          h('button', { type: 'button', class: 'link small dose-adjust', 'aria-expanded': String(doseEditing === key),
            onclick: () => { doseEditing = doseEditing === key ? null : key; renderDoses(doseDay, { keep: true }); } }, 'Adjust'),
          doseEditing === key ? doseEditor(m, s) : null);
      })));
  }
  const adjusted = day.items.some((m) => m.slots.some((s) => s.dose || s.movedTo));
  setStatus(status, day.saved ? `Saved (unchecked items are recorded as skipped)${adjusted ? '; adjustments apply to this day only' : ''}` : 'Not logged for this day');
}

async function saveDoses(evt) {
  evt.preventDefault();
  const status = $('.status', evt.currentTarget);
  keepDoseChecks();
  doseEditing = null;
  const doses = doseDay.items.flatMap((m) => m.slots.map((s) => ({ medication_id: m.id, timing: s.timing, taken: s.taken === true, dose: s.dose ?? null, moved_to: s.movedTo ?? null })));
  try {
    renderDoses(await api('PUT', `/api/doses/${$('#day').value}`, { doses }));
    setStatus(status, 'Saved (unchecked items are recorded as skipped)', 'ok');
  } catch (err) {
    setStatus(status, err.message, 'error');
  }
}

async function clearDoses() {
  const date = $('#day').value;
  if (!confirm(`Clear the check-off for ${date}? The day goes back to not logged.`)) return;
  try {
    await api('DELETE', `/api/doses/${date}`);
    await loadDay();
  } catch (err) {
    setStatus($('.status', $('#doses')), err.message, 'error');
  }
}

function setCount(field, value) {
  counts[field] = Math.max(0, Math.min(50, value));
  $(`.counter .n[data-field="${field}"]`).textContent = String(counts[field]);
  const alcohol = ALCOHOL.reduce((s, f) => s + counts[f], 0);
  $('#drink-total').textContent = `${alcohol} alcoholic drink${alcohol === 1 ? '' : 's'}${counts.cbd ? `, ${counts.cbd} CBD (not counted as alcohol)` : ''}`;
}

/** Data check warnings under the day line (stale or missing Apple Health days, partial days); hidden when none. */
function renderDataChecks(checks = []) {
  $('#data-checks').hidden = !checks.length;
  fill($('#data-checks'), checks.map((c) => h('li', {}, h('span', { 'aria-hidden': 'true' }, '⚠ '), c.message)));
}

async function loadStatus() {
  const s = await api('GET', '/api/status');
  state.today = s.today;
  $('#day').max = s.today;
  if (!$('#day').value) $('#day').value = s.today;
  renderDataChecks(s.dataChecks);
  loadReviewNotice();
  // The demo instance (npm run demo): a banner, no sync, and no privacy toggle (there is nothing real to hide).
  const demoInstance = s.instance === 'demo';
  $('#instance-banner').hidden = !demoInstance;
  $('#sync-now').hidden = s.sync === false;
  document.querySelector('.demo-toggle').hidden = demoInstance;
  if (demoInstance) document.title = 'Health Review (demo data)';
  const last = s.lastSync;
  $('#sync-status').textContent = last
    ? `Last sync ${new Date(last.finished_at ?? last.started_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}${last.status === 'ok' ? '' : ` (${last.status})`}`
    : 'Not synced yet';
}

/** Moves the Today tab back or forward by days, never past today. */
function stepDay(n) {
  const next = addDays($('#day').value || state.today, n);
  if (next > state.today) return;
  $('#day').value = next;
  loadDay();
}

async function loadDay() {
  if (!state.today) await loadStatus();
  const date = $('#day').value || state.today;
  $('#day-next').disabled = date >= state.today;
  $('#day-today').disabled = date === state.today;
  const { checkin, drinking, medications } = await api('GET', `/api/days/${date}`);
  state.day = { checkin, drinking };
  renderDoses(medications);

  const cf = $('#checkin');
  for (const [f] of CHECKIN_SCALES) setScale(cf, f, checkin?.[f] ?? null);
  for (const f of BODY) cf.elements[f].value = checkin?.[f] ?? '';
  $('#body-details').open = BODY.some((f) => checkin?.[f] != null);
  cf.elements.notes.value = checkin?.notes ?? '';
  $('[data-delete="checkin"]').hidden = !checkin;
  setStatus($('.status', cf), checkin ? `Saved${checkin.cadence === 'weekly' ? ' (weekly check-in from v1)' : ''}` : '');

  const df = $('#drinking');
  for (const [f] of DRINKS) setCount(f, drinking?.[f] ?? 0);
  df.elements.setting.value = drinking?.setting ?? '';
  setScale(df, 'mood_before', drinking?.mood_before ?? null);
  setScale(df, 'mood_after', drinking?.mood_after ?? null);
  df.elements.notes.value = drinking?.notes ?? '';
  $('[data-delete="drinking"]').hidden = !drinking;
  setStatus($('.status', df), drinking ? 'Saved' : 'Nothing logged for this day');
}

const numberOrNull = (input) => (input.value === '' ? null : Number(input.value));

async function saveCheckin(evt) {
  evt.preventDefault();
  const form = evt.currentTarget;
  const status = $('.status', form);
  const body = {};
  for (const [f] of CHECKIN_SCALES) body[f] = scaleValue(form, f);
  for (const f of BODY) body[f] = numberOrNull(form.elements[f]);
  body.notes = form.elements.notes.value.trim() || null;
  try {
    await api('PUT', `/api/checkins/${$('#day').value}`, body);
    await loadDay();
    setStatus(status, 'Saved', 'ok');
  } catch (err) {
    setStatus(status, err.message, 'error');
  }
}

async function saveDrinking(evt) {
  evt.preventDefault();
  const form = evt.currentTarget;
  const status = $('.status', form);
  const body = { ...counts };
  body.setting = form.elements.setting.value.trim() || null;
  body.mood_before = scaleValue(form, 'mood_before');
  body.mood_after = scaleValue(form, 'mood_after');
  body.notes = form.elements.notes.value.trim() || null;
  try {
    await api('PUT', `/api/drinking/${$('#day').value}`, body);
    await loadDay();
    setStatus(status, 'Saved', 'ok');
  } catch (err) {
    setStatus(status, err.message, 'error');
  }
}

async function deleteEntry(kind) {
  const date = $('#day').value;
  const what = kind === 'checkin' ? 'check-in' : 'drinks';
  if (!confirm(`Delete the ${what} for ${date}?`)) return;
  const form = kind === 'checkin' ? $('#checkin') : $('#drinking');
  try {
    await api('DELETE', `/api/${kind === 'checkin' ? 'checkins' : 'drinking'}/${date}`);
    await loadDay();
    setStatus($('.status', form), 'Deleted', 'ok');
  } catch (err) {
    setStatus($('.status', form), err.message, 'error');
  }
}

async function syncNow() {
  const btn = $('#sync-now');
  btn.disabled = true;
  $('#sync-status').textContent = 'Syncing...';
  try {
    const r = await api('POST', '/api/sync');
    const added = (r.counts.health_metrics?.upserted ?? 0) + (r.counts.workout_sessions?.upserted ?? 0);
    $('#sync-status').textContent = `Synced (${added} rows checked${r.warnings ? `, ${r.warnings} warnings in the sync log` : ''})`;
    renderDataChecks((await api('GET', '/api/status')).dataChecks);
  } catch (err) {
    $('#sync-status').textContent = `Sync failed: ${err.message}`;
  } finally {
    btn.disabled = false;
    if (location.hash === '#activity') loadActivity();
  }
}

// ---------------- history ----------------
const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const fmt = (digits, unit = '') => (v) => `${v.toLocaleString(undefined, { maximumFractionDigits: digits })}${unit}`;

const CHARTS = [
  { key: 'hrv_ms', title: 'Heart rate variability', from: 'metrics', format: fmt(0, ' ms') },
  { key: 'resting_hr', title: 'Resting heart rate', from: 'metrics', format: fmt(0, ' bpm') },
  { key: 'sleep_total_hr', title: 'Sleep', from: 'metrics', format: fmt(1, ' h') },
  { key: 'steps', title: 'Steps', from: 'metrics', format: fmt(0) },
  { key: 'exercise_min', title: 'Exercise minutes', from: 'metrics', format: fmt(0, ' min'), columns: true },
  { key: 'cardio_recovery_bpm', title: 'Cardio recovery', from: 'metrics', format: fmt(0, ' bpm') },
  { key: 'walking_hr_avg', title: 'Walking heart rate', from: 'metrics', format: fmt(0, ' bpm') },
  { key: 'walking_speed_mph', title: 'Walking speed', from: 'metrics', format: fmt(2, ' mph') },
  { key: 'wrist_temp_f', title: 'Sleeping wrist temperature', from: 'metrics', format: fmt(1, ' °F') },
  // Values only, no reference lines or labels (discussed with a physician, like labs).
  { key: 'spo2_pct', title: 'Blood oxygen', from: 'metrics', format: fmt(1, '%') },
  { key: 'breathing_disturbances', title: 'Breathing disturbances', from: 'metrics', format: fmt(1) },
  { key: 'readiness', title: 'Morning readiness (1 to 10)', from: 'checkins', format: fmt(0), gapDays: 8 },
  { key: 'alcohol', title: 'Alcoholic drinks per day', from: 'drinking', format: fmt(0), columns: true },
];

function tableView(points, format) {
  const details = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = 'Table';
  const scroll = document.createElement('div');
  scroll.className = 'table-scroll';
  const table = document.createElement('table');
  const head = table.createTHead().insertRow();
  for (const h of ['Date', 'Value']) {
    const th = document.createElement('th');
    th.textContent = h;
    head.append(th);
  }
  const body = table.createTBody();
  for (const p of [...points].reverse()) {
    const row = body.insertRow();
    row.insertCell().textContent = p.date;
    row.insertCell().textContent = format(p.value);
  }
  scroll.append(table);
  details.append(summary, scroll);
  return details;
}

function loadHealthTab() {
  loadVo2();
  return loadHistory();
}

async function loadHistory() {
  if (!state.today) await loadStatus();
  $$('[data-range]').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.range) === state.range)));
  const to = state.today;
  const from = addDays(to, -(state.range - 1));
  const data = await api('GET', `/api/history?from=${from}&to=${to}`);
  const container = $('#charts');
  container.replaceChildren();
  for (const c of CHARTS.filter((x) => !(state.demo && isDrinkingChart(x)))) {
    const points = data[c.from].filter((r) => r[c.key] !== null && r[c.key] !== undefined).map((r) => ({ date: r.date, value: r[c.key] }));
    const card = document.createElement('div');
    card.className = 'chart-card';
    const head = document.createElement('div');
    head.className = 'chart-head';
    const h = document.createElement('h3');
    h.textContent = c.title;
    const latest = document.createElement('span');
    latest.className = 'latest';
    if (points.length) {
      const avg = points.reduce((s, p) => s + p.value, 0) / points.length;
      latest.textContent = `avg ${c.format(avg)}`;
    }
    head.append(h, latest);
    const chart = document.createElement('div');
    chart.className = 'chart';
    card.append(head, chart, tableView(points, c.format));
    container.append(card);
    const opts = { from, to, format: c.format, label: c.title, gapDays: c.gapDays };
    (c.columns ? columnChart : lineChart)(chart, points, opts);
  }
}

// ---------------- medications and supplements ----------------
/** Small element builder: h('div', { class: 'x' }, 'text', child). Text goes in as text nodes. */
/** replaceChildren that skips null and false (replaceChildren itself would print "null"). */
const fill = (el, ...kids) => el.replaceChildren(...kids.flat().filter((k) => k !== null && k !== undefined && k !== false));

function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v === null || v === undefined) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k in node && typeof v !== 'string') node[k] = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return node;
}

const TIMING_LABELS = { morning: 'Morning', afternoon: 'Afternoon', before_workout: 'Before workout', during_workout: 'During workout', after_workout: 'After workout', before_bed: 'Before bed', daily: 'Daily' };
const IMPACT_LABELS = { hrv_ms: ['HRV', ' ms'], resting_hr: ['Resting heart rate', ' bpm'], sleep_total_hr: ['Sleep', ' h'], readiness: ['Readiness', ''], energy: ['Energy', ''], mood: ['Mood', ''], stress: ['Stress', ''] };
const niceDate = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
/** The dose as one line: the dose, or each ingredient with its dose ("Alpha 5 mg + Beta 10 mg"). */
const doseLine = (r) => r.dose ?? (r.ingredients?.length ? r.ingredients.map((i) => (i.dose ? `${i.name} ${i.dose}` : i.name)).join(' + ') : null);
const regimenText = (r) => [doseLine(r), r.timings.map((t) => TIMING_LABELS[t].toLowerCase()).join(', ')].filter(Boolean).join(', ');

/**
 * One dose, or a list of ingredients each with its dose (a compounded pill, a blend). The returned element's read()
 * gives { dose, ingredients } for the API, with the unused one null.
 */
function regimenEditor({ dose = null, ingredients = null } = {}) {
  const group = `regimen-${Math.random().toString(36).slice(2)}`;
  const many = h('input', { type: 'radio', name: group, value: 'ingredients', checked: Boolean(ingredients?.length) });
  const one = h('input', { type: 'radio', name: group, value: 'dose', checked: !ingredients?.length });
  const single = h('label', {}, 'Dose', h('input', { type: 'text', maxLength: 100, value: dose ?? '', placeholder: '500 mg, 2 capsules' }));
  const rows = h('div', { class: 'ingredient-rows' });
  const addRow = (i = {}) => {
    const row = h('div', { class: 'ingredient-row' },
      h('input', { type: 'text', maxLength: 100, value: i.name ?? '', placeholder: 'Ingredient', 'aria-label': 'Ingredient name' }),
      h('input', { type: 'text', maxLength: 100, value: i.dose ?? '', placeholder: 'Dose', 'aria-label': 'Ingredient dose' }),
      h('button', { type: 'button', class: 'ghost small', onclick: () => { row.remove(); if (!rows.children.length) addRow(); } }, 'Remove'));
    rows.append(row);
    return row;
  };
  (ingredients?.length ? ingredients : [{}, {}]).forEach(addRow);
  const list = h('div', { class: 'ingredients' }, rows,
    h('button', { type: 'button', class: 'ghost small', onclick: () => $('input', addRow())?.focus() }, 'Add ingredient'));
  const show = () => { single.hidden = many.checked; list.hidden = !many.checked; };
  one.addEventListener('change', show);
  many.addEventListener('change', show);
  show();
  const el = h('fieldset', { class: 'regimen' }, h('legend', {}, 'Dose'),
    h('div', { class: 'opts' }, h('label', {}, one, 'One dose'), h('label', {}, many, 'Ingredients, each with a dose')),
    single, list);
  el.read = () => {
    if (!many.checked) return { dose: $('input', single).value.trim() || null, ingredients: null };
    const items = $$('.ingredient-row', rows).map((r) => $$('input', r).map((x) => x.value.trim()))
      .filter(([name]) => name).map(([name, d]) => ({ name, dose: d || null }));
    return { dose: null, ingredients: items.length ? items : null };
  };
  return el;
}

function fillTimings(fieldset, selected = []) {
  const opts = h('div', { class: 'opts' }, Object.entries(TIMING_LABELS).map(([value, label]) =>
    h('label', {}, h('input', { type: 'checkbox', value, checked: selected.includes(value) }), label)));
  [...fieldset.children].filter((c) => c.tagName !== 'LEGEND').forEach((c) => c.remove());
  fieldset.append(opts);
}
const readTimings = (fieldset) => $$('input:checked', fieldset).map((i) => i.value);
function timingFieldset(selected) {
  const fs = h('fieldset', { class: 'timings' }, h('legend', {}, 'When you take it'));
  fillTimings(fs, selected);
  return fs;
}

async function medAction(statusNode, fn) {
  try {
    await fn();
    await loadMeds();
  } catch (err) {
    setStatus(statusNode, err.message, 'error');
  }
}

/** A collapsible inline form under a card; only one is open per card. */
function inlineForm(card, title, fields, submitLabel, onSubmit) {
  $('.inline-form', card)?.remove();
  const status = h('span', { class: 'status', role: 'status' });
  const form = h('form', { class: 'inline-form' }, h('p', { class: 'small muted' }, title), ...fields,
    h('div', { class: 'actions' }, h('button', { type: 'submit' }, submitLabel),
      h('button', { type: 'button', class: 'ghost', onclick: () => form.remove() }, 'Cancel'), status));
  form.addEventListener('submit', (evt) => {
    evt.preventDefault();
    medAction(status, () => onSubmit(form));
  });
  card.append(form);
  $('input, select', form)?.focus();
}

const dateInput = (name, value) => h('label', {}, name === 'effective_on' ? 'Effective from' : name === 'started_on' ? 'Started on' : 'Stopped on',
  h('input', { type: 'date', name, required: true, value, max: state.today }));

/**
 * The last 12 weeks of daily check-offs for one item: a line for this week and the whole span, a bar per week (height =
 * share taken; an outlined box when nothing was logged, which is unknown, not missed), and the same numbers as a table.
 */
function checkoffTrend(weeks) {
  if (!weeks?.length) return null;
  const now = weeks.at(-1);
  const logged = weeks.reduce((s, w) => s + w.logged, 0);
  const taken = weeks.reduce((s, w) => s + w.taken, 0);
  const label = (w) => `Week ending ${niceDate(w.weekEnd)}${w === now ? ' (so far)' : ''}: ${w.logged ? `${w.taken} of ${w.logged} taken` : 'not logged'}`;
  const line = [
    now.logged ? `Taken ${now.taken} of ${now.logged} logged this week so far` : 'Nothing logged this week yet',
    logged ? `${Math.round((taken / logged) * 100)}% of logged doses taken over ${weeks.length} weeks` : `nothing logged in ${weeks.length} weeks`,
  ].join('; ');
  return h('div', { class: 'checkoffs' },
    h('p', { class: 'meta' }, `${line}.`),
    h('div', { class: 'checkoff-bars', role: 'img', 'aria-label': `Weekly check-offs, oldest first: ${weeks.map(label).join('; ')}` },
      weeks.map((w) => h('span', { class: `checkoff-bar${w.logged ? '' : ' unlogged'}`, title: label(w) },
        w.logged ? h('span', { class: 'fill', style: `height: ${Math.round((w.taken / w.logged) * 100)}%` }) : null))),
    h('details', { class: 'checkoff-table' }, h('summary', {}, 'Weekly numbers'),
      h('table', {}, h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Week ending'), h('th', { scope: 'col' }, 'Taken'), h('th', { scope: 'col' }, 'Logged'))),
        h('tbody', {}, [...weeks].reverse().map((w) => h('tr', {}, h('td', {}, `${niceDate(w.weekEnd)}${w === now ? ' (so far)' : ''}`),
          h('td', {}, w.logged ? String(w.taken) : '·'), h('td', {}, w.logged ? String(w.logged) : 'not logged')))))));
}

function currentCard(m, checkoffs) {
  const card = h('div', { class: 'card med-card' },
    h('div', { class: 'head' }, h('h3', {}, m.name), h('span', { class: 'pill' }, m.kind === 'medication' ? 'Medication' : 'Supplement'),
      m.prescribed ? h('span', { class: 'pill rx' }, 'Prescribed') : null),
    h('div', { class: 'chips' }, m.current.dose ? h('span', { class: 'chip' }, m.current.dose) : null,
      (m.current.ingredients ?? []).map((i) => h('span', { class: 'chip ingredient' }, i.dose ? `${i.name} ${i.dose}` : i.name)),
      m.current.timings.map((t) => h('span', { class: 'chip' }, TIMING_LABELS[t]))),
    h('p', { class: 'meta' }, m.current.start_estimated ? `Taking since at least ${niceDate(m.current.started_on)} (start date unknown)` : `Since ${niceDate(m.current.started_on)}`),
    m.purpose ? h('p', { class: 'meta' }, `For ${m.purpose}`) : null,
    m.notes ? h('p', { class: 'meta note-text' }, m.notes) : null,
    checkoffTrend(checkoffs),
    doseHistory(m));

  const actions = h('div', { class: 'actions' },
    h('button', { type: 'button', class: 'ghost', onclick: () => {
      const regimen = regimenEditor(m.current);
      inlineForm(card, 'Set the new dose (or an ingredient\'s new dose) or timing and the date it took effect. The old one is kept in the dose history.', [
        regimen,
        timingFieldset(m.current.timings),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'correction', onchange: (evt) => {
          const date = $('input[name="effective_on"]', evt.target.form);
          date.disabled = evt.target.checked;
          date.closest('label').hidden = evt.target.checked;
        } }), 'Fix a mistake (nothing actually changed, so no change is recorded)'),
        dateInput('effective_on', state.today),
      ], 'Save', (f) => api('POST', `/api/medications/${m.id}/changes`, {
        ...regimen.read(),
        timings: readTimings($('fieldset.timings', f)),
        ...(f.elements.correction.checked ? { correction: true } : { effective_on: f.elements.effective_on.value }),
      }));
    } }, 'Change dose or timing'),
    h('button', { type: 'button', class: 'ghost', onclick: () => inlineForm(card, 'Stop taking it. The date is the first day you no longer took it.', [
      dateInput('stopped_on', state.today),
      h('label', {}, 'Why (optional)', h('input', { type: 'text', name: 'reason', maxLength: 200 })),
    ], 'Stop', (f) => api('POST', `/api/medications/${m.id}/stop`, { stopped_on: f.elements.stopped_on.value, reason: f.elements.reason.value.trim() || null })) }, 'Stop'),
    editButton(card, m),
    deleteButton(m));
  card.append(actions);
  return card;
}

/** Every dose and timing period, newest first; only shown once something has changed. */
function doseHistory(m) {
  if (m.periods.length < 2) return null;
  const rows = [...m.periods].reverse().map((p) => {
    const start = `${p.start_estimated ? 'since at least ' : ''}${niceDate(p.started_on)}`;
    const span = p.stopped_on ? `${start} to ${niceDate(p.stopped_on)}` : `${p.start_estimated ? start : `from ${start}`}, current`;
    return h('li', {}, h('strong', {}, regimenText(p)), `, ${span}${p.stop_reason ? ` (stopped: ${p.stop_reason})` : ''}`);
  });
  return h('details', { class: 'dose-history', open: true }, h('summary', {}, `Dose history (${m.periods.length})`), h('ul', {}, rows));
}

function editButton(card, m) {
  return h('button', { type: 'button', class: 'ghost', onclick: () => inlineForm(card, 'Edit the label details. These are not dated changes.', [
    h('div', { class: 'grid2' },
      h('label', {}, 'Name', h('input', { type: 'text', name: 'name', maxLength: 100, required: true, value: m.name })),
      h('label', {}, 'Type', h('select', { name: 'kind' },
        h('option', { value: 'supplement', selected: m.kind === 'supplement' }, 'Supplement'),
        h('option', { value: 'medication', selected: m.kind === 'medication' }, 'Medication')))),
    h('label', {}, 'Purpose', h('input', { type: 'text', name: 'purpose', maxLength: 200, value: m.purpose ?? '' })),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'prescribed', checked: m.prescribed }), 'Prescribed by a doctor'),
    h('label', {}, 'Notes', h('textarea', { name: 'notes', rows: 3, maxLength: 1000, value: m.notes ?? '' })),
  ], 'Save', (f) => api('PUT', `/api/medications/${m.id}`, {
    name: f.elements.name.value.trim(), kind: f.elements.kind.value, purpose: f.elements.purpose.value.trim() || null, prescribed: f.elements.prescribed.checked, notes: f.elements.notes.value.trim() || null,
  })) }, 'Edit details');
}

function deleteButton(m) {
  return h('button', { type: 'button', class: 'ghost danger', onclick: async () => {
    if (!confirm(`Delete ${m.name} and all of its history? Use this only for an entry added by mistake; use Stop when you stop taking it.`)) return;
    await api('DELETE', `/api/medications/${m.id}`);
    await loadMeds();
  } }, 'Delete');
}

function pastCard(m) {
  const last = m.periods[m.periods.length - 1];
  const card = h('div', { class: 'card med-card' },
    h('div', { class: 'head' }, h('h3', {}, m.name), h('span', { class: 'pill' }, m.kind === 'medication' ? 'Medication' : 'Supplement'),
      m.prescribed ? h('span', { class: 'pill rx' }, 'Prescribed') : null),
    ...m.periods.map((p) => h('p', { class: 'meta' }, `${niceDate(p.started_on)} to ${niceDate(p.stopped_on)}: ${regimenText(p)}${p.stop_reason ? ` (stopped: ${p.stop_reason})` : ''}`)));
  card.append(h('div', { class: 'actions' },
    h('button', { type: 'button', class: 'ghost', onclick: () => {
      const regimen = regimenEditor(last);
      inlineForm(card, 'Start taking it again.', [
        regimen,
        timingFieldset(last.timings),
        dateInput('started_on', state.today),
      ], 'Start again', (f) => api('POST', `/api/medications/${m.id}/start`, {
        ...regimen.read(), timings: readTimings($('fieldset.timings', f)), started_on: f.elements.started_on.value,
      }));
    } }, 'Start again'),
    editButton(card, m),
    deleteButton(m)));
  return card;
}

function eventText(e) {
  if (e.type === 'start') return `Started ${e.name}: ${regimenText(e.to)}`;
  if (e.type === 'stop') return `Stopped ${e.name}${e.reason ? ` (${e.reason})` : ''}`;
  // An item with ingredients names what changed ("Beta 10 mg to 20 mg; added Gamma 1 g").
  const parts = (e.ingredientChanges ?? []).map((c) => (c.from === null ? `added ${c.name}${c.to ? ` ${c.to}` : ''}`
    : c.to === null ? `removed ${c.name}` : `${c.name} ${c.from ?? 'no dose'} to ${c.to ?? 'no dose'}`));
  const timingsChanged = e.from.timings.join() !== e.to.timings.join();
  if (parts.length && !timingsChanged) return `Changed ${e.name}: ${parts.join('; ')}`;
  return `Changed ${e.name}: ${regimenText(e.from)} to ${regimenText(e.to)}`;
}

function impactCard(e) {
  const i = e.impact;
  const rows = Object.entries(i.fields).map(([key, f]) => {
    const [label, unit] = IMPACT_LABELS[key];
    const fmtV = (v) => (v === null ? 'not enough data' : `${v}${unit}`);
    const change = f.change === null ? '' : `${f.change > 0 ? '+' : ''}${f.change}${unit}`;
    return h('tr', {}, h('td', {}, label),
      h('td', {}, fmtV(f.beforeMean), ' ', h('span', { class: 'n' }, `(${f.beforeDays} d)`)),
      h('td', {}, fmtV(f.afterMean), ' ', h('span', { class: 'n' }, `(${f.afterDays} d)`)),
      h('td', {}, change));
  });
  return h('div', { class: 'card impact' },
    h('div', { class: 'head med-card' }, h('span', { class: 'what' }, eventText(e)), h('span', { class: 'pill' }, niceDate(e.date)),
      i.status === 'pending' ? h('span', { class: 'pill' }, `In progress until ${niceDate(i.after.to)}`) : null),
    i.overlapsWith.length ? h('p', { class: 'note' }, `Other changes within 28 days: ${i.overlapsWith.map((o) => `${o.name} ${o.type} on ${niceDate(o.date)}`).join('; ')}. The comparison mixes their effects.`) : null,
    h('div', { class: 'table-wide' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', {}, '28 days before'), h('th', {}, 'Days 7 to 34 after'), h('th', {}, 'Change'))),
      h('tbody', {}, rows))));
}

/** The Combine panel: pick current items, name the pill and its slot, preview the merged history, then combine. */
function renderCombine(current) {
  const box = $('#med-combine');
  if (current.length < 2) return box.replaceChildren(h('p', { class: 'muted small' }, 'Needs at least two current items.'));
  const status = h('span', { class: 'status', role: 'status' });
  const result = h('div', { class: 'combine-preview' });
  const picks = current.map((m) => h('label', {}, h('input', { type: 'checkbox', value: String(m.id) }), m.name,
    doseLine(m.current) ? h('span', { class: 'muted small' }, ` ${doseLine(m.current)}`) : null));
  const name = h('input', { type: 'text', maxLength: 100, required: true });
  let nameTouched = false;
  name.addEventListener('input', () => { nameTouched = true; });
  const slot = h('select', {}, Object.entries(TIMING_LABELS).map(([v, l]) => h('option', { value: v, selected: v === 'daily' }, l)));
  const chosen = () => picks.map((p) => $('input', p)).filter((i) => i.checked).map((i) => Number(i.value));
  const reset = () => {
    result.replaceChildren();
    setStatus(status, '');
    if (!nameTouched) name.value = current.filter((m) => chosen().includes(m.id)).map((m) => m.name).join(' + ');
  };
  [...picks.map((p) => $('input', p)), slot].forEach((i) => i.addEventListener('change', reset));
  name.addEventListener('input', () => result.replaceChildren());

  const body = () => ({ ids: chosen(), name: name.value.trim(), timing: slot.value });
  const preview = h('button', { type: 'button', class: 'ghost', onclick: async () => {
    if (chosen().length < 2) return setStatus(status, 'Choose at least two items', 'error');
    if (!name.value.trim()) return setStatus(status, 'Give the combined item a name', 'error');
    try {
      const p = await api('POST', '/api/medications/combine', { ...body(), preview: true });
      setStatus(status, '');
      const span = (s) => (s.start_estimated ? `Since at least ${niceDate(s.started_on)}` : `From ${niceDate(s.started_on)}`)
        + (s.stopped_on ? ` to ${niceDate(s.stopped_on)}` : ', current');
      const go = h('button', { type: 'button', onclick: async () => {
        if (!confirm(`Combine ${p.replaces.join(', ')} into ${p.name}? The separate items are removed; their history moves into ${p.name}.`)) return;
        try {
          await api('POST', '/api/medications/combine', body());
          await loadMeds();
        } catch (err) {
          setStatus(status, err.message, 'error');
        }
      } }, 'Combine');
      result.replaceChildren(
        h('p', { class: 'small' }, `${p.name} (${p.kind}${p.prescribed ? ', prescribed' : ''}), ${TIMING_LABELS[p.timing].toLowerCase()}, replacing ${p.replaces.join(' and ')}:`),
        h('ul', { class: 'small' }, p.periods.map((s) => h('li', {}, `${span(s)}: ${doseLine(s)}${s.stop_reason ? ` (stopped: ${s.stop_reason})` : ''}`))),
        h('p', { class: 'small' }, `${p.daysMerged} logged day${p.daysMerged === 1 ? '' : 's'} become one check-off each.`,
          p.daysDisagreeing.length ? ` On ${p.daysDisagreeing.map(niceDate).join(', ')} the items were checked differently; ${p.daysDisagreeing.length === 1 ? 'that day counts' : 'those days count'} as taken.` : '',
          p.adjustmentsDropped ? ` ${p.adjustmentsDropped} one-day dose or slot adjustment${p.adjustmentsDropped === 1 ? '' : 's'} will be dropped.` : ''),
        h('div', { class: 'actions' }, go));
    } catch (err) {
      setStatus(status, err.message, 'error');
    }
  } }, 'Preview');
  box.replaceChildren(
    h('fieldset', { class: 'combine-picks' }, h('legend', {}, 'Items in the pill'), h('div', { class: 'opts' }, picks)),
    h('div', { class: 'grid2' }, h('label', {}, 'Name', name), h('label', {}, 'When you take it', slot)),
    h('div', { class: 'actions' }, preview, status),
    result);
}

async function loadMeds() {
  if (!state.today) await loadStatus();
  const [meds, impact, checkoffs] = await Promise.all([api('GET', '/api/medications'), api('GET', '/api/medications/impact'),
    api('GET', '/api/medications/checkoffs?weeks=12').catch(() => ({ items: [] }))]);
  const weeksOf = new Map(checkoffs.items.map((i) => [i.id, i.weeks]));
  const current = meds.filter((m) => m.current);
  const past = meds.filter((m) => !m.current);
  const empty = (text) => h('p', { class: 'empty-state' }, text);
  $('#meds-current').replaceChildren(...(current.length ? current.map((m) => currentCard(m, weeksOf.get(m.id))) : [empty('Nothing in your current list. Add what you take below.')]));
  $('#meds-past').replaceChildren(...(past.length ? past.map(pastCard) : [empty('Nothing stopped yet.')]));
  renderCombine(current);
  $('#meds-impact').replaceChildren(...(impact.length ? impact.map(impactCard) : [empty('Changes appear here once you add something.')]));
  const add = $('#med-add');
  if (!add.elements.started_on.value) add.elements.started_on.value = state.today;
  add.elements.started_on.max = state.today;
  add.elements.stopped_on.max = state.today;
}

function initMeds() {
  const form = $('#med-add');
  fillTimings($('[data-timings]', form));
  const resetRegimen = () => $('[data-regimen]', form).replaceChildren(regimenEditor());
  resetRegimen();
  const syncEstimated = () => {
    const f = form.elements;
    f.started_on.disabled = f.start_estimated.checked;
    if (f.start_estimated.checked) f.started_on.value = `${state.today.slice(0, 4)}-01-01`;
  };
  form.elements.start_estimated.addEventListener('change', syncEstimated);
  form.addEventListener('submit', async (evt) => {
    evt.preventDefault();
    const status = $('.status', form);
    const timings = readTimings($('[data-timings]', form));
    if (!timings.length) return setStatus(status, 'Choose at least one time you take it', 'error');
    const f = form.elements;
    try {
      await api('POST', '/api/medications', {
        name: f.name.value.trim(), kind: f.kind.value, ...$('.regimen', form).read(), timings,
        started_on: f.started_on.value, start_estimated: f.start_estimated.checked,
        purpose: f.purpose.value.trim() || null, prescribed: f.prescribed.checked, notes: f.notes.value.trim() || null,
        ...(f.stopped_on.value ? { stopped_on: f.stopped_on.value, stop_reason: f.stop_reason.value.trim() || null } : {}),
      });
      // Keep the "don't know when I started" choice, since several items are often added in a row.
      const estimated = f.start_estimated.checked;
      form.reset();
      fillTimings($('[data-timings]', form));
      resetRegimen();
      f.start_estimated.checked = estimated;
      f.started_on.value = state.today;
      syncEstimated();
      setStatus(status, 'Added', 'ok');
      await loadMeds();
    } catch (err) {
      setStatus(status, err.message, 'error');
    }
  });
}

// ---------------- labs ----------------
const LAB_DRAW_COLUMNS = 4;
let labsState = { draws: [], panels: [] };

const labCell = (r) => (r ? r.value_text : '');
function labChange(t) {
  const [latest, previous] = t.results;
  if (!latest || !previous || typeof latest.value !== 'number' || typeof previous.value !== 'number') return '';
  const dec = (s) => (/\.(\d+)$/.exec(s)?.[1].length ?? 0);
  const d = Math.max(dec(latest.value_text), dec(previous.value_text));
  const c = Number((latest.value - previous.value).toFixed(d));
  return c === 0 ? '0' : `${c > 0 ? '+' : ''}${c}`;
}

function labDetail(t) {
  const box = h('div', { class: 'lab-detail' });
  const numeric = [...t.results].reverse().filter((r) => typeof r.value === 'number').map((r) => ({ date: r.drawn_on, value: r.value }));
  if (numeric.length >= 2) {
    const chart = h('div', { class: 'chart' });
    box.append(chart);
    requestAnimationFrame(() => lineChart(chart, numeric, {
      from: numeric[0].date, to: numeric[numeric.length - 1].date, label: t.name, gapDays: 100000,
      format: (v) => `${v}${t.unit ? ` ${t.unit}` : ''}`,
    }));
  }
  box.append(h('ul', { class: 'lab-history' }, t.results.map((r) => labResultItem(t, r))));
  const unit = h('input', { type: 'text', maxLength: 40, value: t.unit ?? '', placeholder: 'unit, e.g. mg/dL', 'aria-label': `Unit for ${t.name}` });
  const status = h('span', { class: 'status' });
  box.append(h('div', { class: 'actions' }, unit,
    h('button', { type: 'button', class: 'ghost', onclick: async () => {
      try { await api('PUT', `/api/labs/tests/${t.id}`, { unit: unit.value.trim() || null }); await loadLabs(t.id); } catch (err) { setStatus(status, err.message, 'error'); }
    } }, 'Save unit'), status));
  return box;
}

/** Where a result came from, including what the sheet had before an in-app correction. */
function labSource(r) {
  if (r.source === 'sheet') return 'from Google Sheet';
  if (!r.corrected_from_date) return 'added in app';
  const was = [r.corrected_from !== r.value_text ? r.corrected_from : null, r.corrected_from_date !== r.drawn_on ? niceDate(r.corrected_from_date) : null].filter(Boolean);
  return `corrected in app${was.length ? ` (sheet had ${was.join(', ')})` : ''}`;
}

/** One result in a test's history, with an inline form to correct its value or date. */
function labResultItem(t, r) {
  const status = h('span', { class: 'status', role: 'status' });
  const item = h('li', {},
    h('span', {}, h('strong', {}, r.value_text), `${t.unit ? ` ${t.unit}` : ''}, ${niceDate(r.drawn_on)}`),
    h('span', { class: 'pill' }, labSource(r)));
  const edit = () => {
    $('form', item)?.remove();
    const value = h('input', { type: 'text', name: 'value', maxLength: 50, required: true, value: r.value_text, 'aria-label': 'Value' });
    const date = h('input', { type: 'date', name: 'drawn_on', required: true, value: r.drawn_on, max: state.today, 'aria-label': 'Draw date' });
    const form = h('form', { class: 'lab-edit' },
      r.source === 'sheet' ? h('p', { class: 'small muted' }, 'Your correction is kept here even if the sheet still has the old value. Fixing the sheet as well keeps both in step.') : null,
      h('div', { class: 'grid2' }, h('label', {}, 'Value', value), h('label', {}, 'Draw date', date)),
      h('div', { class: 'actions' }, h('button', { type: 'submit' }, 'Save'), h('button', { type: 'button', class: 'ghost', onclick: () => form.remove() }, 'Cancel'), status));
    form.addEventListener('submit', async (evt) => {
      evt.preventDefault();
      try {
        await api('PUT', `/api/labs/results/${r.id}`, { value: value.value.trim(), drawn_on: date.value });
        await loadLabs(t.id);
      } catch (err) {
        setStatus(status, err.message, 'error');
      }
    });
    item.append(form);
    value.focus();
  };
  const actions = h('span', { class: 'lab-actions' }, h('button', { type: 'button', class: 'ghost small-btn', onclick: edit }, 'Edit'));
  if (r.source === 'ui') {
    const undo = Boolean(r.corrected_from_date);
    actions.append(h('button', { type: 'button', class: 'ghost danger small-btn', onclick: async () => {
      const question = undo ? `Undo this correction and restore the sheet's value (${r.corrected_from})?` : `Delete ${t.name} on ${niceDate(r.drawn_on)}?`;
      if (!confirm(question)) return;
      try { await api('DELETE', `/api/labs/results/${r.id}`); await loadLabs(t.id); } catch (err) { setStatus(status, err.message, 'error'); }
    } }, undo ? 'Undo correction' : 'Delete'));
  }
  item.append(actions);
  return item;
}

/** One table per panel; tapping a test opens its history below the table (one at a time per panel). */
function labPanel(panel, draws) {
  const head = h('tr', {}, h('th', {}, 'Test'), draws.map((d) => h('th', {}, niceDate(d))), h('th', {}, 'Change'));
  const body = h('tbody', {});
  const detail = h('div', { class: 'lab-detail-slot' });
  const buttons = [];
  for (const t of panel.tests) {
    const byDate = new Map(t.results.map((r) => [r.drawn_on, r]));
    const nameBtn = h('button', { type: 'button', class: 'link', 'aria-expanded': 'false', 'data-test': String(t.id) }, t.name, t.unit ? h('span', { class: 'n' }, ` ${t.unit}`) : null);
    buttons.push(nameBtn);
    nameBtn.addEventListener('click', () => {
      const opening = nameBtn.getAttribute('aria-expanded') !== 'true';
      buttons.forEach((b) => b.setAttribute('aria-expanded', 'false'));
      detail.replaceChildren();
      if (!opening) return;
      nameBtn.setAttribute('aria-expanded', 'true');
      detail.append(h('div', { class: 'lab-detail-head' }, h('h3', {}, t.name),
        h('button', { type: 'button', class: 'ghost small-btn', onclick: () => nameBtn.click() }, 'Close')), labDetail(t));
    });
    body.append(h('tr', {}, h('td', {}, nameBtn),
      draws.map((d) => h('td', { class: byDate.get(d)?.source === 'ui' ? 'from-app' : null }, labCell(byDate.get(d)))),
      h('td', {}, labChange(t))));
  }
  return h('div', { class: 'card lab-panel' }, h('h2', {}, panel.panel),
    h('div', { class: 'table-wide' }, h('table', {}, h('thead', {}, head), body)), detail);
}

async function loadLabs(openTestId) {
  if (!state.today) await loadStatus();
  labsState = await api('GET', '/api/labs');
  const draws = labsState.draws.slice(0, LAB_DRAW_COLUMNS);
  const container = $('#labs-panels');
  container.replaceChildren(...(labsState.panels.length
    ? labsState.panels.map((p) => labPanel(p, draws))
    : [h('p', { class: 'empty-state' }, 'No lab results yet. Add them below.')]));
  if (openTestId) $(`button.link[data-test="${openTestId}"]`)?.click();

  const form = $('#lab-add');
  const select = form.elements.test_id;
  select.replaceChildren(h('option', { value: '' }, 'New test...'),
    ...labsState.panels.map((p) => h('optgroup', { label: p.panel }, p.tests.map((t) => h('option', { value: String(t.id) }, t.name)))));
  $('[data-new-test]', form).hidden = Boolean(select.value);
  if (!form.elements.drawn_on.value) form.elements.drawn_on.value = state.today;
  form.elements.drawn_on.max = state.today;
}

function initLabs() {
  const form = $('#lab-add');
  form.elements.test_id.addEventListener('change', () => { $('[data-new-test]', form).hidden = Boolean(form.elements.test_id.value); });
  form.addEventListener('submit', async (evt) => {
    evt.preventDefault();
    const f = form.elements;
    const status = $('.status', form);
    const body = { drawn_on: f.drawn_on.value, value: f.value.value.trim() };
    if (f.test_id.value) body.test_id = Number(f.test_id.value);
    else Object.assign(body, { name: f.name.value.trim(), panel: f.panel.value.trim() || null, unit: f.unit.value.trim() || null });
    try {
      await api('POST', '/api/labs/results', body);
      f.value.value = '';
      setStatus(status, 'Added', 'ok');
      await loadLabs();
    } catch (err) {
      setStatus(status, err.message, 'error');
    }
  });
}

// ---------------- training volume ----------------
const TRAINING_VIEW_KEY = 'hr.trainingView';
const BUCKET_DAYS = { day: 1, week: 7, month: 30 };
const PREVIOUS_LABEL = { week: 'previous 7 days', month: 'previous 30 days', '3m': 'previous 13 weeks', '6m': 'previous 26 weeks', year: 'previous 52 weeks', '2y': 'previous 2 years', '5y': 'previous 5 years' };
const lbs = (v) => `${Math.round(v).toLocaleString()} lbs`;

function trainingViewChoice() {
  try { return localStorage.getItem(TRAINING_VIEW_KEY) || 'month'; } catch { return 'month'; }
}

/** "Week ending Sep 26, 2026" / "Sep 2026" / null (daily bars use the date itself). */
function bucketLabel(b, bucket) {
  if (bucket === 'week') return `Week ending ${niceDate(b.weekEnding)}`;
  if (bucket === 'month') return b.label;
  return null;
}

function tile(label, value, current, previous, view) {
  let delta = '';
  if (previous) {
    if (previous === 0 && current === 0) delta = `same as ${PREVIOUS_LABEL[view]}`;
    else if (previous === 0) delta = `none in the ${PREVIOUS_LABEL[view]}`;
    else {
      const pct = Math.round(((current - previous) / previous) * 100);
      delta = `${pct > 0 ? '+' : ''}${pct}% vs ${PREVIOUS_LABEL[view]}`;
    }
  } else if (previous === 0) {
    delta = current ? `none in the ${PREVIOUS_LABEL[view]}` : `same as ${PREVIOUS_LABEL[view]}`;
  }
  return h('div', { class: 'tile' }, h('div', { class: 'tile-label' }, label), h('div', { class: 'tile-value' }, value),
    delta ? h('div', { class: 'tile-delta' }, delta) : null);
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
/** Tooltip lines for a bar: the programs trained in it, then days with no program logged. */
function programLines(b) {
  const lines = (b.programs ?? []).map((p) => `${p.name}: ${plural(p.days, 'day')}`);
  if (b.noProgramDays) lines.push(`No program logged: ${plural(b.noProgramDays, 'day')}`);
  return lines;
}

// ---------------- VO2 max (Health tab) ----------------
const VO2_VIEW_KEY = 'hr.vo2View';
const VO2_UNIT = ' ml/kg/min';
const vo2 = (v) => `${v.toFixed(1)}${VO2_UNIT}`;
const signed = (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)}`;

function vo2ViewChoice() {
  try { return localStorage.getItem(VO2_VIEW_KEY) || '1y'; } catch { return '1y'; }
}

const vo2Tile = (label, value, note) => h('div', { class: 'tile' }, h('div', { class: 'tile-label' }, label),
  h('div', { class: 'tile-value' }, value), note ? h('div', { class: 'tile-delta' }, note) : null);

async function loadVo2(view = vo2ViewChoice()) {
  try { localStorage.setItem(VO2_VIEW_KEY, view); } catch { /* storage unavailable: still works, just not remembered */ }
  $$('[data-vview]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.vview === view)));
  const r = await api('GET', `/api/vo2max?view=${view}`);
  $('#vo2-range').textContent = `${niceDate(r.range.from)} to ${niceDate(r.range.to)}`;
  const change = (c, span) => (c ? vo2Tile(`Change vs ${span}`, `${signed(c.value)}${VO2_UNIT}`, `from ${c.from.value.toFixed(1)} on ${niceDate(c.from.date)}`)
    : vo2Tile(`Change vs ${span}`, 'No reading', `none within 30 days of ${span}`));
  $('#vo2-tiles').replaceChildren(
    r.latest ? vo2Tile('Latest', vo2(r.latest.value), niceDate(r.latest.date)) : vo2Tile('Latest', 'No readings'),
    change(r.change90d, '90 days ago'),
    change(r.change1y, '1 year ago'),
    r.best ? vo2Tile('Best on record', vo2(r.best.value), niceDate(r.best.date)) : vo2Tile('Best on record', 'No readings'));

  const points = r.points.map((p) => ({ ...p, details: p.n ? [`Average of ${plural(p.n, 'reading')}`] : [] }));
  lineChart($('#vo2-chart'), points, {
    // The unit goes in the label, not on each value, so the end-of-line label fits.
    from: r.range.from, to: r.range.to, format: (v) => v.toFixed(1), label: `${r.bucket === 'reading' ? 'VO2 max' : 'Average VO2 max'} (ml/kg/min)`,
    gapDays: r.bucket === 'month' ? 62 : 21,
  });
  const per = { reading: '', week: ', shown as weekly averages', month: ', shown as monthly averages' }[r.bucket];
  $('#vo2-summary').textContent = r.readings
    ? `Average ${vo2(r.rangeAvg)} over ${plural(r.readings, 'reading')} in this range${per}. Apple Watch estimates.`
    : 'No readings in this range.';
  $('#vo2-table').replaceChildren(tableView(points.map((p) => ({ date: p.label ?? p.date, value: p.value })), vo2));
}

async function loadTrainingTab() {
  if (!state.today) await loadStatus();
  // A card whose data fails says so rather than showing "Loading..." forever (for example an old server
  // still running after an update: restart it).
  const failed = (sel) => (err) => {
    const el = $(sel);
    el.className = 'muted small';
    el.textContent = `Could not load this (${err.message}). If the app was just updated, restart the server.`;
  };
  loadProgram().catch(failed('#program-body'));
  loadAdvisor().catch(failed('#advisor-body'));
  loadAdherence().catch(failed('#adherence-body'));
  loadChat().catch(failed('#chat-thread'));
  loadLifts().catch(failed('#lifts-body'));
  return loadTraining();
}

// ---------------- called for vs logged ----------------

const ADHERENCE_STATUS = {
  as_called: ['✓', 'As called for'], swapped: ['↔', 'Swapped'], changed: ['↔', 'Changed'], skipped: ['✗', 'Skipped'], added: ['+', 'Added'],
};
const COUNT_WORDS = { as_called: 'as called for', swapped: 'swapped', changed: 'changed', skipped: 'skipped', added: 'added' };
const rangeText = (r) => (!r ? '' : r.min === r.max ? String(r.min) : `${r.min} to ${r.max}`);
const dayLabel = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });

async function loadAdherence(blockId) {
  const body = $('#adherence-body');
  const a = await api('GET', `/api/program/adherence${blockId ? `?block=${encodeURIComponent(blockId)}` : ''}`);
  body.className = '';
  if (!a.available) return fill(body, h('p', { class: 'muted small' }, 'Needs the MAPS catalog (data/maps/programs.json).'));
  if (!a.block) return fill(body, h('p', { class: 'muted small' }, 'No confirmed program block yet. Confirm one with npm run programs:review.'));

  const picker = h('select', { id: 'adherence-block' }, a.blocks.map((b) => h('option', { value: b.id, selected: b.id === a.block.id },
    `${b.program}, ${niceDate(b.start_date)} to ${b.end_date ? niceDate(b.end_date) : 'now'}`)));
  picker.addEventListener('change', () => loadAdherence(picker.value).catch((err) => fill(body, h('p', { class: 'status error' }, err.message))));
  const c = a.coverage;
  const usual = (title, items) => h('div', { class: 'usual' }, h('h3', {}, title),
    items.length ? h('ul', {}, items.map((x) => h('li', {}, x.what, h('span', { class: 'muted' }, ` ×${x.times}`)))) : h('p', { class: 'muted small' }, 'None'));

  fill(body,
    h('label', { class: 'adherence-pick' }, 'Block ', picker),
    h('p', { class: 'small' }, `${c.matched} of ${c.days} lifting days matched a workout; ${c.focus} focus, trigger or mobility session${c.focus === 1 ? '' : 's'}; ${c.notMatched} not matched.`),
    h('div', { class: 'usual-changes' },
      usual('Done instead', a.usualChanges.swaps), usual('Most often skipped', a.usualChanges.skipped), usual('Most often added', a.usualChanges.added)),
    a.weeks.map((w, i) => h('details', { class: 'adherence-week', open: i === 0 },
      h('summary', {}, w.week ? `Week ${w.week}` : 'Week unknown', h('span', { class: 'muted small' }, ` · ${w.sessions.length} day${w.sessions.length === 1 ? '' : 's'}`)),
      w.sessions.map(adherenceSession))));
}

function adherenceSession(s) {
  const head = h('span', { class: 'session-head' }, h('strong', {}, dayLabel(s.date)), ' ', s.workout ?? 'No workout name');
  if (s.match !== 'matched') {
    const what = s.match === 'focus' ? 'Focus, trigger or mobility session, no fixed list' : `Not matched: ${s.reason}`;
    return h('div', { class: 'adherence-session' }, head, h('p', { class: 'muted small session-line' }, `${what}. ${s.exercisesLogged} exercises, ${s.setsLogged} sets.`));
  }
  const parts = Object.entries(s.counts).filter(([, n]) => n).map(([k, n]) => `${n} ${COUNT_WORDS[k]}`);
  const line = `${s.catalogPhase}, ${s.catalogWorkout}: ${parts.join(', ')}; ${s.setsLogged} sets logged of ${rangeText(s.setsCalled)} called for.`;
  const rows = s.rows.map((r) => {
    const [icon, label] = ADHERENCE_STATUS[r.status];
    const notes = [
      r.reason,
      r.setsStatus === 'under' ? 'fewer sets' : r.setsStatus === 'over' ? 'more sets' : null,
      r.repsInRange ? `${r.repsInRange.inRange} of ${r.repsInRange.of} sets in the rep range` : null,
    ].filter(Boolean).join('; ');
    const reps = r.called?.reps ? `${rangeText(r.called.reps)}${r.called.reps.unit === 'seconds' ? ' s' : ''}` : '?';
    const called = r.called ? `${r.called.name}, ${rangeText(r.called.sets) || '?'} × ${reps}` : '·';
    const logged = r.logged ? `${r.logged.name}, ${r.logged.sets} set${r.logged.sets === 1 ? '' : 's'}${r.logged.reps.length ? ` (${r.logged.reps.join(', ')})` : ''}` : '·';
    return h('tr', {},
      h('td', { 'data-label': 'Called for' }, called),
      h('td', { 'data-label': 'Logged' }, logged),
      h('td', { 'data-label': 'Status' }, h('span', { 'aria-hidden': 'true' }, `${icon} `), label, notes ? h('span', { class: 'muted small' }, ` (${notes})`) : null));
  });
  return h('details', { class: 'adherence-session' },
    h('summary', {}, head, h('span', { class: 'small session-line' }, line)),
    h('table', { class: 'adherence-table' },
      h('thead', {}, h('tr', {}, ['Called for', 'Logged', 'Status'].map((t) => h('th', { scope: 'col' }, t)))),
      h('tbody', {}, rows)));
}

// ---------------- next program (Program Advisor) ----------------
const ADVISOR_KEY = 'hr.advisorWeights';
const GOAL_LABELS = { strength: 'Strength', joint: 'Joints and balance', time: 'Time', vo2: 'VO2 max' };
const GOAL_SHORT = { strength: 'Strength', joint: 'Joints', time: 'Time', vo2: 'VO2 max' };
const WEIGHT_LABELS = ['Off', '1x', '2x', '3x'];
const EQUAL = { strength: 1, joint: 1, time: 1, vo2: 1 };

function advisorWeights() {
  try {
    const saved = JSON.parse(localStorage.getItem(ADVISOR_KEY) ?? 'null');
    if (saved && Object.keys(EQUAL).every((g) => [0, 1, 2, 3].includes(saved[g]))) return saved;
  } catch { /* storage unavailable or bad value: equal weights */ }
  return { ...EQUAL };
}

function renderAdvisorWeights(weights) {
  const set = (next) => {
    try { localStorage.setItem(ADVISOR_KEY, JSON.stringify(next)); } catch { /* not remembered, still works */ }
    loadAdvisor().catch((err) => { $('#advisor-body').textContent = `Could not load this (${err.message}).`; });
  };
  const rows = Object.keys(EQUAL).map((g) => h('div', { class: 'weight-row' },
    h('span', { class: 'weight-label', id: `w-${g}` }, GOAL_LABELS[g]),
    h('div', { class: 'filters', role: 'group', 'aria-labelledby': `w-${g}` },
      ...WEIGHT_LABELS.map((label, v) => h('button', { type: 'button', 'aria-pressed': String(weights[g] === v),
        onclick: () => set({ ...weights, [g]: v }) }, label)))));
  const equal = Object.keys(EQUAL).every((g) => weights[g] === 1);
  fill($('#advisor-weights'), ...rows,
    h('button', { type: 'button', class: 'ghost', disabled: equal, onclick: () => set({ ...EQUAL }) }, 'Reset to equal'));
}

/** One goal score as a labelled bar (the number is always shown as text too). */
const scoreBar = (goal, value, weight) => h('div', { class: `score-row${weight ? '' : ' off'}` },
  h('span', { class: 'score-label' }, GOAL_SHORT[goal]),
  h('div', { class: 'ex-bar-track', role: 'img', 'aria-label': `${GOAL_LABELS[goal]} ${value.toFixed(2)}` },
    h('div', { class: 'ex-bar', style: `width:${Math.max(2, value * 100)}%` })),
  h('span', { class: 'score-value' }, value.toFixed(2)));

async function loadAdvisor() {
  const weights = advisorWeights();
  renderAdvisorWeights(weights);
  const qs = new URLSearchParams(Object.entries(weights).map(([g, v]) => [g, String(v)]));
  const a = await api('GET', `/api/advisor?${qs}`);
  const body = $('#advisor-body');
  if (!a.available) {
    body.className = 'muted small';
    body.textContent = 'Needs the MAPS catalog (data/maps/programs.json).';
    return;
  }
  body.className = '';
  if (a.ranking.every((r) => r.total === null)) {
    fill(body, h('p', { class: 'muted small' }, 'Every goal is off. Turn at least one on to rank the programs.'));
    return;
  }
  const notes = (r) => [r.lessHistory && 'less history', r.minutesSource === 'estimate' && 'minutes estimated'].filter(Boolean);
  const top = a.ranking.slice(0, 3).map((r, i) => h('div', { class: 'advisor-pick' },
    h('div', { class: 'program-title' }, h('strong', {}, `${i + 1}. ${r.program}`), h('span', { class: 'advisor-total' }, r.total.toFixed(2)),
      ...notes(r).map((n) => h('span', { class: 'badge neutral' }, n))),
    r.focus ? h('p', { class: 'muted small' }, r.focus) : null,
    h('div', { class: 'scores' }, ...Object.keys(EQUAL).map((g) => scoreBar(g, r.scores[g], a.weights[g]))),
    h('ul', { class: 'reasons small' }, ...r.reasons.map((x) => h('li', {}, x)),
      ...r.flags.map((x) => h('li', { class: 'flag' }, h('span', { 'aria-hidden': 'true' }, '⚠ '), x)))));
  const cell = (v) => (v === null || v === undefined ? '' : String(v));
  const table = h('details', {}, h('summary', { class: 'muted small' }, `Full ranking (${a.ranking.length} programs)`),
    h('div', { class: 'table-scroll wide' }, h('table', {},
      h('thead', {}, h('tr', {}, ...['Program', 'Total', 'Strength', 'Joints', 'Time', 'VO2 max', 'Reached', 'Min a week'].map((t) => h('th', {}, t)))),
      h('tbody', {}, ...a.ranking.map((r) => h('tr', {},
        h('td', {}, r.program), h('td', {}, r.total.toFixed(2)),
        ...Object.keys(EQUAL).map((g) => h('td', {}, r.scores[g].toFixed(2))),
        h('td', {}, r.completion === null ? '' : `${r.completion}%`), h('td', {}, cell(r.weeklyMinutes))))))));
  const extras = [
    ...a.excluded.map((x) => `Left out: ${x.program} (${x.reason}).`),
    a.addons.length ? `Add-ons, not ranked: ${a.addons.map((x) => `${x.program} (${x.total === null ? 'n/a' : x.total.toFixed(2)})`).join(', ')}.` : null,
  ].filter(Boolean);
  fill(body, ...top, table, ...extras.map((t) => h('p', { class: 'muted small' }, t)));
}

// ---------------- next program chat ----------------
const whenText = (iso) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function chatEntry(n) {
  const del = h('button', { type: 'button', class: 'link small', onclick: async () => {
    await api('DELETE', `/api/advisor/chat/${encodeURIComponent(n.id)}`);
    loadChat();
  } }, 'Delete');
  const head = h('div', { class: 'chat-head muted small' }, h('strong', {}, n.role === 'owner' ? 'You' : 'Claude'), ` ${whenText(n.created_at)} `, del);
  const body = h('div', { class: 'chat-body' });
  if (n.role === 'owner') fill(body, h('p', {}, n.text));
  else renderMarkdown(n.text, body);
  return h('article', { class: `chat-entry ${n.role}` }, head, body,
    n.physician?.length ? h('div', { class: 'chat-physician' }, h('p', { class: 'small' }, h('strong', {}, 'To discuss with a physician')),
      h('ul', { class: 'small' }, ...n.physician.map((p) => h('li', {}, h('strong', {}, p.topic), `: ${p.detail}`)))) : null,
    n.warnings?.length ? h('p', { class: 'muted small' }, `Checks flagged: ${n.warnings.join('; ')}`) : null);
}

async function loadChat() {
  const { enabled, notes } = await api('GET', '/api/advisor/chat');
  fill($('#chat-thread'), notes.map(chatEntry));
  $('#chat-clear').hidden = !notes.length;
  const form = $('#chat-form');
  for (const el of form.elements) el.disabled = !enabled;
  if (!enabled) $('#chat-status').textContent = 'The chat is off in this instance.';
}

async function sendChat(e) {
  e.preventDefault();
  const text = $('#chat-text').value.trim();
  if (!text) return;
  const send = $('#chat-form').querySelector('button[type="submit"]');
  send.disabled = true;
  $('#chat-status').className = 'status';
  $('#chat-status').textContent = 'Thinking… usually 30 to 60 seconds.';
  try {
    await api('POST', '/api/advisor/chat', { text, weights: advisorWeights() });
    $('#chat-text').value = '';
    $('#chat-status').textContent = '';
  } catch (err) {
    $('#chat-status').className = 'status error';
    $('#chat-status').textContent = `Not answered: ${err.message}.`;
  } finally {
    send.disabled = false;
    loadChat();
  }
}

// ---------------- lift progress (plateaus) ----------------
const LIFT_STATUS = {
  regressing: ['▼', 'Regressing'], stalled: ['■', 'Stalled'], progressing: ['▲', 'Progressing'],
  new_rep_range: ['○', 'New rep range'], not_enough_data: ['○', 'Not enough data'], not_trained: ['–', 'Not trained recently'],
};
const RANGE_LABEL = { '1-5': '1 to 5 reps', '6-12': '6 to 12 reps', '13+': '13+ reps', reps: 'reps per set' };
/** A lift's measure as text: estimated max, heaviest load for 13+ reps, or reps. */
function liftValue(l, v) {
  if (v == null) return 'none';
  if (l.measure === 'reps') return `${v} reps`;
  return l.range === '13+' ? `${v} lb` : `${v} lb est. max`;
}

async function loadLifts() {
  const lifts = await api('GET', '/api/lifts');
  const body = $('#lifts-body');
  body.className = '';
  const trained = lifts.filter((l) => l.status !== 'not_trained');
  const idle = lifts.filter((l) => l.status === 'not_trained');
  const row = (l) => {
    const [sym, label] = LIFT_STATUS[l.status];
    const change = l.changePct == null ? '' : ` (${l.changePct > 0 ? '+' : ''}${l.changePct}%)`;
    const compare = l.baselineBest == null ? liftValue(l, l.recentBest) : `${liftValue(l, l.recentBest)} vs ${liftValue(l, l.baselineBest)}${change}`;
    const chart = h('div', { class: 'chart' });
    const details = h('details', { class: `lift ${l.status}` },
      h('summary', {},
        h('span', { class: 'lift-name' }, l.name),
        h('span', { class: 'lift-status' }, h('span', { 'aria-hidden': 'true' }, sym), ` ${label}`),
        h('span', { class: 'lift-detail muted small' }, `${RANGE_LABEL[l.range] ?? ''}: ${compare}${l.record ? `; best ${liftValue(l, l.record.value)} on ${niceDate(l.record.date)}` : ''}`)),
      chart,
      tableView(l.trend.map((p) => ({ date: `Week of ${p.date}`, value: p.value })), (v) => liftValue(l, v)));
    details.addEventListener('toggle', () => {
      if (details.open && !chart.childElementCount) {
        lineChart(chart, l.trend, { from: l.trend[0]?.date ?? state.today, to: state.today, format: (v) => liftValue(l, v), label: l.name, gapDays: 21 });
      }
    }, { once: false });
    return details;
  };
  fill(body,
    trained.length ? trained.map(row) : h('p', { class: 'muted small' }, 'No primary lifts trained in the last 6 weeks.'),
    idle.length ? h('details', { class: 'lifts-idle' }, h('summary', { class: 'muted small' }, `Not trained in the last 6 weeks (${idle.length})`),
      h('ul', { class: 'plain-list' }, ...idle.map((l) => h('li', {}, h('span', {}, l.name), h('span', { class: 'muted' }, `last ${niceDate(l.lastSession)}`))))) : null);
}

/** The "Current program" card: the confirmed in-progress block, with phase and week from the MAPS catalog. */
async function loadProgram() {
  const body = $('#program-body');
  const { program: p } = await api('GET', '/api/program');
  if (!p) {
    body.className = 'muted small';
    body.textContent = 'No program in progress. Confirm your current block with npm run programs:review.';
    return;
  }
  body.className = '';
  const flags = [p.deload_week && 'Deload week', p.failure_week && 'Failure week', p.beyond_program && 'Past the end of the program']
    .filter(Boolean).map((f) => h('span', { class: 'badge' }, f));
  const short = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const phaseNote = p.phase_started
    ? `${p.phase_weeks ? `week ${p.phase_week} of ${p.phase_weeks}, ` : ''}since ${short(p.phase_started)}`
    : (p.estimated ? 'estimated from the calendar' : null);
  const finish = !p.earliest_finish ? null
    : p.pace_finish && p.pace_finish !== p.earliest_finish
      ? vo2Tile('Finish', `${short(p.earliest_finish)} to ${p.pace_finish.slice(0, 7) === p.earliest_finish.slice(0, 7) ? Number(p.pace_finish.slice(8)) : short(p.pace_finish)}`,
        'earliest, then at your pace this block')
      : vo2Tile('Finish', niceDate(p.earliest_finish), 'at the earliest');
  const tiles = [
    vo2Tile('Phase', p.phase ?? (p.beyond_program ? 'Past the program' : 'Unknown'), phaseNote),
    p.week && p.program_weeks ? vo2Tile('Program week', `${p.week} of ${p.program_weeks}`) : vo2Tile('Program length', 'Not in the catalog'),
    finish,
    p.days_left !== null ? vo2Tile('Days left', `${p.days_left}+`, 'to the earliest finish') : null,
  ].filter(Boolean);
  fill(body,
    h('div', { class: 'program-title' }, h('strong', {}, p.program), ` since ${niceDate(p.start_date)}`, ...flags),
    p.percent !== null ? h('div', { class: 'ex-bar-track program-track', role: 'img', 'aria-label': `${p.percent}% of the program` },
      h('div', { class: 'ex-bar', style: `width:${Math.max(2, p.percent)}%` })) : null,
    h('div', { class: 'tiles' }, ...tiles),
    h('p', { class: 'muted small' }, `${plural(p.sessions, 'session')} logged in this block.`));
}

async function loadTraining(view = trainingViewChoice()) {
  try { localStorage.setItem(TRAINING_VIEW_KEY, view); } catch { /* storage unavailable: still works, just not remembered */ }
  $$('[data-tview]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tview === view)));
  const t = await api('GET', `/api/training?view=${view}`);
  const prev = t.previous?.totals ?? null;

  $('#training-range').textContent = `${niceDate(t.range.from)} to ${niceDate(t.range.to)}`;
  $('#training-tiles').replaceChildren(
    tile('Volume', lbs(t.totals.volumeLbs), t.totals.volumeLbs, prev?.volumeLbs ?? (prev ? 0 : undefined), view),
    tile('Sets', t.totals.sets.toLocaleString(), t.totals.sets, prev?.sets ?? (prev ? 0 : undefined), view),
    tile('Reps', t.totals.reps.toLocaleString(), t.totals.reps, prev?.reps ?? (prev ? 0 : undefined), view),
    tile('Lifting days', String(t.totals.liftingDays), t.totals.liftingDays, prev?.liftingDays ?? (prev ? 0 : undefined), view));

  const points = t.buckets.map((b) => ({ date: b.start, value: b.volumeLbs, label: bucketLabel(b, t.bucket), details: programLines(b) }));
  columnChart($('#training-chart'), points, {
    from: t.range.from, to: t.range.to, format: lbs, label: 'Volume', bucketDays: BUCKET_DAYS[t.bucket],
  });
  $('#training-table').replaceChildren(tableView(points.map((p) => ({ date: p.label ?? p.date, value: p.value })), lbs));

  const weekly = $('#training-weekly');
  weekly.replaceChildren();
  if (t.weeklyTotals) {
    weekly.append(h('h3', { class: 'sub' }, 'Weekly totals'),
      h('ul', { class: 'plain-list' }, [...t.weeklyTotals].reverse().map((w) =>
        h('li', {}, h('span', {}, `Week ending ${niceDate(w.weekEnding)}${w.start !== addDays(w.weekEnding, -6) || w.end !== w.weekEnding ? ' (part of the week)' : ''}`), h('strong', {}, lbs(w.volumeLbs))))));
  }

  const max = Math.max(1, ...t.byExercise.map((e) => e.volumeLbs));
  $('#training-exercises').replaceChildren(...(t.byExercise.length
    ? t.byExercise.map((e) => h('div', { class: 'ex-row' },
      h('div', { class: 'ex-name' }, e.exercise),
      h('div', { class: 'ex-bar-track' }, h('div', { class: 'ex-bar', style: `width:${Math.max(2, (e.volumeLbs / max) * 100)}%` })),
      h('div', { class: 'ex-value' }, `${lbs(e.volumeLbs)}, ${e.sets} set${e.sets === 1 ? '' : 's'}`)))
    : [h('p', { class: 'muted small' }, 'No weighted sets in this range.')]));

  const u = t.unweighted;
  const parts = [['band', u.band], ['bodyweight', u.bodyweight], ['timed', u.timed], ['other', u.other]].filter(([, n]) => n);
  $('#training-unweighted').textContent = parts.length
    ? `Sets with no weight to count: ${parts.map(([k, n]) => `${k} ${n}`).join(', ')}.`
    : '';
}

// ---------------- reviews ----------------

// The notice when last week's review is missing (the Sunday run skipped for missing Apple Health days, failed, or did
// not run), with a manual run. Shown on the Today and Reviews tabs; hidden in the demo (no review service).
const reviewNotice = { timer: null };
const fmtDay = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
const dayList = (dates) => dates.map(fmtDay).join(', ');

async function loadReviewNotice() {
  clearTimeout(reviewNotice.timer);
  let s;
  try {
    s = await api('GET', '/api/reviews/status');
  } catch {
    return;
  }
  const show = s.canRun && (s.running || (s.overdue && !s.hasReview) || s.rewriteAvailable);
  for (const node of document.querySelectorAll('[data-review-notice]')) {
    node.hidden = !show;
    if (show) fill(node, reviewNoticeContent(s));
  }
  if (s.running) {
    reviewNotice.timer = setTimeout(loadReviewNotice, 5000);
  } else if (reviewNotice.wasRunning) {
    reviewNotice.wasRunning = false;
    if (location.hash.startsWith('#reviews')) loadReviews();
  }
}

function reviewNoticeContent(s) {
  const week = `the week ending ${fmtDay(s.weekEnd)}`;
  const gaps = [
    s.missingDays.length ? `no Apple Health data for ${dayList(s.missingDays)}` : '',
    s.partialDays.length ? `a likely partial export on ${dayList(s.partialDays)}` : '',
  ].filter(Boolean).join('; ');
  if (s.running) return [h('p', {}, `Writing the review for ${week}… This takes 1 to 3 minutes.`)];
  if (s.rewriteAvailable) return rewriteNotice(s, week);
  const run = s.lastRun;
  const why = s.error ? `The manual run failed (${s.error}).`
    : run?.status === 'skipped' ? (s.ready ? 'The Sunday run was skipped because Apple Health data was missing; it has arrived now.' : `The Sunday run was skipped: ${gaps}.`)
    : run?.status === 'error' ? 'The last run failed. The review log on the Activity tab has the details.'
    : 'The weekly run has not written it.';
  const button = h('button', { type: 'button' }, s.ready ? 'Run review now' : 'Run anyway');
  const status = h('span', { class: 'status', role: 'status' });
  button.addEventListener('click', async () => {
    if (!s.ready && !confirm(`Apple Health data is incomplete (${gaps}). Write the review anyway? Those days will be treated as incomplete.`)) return;
    button.disabled = true;
    setStatus(status, 'Syncing, then starting…');
    try {
      await api('POST', '/api/reviews/run', { force: !s.ready });
      reviewNotice.wasRunning = true;
      loadReviewNotice();
    } catch (err) {
      setStatus(status, err.message, 'error');
      button.disabled = false;
    }
  });
  return [
    h('p', {}, h('span', { 'aria-hidden': 'true' }, '⚠ '), `No review for ${week}. ${why}`),
    s.ready || run?.status === 'skipped' ? null : h('p', { class: 'muted small' }, `Still incomplete: ${gaps}.`),
    h('div', { class: 'actions' }, button, h('span', { class: 'muted small' }, "About $0.35 and 1 to 3 minutes; sends the week's summary to Claude."), status),
  ];
}

/** The review exists but was written while days were missing or partial, and the week is complete now. */
function rewriteNotice(s, week) {
  const w = s.writtenWithGaps;
  const was = [
    w.missingDays.length ? `Apple Health data for ${dayList(w.missingDays)} was missing` : '',
    w.partialDays.length ? `${dayList(w.partialDays)} looked like a partial export` : '',
  ].filter(Boolean).join(' and ');
  const button = h('button', { type: 'button' }, 'Rewrite with the full week');
  const status = h('span', { class: 'status', role: 'status' });
  button.addEventListener('click', async () => {
    button.disabled = true;
    setStatus(status, 'Syncing, then starting…');
    try {
      await api('POST', '/api/reviews/run', {});
      reviewNotice.wasRunning = true;
      loadReviewNotice();
    } catch (err) {
      setStatus(status, err.message, 'error');
      button.disabled = false;
    }
  });
  return [
    h('p', {}, h('span', { 'aria-hidden': 'true' }, 'ⓘ '), `The review for ${week} was written while ${was}. The full week has arrived now.`),
    h('div', { class: 'actions' }, button, h('span', { class: 'muted small' }, "About $0.35 and 1 to 3 minutes; replaces the current review for that week."), status),
  ];
}

function renderMarkdown(md, into) {
  // Minimal, safe subset: ## headings, - bullets, **bold**, paragraphs. Text only via textContent.
  const inline = (parent, text) => {
    text.split(/(\*\*[^*]+\*\*)/).forEach((part) => {
      if (/^\*\*[^*]+\*\*$/.test(part)) {
        const b = document.createElement('strong');
        b.textContent = part.slice(2, -2);
        parent.append(b);
      } else if (part) parent.append(document.createTextNode(part));
    });
  };
  let list = null;
  for (const line of md.split('\n')) {
    if (/^##\s+/.test(line)) {
      list = null;
      const h = document.createElement('h3');
      inline(h, line.replace(/^##\s+/, ''));
      into.append(h);
    } else if (/^[-*]\s+/.test(line)) {
      if (!list) { list = document.createElement('ul'); into.append(list); }
      const li = document.createElement('li');
      inline(li, line.replace(/^[-*]\s+/, ''));
      list.append(li);
    } else if (line.trim()) {
      list = null;
      const p = document.createElement('p');
      inline(p, line);
      into.append(p);
    } else list = null;
  }
}

// One review at a time: the latest by default, or the week in the address (#reviews/2026-10-03), with every week
// listed to choose from (a side column on wide screens, a collapsed list on a phone).
const reviewsView = { list: null };
window.matchMedia('(max-width: 720px)').addEventListener('change', () => {
  if (currentView === 'reviews' && reviewsView.list) renderReviews();
});

async function loadReviews() {
  loadReviewNotice();
  reviewsView.list = await api('GET', '/api/reviews');
  renderReviews();
}

function renderReviews() {
  const reviews = reviewsView.list;
  const container = $('#reviews');
  if (!reviews.length) {
    fill(container, h('p', { class: 'empty-state' }, 'No weekly reviews yet.'));
    return;
  }
  const asked = location.hash.split('/')[1];
  const r = reviews.find((x) => x.week_ending === asked) ?? reviews[0];
  const latest = r === reviews[0];

  const items = reviews.map((x, i) => {
    const current = x === r;
    const button = h('button', { type: 'button', class: 'review-pick', 'aria-current': current ? 'true' : null },
      h('span', { 'aria-hidden': 'true', class: 'check' }, current ? '✓' : ''),
      h('span', { class: 'label' }, niceDate(x.week_ending), i === 0 ? h('span', { class: 'muted small' }, ' (latest)') : null));
    button.addEventListener('click', () => {
      location.hash = i === 0 ? '#reviews' : `#reviews/${x.week_ending}`;
    });
    return h('li', {}, button);
  });
  const list = h('ul', { class: 'review-picks' }, items);
  const nav = h('nav', { class: 'review-list card', 'aria-label': 'Weekly reviews' },
    h('details', { class: 'review-list-phone' }, h('summary', {}, `All reviews (${reviews.length}), by week ending`)),
    h('h2', { class: 'review-list-title' }, 'Weeks ending'),
    list);
  // On a phone the list sits inside the collapsed details; on wide screens CSS shows it as a column.
  const phone = window.matchMedia('(max-width: 720px)').matches;
  if (phone) nav.querySelector('details').append(list);

  const card = h('article', { class: 'card review' });
  if (!latest) {
    const back = h('a', { href: '#reviews', class: 'small' }, 'Back to latest');
    card.append(h('p', { class: 'meta' }, 'An earlier week. ', back));
  }
  card.append(h('h2', {}, `Week ending ${niceDate(r.week_ending)}`),
    h('p', { class: 'meta' }, `Generated ${new Date(r.created_at).toLocaleString()}${r.model ? ` by ${r.model}` : ''}`));
  if (r.warnings.length) {
    card.append(h('div', { class: 'review-warnings' },
      h('strong', {}, 'Checks that still failed after a retry:'),
      h('ul', {}, r.warnings.map((w) => h('li', {}, w)))));
  }
  renderMarkdown(state.demo ? redactReview(r.report_md) : r.report_md, card);
  card.append(h('p', { class: 'meta' }, 'An analytical aid, not medical advice. Discuss medications, lab results and symptoms with your physician.'));

  fill(container, h('div', { class: 'review-layout' }, nav, card));
  if (phone && asked) card.scrollIntoView({ block: 'start' });
}

// ---------------- prompt admin ----------------
function sectionCard(section) {
  const isNew = !section.id;
  const card = document.createElement('form');
  card.className = `card section-card${section.sensitive ? ' sensitive' : ''}`;

  const title = document.createElement('h2');
  title.textContent = isNew ? 'New section' : section.name;
  if (section.sensitive) {
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = 'Sensitive';
    title.append(badge);
  }

  const row = document.createElement('div');
  row.className = 'row';
  const pos = document.createElement('label');
  pos.textContent = 'Position';
  const posInput = document.createElement('input');
  Object.assign(posInput, { type: 'number', name: 'position', min: 0, max: 999, required: true, value: section.position ?? '' });
  pos.append(posInput);
  const name = document.createElement('label');
  name.textContent = 'Name';
  const nameInput = document.createElement('input');
  Object.assign(nameInput, { type: 'text', name: 'name', maxLength: 60, required: true, pattern: '[A-Za-z0-9 _\\-]+', value: section.name ?? '' });
  name.append(nameInput);
  row.append(pos, name);

  const check = document.createElement('label');
  check.className = 'check';
  const checkInput = document.createElement('input');
  Object.assign(checkInput, { type: 'checkbox', name: 'sensitive', checked: Boolean(section.sensitive) });
  check.append(checkInput, document.createTextNode('Sensitive (medications, genetics): sent with the weekly review and named in the run log'));

  const textLabel = document.createElement('label');
  textLabel.textContent = 'Text';
  const textArea = document.createElement('textarea');
  textArea.name = 'text';
  textArea.value = section.text ?? '';
  textArea.maxLength = 50000;
  textLabel.append(textArea);

  const actions = document.createElement('div');
  actions.className = 'actions';
  const save = document.createElement('button');
  save.type = 'submit';
  save.textContent = isNew ? 'Add' : 'Save';
  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'ghost danger';
  del.textContent = isNew ? 'Cancel' : 'Delete';
  const status = document.createElement('span');
  status.className = 'status';
  status.setAttribute('role', 'status');
  if (section.updated_at) status.textContent = `Updated ${new Date(section.updated_at).toLocaleString()}`;
  actions.append(save, del, status);

  card.append(title, row, check, textLabel, actions);

  card.addEventListener('submit', async (evt) => {
    evt.preventDefault();
    const body = { position: Number(posInput.value), name: nameInput.value.trim(), text: textArea.value, sensitive: checkInput.checked };
    try {
      if (isNew) await api('POST', '/api/prompt/sections', body);
      else await api('PUT', `/api/prompt/sections/${section.id}`, body);
      await loadSections();
    } catch (err) {
      setStatus(status, err.message, 'error');
    }
  });
  del.addEventListener('click', async () => {
    if (isNew) return card.remove();
    if (!confirm(`Delete the "${section.name}" section? A copy is kept in the version history.`)) return;
    try {
      await api('DELETE', `/api/prompt/sections/${section.id}`);
      await loadSections();
    } catch (err) {
      setStatus(status, err.message, 'error');
    }
  });
  return card;
}

async function loadSettings() {
  const s = await api('GET', '/api/settings');
  const form = $('#settings');
  for (const k of ['zone2_low_bpm', 'zone2_high_bpm']) form.elements[k].value = s[k] ?? '';
  setStatus($('.status', form), s.zone2_low_bpm && s.zone2_high_bpm ? '' : 'Zone 2 is not set yet');
}

async function saveSettings(evt) {
  evt.preventDefault();
  const form = evt.currentTarget;
  const body = {};
  for (const k of ['zone2_low_bpm', 'zone2_high_bpm']) body[k] = numberOrNull(form.elements[k]);
  try {
    await api('PUT', '/api/settings', body);
    setStatus($('.status', form), 'Saved', 'ok');
  } catch (err) {
    setStatus($('.status', form), err.message, 'error');
  }
}

async function loadSections() {
  loadSettings();
  const sections = await api('GET', '/api/prompt/sections');
  const container = $('#sections');
  container.replaceChildren();
  if (!sections.length) {
    const p = document.createElement('p');
    p.className = 'empty-state';
    p.textContent = 'No prompt sections yet. Add one, or import the v1 sections with npm run prompts:import-v1.';
    container.append(p);
  }
  for (const s of sections) container.append(sectionCard(s));
  if (!$('#preview').hidden) await showPreview();
}

async function showPreview() {
  const p = await api('GET', '/api/prompt/preview');
  $('#preview').hidden = false;
  const parts = [`${p.characters.toLocaleString()} characters`, `included: ${p.included.join(', ') || 'none'}`];
  if (p.sensitiveIncluded.length) parts.push(`sensitive, sent every week: ${p.sensitiveIncluded.join(', ')}`);
  if (p.leftOut.length) parts.push(`left out: ${p.leftOut.join(', ')}`);
  $('#preview-meta').textContent = parts.join(' · ');
  $('#preview-text').textContent = p.text || '(empty)';
}

function initPrompt() {
  $('#add-section').addEventListener('click', async () => {
    const sections = await api('GET', '/api/prompt/sections');
    const next = sections.reduce((m, s) => Math.max(m, s.position), 0) + 1;
    const card = sectionCard({ position: next, name: '', text: '', sensitive: false });
    $('#sections').prepend(card);
    $('input[name="name"]', card).focus();
  });
  $('#preview-prompt').addEventListener('click', showPreview);
  $('#settings').addEventListener('submit', saveSettings);
}

// ---------------- activity ----------------
const RUN_LABELS = { sync: 'Sync', review: 'Weekly review', 'review-eval': 'Review eval', backup: 'Encrypted backup' };
const runLabel = (name) => RUN_LABELS[name] ?? name;
const RUN_STATUS = { running: 'running', ok: 'finished', error: 'failed', failed: 'failed', skipped: 'skipped (Apple Health data missing)' };
const when = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
const seconds = (ms) => (ms == null ? '' : ms < 60000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 60000)} min`);
const usd = (v) => (v ? `$${v.toFixed(4)}` : '');
const activity = { selected: null, log: 'sync', timer: null };

/** A run's summary as label: value lines (nested objects flattened to "source rows read"). */
function summaryLines(obj, prefix = '') {
  if (!obj || typeof obj !== 'object') return [];
  return Object.entries(obj).flatMap(([k, v]) => {
    const label = `${prefix}${k.replace(/_/g, ' ')}`;
    if (v && typeof v === 'object' && !Array.isArray(v)) return summaryLines(v, `${label} `);
    return [[label, Array.isArray(v) ? v.join(', ') : String(v)]];
  });
}

/** The Spend card: estimated Claude API cost this month, this year and all time, by month and year. */
async function loadSpend() {
  const body = $('#spend-body');
  let s;
  try {
    s = await api('GET', '/api/spend');
  } catch (err) {
    fill(body, h('p', { class: 'status error' }, `Could not load spend: ${err.message}`));
    return;
  }
  const dollars = (v) => `$${v.toFixed(2)}`;
  const monthName = (m) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', year: 'numeric', timeZone: 'UTC' });
  const tile = (label, value) => h('div', { class: 'tile' }, h('div', { class: 'tile-label' }, label), h('div', { class: 'tile-value' }, dollars(value)));
  // Months before the first one with any spend are left out (months after it show a dot when nothing was spent).
  const firstSpent = s.months.findLastIndex((m) => m.total > 0);
  const months = firstSpent >= 0 ? s.months.slice(0, firstSpent + 1) : s.months.slice(0, 1);
  const table = (caption, rows, label) => h('div', { class: 'spend-table-wrap' }, h('table', { class: 'spend-table' },
    h('caption', {}, caption),
    h('thead', {}, h('tr', {}, ['', 'Reviews', 'Chat', 'Evals', 'Total'].map((c) => h('th', { scope: 'col' }, c)))),
    h('tbody', {}, rows.map((r) => h('tr', {}, h('th', { scope: 'row' }, label(r)),
      [r.reviews, r.chat, r.evals, r.total].map((v) => h('td', {}, v ? dollars(v) : '·')))))));
  fill(body,
    h('div', { class: 'tiles three' }, tile('This month', s.thisMonth), tile('This year', s.thisYear), tile('All time', s.allTime)),
    h('div', { class: 'spend-tables' },
      table('By month (last 12)', months, (r) => monthName(r.month)),
      table('By year', s.years.length ? s.years : [{ year: String(new Date().getFullYear()), reviews: 0, chat: 0, evals: 0, total: 0 }], (r) => r.year)),
    h('p', { class: 'muted small' }, 'Estimated from token counts at list prices; your Anthropic Console bill is the real number. ',
      'Evals are dated by when each variant last ran. Not counted: exercise-name suggestions (a few cents each).',
      s.unpricedEvalRows ? ` ${s.unpricedEvalRows} eval rows used a model with no price and count as $0.` : ''));
}

async function loadActivity() {
  clearTimeout(activity.timer);
  loadSpend();
  const runs = await api('GET', '/api/runs?limit=100');
  const list = $('#activity-list');
  if (!runs.length) {
    list.replaceChildren(h('p', { class: 'muted small' }, 'Nothing has run yet. Syncs run every morning at 7, and the review on Sunday at 8.'));
    $('#activity-detail').replaceChildren();
  } else {
    if (!runs.some((r) => r.id === activity.selected)) activity.selected = runs[0].id;
    list.replaceChildren(...runs.map((r) => {
      const a = h('a', { href: '#activity', class: r.id === activity.selected ? 'on' : '' },
        h('span', { class: `dot ${r.status}`, 'aria-hidden': 'true' }),
        h('span', {}, h('b', {}, runLabel(r.name)),
          h('span', { class: 'muted small' }, ` ${when(r.started_at)}, ${RUN_STATUS[r.status] ?? r.status}${r.duration_ms != null ? `, ${seconds(r.duration_ms)}` : ''}${r.cost_usd ? `, ${usd(r.cost_usd)}` : ''}`)));
      a.addEventListener('click', (e) => { e.preventDefault(); activity.selected = r.id; loadActivity(); });
      return a;
    }));
    await showRun(activity.selected);
  }
  await showLog(activity.log);
  // Follow a run that is still going.
  if (runs.some((r) => r.status === 'running') && location.hash === '#activity') activity.timer = setTimeout(loadActivity, 3000);
}

async function showRun(id) {
  const r = await api('GET', `/api/runs/${id}`);
  const lines = summaryLines(r.summary);
  const shown = new Set(lines.map(([k]) => k));
  const metaLines = summaryLines(r.meta).filter(([k]) => !shown.has(k)); // what the summary already lists is not repeated
  const detail = $('#activity-detail');
  fill(detail,
    h('div', { class: 'activity-head' }, h('b', {}, runLabel(r.name)),
      h('span', { class: 'muted small' }, ` started ${when(r.started_at)}${r.finished_at ? `, ${RUN_STATUS[r.status] ?? r.status} after ${seconds(r.duration_ms)}` : ', still running'}`)),
    r.summary?.error ? h('p', { class: 'error' }, String(r.summary.error)) : null,
    metaLines.length ? h('p', { class: 'muted small' }, metaLines.map(([k, v]) => `${k}: ${v}`).join('; ')) : null,
    lines.length
      ? h('ul', { class: 'plain-list' }, ...lines.filter(([k]) => k !== 'error').map(([k, v]) => h('li', {}, h('span', {}, k), h('strong', {}, v))))
      : h('p', { class: 'muted small' }, 'No counts recorded.'),
    r.calls.length ? h('div', { class: 'table-scroll' }, h('table', { class: 'calls' },
      h('thead', {}, h('tr', {}, ...['Call', 'Model', 'Stop', 'In', 'Out', 'Cache read', 'Cost', 'Time'].map((t) => h('th', {}, t)))),
      h('tbody', {}, ...r.calls.map((c) => h('tr', {},
        h('td', {}, c.label ?? ''), h('td', {}, c.model ?? ''), h('td', {}, c.error_name ?? c.stop_reason ?? ''),
        h('td', {}, c.input_tokens.toLocaleString()), h('td', {}, c.output_tokens.toLocaleString()),
        h('td', {}, c.cache_read_tokens.toLocaleString()), h('td', {}, usd(c.cost_usd)), h('td', {}, seconds(c.duration_ms))))))) : null);
}

async function showLog(name) {
  activity.log = name;
  $$('[data-log]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.log === name)));
  const { lines } = await api('GET', `/api/logs/${name}?lines=200`);
  const box = $('#activity-log');
  box.replaceChildren(...(lines.length ? lines : ['No log yet.']).map((l) => h('div', { class: `console-line${/^====/.test(l) ? ' run-start' : ''}${/failed|\berror:|\[\w+\] error|\b[1-9]\d* errors\b/i.test(l) ? ' bad' : ''}` }, l)));
  box.scrollTop = box.scrollHeight;
}

// ---------------- start ----------------
buildTodayForms();
initPrompt();
initMeds();
initLabs();
$$('[data-tview]').forEach((b) => b.addEventListener('click', () => loadTraining(b.dataset.tview)));
$('#chat-form').addEventListener('submit', sendChat);
$('#chat-clear').addEventListener('click', async () => {
  if (!confirm('Clear the whole Next program thread?')) return;
  await api('DELETE', '/api/advisor/chat');
  loadChat();
});
$$('[data-vview]').forEach((b) => b.addEventListener('click', () => loadVo2(b.dataset.vview)));
$$('[data-log]').forEach((b) => b.addEventListener('click', () => showLog(b.dataset.log)));
$$('[data-range]').forEach((b) => b.addEventListener('click', () => {
  state.range = Number(b.dataset.range);
  loadHistory();
}));
setupDemo();
window.addEventListener('hashchange', route);
route();
