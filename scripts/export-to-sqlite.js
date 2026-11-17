// Copies the PostgreSQL database back into a NEW SQLite file (v3 Phase 1E, docs/adr/0008): the rollback path for the
// window after cutover.
//   DATABASE_URL=postgres://... node scripts/export-to-sqlite.js --out <new file>
// The work is db/transfer-jobs.js exportToSqlite: made with the SQLite migrations, filled in one transaction,
// fingerprinted and compared, and deleted if they do not match. An existing file is never touched. Prints table names,
// counts and PASS or FAIL only. Exit 0 pass, 1 fail.
import { resolve } from 'node:path';
import { exportToSqlite } from '../db/transfer-jobs.js';

const arg = (flag) => { const i = process.argv.indexOf(flag); return i > 0 ? process.argv[i + 1] : undefined; };

exportToSqlite({ url: process.env.DATABASE_URL, out: arg('--out') && resolve(arg('--out')) }).then((code) => { process.exitCode = code; }, (err) => {
  console.error(`Export failed: ${err.message}`);
  process.exitCode = 1;
});
