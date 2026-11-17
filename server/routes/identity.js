// Your account: feeds, Google, Claude key, goals, layouts, setup and Home, time zone, export, pause, resume, delete
// (moved from server/app.js, v3 Phase 2 step 2, docs/adr/0012). register(app, ctx) adds these routes; ctx is what
// buildApp shares with every route module (server/app.js).
import * as q from '../queries.js';
import { loadGoals } from '../../metrics/load.js';
import { currentProgram } from '../../ingest/program-blocks.js';
import { isTimeZone, ownerTz, withTimeZone } from '../../tools/time.ts';
import { OWNER_ID, clearIngestToken, getUser, newIngestToken, setClaudeKey, setGoogleToken, setUserFeeds, timeZoneOf } from '../../db/users.ts';
import { exportUserData, setUserStatus } from '../admin-queries.js';
import { GOAL_KEYS, LAYOUT_ITEMS, TILES, cleanGoals } from '../public/goals.js';
import { SUPPLEMENT_DISCLAIMER, supplementAdviceSince } from '../../agent/supplements.js';
import { SESSION_COOKIE, cookie } from '../session.js';
import { spentThisMonth } from '../ai-access.js';
import { boxKey, seal } from '../../tools/secret-box.ts';
import { SETUP_STEPS, loadSetupFacts, setupSteps } from '../setup.js';
import { anyObject, badRequest } from './schemas.js';

