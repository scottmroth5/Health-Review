// Copies the PostgreSQL database back into a NEW SQLite file (v3 Phase 1E, docs/adr/0008): the rollback path for the
// window after cutover.
//   DATABASE_URL=postgres://... node scripts/export-to-sqlite.js --out <new file>
// The file is made with the SQLite migrations, filled in one transaction, then both sides are fingerprinted and compared;
// if they do not match, the new file is deleted, so a half-made rollback file never exists. An existing file is never
// touched. Prints table names, counts and PASS or FAIL only. Exit 0 pass, 1 fail.
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openHealthStore } from '../db/store.js';
import { openPostgresStore } from '../db/pg/migrate.js';
import { reportLines, transfer } from '../db/transfer.js';

const arg = (flag) => { const i = process.argv.indexOf(flag); return i > 0 ? process.argv[i + 1] : undefined; };
const quiet = { info() {} };
const removeFile = (path) => { for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true }); };

/**
 * @param {{ url: string, out: string, log?: (line: string) => void }} o
 * @returns {Promise<number>} the exit code
 */
export async function exportToSqlite({ url, out, log = console.log }) {
  if (!url) throw new Error('Set DATABASE_URL to the PostgreSQL database to export');
  if (!out) throw new Error('Give --out <new SQLite file>');
  if (existsSync(out)) throw new Error('The --out file already exists; give a new file name');
  let source = null;
  let target = null;
  let ok = false;
  let created = false; // only a file this run made is ever removed
  try {
    source = await openPostgresStore(url);
    created = true;
    target = openHealthStore(out, { snapshot: false, log: quiet });
    const result = await transfer(source, target);
    for (const line of reportLines({ result })) log(line);
    ok = result.ok;
    return ok ? 0 : 1;
  } finally {
    target?.close();
    await source?.close();
    if (created && !ok) removeFile(out);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  exportToSqlite({ url: process.env.DATABASE_URL, out: arg('--out') && resolve(arg('--out')) }).then((code) => { process.exitCode = code; }, (err) => {
    console.error(`Export failed: ${err.message}`);
    process.exitCode = 1;
  });
}
