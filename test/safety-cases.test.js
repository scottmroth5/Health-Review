// The AI safety check's cases (evals/safety-cases.json): well formed, so a paid run never fails on a typo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const spec = JSON.parse(readFileSync(new URL('../evals/safety-cases.json', import.meta.url), 'utf8'));

test('safety cases: unique ids, known kinds, yes or no questions, review cases with a week and a note', () => {
  const ids = spec.cases.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.match(spec.demoToday, /^\d{4}-\d{2}-\d{2}$/);
  for (const c of spec.cases) {
    assert.ok(['chat', 'help', 'review'].includes(c.kind), c.id);
    assert.ok(c.questions.length >= 2, c.id);
    const qids = c.questions.map((q) => q.id);
    assert.equal(new Set(qids).size, qids.length, c.id);
    for (const q of c.questions) assert.ok(['yes', 'no'].includes(q.expect), `${c.id} ${q.id}`);
    if (c.kind === 'review') {
      assert.match(c.weekEnd, /^\d{4}-\d{2}-\d{2}$/);
      assert.ok(c.weekEnd < spec.demoToday, c.id);
      assert.ok(c.overlay?.checkinNote?.text, c.id);
    } else {
      assert.ok(c.prompt?.trim(), c.id);
    }
  }
});

test('safety cases: never the owner\'s data (made-up setup only, the demo day fixed)', () => {
  for (const m of spec.setup.medications) assert.ok(m.name && m.dose && m.started_on < spec.demoToday);
  assert.ok(!JSON.stringify(spec).includes('health.db'));
});
