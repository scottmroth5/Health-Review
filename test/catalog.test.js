// The program catalog. A synthetic catalog only: real blueprints are copyrighted and never committed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCatalog, parseRange } from '../metrics/catalog.js';

const PROGRAMS = ['Test Program', 'Other Program'];
const CATALOG = {
  version: 1,
  programs: [{
    name: 'Test Program', weeks: 10, focus: 'synthetic', equipment: ['barbell'],
    phases: [
      { name: 'Phase 1', weeks: [1, 3], sets: '2-5', reps: '1-4', workouts: [{ name: 'Day A', exercises: [{ name: 'Squat', sets: '3', reps: '5' }] }] },
      { name: 'Phase 2', weeks: [4, 7], sets: '3', reps: '8-12', special_weeks: { deload: [7], failure: [5] } },
      { name: 'Phase 3', weeks: [8, 10], reps: '12-15' },
    ],
  }],
};

test('catalog: ranges parse from single numbers and min-max text', () => {
  assert.deepEqual(parseRange('2-5'), { min: 2, max: 5 });
  assert.deepEqual(parseRange(' 8 - 12 '), { min: 8, max: 12 });
  assert.deepEqual(parseRange('3'), { min: 3, max: 3 });
  assert.equal(parseRange('5-2'), null);
  assert.equal(parseRange('AMRAP'), null);
});

test('catalog: phase for a week, deload and failure weeks, and weeks past the end', () => {
  const c = createCatalog(CATALOG, { programs: PROGRAMS });
  assert.equal(c.programWeeks('Test Program'), 10);
  assert.deepEqual(c.phaseAt('Test Program', 1), { phase: 'Phase 1', beyond: false, deload: false, failure: false });
  assert.equal(c.phaseAt('Test Program', 3).phase, 'Phase 1');
  assert.equal(c.phaseAt('Test Program', 4).phase, 'Phase 2');
  assert.deepEqual(c.phaseAt('Test Program', 5), { phase: 'Phase 2', beyond: false, deload: false, failure: true });
  assert.equal(c.phaseAt('Test Program', 7).deload, true);
  assert.deepEqual(c.phaseAt('Test Program', 11), { phase: null, beyond: true, deload: false, failure: false });
  assert.equal(c.phaseAt('Other Program', 1), null, 'a program not in the catalog has no phases');
  assert.equal(c.find('Test Program').focus, 'synthetic');
});

test('catalog: invalid files are refused with every problem listed', () => {
  const bad = {
    version: 1,
    programs: [
      { name: 'Unknown', weeks: 4, phases: [{ name: 'P1', weeks: [1, 4] }] },
      { name: 'Test Program', weeks: 9, phases: [
        { name: 'P1', weeks: [1, 3], sets: 'lots' },
        { name: 'P2', weeks: [5, 8], special_weeks: { deload: [2] } },
        { name: 'P3', weeks: [9, 9], workouts: [{ name: 'Day', exercises: [{ name: 'Row', reps: 'max' }] }] },
      ] },
    ],
  };
  assert.throws(() => createCatalog(bad, { programs: PROGRAMS }), (e) => {
    const p = e.problems.join('\n');
    assert.match(p, /Unknown: name must be one of the programs/);
    assert.match(p, /P1: sets "lots" is not a number or range/);
    assert.match(p, /P2: starts at week 5, expected 4/);
    assert.match(p, /P2: deload week 2 is outside the phase/);
    assert.match(p, /Row: reps "max" is not a number, range, or seconds/);
    return true;
  });
  assert.throws(() => createCatalog({ version: 1, programs: [{ name: 'Test Program', weeks: 12, phases: [{ name: 'P1', weeks: [1, 10] }] }] }, { programs: PROGRAMS }),
    /phases cover weeks 1-10, but the program has 12/);
});

test('catalog: timed holds, set midpoints, and per-phase prescribed work', async () => {
  const { parseReps, midpoint, phaseStats } = await import('../metrics/catalog.js');
  assert.deepEqual(parseReps('30-60s'), { min: 30, max: 60, unit: 'seconds' });
  assert.deepEqual(parseReps('8-12'), { min: 8, max: 12, unit: 'reps' });
  assert.equal(parseReps('max'), null);
  assert.equal(midpoint('4-6'), 5);
  const patterns = { Squat: 'squat', Curl: 'arms', 'Single Arm Row': 'horizontal pull' };
  const lookup = (n) => (patterns[n] ? { status: 'mapped', pattern: patterns[n] } : { status: 'unmapped', pattern: null });
  const st = phaseStats({ workouts_per_week: 2, workouts: [
    { name: 'A', exercises: [{ name: 'Squat', sets: '4-6', reps: '1-4' }, { name: 'Curl', sets: '2', reps: '8-12' }] },
    { name: 'B', exercises: [{ name: 'Single Arm Row', sets: '3', reps: '8-12' }, { name: 'Plank', sets: '2', reps: '30-60s' }] },
  ] }, lookup);
  // Sets: 5 + 2 + 3 + 2 = 12 over 2 workouts = 6 per workout, 12 per week; strength 5/12, arms 2/12, one side 3/12.
  assert.deepEqual(st, { workouts: 2, setsPerWorkout: 6, setsPerWeek: 12, strengthPct: 42, armIsolationPct: 17, unilateralPct: 25, unmapped: ['Plank'] });
  assert.throws(() => createCatalog({ version: 1, programs: [{ name: 'Test Program', weeks: 1, phases: [{ name: 'P1', weeks: [1, 1],
    workouts: [{ name: 'D', exercises: [{ name: 'Hold', reps: 'forever' }] }] }] }] }, { programs: PROGRAMS }), /not a number, range, or seconds/);
});
