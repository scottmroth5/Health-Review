// Suggested targets for the Health tab and the weekly review (pure; norms in config/health-targets.json). A target
// starts from the owner's current value (the 90-day average, or the latest reading for VO2 max) and moves one step
// toward the healthy level for their sex and age, or straight to it when that is closer; once at or past it, a half step
// more, held at the improvement cap. Ranges aim to get inside the span and then hold. A metric with no norm for the
// owner is "your current value, improved by a step" (based on their data only). Computed here, never by the model; the
// owner can replace any suggestion (health_targets).
import { readFileSync } from 'node:fs';
import { repoPath } from '../tools/paths.js';
import { round } from './stats.js';

export const TARGETS_PATH = repoPath('config', 'health-targets.json');
export const loadTargetConfig = (path = TARGETS_PATH) => JSON.parse(readFileSync(path, 'utf8'));

/** Age in whole years on a date, from a birth year (assumes the birthday has passed; good enough for age bands). */
export const ageOn = (birthYear, today) => (birthYear ? Number(today.slice(0, 4)) - birthYear : null);

const fmt = (v, def) => `${round(v, def.decimals).toLocaleString('en-US')}${def.unit}`;

function bandLabel(norm) {
  if (norm.sex === 'any' && norm.ages[0] <= 18 && norm.ages[1] >= 120) return 'adults';
  const who = norm.sex === 'male' ? 'men' : norm.sex === 'female' ? 'women' : 'adults';
  if (norm.ages[1] >= 120) return `${who} ${norm.ages[0]} and over`;
  if (norm.ages[0] <= 18) return `${who} under ${norm.ages[1] + 1}`;
  return `${who} ${norm.ages[0]} to ${norm.ages[1]}`;
}

/** The norm for this owner: the first band matching their sex (or any sex) and age, or null. */
export function normFor(def, profile) {
  const age = profile?.age ?? null;
  return (def.norms ?? []).find((n) => (n.sex === 'any' || n.sex === profile?.sex)
    && (age === null ? n.sex === 'any' && n.ages[0] <= 18 && n.ages[1] >= 120 : age >= n.ages[0] && age <= n.ages[1])) ?? null;
}

/** A weight range from BMI and height: BMI x height² / 703 (pounds and inches). */
const bmiWeights = ([lo, hi], heightIn) => [lo * heightIn ** 2 / 703, hi * heightIn ** 2 / 703];

/**
 * @param {object} input
 * @param {string} input.metric
 * @param {number|null} input.current  the 90-day average (or latest reading, per the config)
 * @param {{ age?: number|null, sex?: string|null, heightIn?: number|null }} [input.profile]
 * @param {object} input.config  config/health-targets.json
 * @returns {{ metric, current, suggested, basis: 'norm'|'personal', healthy: {low, high}|null, band: number[]|null,
 *   reason: string, source: string }|null}  null for a metric the config does not know
 */
