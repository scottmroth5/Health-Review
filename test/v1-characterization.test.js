// Characterization tests: v2 ports checked against v1 golden outputs in evals/fixtures/v1
// (generated once from the frozen legacy scripts with synthetic inputs). Where v2 keeps v1's
// behavior the outputs must match; where v2 fixes a v1 bug, the test pins both sides.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { repoPath } from '../tools/paths.js';
import { rowsToRecords } from '../ingest/rows.js';
import { latestByKey } from '../ingest/dedupe.js';
import { assembleSections } from '../agent/prompts.js';

const decode = (v) =>
  Array.isArray(v) ? v.map(decode)
  : v && typeof v === 'object' ? ('$date' in v ? new Date(v.$date) : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, decode(x)])))
  : v;

function golden(name) {
  const { cases } = JSON.parse(readFileSync(repoPath('evals', 'fixtures', 'v1', `${name}.json`), 'utf8'));
  return Object.fromEntries(cases.map((c) => [c.name, decode(c)]));
}

// v1's text rendering of a record (goldens use UTC as the script time zone).
const v1Date = (d) => `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`;
const renderV1 = (records) =>
  records.map((r) => Object.entries(r).map(([h, v]) => `${h}: ${v instanceof Date ? v1Date(v) : v}`).join(' | ')).join('\n') || 'No data';

// ---- sheet rows ----
const rows = golden('sheet-rows');

for (const name of [
  'formats each row as Header: value joined by pipes',
  'drops empty cells, null cells and headerless columns but keeps zero and false',
  'skips blank rows',
  'header only returns No data',
  'row with only empty or headerless cells is dropped entirely',
]) {
  test(`rows: ${name}`, () => {
    const c = rows[name];
    assert.equal(renderV1(rowsToRecords(c.tabs[c.tabName])), c.v1.text);
  });
}

test('rows: FIXED v1 bug: date cells lost their time of day; records keep the full timestamp', () => {
  const c = rows['date cells lose their time of day'];
  assert.equal(c.v1.text, 'Type: Outdoor Run | Start: 3/2/2026 | End: 3/2/2026 | Avg HR: 148');
  const [record] = rowsToRecords(c.tabs[c.tabName]);
  assert.equal(record.Start.toISOString(), '2026-03-02T06:15:00.000Z');
  assert.equal(record.End.toISOString(), '2026-03-02T06:52:30.000Z');
});

test('rows: trailing cells the Sheets API omits count as empty', () => {
  assert.deepEqual(rowsToRecords([['Date', 'HRV', 'Notes'], ['2026-03-02', 48]]), [{ Date: '2026-03-02', HRV: 48 }]);
});

test('rows: duplicate headers are rejected instead of silently overwriting', () => {
  assert.throws(() => rowsToRecords([['Date', 'HRV', 'HRV'], ['2026-03-02', 48, 50]]), /Duplicate column header "HRV"/);
});

test('rows: no values gives no records', () => {
  assert.deepEqual(rowsToRecords([]), []);
  assert.deepEqual(rowsToRecords(undefined), []);
});

// ---- consolidation and dedupe ----
const health = golden('consolidate-health');
const workouts = golden('consolidate-workouts');
const byDate = (r) => r.Date;
const bySession = (r) => `${r.Type}|${r.Start}|${r.End}`;

test('dedupe: FIXED v1 bug: a re-exported partial day stayed twice; the later row now wins', () => {
  const c = health['BUG: a partial day re-exported with a different first metric is kept twice'];
  const v1Records = rowsToRecords(c.v1.destination);
  assert.equal(v1Records.filter((r) => r.Date === '2026-03-02 00:00:00').length, 2, 'v1 kept both rows');

  const v2 = latestByKey(v1Records, byDate);
  assert.equal(v2.length, 1);
  assert.equal(v2[0]['Heart Rate Variability (ms)'], 48, 'the later, complete export wins');
});

for (const name of [
  'empty destination gets the header once and rows from matching files in name order',
  'rows whose date and first metric already exist are skipped',
  'empty source file is skipped',
]) {
  test(`dedupe: health matches v1 when there are no re-exports: ${name}`, () => {
    const records = rowsToRecords(health[name].v1.destination);
    assert.deepEqual(latestByKey(records, byDate), records);
  });
}

for (const [name, c] of Object.entries(workouts)) {
  test(`dedupe: workouts match v1: ${name}`, () => {
    const allRows = [c.files[0].values[0], ...c.destination.slice(1), ...c.files.flatMap((f) => f.values.slice(1))];
    assert.deepEqual(latestByKey(rowsToRecords(allRows), bySession), rowsToRecords(c.v1.destination));
  });
}

// ---- prompt sections ----
const prompt = golden('prompt');
const DATA_BLOCKS = '\n\nAPPLE WATCH DAILY METRICS (last 7 days):\n';

for (const name of [
  'sections sort numerically, not alphabetically, and every {{TODAY}} is replaced',
  'a single section still gets the data blocks appended',
]) {
  test(`prompt: sections match v1: ${name}`, () => {
    const c = prompt[name];
    // v1 keys are PROMPT_NN_<name>; v2 section names are NN_<name>.
    const sections = Object.entries(c.promptProps)
      .filter(([key]) => key.startsWith('PROMPT_'))
      .map(([key, text]) => ({ name: key.slice('PROMPT_'.length), text }));
    const v1Instructions = c.v1.prompt.slice(0, c.v1.prompt.indexOf(DATA_BLOCKS));
    assert.equal(assembleSections(sections, '2026-03-08'), v1Instructions);
  });
}

test('prompt: names without a numeric prefix are not sections', () => {
  const sections = [{ name: 'notes.md', text: 'ignored' }, { name: '01_profile.md', text: 'kept' }];
  assert.equal(assembleSections(sections, '2026-03-08'), 'kept');
});

// ---- Claude call ----
const claudeCall = golden('claude-call');
const { createClaude, ClaudeTruncatedError } = await import('@scottmroth5/agent-core');
const viaAgentCore = (response) => createClaude({ client: { messages: { create: async () => ({ model: 'claude-haiku-4-5', usage: {}, ...response }) } } })
  .send({ model: 'claude-haiku-4-5', maxTokens: 100, prompt: 'PROMPT' });

test('claude: FIXED v1 bug: a response cut off at max_tokens was returned as complete; now it fails', async () => {
  const c = claudeCall['BUG: a response cut off at max_tokens is returned as if complete'];
  assert.equal(c.v1.text, '## Weekly Wins\npartial');
  await assert.rejects(viaAgentCore(c.response), ClaudeTruncatedError);
});

test('claude: FIXED v1 bug: only the first content block was read; now every text block is kept', async () => {
  const c = claudeCall['BUG: only the first content block is read'];
  assert.equal(c.v1.text, 'first');
  assert.equal((await viaAgentCore(c.response)).text, 'first\nsecond');
});
