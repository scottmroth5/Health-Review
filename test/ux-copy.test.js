// The UX review's trust and clarity fixes (2026-10-26): screens say what the app does, ordinary screens carry no
// developer commands or server paths, the Zone 2 range lives in Settings, runs list newest first by start time, and the
// demo's guides say they are the demo's copy and show the main app's addresses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openHealthStore, openOwnerStore } from '../db/store.js';
import { buildApp } from '../server/app.js';
import { repoPath } from '../tools/paths.js';
import { OWNER_ID } from '../db/users.js';

const page = readFileSync(repoPath('server', 'public', 'index.html'), 'utf8');
const script = readFileSync(repoPath('server', 'public', 'app.js'), 'utf8');

test('Labs says what it does: ranges and below or above range marks, never "no reference ranges"', () => {
  assert.doesNotMatch(page, /No reference ranges/);
  assert.match(page, /typical adult range/);
});

test('ordinary screens carry no npm commands or server file paths (comments aside)', () => {
  const strings = [...script.replace(/^\s*(\/\/|\*).*$/gm, '').matchAll(/(['"`])((?:(?!\1).)*)\1/g)].map((m) => m[2]);
  for (const s of strings) assert.doesNotMatch(s, /npm run|data\/maps|programs\.json|\b[A-Z]+_(API_KEY|TOKEN|SECRET|ID)\b/, s);
  // The page's text outside its HTML comments (split on the markers, so nothing is "sanitized").
  const visible = page.split('<!--').map((part, i) => (i ? part.split('-->').slice(1).join('-->') : part)).join(' ');
  assert.doesNotMatch(visible, /npm run|data\/maps/);
});

test('the Zone 2 range is in Settings, and the Prompt tab no longer holds it', () => {
  const view = (id) => page.slice(page.indexOf(`<section id="view-${id}"`), page.indexOf('</section>', page.indexOf(`<section id="view-${id}"`)));
  assert.match(view('settings'), /<form id="settings"/);
  assert.doesNotMatch(view('prompt'), /zone2_low_bpm/);
  assert.match(view('settings'), /each minute's heart rate/);
});

test('every check-in scale names its ends', () => {
  const scales = script.slice(script.indexOf('const CHECKIN_SCALES'), script.indexOf('];', script.indexOf('const CHECKIN_SCALES')));
  for (const field of ['readiness', 'energy', 'mood', 'stress', 'nutrition']) {
    assert.match(scales, new RegExp(String.raw`\['${field}', '[^']+', '1 [^']+, 10 [^']+'\]`), field);
  }
});

test('Activity lists runs newest first by start time, whatever order they were written in', async () => {
  const store = openOwnerStore(':memory:');
  const insert = store.db.prepare("INSERT INTO runs (user_id, name, status, started_at) VALUES (?, ?, 'ok', ?)");
  insert.run(OWNER_ID, 'review', '2026-10-01T08:00:00.000Z');
  insert.run(OWNER_ID, 'sync', '2026-10-20T07:00:00.000Z');
  insert.run(OWNER_ID, 'review', '2026-09-01T08:00:00.000Z');
  const app = await buildApp({ store });
  const runs = (await app.inject('/api/runs')).json();
  const list = runs.runs ?? runs;
  assert.deepEqual(list.map((r) => r.started_at), ['2026-10-20T07:00:00.000Z', '2026-10-01T08:00:00.000Z', '2026-09-01T08:00:00.000Z']);
  await app.close();
});

test("the demo's guides say they are the demo's copy and show the main app's address; the main app's guides do not", async () => {
  const MAIN = 'https://main.example.com';
  const demo = await buildApp({ store: openHealthStore(':memory:'), instance: 'demo', requestAccessUrl: `${MAIN}/auth/login` });
  const body = (await demo.inject('/guides/health-auto-export')).body;
  assert.match(body, /the demo(&#39;|')s copy of the guide/);
  // The banner's link and the guide's first ingest address, compared whole.
  assert.equal(/<p style="[^"]*">[^<]*<a href="([^"]+)">/.exec(body)?.[1], `${MAIN}/auth/login`);
  assert.equal(/<code>([^<]*\/api\/ingest\/health)<\/code>/.exec(body)?.[1], `${MAIN}/api/ingest/health`, "the main app's address in the steps");
  await demo.close();
  // A request access link that is not http(s) never becomes a link.
  const odd = await buildApp({ store: openHealthStore(':memory:'), instance: 'demo', requestAccessUrl: 'javascript:alert(1)' });
  assert.doesNotMatch((await odd.inject('/guides/health-auto-export')).body, /javascript:/);
  await odd.close();
  const main = await buildApp({ store: openHealthStore(':memory:') });
  assert.doesNotMatch((await main.inject('/guides/health-auto-export')).body, /the demo(&#39;|')s copy/);
  await main.close();
});
