// Small single-series charts in plain SVG: a line chart with a crosshair tooltip, and a column
// chart with a per-bar tooltip. One series each, so the card title names it (no legend box).
// All labels go in with textContent.
const NS = 'http://www.w3.org/2000/svg';
const DAY = 86400000;
const M = { top: 10, right: 40, bottom: 22, left: 38 };

const el = (name, attrs = {}, parent) => {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  parent?.appendChild(node);
  return node;
};
const toMs = (date) => Date.parse(`${date}T00:00:00Z`);
const shortDate = (date) => new Date(toMs(date)).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
const monthYear = (date) => new Date(toMs(date)).toLocaleDateString(undefined, { month: 'short', year: 'numeric', timeZone: 'UTC' });
const longDate = (date) => new Date(toMs(date)).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

/** Clean tick values (1, 2, 5 steps) spanning min..max. */
function niceTicks(min, max, count = 3) {
  if (min === max) { min -= 1; max += 1; }
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Number(v.toFixed(10)));
  return ticks;
}

const tooltip = () => document.getElementById('tooltip');
function showTip(evt, date, value, heading, details = []) {
  const tip = tooltip();
  tip.replaceChildren();
  const d = document.createElement('div');
  d.className = 't-date';
  d.textContent = heading ?? longDate(date);
  const v = document.createElement('div');
  v.textContent = value;
  tip.append(d, v);
  for (const line of details) {
    const extra = document.createElement('div');
    extra.className = 't-detail';
    extra.textContent = line;
    tip.append(extra);
  }
  tip.hidden = false;
  const x = Math.min(evt.clientX + 12, window.innerWidth - tip.offsetWidth - 8);
  const y = Math.max(evt.clientY - tip.offsetHeight - 12, 8);
  tip.style.left = `${x}px`;
  tip.style.top = `${y}px`;
}
const hideTip = () => { tooltip().hidden = true; };

function frame(container, { from, to, yValues }) {
  const width = Math.max(container.clientWidth, 200);
  const height = container.clientHeight || 150;
  const svg = el('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img' });
  const plotW = width - M.left - M.right;
  const plotH = height - M.top - M.bottom;
  const x0 = toMs(from);
  const span = Math.max(toMs(to) - x0, DAY);
  const x = (date) => M.left + ((toMs(date) - x0) / span) * plotW;
  const ticks = niceTicks(Math.min(...yValues), Math.max(...yValues));
  const [ylo, yhi] = [ticks[0], ticks[ticks.length - 1]];
  const y = (v) => M.top + plotH - ((v - ylo) / (yhi - ylo)) * plotH;

  const grid = el('g', { class: 'grid' }, svg);
  const axis = el('g', { class: 'axis' }, svg);
  for (const t of ticks) {
    el('line', { x1: M.left, x2: M.left + plotW, y1: y(t), y2: y(t) }, grid);
    el('text', { x: M.left - 6, y: y(t) + 4, 'text-anchor': 'end' }, axis).textContent = t.toLocaleString();
  }
  const mid = new Date(x0 + span / 2).toISOString().slice(0, 10);
  [[from, 'start'], [mid, 'middle'], [to, 'end']].forEach(([d, anchor]) => {
    // Ranges past about 10 months label month and year ("Jul 2018"); shorter ones month and day.
    el('text', { x: x(d), y: height - 6, 'text-anchor': anchor }, axis).textContent = span > 300 * DAY ? monthYear(d) : shortDate(d);
  });
  return { svg, x, y, plotW, plotH, width, height, ylo };
}

function empty(container) {
  const width = Math.max(container.clientWidth, 200);
  const svg = el('svg', { viewBox: `0 0 ${width} 150` });
  el('text', { class: 'empty', x: width / 2, y: 78, 'text-anchor': 'middle' }, svg).textContent = 'No data in this range';
  return svg;
}

/**
 * Line chart. points: [{date, value}] sorted by date, values non-null.
 * The line breaks across gaps longer than gapDays so missing stretches are not drawn as data.
 */
