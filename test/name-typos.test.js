// The exercise-name typo finder (metrics/name-typos.js). Synthetic names only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { typoWords, typoCandidates, applyTypoMerges, markDistinct, editDistance } from '../metrics/name-typos.js';
import { createDictionary } from '../metrics/dictionary.js';
import { baseKey } from '../metrics/exercises.js';

const ex = (id, name, implement = 'dumbbell', pattern = 'vertical press', variants) => ({ id, name, implement, pattern, primary: false, ...(variants ? { variants } : {}) });

test('the rule: one word 1 or 2 letters off is a typo; different words, short words and extra words are not', () => {
  assert.equal(editDistance('should', 'shoulder'), 2);
  assert.deepEqual(typoWords(baseKey('Dumbbell Should Press'), baseKey('Dumbbell Shoulder Press')), ['should', 'shoulder']);
  assert.deepEqual(typoWords(baseKey('Assault Bik'), baseKey('Assault Bike')), ['bik', 'bike']);
  assert.equal(typoWords(baseKey('Barbell Hip Thrust'), baseKey('Dumbbell Hip Raise')), null); // two words differ
  assert.equal(typoWords(baseKey('Leg Curl'), baseKey('Leg Press')), null); // 4 letters apart
  assert.equal(typoWords(baseKey('Row A'), baseKey('Row B')), null); // too short to judge
  assert.equal(typoWords(baseKey('Plank Hold'), baseKey('Plank')), null); // a different number of words
  assert.equal(typoWords(baseKey('Squats'), baseKey('Squat')), null); // the key already treats these as one name
});

const dictionary = {
  version: 1,
  exercises: [
    ex('single-arm-row', 'Single-Arm Row', 'dumbbell', 'horizontal pull'),
    ex('sing-arm-row', 'Sing-Arm Row', 'dumbbell', 'horizontal pull'),
    ex('single-leg-press', 'Single-Leg Press', 'dumbbell', 'squat'),
    ex('ball-curl', 'Ball Curl', 'other', 'arms'),
    ex('band-curl', 'Band Curl', 'band', 'arms'),
    ex('knee-abduction', 'Knee Abduction', 'band', 'other'),
    ex('knee-adduction', 'Knee Adduction', 'band', 'other'),
  ],
};

test('candidates: dictionary pairs need the same implement and pattern; the common spelling is kept even when logged less', () => {
  const found = typoCandidates({ dictionary, setCounts: { 'single-arm-row': 10, 'sing-arm-row': 30, 'knee-abduction': 5, 'knee-adduction': 4 } });
  assert.deepEqual(found.entries.map((c) => [c.keepId, c.dropId]), [
    ['single-arm-row', 'sing-arm-row'], // "single" is in two names, "sing" in one
    ['knee-abduction', 'knee-adduction'], // a tie on the word: more sets
  ]);
  // Ball Curl and Band Curl differ in implement, so they are not offered.
  const marked = typoCandidates({ dictionary: markDistinct(dictionary, [['knee-adduction', 'knee-abduction']]) });
  assert.deepEqual(marked.entries.map((c) => c.dropId), ['sing-arm-row']);
});

test('candidates: unmapped names close to an entry, most sets first; a pair marked distinct is skipped', () => {
  const unmapped = [
    { key: baseKey('Singel-Arm Row'), spellings: ['Singel-Arm Row'], sets: 2 },
    { key: baseKey('Kne Abduction'), spellings: ['Kne Abduction'], sets: 5 },
    { key: baseKey('Lunge Hold'), spellings: ['Lunge Hold'], sets: 9 },
  ];
  const found = typoCandidates({ dictionary, unmapped, setCounts: { 'single-arm-row': 10 } });
  assert.deepEqual(found.unmapped.map((c) => [c.spellings[0], c.keepId]), [['Kne Abduction', 'knee-abduction'], ['Singel-Arm Row', 'single-arm-row']]);
  const marked = markDistinct(dictionary, [['knee-abduction', `key:${baseKey('Kne Abduction')}`]]);
  assert.deepEqual(typoCandidates({ dictionary: marked, unmapped }).unmapped.map((c) => c.spellings[0]), ['Singel-Arm Row']);
  createDictionary(marked); // a key: side is valid in distinct
});

test('merging folds the typo into the keeper as a variant and removes it; the result is a valid dictionary', () => {
  const withVariant = structuredClone(dictionary);
  withVariant.exercises[1].variants = ['Sing Arm Rows Old'];
  const pair = typoCandidates({ dictionary: withVariant }).entries.find((c) => c.dropId === 'sing-arm-row');
  const unmappedPick = { kind: 'unmapped', keepId: 'band-curl', spellings: ['Bnad Curl'] };
  const next = applyTypoMerges(withVariant, [pair, unmappedPick]);
  assert.equal(next.exercises.some((e) => e.id === 'sing-arm-row'), false);
  assert.deepEqual(next.exercises.find((e) => e.id === 'single-arm-row').variants, ['Sing-Arm Row', 'Sing Arm Rows Old']);
  assert.deepEqual(next.exercises.find((e) => e.id === 'band-curl').variants, ['Bnad Curl']);
  const lookup = createDictionary(next).lookup;
  assert.equal(lookup('sing arm row').id, 'single-arm-row');
  assert.equal(lookup('Bnad Curls').id, 'band-curl');
  assert.equal(withVariant.exercises.length, 7, 'the input is not changed');
});

test('the dictionary refuses a distinct pair with an unknown id or the same id twice', () => {
  assert.throws(() => createDictionary({ ...dictionary, distinct: [['knee-abduction', 'nope']] }), /unknown id nope/);
  assert.throws(() => createDictionary({ ...dictionary, distinct: [['knee-abduction', 'knee-abduction']] }), /two different ids/);
});