export function suggestTarget({ metric, current, profile = {}, config }) {
  const def = config.metrics[metric];
  if (!def) return null;
  const now = current === null || current === undefined ? null : current;
  const step = def.stepPct && now !== null ? (Math.abs(now) * def.stepPct) / 100 : def.step ?? 0;
  const currentLabel = def.current === 'latest' ? 'latest reading' : '90-day average';

  let norm = normFor(def, profile);
  let low = null;
  let high = null;
  if (def.bmi && profile?.heightIn) {
    [low, high] = bmiWeights(def.bmi, profile.heightIn);
    norm = { sex: 'any', ages: [18, 120], text: `${fmt(low, def)} to ${fmt(high, def)} (BMI ${def.bmi[0]} to ${def.bmi[1]} for your height)` };
  } else if (norm && def.direction === 'range') {
    [low, high] = [norm.low, norm.high];
  } else if (norm && def.direction === 'higher') {
    low = norm.healthy;
  } else if (norm && def.direction === 'lower') {
    high = norm.healthy;
  }

  let suggested = null;
  let band = null;
  let verb = '';
  if (def.direction === 'band') {
    suggested = now;
    band = now === null ? null : [now - def.band, now + def.band];
  } else if (!norm) {
    // No norm for this owner: improve on their own data (a range with no span, such as weight without a height, holds).
    if (now !== null && def.direction === 'range') {
      suggested = now;
      verb = `hold at {T}`;
    } else if (now !== null) {
      suggested = def.direction === 'lower' ? Math.max(now - step, def.floor ?? -Infinity) : Math.min(now + step, def.ceiling ?? Infinity);
      verb = `next step {T}`;
    }
  } else if (def.direction === 'range') {
    if (now === null) suggested = (low + high) / 2;
    else if (now < low) { suggested = Math.min(now + step, low); verb = `next step {T}`; }
    else if (now > high) { suggested = Math.max(now - step, high); verb = `next step {T}`; }
    else { suggested = now; verb = `in the healthy range: hold at {T}`; }
    band = [low, high];
  } else if (def.direction === 'higher') {
    if (now === null) suggested = norm.healthy;
    else if (now < norm.healthy) { suggested = Math.min(now + step, norm.healthy); verb = `next step {T}`; }
    else if (norm.cap !== undefined && now >= norm.cap) { suggested = now; verb = `already past ${fmt(norm.cap, def)}: hold at {T}`; }
    else { suggested = Math.min(now + step / 2, norm.cap ?? Infinity); verb = `keep improving to {T}`; }
  } else {
    if (now === null) suggested = norm.healthy;
    else if (now > norm.healthy) { suggested = Math.max(now - step, norm.healthy); verb = `next step {T}`; }
    else if (norm.cap !== undefined && now <= norm.cap) { suggested = now; verb = `already at ${fmt(norm.cap, def)} or better: hold at {T}`; }
    else { suggested = Math.max(now - step / 2, norm.cap ?? -Infinity); verb = `keep improving to {T}`; }
  }
  // roundTo keeps a suggestion a usable number (steps to the nearest 100); the reason names the rounded value.
  suggested = suggested === null ? null : def.roundTo ? Math.round(suggested / def.roundTo) * def.roundTo : round(suggested, def.decimals);
  if (suggested !== null) verb = verb.replaceAll('{T}', fmt(suggested, def));
  if (band) band = band.map((b) => round(b, def.decimals));

  const basis = norm && def.direction !== 'band' ? 'norm' : 'personal';
  const healthyText = basis !== 'norm' ? '' : norm.text ?? (def.direction === 'range' ? `${fmt(low, def)} to ${fmt(high, def)}`
    : def.direction === 'higher' ? `${fmt(low, def)} or more` : `${fmt(high, def)} or less`);
  const yours = now === null ? 'No data yet' : `Your ${currentLabel} ${fmt(now, def)}`;
  let reason;
  if (def.direction === 'band') {
    reason = now === null ? 'Based on your data only: no data yet.' : `Based on your data only: stay within ${def.band}${def.unit} of your 90-day average (${fmt(now, def)}).`;
  } else if (basis === 'norm') {
    reason = `Healthy for ${bandLabel(norm)}: ${healthyText}. ${yours}${verb ? `: ${verb}` : ''}.`;
  } else {
    const missing = (def.norms ?? []).length && !(profile?.age && profile?.sex) ? ' Add your profile for an age-based target.' : '';
    const noNorm = def.bmi && !profile?.heightIn ? 'Add your height for a healthy weight range.' : 'No published norm for you on this measure; based on your data only.';
    reason = `${noNorm}${missing} ${yours}${verb ? `: ${verb}` : ''}.`;
  }

  return {
    metric,
    current: now === null ? null : round(now, def.decimals),
    suggested,
    basis,
    healthy: basis === 'norm' ? { low: low === null ? null : round(low, def.decimals), high: high === null ? null : round(high, def.decimals) } : null,
    band,
    reason,
    source: def.source,
  };
}
