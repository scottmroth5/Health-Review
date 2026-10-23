import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Repo root, independent of the current working directory.
export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Absolute path inside the repo, e.g. repoPath('data', 'health.db'). */
export const repoPath = (...parts) => join(ROOT, ...parts);

/**
 * The data folder: DATA_DIR when set (the container mounts it, /app/data), else the repo's data/. Health data, the
 * database, the MAPS catalog and the Google sign-in files live here, never in the image or the repo.
 */
export const DATA_DIR = process.env.DATA_DIR ? resolve(process.env.DATA_DIR) : join(ROOT, 'data');
/** Absolute path inside the data folder, e.g. dataPath('health.db'). */
export const dataPath = (...parts) => join(DATA_DIR, ...parts);
