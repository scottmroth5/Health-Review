// One user's view of the shared database (multi-user, phase 1). scopeDb(db, uid) behaves like the better-sqlite3
// database, but every statement whose SQL names @uid gets that user's id bound for it. So every query on a user table
// writes "user_id = @uid" (and inserts user_id with @uid), functions keep taking `db`, and a statement prepared on the
// raw, unscoped database fails with "Missing named parameters" instead of reading everyone's rows.
// test/user-scope.test.js checks that every query on a user table names user_id.

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !Buffer.isBuffer(v);

function scopeStatement(stmt, uid) {
  const needsUid = stmt.source.includes('@uid');
  // Named values travel in one plain object; add uid to it, or pass one holding only uid after the positional values.
  const bind = (args) => {
    if (!needsUid) return args;
    const i = args.findIndex(isPlainObject);
    if (i < 0) return [...args, { uid }];
    const copy = [...args];
    copy[i] = { ...args[i], uid };
    return copy;
  };
  const scoped = {
    run: (...args) => stmt.run(...bind(args)),
    get: (...args) => stmt.get(...bind(args)),
    all: (...args) => stmt.all(...bind(args)),
    iterate: (...args) => stmt.iterate(...bind(args)),
    pluck: (on = true) => { stmt.pluck(on); return scoped; },
    raw: (on = true) => { stmt.raw(on); return scoped; },
    expand: (on = true) => { stmt.expand(on); return scoped; },
    columns: () => stmt.columns(),
    get source() { return stmt.source; },
    get reader() { return stmt.reader; },
  };
  return scoped;
}

/**
 * The database as seen by one user.
 * @param {import('better-sqlite3').Database} db  the shared database (a scoped one is unwrapped first)
 * @param {string} uid  users.id
 */
export function scopeDb(db, uid) {
  if (!uid) throw new TypeError('scopeDb: uid is required');
  const raw = db.unscoped ?? db;
  return new Proxy(raw, {
    get(target, prop) {
      if (prop === 'prepare') return (sql) => scopeStatement(target.prepare(sql), uid);
      if (prop === 'uid') return uid;
      if (prop === 'unscoped') return target;
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** A store ({ db, tx, close }) whose db is scoped to one user; tx and close are the shared store's. */
export function scopeStore(store, uid) {
  return { ...store, db: scopeDb(store.db, uid), uid };
}
