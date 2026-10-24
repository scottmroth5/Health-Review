import { openStore } from '@scottmroth5/agent-core';
import { dataPath } from '../tools/paths.js';
import { MIGRATIONS } from './migrations.js';
import { scopeStore } from './scope.js';
import { OWNER_ID, syncOwnerEmail } from './users.js';

export const DEFAULT_DB_PATH = dataPath('health.db');

/**
 * Opens the local health database (agent-core's runs tables plus this app's tables).
 * @param {string} [path]  HEALTH_DB_PATH, else data/health.db; ':memory:' for tests
 */
export function openHealthStore(path = process.env.HEALTH_DB_PATH || DEFAULT_DB_PATH) {
  const store = openStore(path, { app: 'health-review', migrations: MIGRATIONS });
  syncOwnerEmail(store.db);
  return store;
}

/**
 * The database as the owner (user 1) sees it: every query scoped to the owner (db/scope.js). The command-line scripts
 * act as the owner; the server scopes each request and job to its own user instead.
 */
export function openOwnerStore(path) {
  return scopeStore(openHealthStore(path), OWNER_ID);
}
