// Creates the production database and its roles on RDS (v3 Phase 1G, docs/adr/0010; db/pg/roles.js). The owner runs it
// through infra/db-setup.ps1, which opens an SSM port forward to RDS and passes everything in environment variables;
// nothing is read from or written to disk but the CA bundle, and no password or URL is printed.
//   DB_SETUP_PORT     the local end of the port forward
//   DB_SETUP_HOST     the RDS host name: TLS is verified against it (verify-full), though the socket is local
//   DB_SETUP_CA       the RDS CA bundle file
//   DB_MASTER_USER, DB_MASTER_PASSWORD                         RDS's master login (from Secrets Manager)
//   HR_MIGRATE_PASSWORD, HR_APP_PASSWORD, HR_BACKUP_PASSWORD   the three roles' new passwords
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { DATABASE, setupGrants, setupRoles } from '../db/pg/roles.js';

const need = (name) => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
};

async function connect(user, password, database) {
  const client = new pg.Client({
    host: '127.0.0.1',
    port: Number(need('DB_SETUP_PORT')),
    user,
    password,
    database,
    ssl: { ca: readFileSync(need('DB_SETUP_CA'), 'utf8'), servername: need('DB_SETUP_HOST'), rejectUnauthorized: true },
  });
  await client.connect();
  return client;
}

async function main() {
  const passwords = { migrate: need('HR_MIGRATE_PASSWORD'), app: need('HR_APP_PASSWORD'), backup: need('HR_BACKUP_PASSWORD') };
  const master = await connect(need('DB_MASTER_USER'), need('DB_MASTER_PASSWORD'), 'postgres');
  try {
    const roles = await setupRoles(master, { passwords });
    console.log(`db-setup: roles ready (${Object.values(roles).join(', ')}); database ${DATABASE} ready`);
  } finally {
    await master.end();
  }
  const owner = await connect('hr_migrate', passwords.migrate, DATABASE);
  try {
    await setupGrants(owner);
    console.log('db-setup: grants applied (app: rows only; backup: read only)');
  } finally {
    await owner.end();
  }
}

main().catch((err) => {
  // pg's messages name roles and objects, never passwords; the URL is never built here.
  console.error(`db-setup failed: ${err.name}: ${err.message}`);
  process.exitCode = 1;
});
