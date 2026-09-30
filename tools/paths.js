import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Repo root, independent of the current working directory.
export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Absolute path inside the repo, e.g. repoPath('data', 'health.db'). */
export const repoPath = (...parts) => join(ROOT, ...parts);
