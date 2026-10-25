// Starts the Health Review UI: npm start, then open http://localhost:5188
// Locally AUTH_MODE=none binds to 127.0.0.1. On the server AUTH_MODE=google (or demo for the public demo) with HOST=0.0.0.0
// behind Caddy (TRUST_PROXY). Google sign-in for the sync loads on the first sync.
import { openHealthStore } from '../db/store.js';
import { scopeStore } from '../db/scope.js';
import { OWNER_ID, getUser, startUserRun, timeZoneOf } from '../db/users.js';
import { open } from '../tools/secret-box.js';
import { OAuth2Client } from 'google-auth-library';
import { createSheetsSource } from '../ingest/sheets.js';
import { createWorkoutSheet, ensureYearTab } from '../ingest/create-sheet.js';
import { createMailer } from '../tools/mail.js';
import { repoPath, dataPath } from '../tools/paths.js';
import { localDate as ownerDate, withTimeZone, zonedInstant, zonedParts } from '../tools/time.js';
import { createAlerts } from './alerts.js';
import { appleSource } from '../ingest/sync.js';
import { syncJob } from '../jobs/sync.js';
import { weeklyReview } from '../jobs/review.js';
import { backupJob } from '../jobs/backup.js';
import { restoreTestJob } from '../jobs/restore-check.js';
import { createScheduler, schedulesFromEnv } from './scheduler.js';
import { jobRunsLookup, activeUserIds } from './admin-queries.js';
import { buildApp } from './app.js';
import { loadCatalog } from '../metrics/catalog.js';
import { userCatalog } from '../metrics/load.js';
import { createReviewClaude, DEFAULT_REVIEW_MODEL, DEFAULT_REVIEW_EFFORT } from '../agent/claude.js';
import { runReview } from '../agent/review.js';
import { assertSafeBinding, authSettings } from './auth.js';
import { createAiAccess } from './ai-access.js';

const demo = process.env.HEALTH_INSTANCE === 'demo';
const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? (demo ? 5189 : 5188));
const settings = authSettings();
const authMode = settings.mode;
assertSafeBinding({ host, mode: authMode, settings });
// Behind Caddy: true, a hop count, or an address; unset means no proxy is trusted.
const trustProxy = (() => {
  const v = process.env.TRUST_PROXY;
  if (!v) return false;
  if (v === 'true') return true;
  return /^\d+$/.test(v) ? Number(v) : v;
})();
const auth = { settings };

