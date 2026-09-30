import { openStore } from '@scottmroth5/agent-core';
import { repoPath } from '../tools/paths.js';
import { MIGRATIONS } from './migrations.js';

export const DEFAULT_DB_PATH = repoPath('data', 'health.db');

/**
 * Opens the local health database (agent-core's runs tables plus this app's tables).
 * @param {string} [path]  HEALTH_DB_PATH, else data/health.db; ':memory:' for tests
 */
export function openHealthStore(path = process.env.HEALTH_DB_PATH || DEFAULT_DB_PATH) {
  return openStore(path, { app: 'health-review', migrations: MIGRATIONS });
}
