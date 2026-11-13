// db/placeholders.ts: better-sqlite3's `?` and `@name` placeholders rewritten to PostgreSQL's $n, with better-sqlite3's
// binding rules and errors. No database needed; test/postgres.test.ts runs the result on a real server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { toPositional } from '../db/placeholders.ts';

test('rewrites ? in order and @name once per name', () => {
  const { text, bind } = toPositional('SELECT * FROM t WHERE user_id = @uid AND a = ? AND b = ? OR owner = @uid');
  assert.equal(text, 'SELECT * FROM t WHERE user_id = $1 AND a = $2 AND b = $3 OR owner = $1');
  assert.deepEqual(bind(['x', 'y', { uid: 'u1' }]), ['u1', 'x', 'y']);
});

test('leaves strings, quoted identifiers, comments and casts alone', () => {
  const sql = `SELECT '?', 'it''s @x', "end", "a""?" -- what? @y
    /* @z ? */ , a::text, b FROM t WHERE c = ? AND d = @d`;
  const { text, bind } = toPositional(sql);
  assert.equal(text, `SELECT '?', 'it''s @x', "end", "a""?" -- what? @y
    /* @z ? */ , a::text, b FROM t WHERE c = $1 AND d = $2`);
  assert.deepEqual(bind([1, { d: 2 }]), [1, 2]);
});

test('an email-like @ inside a string is not a parameter, and a bare @ is left as is', () => {
  assert.equal(toPositional("SELECT 'a@example.com', 1 @ 2").text, "SELECT 'a@example.com', 1 @ 2");
});

test('binds as better-sqlite3 does, and fails where it fails with the same error', () => {
  const sqlite = new Database(':memory:');
  const cases = [
    ['SELECT ? AS a', [1]],
    ['SELECT ? AS a', [undefined]],
    ['SELECT ? AS a', [null]],
    ['SELECT ? AS a', [Buffer.from('a')]],
    ['SELECT ? AS a, ? AS b', [[1, 2]]],
    ['SELECT ? AS a, @x AS b', [{ x: 1 }, 2]],
    ['SELECT @x AS a', [{ x: 1, unused: 2 }]],
    ['SELECT @x AS a', [Object.assign(Object.create(null), { x: 3 })]],
    ['SELECT ? AS a', [true]],
    ['SELECT ? AS a', [new Date(0)]],
    ['SELECT ? AS a', [1, 2]],
    ['SELECT ? AS a', []],
    ['SELECT @x AS a', [{ y: 1 }]],
    ['SELECT @x AS a', [{ x: 1 }, { x: 2 }]],
  ];
  const outcome = (fn) => {
    try {
      return { ok: fn() };
    } catch (err) {
      return { error: `${err.constructor.name}: ${err.message}` };
    }
  };
  try {
    for (const [sql, args] of cases) {
      const expected = outcome(() => Object.values(sqlite.prepare(sql).raw().get(...args) ?? {}));
      const actual = outcome(() => toPositional(sql).bind(args).map((v) => (v === undefined ? null : v)));
      if (expected.error || actual.error) assert.deepEqual(actual, expected, sql);
      else assert.deepEqual(actual.ok.map(String), expected.ok.map(String), sql);
    }
  } finally {
    sqlite.close();
  }
});
