// The run tracer (v3 Phase 1D): one run row per job or Claude request, with per-call metadata (tokens, cost, timing,
// errors) in run_calls and totals on finish. It matches agent-core 0.4.0's createTracer (same columns, totals, log line,
// promises and idempotent finish), but writes through the store's async interface (db/database.ts) and stamps the run
// with its user in the insert. Traces never hold prompt or response text.
//
// Statements go through the async interface, so a run write made while another request holds a transaction waits for
// it rather than joining it. Never start or finish a run inside a db.tx: the run row would roll back with it.

/**
 * Starts a run for the user of a scoped store (db/scope.js scopeStore). Pass the run to createClaude().send as trace.
 * @param {{ db: import('./database.ts').Database & { uid?: string } }} store
 * @param {string} name
 * @param {object} [meta]
 * @param {{ info?: Function, warn?: Function, error?: Function, log?: Function }} [logger]  defaults to console
 * @returns {Promise<{ id: number, recordCall: (info: object) => Promise<void>, log: Function,
 *   finish: (status?: string, summary?: object) => Promise<object> }>}
 */
export async function startUserRun(store, name, meta = {}, logger = console) {
  if (!name) throw new TypeError('startUserRun: name is required');
  const db = store.db;
  if (!db.uid) throw new TypeError(`startUserRun(${name}): the store is not scoped to a user`);
  const started = Date.now();
  const totals = {
    status: 'running',
    calls: 0,
    errors: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    unpricedCalls: 0,
    durationMs: 0,
  };
  let finishing = null;

  const inserted = await db
    .prepare('INSERT INTO runs (user_id, name, meta, started_at) VALUES (@uid, ?, ?, ?) RETURNING id')
    .get(name, JSON.stringify(meta), new Date(started).toISOString());
  const id = Number(inserted.id);

  async function recordCall(info) {
    totals.calls += 1;
    if (info.error) totals.errors += 1;
    totals.inputTokens += info.inputTokens ?? 0;
    totals.outputTokens += info.outputTokens ?? 0;
    totals.cacheReadTokens += info.cacheReadTokens ?? 0;
    totals.cacheWriteTokens += info.cacheWriteTokens ?? 0;
    if (info.costUsd == null) totals.unpricedCalls += 1;
    else totals.costUsd += info.costUsd;
    await db.prepare(`INSERT INTO run_calls
      (run_id, label, model, stop_reason, input_tokens, output_tokens, cache_read_tokens,
       cache_write_tokens, cost_usd, duration_ms, error_name, error_message, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id,
      info.label ?? null,
      info.model ?? null,
      info.stopReason ?? null,
      info.inputTokens ?? 0,
      info.outputTokens ?? 0,
      info.cacheReadTokens ?? 0,
      info.cacheWriteTokens ?? 0,
      info.costUsd ?? null,
      info.durationMs ?? null,
      info.error?.name ?? null,
      info.error?.message ?? null,
      new Date().toISOString(),
    );
  }

  function log(level, msg, fields) {
    const write = logger[level] ?? logger.info ?? logger.log;
    write.call(logger, `[${name}] ${msg}`, ...(fields ? [fields] : []));
  }

  // The first call's totals are fixed before anything is awaited, so a second call (even one made before the first has
  // settled) returns the same totals and writes nothing.
  function finish(status = 'ok', summary) {
    finishing ??= writeFinish(status, summary);
    return finishing;
  }

  async function writeFinish(status, summary) {
    totals.status = status;
    totals.durationMs = Date.now() - started;
    const finished = { ...totals };
    await db.prepare(`UPDATE runs SET status = ?, finished_at = ?, duration_ms = ?, calls = ?, errors = ?,
        input_tokens = ?, output_tokens = ?, cache_read_tokens = ?, cache_write_tokens = ?, cost_usd = ?, summary = ?
      WHERE user_id = @uid AND id = ?`).run(
      status,
      new Date().toISOString(),
      finished.durationMs,
      finished.calls,
      finished.errors,
      finished.inputTokens,
      finished.outputTokens,
      finished.cacheReadTokens,
      finished.cacheWriteTokens,
      finished.costUsd,
      summary === undefined ? null : JSON.stringify(summary),
      id,
    );
    log(
      status === 'ok' ? 'info' : 'warn',
      `${status}: ${finished.calls} calls, ${finished.errors} errors, ` +
        `${finished.inputTokens} in / ${finished.outputTokens} out, ` +
        `${finished.cacheReadTokens} cache read / ${finished.cacheWriteTokens} cache write, ` +
        `$${finished.costUsd.toFixed(4)}${finished.unpricedCalls ? ` (+${finished.unpricedCalls} unpriced)` : ''}, ` +
        `${finished.durationMs} ms`,
    );
    return finished;
  }

  return { id, recordCall, log, finish };
}
