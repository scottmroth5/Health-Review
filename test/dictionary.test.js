// Canonical exercise dictionary. Synthetic names only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDictionary, implementFromName } from '../metrics/dictionary.js';

const DICT = {
  version: 1,
  exercises: [
    { id: 'barbell-bench-press', name: 'Barbell Bench Press', implement: 'barbell', pattern: 'horizontal press', primary: true,
      lift: 'bench press', variants: ['Bench Press', 'Barbell Bench'] },
    { id: 'dumbbell-bench-press', name: 'Dumbbell Bench Press', implement: 'dumbbell', pattern: 'horizontal press', primary: false,
      lift: 'bench press', variants: ['DB Bench'] },
    { id: 'pullup', name: 'Pullup', implement: 'bodyweight', pattern: 'vertical pull', primary: true },
  ],
  ignore: ['superset'],
};

test('dictionary: variants map to their canonical exercise, including spelling, plural, hyphen and word order', () => {
  const d = createDictionary(DICT);
  for (const n of ['Bench Press', 'bench  presses', 'Barbell Bench', 'Bench Barbell', 'Barbell Bench Press'])
    assert.equal(d.lookup(n).id, 'barbell-bench-press', n);
  for (const n of ['Pull-ups', 'Pull ups', 'pullups']) assert.equal(d.lookup(n).id, 'pullup', n);
  assert.deepEqual(d.lookup('Dumbell Bench Press'), {
    status: 'mapped', id: 'dumbbell-bench-press', name: 'Dumbbell Bench Press', implement: 'dumbbell',
    pattern: 'horizontal press', primary: false, lift: 'bench press',
  });
});

test('dictionary: barbell and dumbbell versions of a lift stay separate canonical exercises', () => {
  const d = createDictionary(DICT);
  const bb = d.lookup('Barbell Bench Press');
  const db = d.lookup('DB Bench');
  assert.notEqual(bb.id, db.id);
  assert.deepEqual([bb.implement, db.implement], ['barbell', 'dumbbell']);
  assert.equal(bb.lift, db.lift, 'they share a lift group for display only');
});

test('dictionary: unknown names are flagged, never guessed; an implement word alone gives an inferred implement', () => {
  const d = createDictionary(DICT);
  assert.deepEqual(d.lookup('Cable Fly'), { status: 'inferred', id: null, name: null, implement: 'cable', pattern: null, primary: false, lift: null });
  assert.equal(d.lookup('Kettlebells Swing').implement, 'kettlebell');
  assert.equal(d.lookup('Zottman Thing').status, 'unmapped');
  assert.equal(d.lookup('Dumbbell Incline Barbell Press').status, 'unmapped', 'two implement words: ambiguous');
  assert.equal(d.lookup('Superset').status, 'ignored');
});

test('dictionary: implement inference reads the usual typos and plurals', () => {
  assert.equal(implementFromName('Dumbell Rows'), 'dumbbell');
  assert.equal(implementFromName('Barell Curl'), 'barbell');
  assert.equal(implementFromName('Trap Bar Deadlift'), 'barbell');
  assert.equal(implementFromName('Band Pull-a-Parts'), 'band');
  assert.equal(implementFromName('Lateral Raise'), null);
});

test('dictionary: invalid files are refused with every problem listed', () => {
  const bad = {
    version: 1,
    exercises: [
      { id: 'Bad Id', name: 'X', implement: 'rope', pattern: 'push', primary: 'yes' },
      { id: 'a', name: 'Squat', implement: 'barbell', pattern: 'squat', primary: true },
      { id: 'b', name: 'Squats', implement: 'barbell', pattern: 'squat', primary: true },
      { id: 'a', name: 'Other', implement: 'barbell', pattern: 'squat', primary: true },
    ],
  };
  assert.throws(() => createDictionary(bad), (e) => {
    const p = e.problems.join('\n');
    assert.match(p, /Bad Id: id must be/);
    assert.match(p, /implement must be one of/);
    assert.match(p, /pattern must be one of/);
    assert.match(p, /primary must be true or false/);
    assert.match(p, /"Squats" matches both a and b/);
    assert.match(p, /exercise a: duplicate id/);
    return true;
  });
  assert.throws(() => createDictionary({ version: 2, exercises: [] }), /version must be 1/);
});
