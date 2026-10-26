// The demo's weekly reviews, written in code from each week's real computed summary (agent/summary.js on the demo's
// made-up data), so every number in them is one the summary holds and they pass the review's own checks
// (agent/validate.js: no dashes, grounded numbers, physician routing). The same sections the owner's reviews have;
// wording varies by a seed per week. No Claude call; nothing leaves the machine.

// Values are printed exactly as the summary holds them (already rounded to the precision the report shows).
const fmt = (n) => (typeof n === 'number' ? n.toLocaleString('en-US', { maximumFractionDigits: 3 }) : String(n));
const day = (iso) => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`;
const signed = (n) => (n > 0 ? `up ${fmt(n)}` : n < 0 ? `down ${fmt(-n)}` : 'level');
const list = (xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);

/** A tiny seeded chooser for wording (the same week always reads the same). */
function chooser(seedText) {
  let a = [...seedText].reduce((h, c) => (Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0), 2166136261);
  return (options) => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return options[(((t ^ (t >>> 14)) >>> 0) % options.length)];
  };
}

const LABELS = { hrv_ms: 'HRV', resting_hr: 'resting heart rate', sleep_total_hr: 'sleep', sleep_deep_hr: 'deep sleep', sleep_rem_hr: 'REM sleep',
  sleep_core_hr: 'core sleep', sleep_awake_hr: 'time awake', stand_hours: 'stand hours', steps: 'steps', active_energy_kcal: 'active energy', exercise_min: 'exercise minutes',
  respiratory_rate: 'breathing rate', walking_hr_avg: 'walking heart rate', walking_speed_mph: 'walking speed', walking_asymmetry_pct: 'walking asymmetry',
  cardio_recovery_bpm: 'cardio recovery', wrist_temp_f: 'wrist temperature', hr_min: 'lowest heart rate', hr_max: 'highest heart rate', hr_avg: 'average heart rate',
  physical_effort: 'physical effort', vo2max: 'VO2 max' };
const STATUS_WORDS = { progressing: 'progressing', stalled: 'holding flat', regressing: 'slipping', new_rep_range: 'in a new rep range', not_enough_data: 'still building history' };

function wins(s, pick) {
  const out = [];
  const up = (s.lifts ?? []).filter((l) => l.status === 'progressing');
  if (up.length) out.push(`- **${up[0].name}** is progressing in the ${up[0].range} range: best ${fmt(up[0].recentBest)} lbs estimated against ${fmt(up[0].baselineBest)} before (${fmt(up[0].changePct)}%).`);
  const a = s.programAdherence;
  if (a?.days) out.push(`- **${a.matched} of ${a.days} lifting days** matched the ${a.program} workout, with ${fmt(a.setsLogged)} sets logged.`);
  const st = s.checkins?.scales?.stress;
  if (st?.mean != null && st.changeVsBaseline < 0) out.push(`- **Stress eased:** check-ins averaged ${fmt(st.mean)} against ${fmt(st.baselineMean)} over the baseline.`);
  const hrv = s.recovery?.hrv_ms;
  if (hrv?.mean != null && hrv.changeVsBaseline > 0) out.push(`- **HRV ${pick(['climbed', 'rose', 'improved'])}** to ${fmt(hrv.mean)} ms, ${signed(hrv.changeVsBaseline)} on the baseline.`);
  const c = s.cardio?.cardio;
  if (c?.minutes && c.changeVsBaselineMinutes > 0) out.push(`- **Cardio:** ${fmt(c.minutes)} minutes over ${c.sessions} sessions, ahead of the usual ${fmt(c.baselineWeeklyMinutes)}.`);
  if (!out.length && s.strength?.week?.days) out.push(`- **${s.strength.week.days} lifting days** and ${fmt(s.strength.week.sets)} sets kept the program moving.`);
  return out.length ? { title: 'Weekly Wins', body: out.join('\n') } : null;
}

function recovery(s, pick) {
  const r = s.recovery ?? {};
  const lines = [];
  const metric = (m, label, unit) => {
    if (m?.mean == null) return;
    const vs = m.baselineMean != null ? `, against a baseline of ${fmt(m.baselineMean)}${unit} (${fmt(m.changeVsBaselinePct)}%)` : '';
    lines.push(`- **${label}:** ${fmt(m.mean)}${unit} on average over ${m.days} days${vs}.`);
  };
  metric(r.hrv_ms, 'HRV', ' ms');
  metric(r.resting_hr, 'Resting heart rate', ' bpm');
  metric(r.sleep_total_hr, 'Sleep', ' hours');
  const odd = Object.entries(r).flatMap(([k, m]) => (m?.unusualDays ?? []).map((u) => `${LABELS[k] ?? k.replace(/_/g, ' ')} ${u.direction} on ${day(u.date)}`));
  if (odd.length) lines.push(`- **Unusual days:** ${list(odd.slice(0, 4))}.`);
  const dq = s.dataQuality;
  if (dq?.missingDays?.length || dq?.suspectedPartialDays?.length) {
    lines.push(`- **Incomplete data:** ${[dq.missingDays?.length ? `no Apple Health data for ${list(dq.missingDays.map(day))}` : '', dq.suspectedPartialDays?.length ? `a partial export on ${list(dq.suspectedPartialDays.map(day))}` : ''].filter(Boolean).join('; ')}. ${pick(['Those days are left out of the averages, not counted as bad days.', 'Read the averages with those gaps in mind.'])}`);
  }
  return lines.length ? { title: 'Recovery', body: lines.join('\n') } : null;
}

function training(s, pick) {
  const lines = [];
  const p = s.program;
  if (p?.program) {
    lines.push(`- **Program:** ${p.program}, ${p.phase ?? 'phase unknown'}${p.phaseWeek ? ` (week ${p.phaseWeek} of ${p.phaseWeeks})` : ''}, program week ${p.week} of ${p.programWeeks}${p.deloadWeek ? ', a deload week' : ''}. ${p.earliestFinish ? `The earliest finish is ${day(p.earliestFinish)}.` : ''}`.trim());
  }
  const w = s.strength?.week;
  if (w?.days) {
    const change = s.strength.volumeChangeVsPrevious3WeeksPct;
    lines.push(`- **Volume:** ${fmt(w.volumeLbs)} lbs over ${w.days} days and ${fmt(w.sets)} sets${change != null ? `, ${signed(change)}% against the previous three weeks (${fmt(s.strength.previous3WeeksAvgVolumeLbs)} lbs on average)` : ''}.`);
  }
  const lifts = (s.lifts ?? []).filter((l) => STATUS_WORDS[l.status]).slice(0, 5);
  if (lifts.length) {
    lines.push(`- **Lift progress:** ${list(lifts.map((l) => `${l.name} ${STATUS_WORDS[l.status]}${l.changePct != null ? ` (${fmt(l.changePct)}%)` : ''}`))}.`);
  }
  const a = s.programAdherence;
  if (a?.days) {
    const c = a.counts;
    lines.push(`- **Called for vs logged:** ${c.as_called} exercises as called for${c.swapped ? `, ${c.swapped} swapped for home equipment` : ''}${c.changed ? `, ${c.changed} changed` : ''}${c.skipped ? `, ${c.skipped} skipped` : ''}${c.added ? `, ${c.added} added` : ''}.${a.doneInstead?.length ? ` Done instead: ${list(a.doneInstead.slice(0, 3).map((x) => x.logged ?? x.name ?? x))}.` : ''}`);
  }
  const regress = (s.lifts ?? []).find((l) => l.status === 'regressing');
  if (regress) lines.push(`- **Watch:** ${regress.name} best is ${fmt(regress.recentBest)} lbs against ${fmt(regress.baselineBest)} before. ${pick(['Check sleep and recovery on its days before adding load.', 'Hold the load steady and own the reps before pushing again.'])}`);
  return lines.length ? { title: 'Training', body: lines.join('\n') } : null;
}

function cardio(s) {
  const c = s.cardio;
  const z = s.heartRateZones;
  if (!c?.cardio && !z) return null;
  const lines = [];
  if (c?.cardio) lines.push(`- **Cardio:** ${c.cardio.sessions} sessions and ${fmt(c.cardio.minutes)} minutes (usual week ${fmt(c.cardio.baselineWeeklyMinutes)}), average heart rate ${fmt(c.cardio.avgHr)} bpm; peak ${fmt(c.peakHr)} bpm.`);
  if (z?.week) {
    const parts = z.week.minutes.map((m, i) => `Zone ${i + 1} ${fmt(m)}`).filter((t, i) => z.week.minutes[i]);
    if (parts.length) lines.push(`- **Heart rate zones (minutes):** ${list(parts)}${z.week.noDetail ? `, plus ${fmt(z.week.noDetail)} with no minute detail` : ''}. Zone 2 is ${fmt(z.zones[1].low)} to ${fmt(z.zones[1].high)} bpm.`);
  }
  const types = (c?.byType ?? []).filter((t) => t.kind === 'cardio').map((t) => `${t.type} ${t.sessions}x`);
  if (types.length) lines.push(`- **By type:** ${list(types)}.`);
  return { title: 'Cardio and Heart Rate Zones', body: lines.join('\n') };
}

function drinks(s) {
  const d = s.drinking;
  if (!d?.week) return null;
  const w = d.week;
  if (!w.loggedDays) return { title: 'Drinks', body: '- No drink days logged this week, so there is nothing to compare.' };
  const lines = [`- **${fmt(w.totalDrinks)} drinks** over ${w.drinkingDays} drinking days and ${w.alcoholFreeDays} alcohol-free days (${w.loggedDays} days logged).`];
  if (d.baseline?.drinksPer7Days != null) lines.push(`- **Usual pace:** ${fmt(d.baseline.drinksPer7Days)} per 7 logged days over the baseline.`);
  const hrv = d.nextMorning90d?.hrv_ms;
  if (hrv?.difference != null) lines.push(`- **Next morning HRV:** ${fmt(hrv.meanAfterDrinking)} ms after drinking days against ${fmt(hrv.meanAfterAlcoholFree)} ms after alcohol-free days (90 days).`);
  return { title: 'Drinks', body: lines.join('\n') };
}

function body(s) {
  const c = s.checkins;
  if (!c?.week?.entries) return null;
  const lines = [];
  const sc = c.scales ?? {};
  const scale = (k, label) => (sc[k]?.mean != null ? `${label} ${fmt(sc[k].mean)}` : null);
  const parts = [scale('readiness', 'readiness'), scale('energy', 'energy'), scale('mood', 'mood'), scale('stress', 'stress'), scale('nutrition', 'nutrition')].filter(Boolean);
  if (parts.length) lines.push(`- **Check-ins (${c.week.entries} this week):** ${list(parts)} out of 10.`);
  const wt = c.body?.weight_lbs;
  if (wt?.latest != null) lines.push(`- **Weight:** ${fmt(wt.latest)} lbs on ${day(wt.latestDate)}${wt.change != null ? `, ${signed(wt.change)} lbs` : ''}.`);
  return lines.length ? { title: 'Check-ins and Body', body: lines.join('\n') } : null;
}

function targets(s) {
  const t = (s.targets ?? []).filter((x) => x.current90d != null && !/blood oxygen|breathing/i.test(x.metric)).slice(0, 4);
  if (!t.length) return null;
  return { title: 'Targets', body: t.map((x) => `- **${x.metric}:** ${fmt(x.current90d)} over 90 days, target ${fmt(x.target)} (${x.setBy}).`).join('\n') };
}

function nextWeek(s, pick) {
  const lines = [];
  const p = s.program;
  if (p?.phase) lines.push(`- Keep ${p.program} ${p.phase} on its days; ${pick(['aim for every session', 'protect the main lift on each day', 'keep the rest times honest'])}.`);
  const top = s.advisor?.top?.[0];
  if (top) lines.push(`- The block ends soon. The Advisor ranks **${top.program}** first (score ${top.total.toFixed(2)}): ${top.reasons?.[0] ?? 'see the Training tab'}.`);
  const c = s.cardio?.cardio;
  if (c && c.changeVsBaselineMinutes < 0) lines.push(`- Add a walk or ride to get back toward ${fmt(c.baselineWeeklyMinutes)} cardio minutes.`);
  const hrv = s.recovery?.hrv_ms;
  if (hrv && hrv.changeVsBaseline < 0) lines.push(`- HRV ran ${fmt(Math.abs(hrv.changeVsBaselinePct))}% under the baseline; ${pick(['guard sleep before heavy days', 'keep late nights for the weekend', 'go easier if readiness drops'])}.`);
  if (!lines.length) lines.push('- Same plan: lift on schedule, walk most days, and log check-ins.');
  return { title: 'Next Week', body: lines.join('\n') };
}

function physician(s) {
  const items = [];
  for (const r of s.labs?.results ?? []) {
    if (r.rangeStatus === 'above' || r.rangeStatus === 'below') {
      const bound = r.rangeStatus === 'above' ? `high ${fmt(r.range.high)}` : `low ${fmt(r.range.low)}`;
      items.push({ topic: r.test, detail: `${fmt(r.latest.value)} ${r.unit ?? ''} on ${day(r.latest.date)}, ${r.rangeStatus} its typical range (${bound})${r.change != null ? `; ${signed(r.change)} since ${day(r.previous.date)}` : ''}. Worth a look at your next visit.`.replace(/\s+,/g, ',') });
    }
  }
  const o2 = s.nightBreathing?.spo2_pct;
  if (o2?.mean != null) items.push({ topic: 'Overnight blood oxygen', detail: `Averaged ${fmt(o2.mean)}% this week (baseline ${fmt(o2.baselineMean)}%). Shown for your records; ask whether it needs follow up.` });
  return items.slice(0, 4);
}

/**
 * A full weekly review ({ sections, physicianDiscussion }, the shape agent/instructions.js renderReport takes) from one
 * week's summary. Every number comes from the summary itself.
 */
export function writeDemoReview(summary) {
  const pick = chooser(summary.about?.weekEnd ?? 'week');
  const sections = [wins, recovery, training, cardio, drinks, body, targets, nextWeek].map((f) => f(summary, pick)).filter(Boolean);
  return { sections, physicianDiscussion: physician(summary) };
}