export function lineChart(container, points, { from, to, format = String, gapDays = 3, label = 'Value' }) {
  const draw = () => {
    container.replaceChildren();
    if (!points.length) return container.append(empty(container));
    const { svg, x, y, plotW, plotH } = frame(container, { from, to, yValues: points.map((p) => p.value) });
    svg.setAttribute('aria-label', `${label}, ${points.length} values from ${shortDate(from)} to ${shortDate(to)}`);

    let d = '';
    points.forEach((p, i) => {
      const gap = i > 0 && (toMs(p.date) - toMs(points[i - 1].date)) / DAY > gapDays;
      d += `${i === 0 || gap ? 'M' : 'L'}${x(p.date).toFixed(1)},${y(p.value).toFixed(1)}`;
    });
    el('path', { class: 'line', d }, svg);

    // Isolated points (no neighbour within gapDays) would be invisible as a line: mark them.
    points.forEach((p, i) => {
      const near = (j) => points[j] && Math.abs(toMs(points[j].date) - toMs(p.date)) / DAY <= gapDays;
      if (!near(i - 1) && !near(i + 1)) el('circle', { class: 'dot', cx: x(p.date), cy: y(p.value), r: 3 }, svg);
    });

    const last = points[points.length - 1];
    el('circle', { class: 'dot', cx: x(last.date), cy: y(last.value), r: 4 }, svg);
    el('text', { x: x(last.date) + 8, y: y(last.value) + 4, class: 'axis-end', fill: 'var(--text-secondary)', 'font-size': 11 }, svg)
      .textContent = format(last.value);

    const cross = el('line', { class: 'crosshair', y1: M.top, y2: M.top + plotH, visibility: 'hidden' }, svg);
    const focus = el('circle', { class: 'dot', r: 4, visibility: 'hidden' }, svg);
    const hit = el('rect', { x: M.left, y: M.top, width: plotW, height: plotH, fill: 'transparent' }, svg);
    hit.addEventListener('pointermove', (evt) => {
      const box = svg.getBoundingClientRect();
      const px = ((evt.clientX - box.left) / box.width) * svg.viewBox.baseVal.width;
      let best = points[0];
      for (const p of points) if (Math.abs(x(p.date) - px) < Math.abs(x(best.date) - px)) best = p;
      cross.setAttribute('x1', x(best.date));
      cross.setAttribute('x2', x(best.date));
      cross.setAttribute('visibility', 'visible');
      focus.setAttribute('cx', x(best.date));
      focus.setAttribute('cy', y(best.value));
      focus.setAttribute('visibility', 'visible');
      showTip(evt, best.date, `${label}: ${format(best.value)}`, best.label, best.details);
    });
    hit.addEventListener('pointerleave', () => {
      cross.setAttribute('visibility', 'hidden');
      focus.setAttribute('visibility', 'hidden');
      hideTip();
    });
    container.append(svg);
  };
  draw();
  observe(container, draw);
}

/**
 * Column chart. points: [{date, value, label?, details?}] (zero buckets included). Each column covers
 * bucketDays days starting at its date (1 for daily, 7 for weeks, about 30 for months); a point's
 * label replaces the tooltip date ("Week ending Sep 26").
 */
export function columnChart(container, points, { from, to, format = String, label = 'Value', bucketDays = 1 }) {
  const draw = () => {
    container.replaceChildren();
    if (!points.length) return container.append(empty(container));
    const { svg, x, y, plotW } = frame(container, { from, to, yValues: [0, ...points.map((p) => p.value)] });
    svg.setAttribute('aria-label', `${label}, ${points.length} ${bucketDays === 1 ? 'days' : 'periods'} from ${shortDate(from)} to ${shortDate(to)}`);
    const days = Math.max(1, Math.round((toMs(to) - toMs(from)) / DAY) + 1);
    const slot = (plotW / days) * bucketDays;
    const w = Math.max(2, Math.min(24, slot > 6 ? slot - 2 : slot * 0.75)); // 2px surface gap once there is room
    const base = y(0);
    for (const p of points) {
      const cx = x(p.date) + ((bucketDays - 1) / 2) * (plotW / days); // centre of the bucket
      if (p.value > 0) {
        const top = y(p.value);
        const r = w >= 8 ? Math.min(4, (base - top) / 2) : 0; // 4px rounded data end, square at the baseline
        const left = cx - w / 2;
        const bar = el('path', {
          class: 'bar',
          d: `M${left},${base}V${top + r}Q${left},${top} ${left + r},${top}H${left + w - r}Q${left + w},${top} ${left + w},${top + r}V${base}Z`,
        }, svg);
        bar.dataset.date = p.date;
      }
      const hit = el('rect', { x: cx - Math.max(slot, 6) / 2, y: 0, width: Math.max(slot, 6), height: base, fill: 'transparent' }, svg);
      hit.addEventListener('pointermove', (evt) => {
        svg.querySelector(`.bar[data-date="${p.date}"]`)?.classList.add('hover');
        showTip(evt, p.date, `${label}: ${format(p.value)}`, p.label, p.details);
      });
      hit.addEventListener('pointerleave', () => {
        svg.querySelector(`.bar[data-date="${p.date}"]`)?.classList.remove('hover');
        hideTip();
      });
    }
    container.append(svg);
  };
  draw();
  observe(container, draw);
}

const observers = new WeakMap();
function observe(container, draw) {
  observers.get(container)?.disconnect();
  let lastWidth = container.clientWidth;
  const ro = new ResizeObserver(() => {
    if (container.clientWidth !== lastWidth) {
      lastWidth = container.clientWidth;
      draw();
    }
  });
  ro.observe(container);
  observers.set(container, ro);
}