const quiet = { info() {}, warn() {}, error() {} };
let store;
let app;
let scheduler = null; // the main instance's in-app schedule (never in the demo)
if (demo) {
  // The demo instance: made-up data in its own database (built from demo/generate.js when missing), the made-up
  // catalog and substitutions, its own log folder, and no Google sync, review or chat. Never opens data/health.db.
  const { DEMO_DB_PATH, buildDemoDatabase, refreshDemoDatabase, demoBuiltFor, loadDemoCatalog, DEMO_SUBSTITUTIONS_PATH } = await import('../demo/generate.js');
  const { readFileSync, existsSync } = await import('node:fs');
  if (!existsSync(DEMO_DB_PATH)) buildDemoDatabase();
  store = openHealthStore(DEMO_DB_PATH);
  // The data always runs through yesterday: made again in place when the owner's date moves on (checked on start and
  // every 10 minutes). The demo's clock stays at noon on the day its data was made for, so a late refresh never shows
  // "data stopped".
  let builtFor = demoBuiltFor(store);
  const refresh = () => {
    const today = ownerDate();
    if (builtFor === today) return;
    refreshDemoDatabase(store, { today });
    builtFor = today;
    console.log(`[demo] data refreshed for ${today}`);
  };
  refresh();
  setInterval(() => { try { refresh(); } catch (err) { console.error(`[demo] refresh failed: ${err.name}: ${err.message}`); } }, 10 * 60 * 1000).unref();
  app = await buildApp({
    clock: () => zonedInstant(builtFor, 12, 0),
    store, services: {}, publicDir: repoPath('server', 'public'), authMode, auth, trustProxy, instance: 'demo', features: { chat: false },
    requestAccessUrl: process.env.REQUEST_ACCESS_URL || null,
    catalog: loadDemoCatalog(), substitutions: JSON.parse(readFileSync(DEMO_SUBSTITUTIONS_PATH, 'utf8')),
  });
} else {
  store = openHealthStore();
  // Each user's view of the database (db/scope.js); the command-line scripts and these jobs act as one user at a time.
  const forUser = (uid) => scopeStore(store, uid);
  // Claude per user (multi-user, phases 2 and 4; server/ai-access.js decides): the owner's client from ANTHROPIC_API_KEY
  // (made on first use) for the owner and for users the admin put on the owner's key, under their monthly cap; another
  // user's from their own key, decrypted in memory for this call only (tools/secret-box.js), never cached or logged;
  // none otherwise (no AI for them, and the screens say why).
  const mailer = createMailer();
  const appUrl = () => auth.settings?.publicUrl || `http://localhost:${port}`;
  const alerts = createAlerts({ db: store.db, mailer, adminEmail: () => process.env.ADMIN_EMAIL || getUser(store.db, OWNER_ID)?.email, appUrl });
  const ai = createAiAccess({ db: store.db, mailer, adminEmail: () => process.env.ADMIN_EMAIL || getUser(store.db, OWNER_ID)?.email, appUrl });
  const ownerClaude = (() => { let c; return () => (c ??= createReviewClaude()); })();
  const claudeFor = (uid = OWNER_ID) => {
    const { source } = ai.check(uid);
    if (source === 'owner' || source === 'owner-for-user') return ownerClaude();
    return source === 'own' ? createReviewClaude({ apiKey: open(getUser(store.db, uid).claude_key_enc, uid) }) : null;
  };
  const hasAi = (uid) => ai.check(uid).source !== null;
  // A user's own Google permission for Sheets (read only), from their sealed refresh token, with the web sign-in client.
  const sheetsAuthFor = (uid) => {
    const sealed = getUser(store.db, uid)?.google_refresh_enc;
    if (!sealed) throw new Error('Google Sheets is not connected');
    const client = new OAuth2Client({ clientId: auth.settings.clientId, clientSecret: auth.settings.clientSecret });
    client.setCredentials({ refresh_token: open(sealed, uid) });
    return client;
  };
  const userFeedFor = (uid) => {
    const sheetId = forUser(uid).db.prepare("SELECT value FROM settings WHERE user_id = @uid AND key = 'workout_log_sheet_id'").pluck().get() ?? null;
    if (!sheetId || !getUser(store.db, uid)?.google_refresh_enc) return null;
    const created = forUser(uid).db.prepare("SELECT value FROM settings WHERE user_id = @uid AND key = 'workout_log_created'").pluck().get();
    const auth = sheetsAuthFor(uid);
    return { auth, sheetId, catalog: catalogFor(uid),
      // Only the sheet Health Review created for them (drive.file); the year is theirs (their time zone).
      ensureYearTab: created === sheetId ? () => ensureYearTab({ auth, sheetId, year: ownerDate().slice(0, 4) }) : null };
  };
  // A user's program catalog: their own programs (phase 5), plus the owner's MAPS catalog when the owner shares it with
  // them. The owner's is left undefined, so each job reads the MAPS file and the owner's own programs when it runs.
  const catalogFor = (uid) => (uid === OWNER_ID ? undefined : userCatalog(forUser(uid).db, getUser(store.db, uid)?.maps_shared ? loadCatalog() : null));
  const services = {
    sync: ({ uid = OWNER_ID } = {}) => syncJob({ store: forUser(uid), userFeed: uid === OWNER_ID ? undefined : userFeedFor(uid) }),
    // A user's sheet: its tab names, read with their own Google permission (checks a sheet before it is saved).
    sheetTabs: async (uid, sheetId) => createSheetsSource(sheetsAuthFor(uid), { WORKOUT_LOG_SHEET_ID: sheetId }).listTabs('workout_log'),
    // "Create my Workout Log": a new sheet in their Drive with their drive.file permission, tabbed for this year.
    createWorkoutSheet: (uid) => createWorkoutSheet({ auth: sheetsAuthFor(uid), year: ownerDate().slice(0, 4) }),
    claude: claudeFor,
    hasAi,
    aiAccess: (uid) => ai.check(uid),
    // The Reviews tab's "Run review now": the same call as npm run review, after the route's sync and data gate.
    review: ({ uid = OWNER_ID, weekEnd, today }) => runReview({
      store: forUser(uid), claude: claudeFor(uid), catalog: catalogFor(uid), weekEnd, today, logger: quiet,
      model: process.env.REVIEW_MODEL || DEFAULT_REVIEW_MODEL, effort: process.env.REVIEW_EFFORT || DEFAULT_REVIEW_EFFORT,
    }),
  };
  // The in-app schedule (SCHEDULE_* in .env; none set, nothing runs). The same jobs as the npm scripts (jobs/).
  // Sync and the review run for each approved user in turn (one user's failure never stops the rest; logs name the owner
  // or "a user", never an email). Backup and the restore test cover the whole database, as the owner.
  // Each user's jobs run in their own time zone (tools/time.js withTimeZone), so their "today" and review week are theirs;
  // the schedule itself is on the owner's clock. A failure emails the administrator (server/alerts.js), once a day.
  const who = (uid) => (uid === OWNER_ID ? 'owner' : 'a user');
  const emailOf = (uid) => getUser(store.db, uid)?.email ?? 'a user';
  const eachUser = async (job, fn) => {
    for (const uid of activeUserIds(store.db)) {
      try {
        await withTimeZone(timeZoneOf(store.db, uid), () => fn(uid));
        alerts.recovered(`${job}:${uid}`);
      } catch (err) {
        console.error(`[${job}] failed for ${who(uid)}: ${err.name}`);
        await alerts.alert(`${job}:${uid}`, uid === OWNER_ID ? `the scheduled ${job} failed` : `a user's scheduled ${job} failed`,
          `The scheduled ${job} failed${uid === OWNER_ID ? '' : ` for ${emailOf(uid)}`} (${err.name}).`);
      }
    }
  };
  const ownerJob = async (job, fn) => {
    try {
      await fn();
      alerts.recovered(job);
    } catch (err) {
      await alerts.alert(job, `the ${job} failed`, `The scheduled ${job} failed (${err.name}).`);
      throw err;
    }
  };
  const runners = {
    sync: () => eachUser('sync', async (uid) => {
      const { counts, warnings } = await services.sync({ uid });
      console.log(`[sync] ok (${who(uid)}) ${JSON.stringify(counts)} warnings=${warnings.length}`);
      // The owner's Apple Health feed going quiet is worth an email (once, until it is back).
      if (uid === OWNER_ID) await alerts.dataChecks(warnings);
    }),
    review: () => eachUser('review', async (uid) => {
      // No AI (no key, or the owner's key past its cap): the week is skipped for that user and recorded with its reason.
      const { reason } = ai.check(uid);
      if (reason) {
        startUserRun(forUser(uid), 'review', { gate: true, reason }, quiet).finish('skipped', { reason });
        return;
      }
      const r = await weeklyReview({ store: forUser(uid), claude: () => claudeFor(uid), catalog: catalogFor(uid), sync: () => services.sync({ uid }), scheduled: true });
      console.log(`[review] ${r.status} (${who(uid)}) week ending ${r.weekEnd}${r.syncError ? ' (sync failed first)' : ''}`);
      // Tuesday is the last catch-up: still skipped then, the owner's week gets no review unless it is run by hand.
      if (uid === OWNER_ID && r.status === 'skipped' && zonedParts(new Date()).weekday === 2) {
        await alerts.alert(`review-week:${r.weekEnd}`, 'no weekly review this week',
          `The review for the week ending ${r.weekEnd} was skipped at the last catch-up: Apple Health days are missing or partial (${[...(r.missingDays ?? []), ...(r.partialDays ?? [])].join(', ') || 'none listed'}). Use Run review now on the Reviews tab, with force if the days will not arrive.`);
      }
    }),
    backup: () => ownerJob('backup', async () => { const r = await backupJob({ store: forUser(OWNER_ID) }); console.log(`[backup] ok ${r.name} ${r.bytes} bytes`); }),
    'restore-test': () => ownerJob('restore-test', async () => {
      const r = await restoreTestJob({ store: forUser(OWNER_ID) });
      console.log(`[restore-test] ${r.ok ? 'ok' : 'failed'} ${r.file} tables=${r.tables} problems=${r.problems.length}`);
      if (!r.ok) throw Object.assign(new Error('restore test failed'), { name: 'RestoreTestFailed' });
    }),
  };
  scheduler = createScheduler({
    jobs: schedulesFromEnv().filter((j) => runners[j.name]).map((j) => ({ ...j, run: runners[j.name] })),
    runs: jobRunsLookup(store.db),
  });
  // Health Auto Export's posts (POST /api/ingest/*): on the server APPLE_SOURCE=rest and INGEST_TOKEN are set.
  const ingest = { token: process.env.INGEST_TOKEN || null, apple: appleSource() };
  app = await buildApp({
    store, services, publicDir: repoPath('server', 'public'), authMode, auth, ingest, trustProxy, evalDir: dataPath('evals', 'review'), mailer,
    schedule: () => scheduler.status(),
  });
}
await app.listen({ host, port });
console.log(`Health Review${demo ? ' (demo data)' : ''}: http://localhost:${port}  (API contract: http://localhost:${port}/api/openapi.json)`);
scheduler?.start();

const shutdown = async () => {
  scheduler?.stop();
  await app.close();
  store.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
