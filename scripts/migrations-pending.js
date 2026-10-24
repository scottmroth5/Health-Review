// Would opening the database change it? Applies the migrations to a throwaway copy in the OS temp folder (deleted
// afterwards) and reports which would run, so deploy/deploy.sh can back up first, and a migration that would fail on this
// data fails here, before the real file is touched. Only reads the real database.
//   npm run db:pending        exit 0: none pending; 10: some pending (listed); 1: a migration failed on the copy
import { tmpdir } from 'node:os';
import { DEFAULT_DB_PATH, pendingMigrations } from '../db/store.js';

const path = process.env.HEALTH_DB_PATH || DEFAULT_DB_PATH;
try {
  const { pending } = pendingMigrations(path, tmpdir());
  if (!pending.length) {
    console.log('migrations pending: none');
    process.exitCode = 0;
  } else {
    console.log(`migrations pending: ${pending.length} (${pending.join(', ')})`);
    process.exitCode = 10;
  }
} catch (err) {
  console.error(`migrations pending: check failed: ${err.name}: ${err.message}`);
  process.exitCode = 1;
}
