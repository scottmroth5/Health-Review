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
