import { lineChart, columnChart } from './charts.js';

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

const state = { today: null, day: null, range: 30 };

// ---------------- routing ----------------
const VIEWS = ['today', 'training', 'health', 'meds', 'labs', 'reviews', 'prompt'];
function route() {
  if (location.hash === '#history') return location.replace('#health'); // the old name of the Health tab
  const view = VIEWS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'today';
  for (const v of VIEWS) $(`#view-${v}`).hidden = v !== view;
  $$('.top nav a').forEach((a) => (a.getAttribute('href') === `#${view}` ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
  ({ today: loadDay, training: loadTrainingTab, health: loadHealthTab, meds: loadMeds, labs: loadLabs, reviews: loadReviews, prompt: loadSections })[view]();
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

function renderDoses(day) {
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
  for (const slot of SLOT_ORDER) {
    const rows = day.items.flatMap((m) => m.slots.filter((s) => s.timing === slot).map((s) => ({ m, s })));
    if (!rows.length) continue;
    list.append(h('div', { class: 'dose-group' }, h('div', { class: 'dose-slot' }, TIMING_LABELS[slot]),
      rows.map(({ m, s }) => h('label', { class: 'check dose' },
        h('input', { type: 'checkbox', checked: s.taken === true, 'data-med': String(m.id), 'data-timing': slot }),
        h('span', {}, m.name, m.dose ? h('span', { class: 'muted' }, ` ${m.dose}`) : null)))));
  }
  setStatus(status, day.saved ? 'Saved (unchecked items are recorded as skipped)' : 'Not logged for this day');
}

async function saveDoses(evt) {
  evt.preventDefault();
  const status = $('.status', evt.currentTarget);
  const doses = $$('#dose-list input[type="checkbox"]').map((c) => ({ medication_id: Number(c.dataset.med), timing: c.dataset.timing, taken: c.checked }));
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

async function loadStatus() {
  const s = await api('GET', '/api/status');
  state.today = s.today;
  $('#day').max = s.today;
  if (!$('#day').value) $('#day').value = s.today;
  const last = s.lastSync;
  $('#sync-status').textContent = last
    ? `Last sync ${new Date(last.finished_at ?? last.started_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}${last.status === 'ok' ? '' : ` (${last.status})`}`
    : 'Not synced yet';
}

async function loadDay() {
  if (!state.today) await loadStatus();
  const date = $('#day').value || state.today;
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
  } catch (err) {
    $('#sync-status').textContent = `Sync failed: ${err.message}`;
  } finally {
    btn.disabled = false;
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
  for (const c of CHARTS) {
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
const regimenText = (r) => [r.dose, r.timings.map((t) => TIMING_LABELS[t].toLowerCase()).join(', ')].filter(Boolean).join(', ');

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

function currentCard(m) {
  const card = h('div', { class: 'card med-card' },
    h('div', { class: 'head' }, h('h3', {}, m.name), h('span', { class: 'pill' }, m.kind === 'medication' ? 'Medication' : 'Supplement'),
      m.prescribed ? h('span', { class: 'pill rx' }, 'Prescribed') : null),
    h('div', { class: 'chips' }, m.current.dose ? h('span', { class: 'chip' }, m.current.dose) : null,
      m.current.timings.map((t) => h('span', { class: 'chip' }, TIMING_LABELS[t]))),
    h('p', { class: 'meta' }, m.current.start_estimated ? `Taking since at least ${niceDate(m.current.started_on)} (start date unknown)` : `Since ${niceDate(m.current.started_on)}`),
    m.purpose ? h('p', { class: 'meta' }, `For ${m.purpose}`) : null,
    m.notes ? h('p', { class: 'meta note-text' }, m.notes) : null,
    doseHistory(m));

  const actions = h('div', { class: 'actions' },
    h('button', { type: 'button', class: 'ghost', onclick: () => {
      inlineForm(card, 'Set the new dose or timing and the date it took effect. The old one is kept in the dose history.', [
        h('label', {}, 'Dose', h('input', { type: 'text', name: 'dose', maxLength: 100, value: m.current.dose ?? '' })),
        timingFieldset(m.current.timings),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'correction', onchange: (evt) => {
          const date = $('input[name="effective_on"]', evt.target.form);
          date.disabled = evt.target.checked;
          date.closest('label').hidden = evt.target.checked;
        } }), 'Fix a mistake (nothing actually changed, so no change is recorded)'),
        dateInput('effective_on', state.today),
      ], 'Save', (f) => api('POST', `/api/medications/${m.id}/changes`, {
        dose: f.elements.dose.value.trim() || null,
        timings: readTimings($('fieldset', f)),
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
    h('button', { type: 'button', class: 'ghost', onclick: () => inlineForm(card, 'Start taking it again.', [
      h('label', {}, 'Dose', h('input', { type: 'text', name: 'dose', maxLength: 100, value: last.dose ?? '' })),
      timingFieldset(last.timings),
      dateInput('started_on', state.today),
    ], 'Start again', (f) => api('POST', `/api/medications/${m.id}/start`, {
      dose: f.elements.dose.value.trim() || null, timings: readTimings($('fieldset', f)), started_on: f.elements.started_on.value,
    })) }, 'Start again'),
    editButton(card, m),
    deleteButton(m)));
  return card;
}

function eventText(e) {
  if (e.type === 'start') return `Started ${e.name}: ${regimenText(e.to)}`;
  if (e.type === 'stop') return `Stopped ${e.name}${e.reason ? ` (${e.reason})` : ''}`;
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

async function loadMeds() {
  if (!state.today) await loadStatus();
  const [meds, impact] = await Promise.all([api('GET', '/api/medications'), api('GET', '/api/medications/impact')]);
  const current = meds.filter((m) => m.current);
  const past = meds.filter((m) => !m.current);
  const empty = (text) => h('p', { class: 'empty-state' }, text);
  $('#meds-current').replaceChildren(...(current.length ? current.map(currentCard) : [empty('Nothing in your current list. Add what you take below.')]));
  $('#meds-past').replaceChildren(...(past.length ? past.map(pastCard) : [empty('Nothing stopped yet.')]));
  $('#meds-impact').replaceChildren(...(impact.length ? impact.map(impactCard) : [empty('Changes appear here once you add something.')]));
  const add = $('#med-add');
  if (!add.elements.started_on.value) add.elements.started_on.value = state.today;
  add.elements.started_on.max = state.today;
  add.elements.stopped_on.max = state.today;
}

function initMeds() {
  const form = $('#med-add');
  fillTimings($('[data-timings]', form));
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
        name: f.name.value.trim(), kind: f.kind.value, dose: f.dose.value.trim() || null, timings,
        started_on: f.started_on.value, start_estimated: f.start_estimated.checked,
        purpose: f.purpose.value.trim() || null, prescribed: f.prescribed.checked, notes: f.notes.value.trim() || null,
        ...(f.stopped_on.value ? { stopped_on: f.stopped_on.value, stop_reason: f.stop_reason.value.trim() || null } : {}),
      });
      // Keep the "don't know when I started" choice, since several items are often added in a row.
      const estimated = f.start_estimated.checked;
      form.reset();
      fillTimings($('[data-timings]', form));
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
const PREVIOUS_LABEL = { week: 'previous 7 days', month: 'previous 30 days', year: 'previous 52 weeks', '2y': 'previous 2 years', '5y': 'previous 5 years' };
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
  return loadTraining();
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

async function loadReviews() {
  const reviews = await api('GET', '/api/reviews');
  const container = $('#reviews');
  container.replaceChildren();
  if (!reviews.length) {
    const p = document.createElement('p');
    p.className = 'empty-state';
    p.textContent = 'No weekly reviews yet.';
    container.append(p);
    return;
  }
  for (const r of reviews) {
    const card = document.createElement('article');
    card.className = 'card review';
    card.append(h('h2', {}, `Week ending ${niceDate(r.week_ending)}`),
      h('p', { class: 'meta' }, `Generated ${new Date(r.created_at).toLocaleString()}${r.model ? ` by ${r.model}` : ''}`));
    if (r.warnings.length) {
      card.append(h('div', { class: 'review-warnings' },
        h('strong', {}, 'Checks that still failed after a retry:'),
        h('ul', {}, r.warnings.map((w) => h('li', {}, w)))));
    }
    renderMarkdown(r.report_md, card);
    card.append(h('p', { class: 'meta' }, 'An analytical aid, not medical advice. Discuss medications, lab results and symptoms with your physician.'));
    container.append(card);
  }
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

// ---------------- start ----------------
buildTodayForms();
initPrompt();
initMeds();
initLabs();
$$('[data-tview]').forEach((b) => b.addEventListener('click', () => loadTraining(b.dataset.tview)));
$$('[data-vview]').forEach((b) => b.addEventListener('click', () => loadVo2(b.dataset.vview)));
$$('[data-range]').forEach((b) => b.addEventListener('click', () => {
  state.range = Number(b.dataset.range);
  loadHistory();
}));
window.addEventListener('hashchange', route);
route();
