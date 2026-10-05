import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactReview, demoFromLocation, isDrinkingChart, DEMO_KEY } from '../server/public/demo.js';

// A synthetic review in the real shape (## sections, bullets, paragraphs). No real data.
const review = [
  '## Weekly Wins',
  '- Four strength sessions completed',
  '- Two alcohol-free days in a row',
  '## Patterns Noticed',
  'Sleep was longer on nights with no drinks.',
  'Readiness rose through the week.',
  '## Drinking Patterns',
  '- 6 drinks over 3 days',
  '- Mostly beer and wine',
  '## Recovery Signals',
  'HRV averaged 52 ms.',
  '## Discuss with your physician',
  '- **Alcohol and sleep**: how drinking affects sleep quality',
].join('\n');

test('demo mode drops the drinking section and every line about drinking, and keeps the rest', () => {
  const out = redactReview(review);
  assert.doesNotMatch(out, /drink|alcohol|beer|wine/i);
  assert.match(out, /## Weekly Wins\n- Four strength sessions completed/);
  assert.match(out, /## Patterns Noticed\nReadiness rose through the week\./);
  assert.match(out, /## Recovery Signals\nHRV averaged 52 ms\./);
  assert.doesNotMatch(out, /## Drinking Patterns/);
  assert.doesNotMatch(out, /## Discuss with your physician/, 'a section left empty is dropped');
});

test('reviews with nothing to hide are unchanged; CBD lines are hidden like drinking', () => {
  const plain = '## Weekly Wins\n- Slept 8 hours\n## Focus\nKeep the evening stretch routine.';
  assert.equal(redactReview(plain), plain);
  assert.equal(redactReview(''), '');
  const withCbd = '## Weekly Wins\n- Slept 8 hours\n- Two evenings with CBD\n## Patterns Noticed\nSleep was longer after cannabidiol.\nHRV held steady.';
  assert.equal(redactReview(withCbd), '## Weekly Wins\n- Slept 8 hours\n## Patterns Noticed\nHRV held steady.');
});

test('the switch: ?demo=1 or ?demo=0 wins, else the saved choice; blocked storage means off', () => {
  const saved = (v) => ({ getItem: (k) => (k === DEMO_KEY ? v : null) });
  assert.equal(demoFromLocation('?demo=1', saved('0')), true);
  assert.equal(demoFromLocation('?demo=0', saved('1')), false);
  assert.equal(demoFromLocation('', saved('1')), true);
  assert.equal(demoFromLocation('', saved(null)), false);
  assert.equal(demoFromLocation('', { getItem: () => { throw new Error('blocked'); } }), false);
  assert.equal(demoFromLocation('', null), false);
});

test('only the drinking chart is hidden on the Health tab', () => {
  assert.equal(isDrinkingChart({ key: 'alcohol', from: 'drinking' }), true);
  assert.equal(isDrinkingChart({ key: 'hrv_ms', from: 'metrics' }), false);
});