/** @param {import('fastify').FastifyInstance} app @param {object} ctx  shared state and helpers from buildApp */
export async function register(app, ctx) {
  const {
    NO_AI, aiAccessOf, appUrl, authMode, clock, db, deleteAccount, ingest, isPaused, keyBox, keyCheck, log,
    programCatalog, selfFlag, services, setSelfPaused, store, uidOf,
  } = ctx;
  // ---- account: the signed-in user's own settings (multi-user, phase 2) ----
  const accountView = async (req) => {
    const uid = uidOf(req);
    const u = await getUser(store.db, uid);
    const access = await aiAccessOf(req);
    const setting = async (key) => (await db.prepare('SELECT value FROM settings WHERE user_id = @uid AND key = ?').pluck().get(key)) ?? null;
    const json = (text) => { try { return JSON.parse(text ?? 'null'); } catch { return null; } };
    return {
      email: u?.email ?? null, name: u?.name ?? req.userName ?? null, role: u?.role ?? 'user', owner: uid === OWNER_ID, status: u?.status ?? 'approved',
      // Never the key: where it comes from and when it was saved.
      claudeKey: uid === OWNER_ID ? { source: 'server' } : u?.claude_key_enc ? { source: 'yours', setAt: u.claude_key_set_at } : null,
      ai: access.source !== null,
      aiReason: access.reason ?? null,
      // The zone this account runs in: its own (Settings), else the server default; the owner's is always the default.
      timeZone: { zone: ownerTz(), own: Boolean(await timeZoneOf(store.db, uid)), fromServer: uid === OWNER_ID },
      // Training goals (Settings) and the Home tile order the user arranged (null: the goals' default).
      goals: await loadGoals(db),
      tileOrder: json(await setting('tile_order')),
      layouts: await (async () => {
        const out = {};
        for (const area of Object.keys(LAYOUT_ITEMS)) out[area] = json(await setting(`layout_${area}`));
        return out;
      })(),
      // Home's setup checklist was hidden (Settings brings it back).
      setupHidden: Boolean(await db.prepare("SELECT 1 FROM settings WHERE user_id = @uid AND key = 'setup_hidden'").get()),
      // The Training tab's Log workout card was hidden (someone who logs in their sheet; Settings brings it back).
      logWorkoutHidden: (await setting('hide_log_workout')) === '1',
      // Supplement suggestions (off by default): when the statement was accepted, and the statement itself.
      supplementAdvice: { since: await supplementAdviceSince(db), statement: SUPPLEMENT_DISCLAIMER },
      pausedBySelf: u?.status === 'paused' && Boolean(await db.prepare("SELECT 1 FROM settings WHERE user_id = @uid AND key = 'paused_by_self'").get()),
      // The administrator's key with its monthly cap (until the user adds their own): the cap and this month's spend.
      ownerKey: uid !== OWNER_ID && u?.uses_owner_key && !u.claude_key_enc
        ? { cap: u.owner_key_cap_usd, spent: Math.round((await spentThisMonth(store.db, uid, clock())) * 100) / 100 } : null,
      feeds: await feedsView(req, u),
    };
  };
  // ---- data feeds (multi-user, phase 3): Health Auto Export by REST, the Workout Log in Google Sheets, entering in the app ----
  const FEEDS = ['appleHealth', 'workoutLog', 'manual'];
  const feedsView = async (req, u) => {
    const uid = uidOf(req);
    const owner = uid === OWNER_ID;
    let chosen = {};
    try { chosen = JSON.parse(u?.feeds ?? '{}') ?? {}; } catch { chosen = {}; }
    const lastPost = (await db.prepare("SELECT MAX(received_at) FROM ingest_log WHERE user_id = @uid AND result = 'ok'").pluck().get()) ?? null;
    const lastSync = (await db.prepare("SELECT MAX(finished_at) FROM runs WHERE user_id = @uid AND name = 'sync' AND status = 'ok'").pluck().get()) ?? null;
    const sheetId = (await db.prepare("SELECT value FROM settings WHERE user_id = @uid AND key = 'workout_log_sheet_id'").pluck().get()) ?? null;
    const sheetSet = Boolean(sheetId);
    return {
      chosen: Object.fromEntries(FEEDS.map((f) => [f, chosen[f] ?? (owner || f === 'manual')])),
      // The owner's feeds come from the server's settings (INGEST_TOKEN, WORKOUT_LOG_SHEET_ID and the Google files).
      fromServer: owner,
      appleHealth: { token: owner ? Boolean(ingest.token) : Boolean(u?.ingest_token_hash), lastPost,
        urls: { health: `${appUrl()}/api/ingest/health`, workouts: `${appUrl()}/api/ingest/workouts` } },
      workoutLog: { connected: owner || Boolean(u?.google_refresh_enc), sheetSet: owner || sheetSet, lastSync, canConnect: authMode === 'google',
        // Their own sheet's link, for them only (never on the admin screens).
        sheetUrl: !owner && sheetId ? `https://docs.google.com/spreadsheets/d/${encodeURIComponent(sheetId)}/edit` : null,
        canCreate: authMode === 'google' && typeof services.createWorkoutSheet === 'function' },
    };
  };
  app.put('/api/account/feeds', {
    schema: { summary: 'Which data feeds you use (Apple Health, Workout Log, entering in the app)', body: { type: 'object', additionalProperties: false, properties: Object.fromEntries(FEEDS.map((f) => [f, { type: 'boolean' }])) }, response: { 200: anyObject } },
  }, async (req) => {
    await setUserFeeds(store.db, uidOf(req), JSON.stringify(req.body));
    return accountView(req);
  });
  app.post('/api/account/ingest-token', { schema: { summary: 'A new Health Auto Export token for your account, shown once (replaces any earlier one)', response: { 200: anyObject } } }, async (req, reply) => {
    if (uidOf(req) === OWNER_ID) return reply.code(409).send({ error: "The owner's posts use INGEST_TOKEN from the server's settings" });
    const token = await newIngestToken(store.db, uidOf(req));
    log.info('[users] an ingest token was created');
    // The status first, then the token itself (the status's own token field is only true or false).
    return { ...(await feedsView(req, await getUser(store.db, uidOf(req)))).appleHealth, token };
  });
  app.delete('/api/account/ingest-token', { schema: { summary: 'Turn off your Health Auto Export token', response: { 200: anyObject } } }, async (req) => {
    await clearIngestToken(store.db, uidOf(req));
    return accountView(req);
  });
  app.put('/api/account/workout-sheet', {
    schema: { summary: 'Your Workout Log sheet: its link or ID, checked for year tabs with your Google permission', body: { type: 'object', additionalProperties: false, required: ['sheet'], properties: { sheet: { type: 'string', minLength: 10, maxLength: 500 } } }, response: { 200: anyObject } },
  }, async (req, reply) => {
    const uid = uidOf(req);
    if (uid === OWNER_ID) return reply.code(409).send({ error: "The owner's Workout Log comes from the server's settings" });
    const id = /\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})/.exec(req.body.sheet)?.[1] ?? (/^[A-Za-z0-9_-]{20,}$/.test(req.body.sheet.trim()) ? req.body.sheet.trim() : null);
    if (!id) return reply.code(400).send({ error: 'Paste the link to your Google Sheet (or its ID)' });
    if (!(await getUser(store.db, uid))?.google_refresh_enc) return reply.code(409).send({ error: 'Connect Google Sheets first' });
    let tabs;
    try {
      tabs = await services.sheetTabs(uid, id);
    } catch (err) {
      return reply.code(400).send({ error: "That sheet couldn't be opened with your Google permission. Check the link and that this Google account can see it." });
    }
    const years = tabs.filter((t) => /^\d{4}$/.test(t));
    if (!years.length) return reply.code(400).send({ error: 'That sheet has no year tabs (a tab named like 2026); see the Workout Log guide' });
    await db.prepare(`INSERT INTO settings (user_id, key, value, updated_at) VALUES (@uid, 'workout_log_sheet_id', ?, ?)
      ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(id, new Date().toISOString());
    return { ...(await accountView(req)), yearTabs: years };
  });
  app.delete('/api/account/google', { schema: { summary: 'Disconnect Google Sheets: forgets your permission and your sheet', response: { 200: anyObject } } }, async (req) => {
    await setGoogleToken(store.db, uidOf(req), null);
    await db.prepare("DELETE FROM settings WHERE user_id = @uid AND key IN ('workout_log_sheet_id', 'workout_log_created')").run();
    return accountView(req);
  });
  app.get('/api/account', { schema: { summary: "The signed-in user's account: name, email, role, and whether a Claude key is set (never the key)", response: { 200: anyObject } } },
    async (req) => accountView(req));

  // ---- Home (UX roadmap phase 2): the setup checklist for new users, then a summary of where things stand ----
  const setupOf = async (req) => {
    const uid = uidOf(req);
    const u = await getUser(store.db, uid);
    const feeds = await feedsView(req, u);
    const facts = await loadSetupFacts(db, { owner: uid === OWNER_ID, chosen: feeds.chosen, ai: (await aiAccessOf(req)).source !== null,
      appleToken: feeds.appleHealth.token, sheetConnected: feeds.workoutLog.connected });
    return { facts, feeds, setup: setupSteps(facts, { today: q.localDate(clock()) }) };
  };
  /** The newest review's opening: the first two bullets of its first section, as plain text. */
  const reviewOpening = async () => {
    const latest = await db.prepare('SELECT week_ending, report_md FROM reviews WHERE user_id = @uid ORDER BY week_ending DESC LIMIT 1').get();
    if (!latest) return null;
    const first = String(latest.report_md).split(/^## /m)[1] ?? '';
    const lines = first.split('\n').filter((l) => /^\s*[-*] /.test(l)).slice(0, 2)
      .map((l) => l.replace(/^\s*[-*] /, '').replace(/\*\*|__|`/g, '').trim());
    return { weekEnding: latest.week_ending, section: first.split('\n')[0].trim() || null, lines };
  };
  app.get('/api/home', { schema: { summary: 'Home: the setup checklist (goals, profile, how data comes in, AI, first result) and a summary: today\'s check-in, current program, the latest review\'s opening, each feed\'s freshness, data issue count', response: { 200: anyObject } } }, async (req) => {
    const today = q.localDate(clock());
    const { facts, setup } = await setupOf(req);
    const chosen = facts.chosen ?? {};
    const program = await (async () => { try { return await currentProgram(db, today, await programCatalog(req)); } catch { return null; } })();
    const feedRows = [
      chosen.appleHealth || facts.owner ? { feed: 'appleHealth', latest: facts.apple.lastPost ?? facts.apple.latestDay ?? null, latestDay: facts.apple.latestDay } : null,
      chosen.workoutLog || facts.owner ? { feed: 'workoutLog', latest: facts.sheet.lastSync, problem: setup.steps.find((s) => s.id === 'data').ways.workoutLog.problem } : null,
      chosen.manual !== false ? { feed: 'manual', latest: facts.manual.lastCheckin } : null,
    ].filter(Boolean);
    return {
      setup,
      summary: {
        today,
        checkin: { done: Boolean(await db.prepare('SELECT 1 FROM checkins WHERE user_id = @uid AND date = ?').get(today)) },
        program: program ? { program: program.program, phase: program.phase ?? null, week: program.week ?? null, programWeeks: program.programWeeks ?? null } : null,
        latestReview: await reviewOpening(),
        feeds: feedRows,
        dataIssues: (await q.dataCheckWarnings(db, today, { apple: ingest.apple ?? 'drive', now: clock() })).length,
      },
    };
  });
  app.put('/api/account/setup', {
    schema: {
      summary: 'The setup checklist: skip or bring back a step, or hide the checklist',
      body: { type: 'object', additionalProperties: false, minProperties: 1, properties: {
        hidden: { type: 'boolean' }, dismiss: { type: 'string', enum: SETUP_STEPS }, restore: { type: 'string', enum: SETUP_STEPS } } },
      response: { 200: anyObject },
    },
  }, async (req) => {
    // Read the skipped steps and write them back in one transaction, so two changes at once keep both.
    await db.tx(async () => {
      const saved = await db.prepare("SELECT value FROM settings WHERE user_id = @uid AND key = 'setup_dismissed'").pluck().get();
      let list = [];
      try { list = JSON.parse(saved ?? '[]') ?? []; } catch { list = []; }
      const dismissed = new Set(list.filter((s) => SETUP_STEPS.includes(s)));
      if (req.body.dismiss) dismissed.add(req.body.dismiss);
      if (req.body.restore) dismissed.delete(req.body.restore);
      await putSetting('setup_dismissed', dismissed.size ? JSON.stringify([...dismissed]) : null);
      if (req.body.hidden !== undefined) await putSetting('setup_hidden', req.body.hidden ? '1' : null);
    });
    return { setup: (await setupOf(req)).setup };
  });
  app.put('/api/account/claude-key', {
    schema: {
      summary: 'Save your Claude API key: checked with Anthropic (free), stored encrypted, never shown again',
      body: { type: 'object', additionalProperties: false, required: ['key'], properties: { key: { type: 'string', minLength: 20, maxLength: 300, pattern: '^sk-ant-[A-Za-z0-9_-]+$' } } },
      response: { 200: anyObject },
    },
  }, async (req, reply) => {
    const uid = uidOf(req);
    if (uid === OWNER_ID) return reply.code(409).send({ error: "The owner's key comes from the server's settings" });
    if (!(await keyCheck(req.body.key))) return reply.code(400).send({ error: 'Anthropic did not accept that key. Check it and try again.' });
    await setClaudeKey(store.db, uid, seal(req.body.key, uid, keyBox ?? boxKey()));
    log.info('[users] a Claude key was saved');
    return accountView(req);
  });
  // Your training goals: a primary and an optional secondary; they order the pages and frame the review (public/goals.js).
  const putSetting = (key, value) => (value === null
    ? db.prepare('DELETE FROM settings WHERE user_id = @uid AND key = ?').run(key)
    : db.prepare(`INSERT INTO settings (user_id, key, value, updated_at) VALUES (@uid, ?, ?, ?)
      ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(key, value, clock().toISOString()));
  const goalValue = { type: ['string', 'null'], enum: [...GOAL_KEYS, null] };
  app.put('/api/account/goals', {
    schema: { summary: 'Your training goals: primary and an optional secondary (strength, cardio, weight, endurance, health), or null', body: { type: 'object', additionalProperties: false, required: ['primary'], properties: { primary: goalValue, secondary: goalValue } }, response: { 200: anyObject } },
  }, async (req) => {
    const g = cleanGoals(req.body);
    await db.tx(async () => {
      await putSetting('goal_primary', g.primary);
      await putSetting('goal_secondary', g.secondary);
    });
    return accountView(req);
  });
  // Supplement suggestions in the review, the chat and Help: on only with the statement accepted; a paused account may
  // turn them off but not on (the demo refuses every change).
  app.put('/api/account/supplement-advice', {
    schema: { summary: 'Turn supplement suggestions on (accept: true, after reading the statement) or off', body: { type: 'object', additionalProperties: false, required: ['on'], properties: { on: { type: 'boolean' }, accept: { type: 'boolean' } } }, response: { 200: anyObject } },
  }, async (req, reply) => {
    if (req.body.on) {
      if (req.body.accept !== true) return reply.code(400).send({ error: 'Read and accept the statement to turn supplement suggestions on' });
      if (await isPaused(req)) return reply.code(403).send({ error: NO_AI.paused });
      await putSetting('supplement_advice', clock().toISOString());
    } else await putSetting('supplement_advice', null);
    return accountView(req);
  });

  // Hide or show the Training tab's Log workout card (from the card, or Settings).
  app.put('/api/account/log-workout', {
    schema: { summary: "Hide or show the Training tab's Log workout card", body: { type: 'object', additionalProperties: false, required: ['hidden'], properties: { hidden: { type: 'boolean' } } }, response: { 200: anyObject } },
  }, async (req) => {
    await putSetting('hide_log_workout', req.body.hidden ? '1' : null);
    return accountView(req);
  });

  // Your Home tile order (Arrange on Home); null goes back to the default.
  app.put('/api/account/tile-order', {
    schema: { summary: 'Your Home tile order (view names), or null for the default', body: { type: 'object', additionalProperties: false, required: ['tiles'], properties: { tiles: { type: ['array', 'null'], maxItems: 30, items: { type: 'string', enum: TILES } } } }, response: { 200: anyObject } },
  }, async (req) => {
    await putSetting('tile_order', req.body.tiles ? JSON.stringify([...new Set(req.body.tiles)]) : null);
    return accountView(req);
  });

  // The Training and Health tabs' order (Arrange on each tab): training cards, health cards, or health charts; null resets.
  app.put('/api/account/layout', {
    schema: {
      summary: 'Your order of the Training cards, the Health cards or the Health charts, or null for the default',
      body: { type: 'object', additionalProperties: false, required: ['area', 'order'], properties: {
        area: { type: 'string', enum: Object.keys(LAYOUT_ITEMS) }, order: { type: ['array', 'null'], maxItems: 40, items: { type: 'string', maxLength: 40 } } } },
      response: { 200: anyObject },
    },
  }, async (req) => {
    const { area, order } = req.body;
    if (order && order.some((x) => !LAYOUT_ITEMS[area].includes(x))) throw badRequest(`Unknown item for ${area}`);
    await putSetting(`layout_${area}`, order ? JSON.stringify([...new Set(order)]) : null);
    return accountView(req);
  });


  app.put('/api/account/time-zone', {
    schema: { summary: 'Set your time zone (an IANA name such as America/Chicago), or null for the server default', body: { type: 'object', additionalProperties: false, required: ['timeZone'], properties: { timeZone: { type: ['string', 'null'], maxLength: 64 } } }, response: { 200: anyObject } },
  }, async (req, reply) => {
    if (uidOf(req) === OWNER_ID) return reply.code(409).send({ error: "The owner's time zone comes from the server's settings (OWNER_TZ)" });
    const tz = req.body.timeZone;
    if (tz !== null && !isTimeZone(tz)) throw badRequest('Unknown time zone');
    if (tz === null) await db.prepare("DELETE FROM settings WHERE user_id = @uid AND key = 'time_zone'").run();
    else {
      await db.prepare(`INSERT INTO settings (user_id, key, value, updated_at) VALUES (@uid, 'time_zone', ?, ?)
        ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(tz, clock().toISOString());
    }
    // This request began in the old zone; answer in the new one.
    return withTimeZone(tz ?? process.env.OWNER_TZ, () => accountView(req));
  });
  app.delete('/api/account/claude-key', { schema: { summary: 'Remove your Claude API key (no AI is used without one)', response: { 200: anyObject } } }, async (req) => {
    await setClaudeKey(store.db, uidOf(req), null);
    return accountView(req);
  });

  // ---- your account (multi-user, phase 6): export, pause and resume yourself, delete ----
  const notOwner = async (req, reply, what) => {
    if (uidOf(req) !== OWNER_ID && await getUser(store.db, uidOf(req))) return true;
    reply.code(409).send({ error: `The owner's account cannot be ${what} here` });
    return false;
  };
  app.get('/api/account/export', { schema: { summary: 'Everything stored for you, as one JSON file (never your sealed key, tokens or Google permission)', response: { 200: anyObject } } },
    async (req, reply) => {
      const data = await exportUserData(store.db, uidOf(req), { now: clock() });
      if (!data) return reply.code(404).send({ error: 'No such account' });
      return reply.header('Content-Disposition', `attachment; filename="health-review-export-${q.localDate(clock())}.json"`).send(data);
    });
  app.post('/api/account/pause', { schema: { summary: 'Pause your account: posts, syncs and AI stop until you resume; your data stays', response: { 200: anyObject } } },
    async (req, reply) => {
      if (!(await notOwner(req, reply, 'paused'))) return reply;
      // The status check and both writes in one transaction, so a pause racing an administrator's change cannot mix them.
      const paused = await store.db.tx(async () => {
        if ((await getUser(store.db, uidOf(req)))?.status !== 'approved') return false;
        await setUserStatus(store.db, uidOf(req), 'paused');
        await setSelfPaused(uidOf(req), true);
        return true;
      });
      if (!paused) return reply.code(409).send({ error: 'Your account is not active' });
      return accountView(req);
    });
  app.post('/api/account/resume', { schema: { summary: 'Resume your account after pausing it yourself (a pause by the administrator stays)', response: { 200: anyObject } } },
    async (req, reply) => {
      if (!(await notOwner(req, reply, 'resumed'))) return reply;
      // Paused by themselves (status paused and the flag set), checked and undone in one transaction.
      const resumed = await store.db.tx(async () => {
        if ((await getUser(store.db, uidOf(req)))?.status !== 'paused') return false;
        if (!(await selfFlag(uidOf(req)).prepare("SELECT 1 FROM settings WHERE user_id = @uid AND key = 'paused_by_self'").get())) return false;
        await setSelfPaused(uidOf(req), false);
        await setUserStatus(store.db, uidOf(req), 'approved');
        return true;
      });
      if (!resumed) return reply.code(409).send({ error: 'Only the administrator can resume this account' });
      return accountView(req);
    });
  app.post('/api/account/delete', {
    schema: { summary: 'Delete your account and everything stored for you (confirm with your email); signs you out',
      body: { type: 'object', additionalProperties: false, required: ['confirmEmail'], properties: { confirmEmail: { type: 'string', maxLength: 320 } } }, response: { 200: anyObject } },
  }, async (req, reply) => {
    if (!(await notOwner(req, reply, 'deleted'))) return reply;
    const u = await getUser(store.db, uidOf(req));
    if (String(req.body.confirmEmail).trim().toLowerCase() !== u.email) throw badRequest('Type your email exactly to confirm');
    await deleteAccount(u.id);
    reply.header('Set-Cookie', cookie(SESSION_COOKIE, '', { maxAge: 0, secure: appUrl().startsWith('https:') }));
    return { deleted: true };
  });
}
