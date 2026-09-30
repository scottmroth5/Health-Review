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
const VIEWS = ['today', 'history', 'reviews', 'prompt'];
function route() {
  const view = VIEWS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'today';
  for (const v of VIEWS) $(`#view-${v}`).hidden = v !== view;
  $$('.top nav a').forEach((a) => (a.getAttribute('href') === `#${view}` ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
  ({ today: loadDay, history: loadHistory, reviews: loadReviews, prompt: loadSections })[view]();
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
  const { checkin, drinking } = await api('GET', `/api/days/${date}`);
  state.day = { checkin, drinking };

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

async function loadHistory() {
  if (!state.today) await loadStatus();
  $$('.filters button').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.range) === state.range)));
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
    const h = document.createElement('h2');
    h.textContent = `Week ending ${r.week_ending}`;
    const meta = document.createElement('p');
    meta.className = 'meta';
    meta.textContent = `Generated ${new Date(r.created_at).toLocaleString()}`;
    card.append(h, meta);
    renderMarkdown(r.report_md, card);
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
  check.append(checkInput, document.createTextNode('Sensitive (medications, genetics): left out of the weekly review'));

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

async function loadSections() {
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
  if (p.leftOut.length) parts.push(`left out (sensitive): ${p.leftOut.join(', ')}`);
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
}

// ---------------- start ----------------
buildTodayForms();
initPrompt();
$$('.filters button').forEach((b) => b.addEventListener('click', () => {
  state.range = Number(b.dataset.range);
  loadHistory();
}));
window.addEventListener('hashchange', route);
route();
