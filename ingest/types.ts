// Shapes shared across ingest/ and jobs/ (v3 Phase 2 step 8): types only, nothing at run time.
import type BetterSqlite3 from 'better-sqlite3';
import type { Database } from '../db/database.ts';

/** A user's database: the async interface, scoped to one user (db/scope.ts scopeDatabase) wherever @uid is written. */
export type UserDb = Database & { readonly uid?: string };

/**
 * A user's store as ingest and the jobs use it (db/scope.ts scopeStore): the async database, and on SQLite the guarded
 * sync handle (the backup's only).
 */
export interface UserStore {
  db: UserDb;
  tx: Database['tx'];
  syncDb?: BetterSqlite3.Database | null;
}

/** One line of a sync's warnings: names, dates, sheet rows and counts only (a parser's warnings carry tab and row). */
export interface SyncWarning {
  source: string;
  tab?: string;
  row?: number;
  kind: string;
  detail?: string;
  severity?: 'warn' | 'info';
}

/** Where a job's lines go (console by default); quiet loggers implement none, some or all. */
export interface Logger {
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
  log?: (...args: unknown[]) => void;
}
