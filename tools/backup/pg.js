// PostgreSQL's own tools for the backup container (v3 Phase 1G, docs/adr/0010): pg_dump, pg_restore, and a scratch
// cluster (initdb plus pg_ctl) to restore into. The only code allowed to start them (scripts/security-check.js lists
// this file); it runs in the backup image, which has postgresql-18, never in the app image.
//
// Safety:
// - Commands start with an argument array, never a shell.
// - Connection details go to the child through PG* environment variables, never argv (other processes can read argv);
//   the URL itself is never logged.
// - A failure names the tool and its exit code only: their messages can quote row values (a COPY error), so stderr is
//   kept out of errors and logs.
// - A scratch cluster lives in a new folder under the OS temp folder, listens on a Unix socket only (no TCP), and is
//   stopped and deleted on every exit path.
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The folder holding the PostgreSQL programs (the backup image sets PG_BIN; else they are looked up on PATH). */
const bin = (name) => (process.env.PG_BIN ? join(process.env.PG_BIN, name) : name);

/** Whether this machine has PostgreSQL's server programs (tests skip without them). */
export const pgToolsSkip = process.env.PG_BIN ? false : 'PG_BIN is not set (PostgreSQL 18 programs; the backup image and CI have them)';

/**
 * A database URL as libpq environment variables. Only the parts libpq needs; anything else in the URL is ignored.
 * @param {string} url  postgres://user:password@host:port/database?sslmode=...&sslrootcert=...
 */
export function pgEnv(url) {
  const u = new URL(url);
  const q = u.searchParams;
  const env = {
    PGHOST: q.get('host') ?? decodeURIComponent(u.hostname),
    PGPORT: u.port || '5432',
    PGUSER: decodeURIComponent(u.username),
    PGDATABASE: decodeURIComponent(u.pathname.slice(1)),
  };
  if (u.password) env.PGPASSWORD = decodeURIComponent(u.password);
  if (q.get('sslmode')) env.PGSSLMODE = q.get('sslmode');
  if (q.get('sslrootcert')) env.PGSSLROOTCERT = q.get('sslrootcert');
  return env;
}

/** Runs one program; rejects with "<tool> failed (exit N)" only. */
function run(tool, args, env = {}) {
  return new Promise((resolve, reject) => {
    // A small, fixed environment: PATH and locale for the tools, plus the connection variables given.
    const childEnv = { PATH: process.env.PATH ?? '', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', ...env };
    execFile(bin(tool), args, { env: childEnv, maxBuffer: 1024 * 1024, windowsHide: true }, (err) => {
      if (!err) return resolve();
      const code = typeof err.code === 'number' ? err.code : err.code ?? 'unknown';
      reject(Object.assign(new Error(`${tool} failed (exit ${code})`), { name: 'PgToolError', tool, exitCode: code }));
    });
  });
}

/**
 * pg_dump in custom format (compressed, restorable table by table) to file. Every user's rows under row-level security
 * (v3 Phase 1I): hr_backup is held to the policies, so the dump runs in all-users mode (app.all_users on) with
 * --enable-row-security; without the flag pg_dump turns row security off, which stops with an error for a role the
 * policies apply to, and without the setting it would dump no user's rows.
 */
export function dump(url, file) {
  return run('pg_dump', ['--format=custom', '--no-password', '--enable-row-security', `--file=${file}`],
    { ...pgEnv(url), PGOPTIONS: '-c app.all_users=on' });
}

/**
 * Restores a dump into an empty database (a scratch cluster's): owners and grants are left out, as the scratch cluster
 * has none of production's roles. One transaction; the first error stops it.
 */
export function restoreInto(url, file) {
  return run('pg_restore', ['--no-owner', '--no-privileges', '--exit-on-error', '--single-transaction', '--no-password',
    `--dbname=${pgEnv(url).PGDATABASE}`, file], pgEnv(url));
}

/**
 * Restores a dump into the live database after its schema was emptied (pg-deploy.js restorePreMigration), as the
 * migration role: one transaction, objects owned by that role, with the dump's grants to the app and backup roles.
 */
export function restoreLive(url, file) {
  return run('pg_restore', ['--no-owner', '--exit-on-error', '--single-transaction', '--no-password',
    `--dbname=${pgEnv(url).PGDATABASE}`, file], pgEnv(url));
}

/**
 * A throwaway PostgreSQL in the OS temp folder for fn(url): initdb with SQLite's byte order (C locale, UTF8), started on
 * a Unix socket only, with a database named scratch. Stopped and deleted however fn ends.
 * @template T
 * @param {(url: string) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withScratchCluster(fn) {
  const root = mkdtempSync(join(tmpdir(), 'hr-scratch-pg-'));
  const data = join(root, 'data');
  const socket = root;
  let started = false;
  try {
    await run('initdb', ['--pgdata', data, '--username=scratch', '--auth=trust', '--locale=C', '--encoding=UTF8', '--no-instructions', '--no-sync']);
    // Settings for a short-lived copy: no TCP, small memory, no durability (it is deleted afterwards).
    const opts = `-c listen_addresses= -c unix_socket_directories=${socket} -c shared_buffers=16MB -c fsync=off -c full_page_writes=off -c synchronous_commit=off`;
    await run('pg_ctl', ['--pgdata', data, '--options', opts, '--wait', '--silent', '--log', join(root, 'log'), 'start']);
    started = true;
    const url = (database) => `postgres://scratch@localhost/${database}?host=${encodeURIComponent(socket)}`;
    await run('createdb', ['--template=template0', '--encoding=UTF8', '--lc-collate=C', '--lc-ctype=C', 'scratch'], pgEnv(url('postgres')));
    return await fn(url('scratch'));
  } finally {
    if (started) await run('pg_ctl', ['--pgdata', data, '--mode=immediate', '--wait', '--silent', 'stop']).catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
}
