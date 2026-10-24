// User secrets (their Claude key): sealed per user, never readable with the wrong key or on another user's row.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boxKey, open, seal } from '../tools/secret-box.js';
import { createMailer } from '../tools/mail.js';

const key = boxKey('a-test-secret-that-is-long-enough-32+');

test('secret box: round trip; no plain text in the sealed value; wrong user, wrong key or a change fails', () => {
  const sealed = seal('sk-test-made-up-value', 'user-a', key);
  assert.equal(open(sealed, 'user-a', key), 'sk-test-made-up-value');
  assert.ok(!sealed.includes('made-up'));
  assert.notEqual(seal('sk-test-made-up-value', 'user-a', key), sealed, 'a fresh nonce each time');
  assert.throws(() => open(sealed, 'user-b', key));
  assert.throws(() => open(sealed, 'user-a', boxKey('another-secret-that-is-long-enough-32+')));
  const parts = sealed.split('.');
  parts[3] = Buffer.from('changed').toString('base64');
  assert.throws(() => open(parts.join('.'), 'user-a', key));
  assert.throws(() => boxKey('short'), /USER_KEY_SECRET/);
});

test('mail: sends through the transport; without settings nothing is sent and the body is never logged', async () => {
  const sent = [];
  const lines = [];
  const log = { info: (l) => lines.push(l), warn: (l) => lines.push(l) };
  const mailer = createMailer({ transport: { sendMail: async (m) => sent.push(m) }, log });
  assert.equal(await mailer.send({ to: 'a@example.com', subject: 'Hello', text: 'secret body' }), true);
  assert.equal(sent.length, 1);
  const off = createMailer({ env: {}, log });
  assert.equal(off.configured, false);
  assert.equal(await off.send({ to: 'a@example.com', subject: 'Hi', text: 'secret body' }), false);
  assert.ok(lines.every((l) => !l.includes('secret body')));
});
