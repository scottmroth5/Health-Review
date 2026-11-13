// SQL placeholders for PostgreSQL (v3 Phase 1C, docs/adr/0007). The app's SQL is written once, with better-sqlite3's
// placeholders: `?` for positional values and `@name` for named ones, which the scope wrapper relies on (`@uid`).
// PostgreSQL takes only `$1..$n`. toPositional rewrites a statement's text once, at prepare, and returns a binder that
// turns a call's values (better-sqlite3's calling style: positional values, at most one plain object of named values)
// into the `$n` array, with better-sqlite3's errors, so the same mistakes fail the same way on both engines.
// Text inside string literals, quoted identifiers and comments is left alone.

export type Binder = (params: unknown[]) => unknown[];

export interface Translated {
  text: string;
  bind: Binder;
}

type Slot = { kind: 'positional'; index: number } | { kind: 'named'; name: string };

const NAME_START = /[A-Za-z_]/;
const NAME_PART = /[A-Za-z0-9_]/;

// Named values come in an object literal (or one with no prototype); a Date, Buffer or array is a value.
const isPlainObject = (v: unknown): v is Record<string, unknown> => {
  if (v === null || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

/** Rewrites `?` and `@name` to `$n`; a repeated name reuses its number. */
export function toPositional(sql: string): Translated {
  const slots: Slot[] = [];
  const named = new Map<string, number>();
  let positional = 0;
  let out = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (ch === "'" || ch === '"') {
      // A string literal or quoted identifier; a doubled quote is an escaped one.
      let j = i + 1;
      while (j < n) {
        if (sql[j] === ch) {
          if (sql[j + 1] === ch) { j += 2; continue; }
          break;
        }
        j += 1;
      }
      out += sql.slice(i, j + 1);
      i = j + 1;
    } else if (ch === '-' && next === '-') {
      const j = sql.indexOf('\n', i);
      const end = j < 0 ? n : j;
      out += sql.slice(i, end);
      i = end;
    } else if (ch === '/' && next === '*') {
      const j = sql.indexOf('*/', i + 2);
      const end = j < 0 ? n : j + 2;
      out += sql.slice(i, end);
      i = end;
    } else if (ch === '?') {
      slots.push({ kind: 'positional', index: positional });
      positional += 1;
      out += `$${slots.length}`;
      i += 1;
    } else if (ch === '@' && next !== undefined && NAME_START.test(next)) {
      let j = i + 1;
      while (j < n && NAME_PART.test(sql[j])) j += 1;
      const name = sql.slice(i + 1, j);
      let number = named.get(name);
      if (number === undefined) {
        slots.push({ kind: 'named', name });
        number = slots.length;
        named.set(name, number);
      }
      out += `$${number}`;
      i = j;
    } else {
      out += ch;
      i += 1;
    }
  }
  return { text: out, bind: binder(slots, positional) };
}

function binder(slots: Slot[], positionalCount: number): Binder {
  return (params) => {
    // better-sqlite3 spreads arrays given as arguments and takes named values from one plain object.
    const values: unknown[] = [];
    let names: Record<string, unknown> | null = null;
    for (const p of params) {
      if (Array.isArray(p)) values.push(...p);
      else if (isPlainObject(p)) {
        if (names) throw new TypeError('You cannot specify named parameters in two different objects');
        names = p;
      } else values.push(p);
    }
    if (values.length < positionalCount) throw new RangeError('Too few parameter values were provided');
    if (values.length > positionalCount) throw new RangeError('Too many parameter values were provided');
    return slots.map((slot) => {
      if (slot.kind === 'positional') return check(values[slot.index]);
      if (!names || !Object.hasOwn(names, slot.name)) throw new RangeError(`Missing named parameter "${slot.name}"`);
      return check(names[slot.name]);
    });
  };
}

/** The values better-sqlite3 binds: numbers, strings, bigints, buffers and null. Anything else is a bug on both engines. */
function check(v: unknown): unknown {
  if (v === undefined) return null; // as better-sqlite3 binds it
  if (v === null || typeof v === 'number' || typeof v === 'string' || typeof v === 'bigint' || Buffer.isBuffer(v)) return v;
  throw new TypeError('SQLite3 can only bind numbers, strings, bigints, buffers, and null');
}
