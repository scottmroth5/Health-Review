// The static security check (scripts/security-check.js) passes on the code as it is, and catches what it guards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { securityProblems } from '../scripts/security-check.js';

test('the code passes the security check', () => {
  assert.deepEqual(securityProblems(), []);
});

test('it catches raw HTML in the browser code, stray child processes and request-built redirects', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sec-'));
  try {
    mkdirSync(join(dir, 'server', 'public'), { recursive: true });
    writeFileSync(join(dir, 'server', 'public', 'bad.js'), "el.innerHTML = note;\nsetTimeout('go()', 5);\nconst f = new Function('x', body);\n");
    writeFileSync(join(dir, 'server', 'bad.js'), "import { exec } from 'node:child_process';\nreturn reply.redirect(req.query.next);\n");
    const rules = securityProblems(dir).map((p) => p.rule);
    for (const r of ['browser code: innerHTML assignment', 'browser code: a string passed to a timer', 'browser code: new Function',
      'child_process outside the known command-line scripts', 'a redirect straight from the request']) assert.ok(rules.includes(r), r);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cookie and spreadsheet names can never reach an object prototype', async () => {
  const { parseCookies } = await import('../server/session.js');
  const c = parseCookies('__proto__=x; constructor=y; hr_session=abc; bad name=z; enc=%E0%A4%A');
  assert.equal(c.hr_session, 'abc');
  assert.equal(Object.getPrototypeOf(c), null);
  assert.equal(Object.keys(c).join(','), 'hr_session', 'unsafe or malformed cookies are dropped');
  assert.equal(({}).x, undefined);
  const { readXlsx, workbookParts, zipParts } = await import('../tools/xlsx.js');
  const parts = workbookParts([{ name: '2026', rows: [['a']] }]);
  const sheet = '<worksheet><sheetData><row r="1" __proto__="1" constructor="2"><c r="A1" __proto__="x" t="inlineStr"><is><t>ok</t></is></c></row></sheetData></worksheet>';
  const book = readXlsx(zipParts([...parts.filter(([n]) => n !== 'xl/worksheets/sheet1.xml'), ['xl/worksheets/sheet1.xml', sheet]]));
  assert.deepEqual(book.sheets[0].rows, [['ok']]);
  assert.equal(({}).r, undefined);
});

test('every route has a per-address ceiling (429 past it); the deploy check is exempt', async () => {
  const { openHealthStore } = await import('../db/store.js');
  const { buildApp } = await import('../server/app.js');
  const app = await buildApp({ store: openHealthStore(':memory:'), authMode: 'demo', instance: 'demo', features: { chat: false } });
  let last;
  for (let i = 0; i < 601; i++) last = await app.inject('/privacy');
  assert.equal(last.statusCode, 429);
  assert.equal((await app.inject('/api/health')).statusCode, 200);
});
