// Training volume, the current program, the Next program ranking and chat, adherence, own programs, blocks and lifts
// (moved from server/app.js, v3 Phase 2 step 2, docs/adr/0012). register(app, ctx) adds these routes; ctx is what
// buildApp shares with every route module (server/app.js).
import * as q from '../queries.js';
import { VIEWS } from '../../metrics/volume.js';
import { loadDictionary } from '../../metrics/dictionary.js';
import { loadSubstitutions, loadUserPrograms } from '../../metrics/load.js';
import { GOALS, MAX_WEIGHT } from '../../metrics/advisor.js';
import { changeBlockDates, confirmBlocks, currentProgram, endBlock, listBlocks, refreshPhases, ReviewError, startBlock } from '../../ingest/program-blocks.js';
import { ProgramError, SOURCES, deleteProgram, exportPrograms, importPrograms, saveProgram } from '../../ingest/user-programs.js';
import { MAX_PDF_BYTES, extractProgram, isPdf } from '../../agent/extract-program.js';
import { askAdvisor, clearChat, deleteChatNote, listChat, MAX_NOTE_CHARS } from '../../agent/advisor-chat.js';
import { OWNER_ID } from '../../db/users.ts';
import { anyObject, badRequest } from './schemas.js';

/** @param {import('fastify').FastifyInstance} app @param {object} ctx  shared state and helpers from buildApp */
export async function register(app, ctx) {
  const {
    aiOn, aiReason, clock, db, dictionary, features, log, noAi, programCatalog, services, sharedCatalog,
    substitutions, uidOf, userStore,
  } = ctx;
  // ---- training volume ----
  app.get('/api/training', {
    schema: {
      summary: 'Training volume (reps x total load) for the last 7 days, 30 days, 52 weeks, or all history',
      querystring: { type: 'object', required: ['view'], properties: { view: { type: 'string', enum: VIEWS } } },
      response: { 200: anyObject },
    },
  }, async (req) => await q.trainingDashboard(db, req.query.view, q.localDate(clock())));

  // The MAPS catalog is read per request when not injected, so edits to data/maps/programs.json show without a restart.
  app.get('/api/program', {
    schema: {
      summary: 'The confirmed in-progress program block: week, phase, deload or failure week, expected end (program is null when none)',
      response: { 200: { type: 'object', properties: { program: { anyOf: [{ type: 'null' }, { type: 'object', additionalProperties: true }] } } } },
    },
  }, async (req) => ({ program: await currentProgram(db, q.localDate(clock()), await programCatalog(req)) }));

  // The dictionary and substitutions are committed config, read per request (like the catalog) unless injected.
  const goalWeight = { type: 'integer', minimum: 0, maximum: MAX_WEIGHT, default: 1 };
  app.get('/api/advisor', {
    schema: {
      summary: 'Program Advisor ranking for the next block: goal scores (0 to 1), total, reasons and flags per program; '
        + 'weights 0 to 3 per goal (default 1) change the total; available false without the MAPS catalog',
      querystring: { type: 'object', properties: Object.fromEntries(GOALS.map((g) => [g, goalWeight])) },
      response: { 200: anyObject },
    },
  }, async (req) => await q.advisor(db, q.localDate(clock()), {
    catalog: await programCatalog(req),
    dictionary: dictionary ?? loadDictionary(),
    substitutions: substitutions ?? loadSubstitutions(),
    weights: Object.fromEntries(GOALS.map((g) => [g, req.query[g]])),
  }));

  app.get('/api/program/adherence', {
    schema: {
      summary: 'What the program calls for against what was logged, per lifting day of a confirmed block (default: the one in progress, else the latest): '
        + 'each exercise as called for, swapped, changed, skipped or added, sets, the usual changes, and the blocks to choose from; available false without the MAPS catalog',
      querystring: { type: 'object', properties: { block: { type: 'string', minLength: 1, maxLength: 64 } } },
      response: { 200: anyObject },
    },
  }, async (req, reply) => {
    const result = await q.programAdherence(db, q.localDate(clock()), {
      catalog: await programCatalog(req), dictionary: dictionary ?? loadDictionary(), substitutions: substitutions ?? loadSubstitutions(), blockId: req.query.block,
    });
    if (result === null) return reply.code(404).send({ error: 'No such confirmed block' });
    return result;
  });

  // ---- Next program chat (computed training facts and the owner's notes go to Claude; see agent/advisor-chat.js) ----
  const chatOn = async (req) => features.chat !== false && typeof services.claude === 'function' && await aiOn(req);
  const chatThread = { 200: { type: 'object', properties: { enabled: { type: 'boolean' }, needsKey: { type: 'boolean' }, aiReason: { type: ['string', 'null'] }, notes: { type: 'array', items: anyObject } } } };
  app.get('/api/advisor/chat', { schema: { summary: 'The Next program chat thread, oldest first, and whether the chat is on', response: chatThread } },
    async (req) => { const reason = await aiReason(req); return { enabled: await chatOn(req), needsKey: reason !== null, aiReason: reason, notes: await listChat(db) }; });
  const chatting = new Set();
  app.post('/api/advisor/chat', {
    schema: {
      summary: 'Ask Claude about the next program: saves the note, sends computed training facts plus the note and recent thread, saves the checked reply',
      body: {
        type: 'object', additionalProperties: false, required: ['text'],
        properties: {
          text: { type: 'string', minLength: 1, maxLength: MAX_NOTE_CHARS },
          weights: { type: 'object', additionalProperties: false, properties: Object.fromEntries(GOALS.map((g) => [g, { type: 'integer', minimum: 0, maximum: MAX_WEIGHT }])) },
        },
      },
      response: { 200: anyObject },
    },
  }, async (req, reply) => {
    const reason = await aiReason(req);
    if (reason) return noAi(reply, reason);
    if (!(await chatOn(req))) return reply.code(503).send({ error: 'The chat is off in this instance' });
    if (!req.body.text.trim()) throw badRequest('text must not be blank');
    if (chatting.has(uidOf(req))) return reply.code(409).send({ error: 'A question is already being answered' });
    const cat = await programCatalog(req);
    if (!cat) return reply.code(503).send({ error: 'The chat needs a program catalog' });
    chatting.add(uidOf(req));
    try {
      return await askAdvisor({
        store: userStore(), claude: await services.claude(uidOf(req)), text: req.body.text.trim(), today: q.localDate(clock()), catalog: cat,
        dictionary: dictionary ?? loadDictionary(), substitutions: substitutions ?? loadSubstitutions(), weights: req.body.weights,
        logger: { info() {}, warn() {}, error() {} },
      });
    } finally {
      chatting.delete(uidOf(req));
    }
  });
  app.delete('/api/advisor/chat/:id', {
    schema: { summary: 'Delete one note or reply from the thread', params: { type: 'object', required: ['id'], properties: { id: { type: 'string', maxLength: 64 } } }, response: { 200: anyObject } },
  }, async (req, reply) => ((await deleteChatNote(db, req.params.id)) ? { deleted: 1 } : reply.code(404).send({ error: 'Not found' })));
  app.delete('/api/advisor/chat', { schema: { summary: 'Clear the whole thread', response: { 200: anyObject } } },
    async () => ({ deleted: await clearChat(db) }));

  // ---- a user's own programs (multi-user, phase 5; ingest/user-programs.js): built here, imported as JSON, or drafted
  // by Claude from a PDF (never stored). The shared catalog (the owner's MAPS) shows by name only, never its contents.
  const programsView = async (req) => {
    const own = await loadUserPrograms(db);
    const names = new Set(own.map((r) => r.name));
    return {
      programs: own,
      shared: ((await sharedCatalog(req))?.programs ?? []).map((p) => p.name).filter((n) => !names.has(n)),
      canExtract: typeof services.claude === 'function',
      owner: uidOf(req) === OWNER_ID,
    };
  };
  const programError = (reply, err) => {
    if (err instanceof ProgramError) return reply.code(400).send({ error: err.message, problems: err.problems });
    throw err;
  };
  const programWrite = (req) => ({ today: q.localDate(clock()), catalog: () => programCatalog(req), now: clock() });
  const programBody = {
    type: 'object', additionalProperties: false, required: ['program'],
    properties: { program: anyObject, match: { type: 'string', maxLength: 200 }, source: { type: 'string', enum: SOURCES } },
  };
  const programIdParams = { type: 'object', required: ['id'], properties: { id: { type: 'string', minLength: 1, maxLength: 64 } } };
  app.get('/api/programs', { schema: { summary: 'Your own programs in full, and the names of the shared catalog\'s programs', response: { 200: anyObject } } },
    async (req) => await programsView(req));
  app.post('/api/programs', { schema: { summary: 'Add a program of your own (checked like a catalog entry; problems listed)', body: programBody, response: { 200: anyObject } } },
    async (req, reply) => {
      try { await saveProgram(db, { ...req.body, ...programWrite(req) }); } catch (err) { return programError(reply, err); }
      return await programsView(req);
    });
  app.put('/api/programs/:id', { schema: { summary: 'Replace one of your programs', params: programIdParams, body: programBody, response: { 200: anyObject } } },
    async (req, reply) => {
      try { await saveProgram(db, { id: req.params.id, ...req.body, ...programWrite(req) }); } catch (err) { return programError(reply, err); }
      return await programsView(req);
    });
  app.delete('/api/programs/:id', { schema: { summary: 'Delete one of your programs', params: programIdParams, response: { 200: anyObject } } },
    async (req, reply) => ((await deleteProgram(db, req.params.id, programWrite(req))) ? await programsView(req) : reply.code(404).send({ error: 'No such program' })));
  app.post('/api/programs/import', { schema: { summary: 'Import one program or a catalog of programs, all or nothing', body: anyObject, response: { 200: anyObject } } },
    async (req, reply) => {
      let added;
      try { added = await importPrograms(db, req.body, programWrite(req)); } catch (err) { return programError(reply, err); }
      return { added, ...(await programsView(req)) };
    });
  app.get('/api/programs/export', { schema: { summary: 'Your own programs as a catalog file (never the shared catalog)', response: { 200: anyObject } } },
    async (req, reply) => reply.header('Content-Disposition', 'attachment; filename="my-programs.json"').send(await exportPrograms(db)));
  // Claude reads a PDF the user uploaded, on their own AI; the draft comes back to check in the builder, nothing saved.
  app.post('/api/programs/extract', {
    bodyLimit: Math.ceil(MAX_PDF_BYTES * 1.4),
    schema: {
      summary: 'Draft a program from a PDF you have the right to use (Claude reads it with your AI; the PDF is never stored)',
      body: { type: 'object', additionalProperties: false, required: ['pdf', 'rightToUse'], properties: {
        pdf: { type: 'string', minLength: 8, maxLength: Math.ceil(MAX_PDF_BYTES * 1.37) }, rightToUse: { type: 'boolean' }, filename: { type: 'string', maxLength: 200 } } },
      response: { 200: anyObject },
    },
  }, async (req, reply) => {
    if (typeof services.claude !== 'function') return reply.code(503).send({ error: 'Reading PDFs is not available in this server' });
    const reason = await aiReason(req);
    if (reason) return noAi(reply, reason);
    if (req.body.rightToUse !== true) throw badRequest('Confirm that you own this program or have the right to use it');
    const pdf = Buffer.from(req.body.pdf, 'base64');
    if (!isPdf(pdf)) throw badRequest('That file is not a PDF');
    if (pdf.length > MAX_PDF_BYTES) throw badRequest('The PDF is over 20 MB');
    try {
      return await extractProgram({ store: userStore(), claude: await services.claude(uidOf(req)), pdf, logger: { info() {}, warn() {}, error() {} } });
    } catch (err) {
      log.warn(`[programs] reading a PDF failed: ${err.name}`);
      return reply.code(502).send({ error: err.status === 400 ? 'Claude could not read that PDF (it may be over 100 pages or protected)' : 'Claude could not read the PDF; try again' });
    }
  });


  // Program blocks for a user to confirm in the app (the owner also has npm run programs:review for edits, merges and splits).
  app.get('/api/program/blocks', { schema: { summary: 'Your program blocks, detected and confirmed, oldest first', response: { 200: { type: 'array', items: anyObject } } } },
    async () => await listBlocks(db));
  app.post('/api/program/blocks/:id/confirm', { schema: { summary: 'Confirm a detected program block (phases and progress then follow it)', params: programIdParams, response: { 200: anyObject } } },
    async (req, reply) => {
      try {
        await confirmBlocks(db, req.params.id, { today: q.localDate(clock()), now: clock() });
      } catch (err) {
        if (err instanceof ReviewError) return reply.code(409).send({ error: err.message });
        throw err;
      }
      await refreshPhases(db, await programCatalog(req));
      return { blocks: await listBlocks(db) };
    });
  // End program and Start program on the Training tab's Current program card (ingest/program-blocks.js endBlock,
  // startBlock). Either answers the current program and the block list after the change.
  const blockDate = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' };
  const blockChange = async (req, reply, change) => {
    try {
      await change({ today: q.localDate(clock()), now: clock() });
    } catch (err) {
      if (err instanceof ReviewError) return reply.code(409).send({ error: err.message });
      throw err;
    }
    const catalog = await programCatalog(req);
    await refreshPhases(db, catalog);
    return { program: await currentProgram(db, q.localDate(clock()), catalog), blocks: await listBlocks(db) };
  };
  app.post('/api/program/blocks/:id/end', {
    schema: {
      summary: 'End the program in progress on its last day, as completed or abandoned (stopped early); later lifting days leave it',
      params: programIdParams,
      body: { type: 'object', additionalProperties: false, required: ['end', 'outcome'],
        properties: { end: blockDate, outcome: { type: 'string', enum: ['completed', 'abandoned'] } } },
      response: { 200: anyObject },
    },
  }, async (req, reply) => await blockChange(req, reply, (opts) => endBlock(db, req.params.id, req.body, opts)));
  app.put('/api/program/blocks/:id', {
    schema: {
      summary: "Change a block's start, last day or status (an in-progress block has no last day); sessions move to match",
      params: programIdParams,
      body: { type: 'object', additionalProperties: false, minProperties: 1,
        properties: { start: blockDate, end: { anyOf: [blockDate, { type: 'null' }] }, status: { type: 'string', enum: ['completed', 'abandoned', 'in_progress'] } } },
      response: { 200: anyObject },
    },
  }, async (req, reply) => await blockChange(req, reply, (opts) => changeBlockDates(db, req.params.id, req.body, opts)));
  app.post('/api/program/blocks', {
    schema: {
      summary: 'Start a program or training block on a day (any name; one outside the catalog has no phases or finish)',
      body: { type: 'object', additionalProperties: false, required: ['program', 'start'],
        properties: { program: { type: 'string', minLength: 1, maxLength: 80 }, start: blockDate } },
      response: { 200: anyObject },
    },
  }, async (req, reply) => await blockChange(req, reply, (opts) => startBlock(db, req.body, opts)));

  app.get('/api/lifts', {
    schema: {
      summary: 'Plateau status of each primary lift (last 42 days against the 84 before, within one rep range), with trend points',
      response: { 200: { type: 'array', items: anyObject } },
    },
  }, async () => q.lifts(db, q.localDate(clock())));
}
