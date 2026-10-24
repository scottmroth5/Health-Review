// Encryption for the secrets users give the app (their Claude API key; phase 3 adds their Google refresh token).
// AES-256-GCM with a key derived from USER_KEY_SECRET (the server's .env only, never in the database, the image or
// GitHub), a fresh 12-byte nonce per value, and the user's id bound in as associated data, so a value copied onto
// another user's row does not decrypt. Stored as base64 "v1.nonce.tag.ciphertext". Plain text exists only in memory, for
// the call that needs it; never logged.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const VERSION = 'v1';

/** The 32-byte key from the secret (at least 32 characters). Throws when it is missing or short. */
export function boxKey(secret = process.env.USER_KEY_SECRET) {
  const s = String(secret ?? '');
  if (s.length < 32) throw new Error('USER_KEY_SECRET must be set to at least 32 characters to store user keys');
  return createHash('sha256').update(`health-review user secrets\n${s}`).digest();
}

/** Encrypts text for one user. */
export function seal(text, uid, key = boxKey()) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(String(uid)));
  const body = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  return [VERSION, nonce.toString('base64'), cipher.getAuthTag().toString('base64'), body.toString('base64')].join('.');
}

/** Decrypts a value sealed for this user. Throws on a wrong key, another user's value or any change to it. */
export function open(sealed, uid, key = boxKey()) {
  const [version, nonce, tag, body] = String(sealed ?? '').split('.');
  if (version !== VERSION || !nonce || !tag || body === undefined) throw new Error('Not a sealed value');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(nonce, 'base64'));
  decipher.setAAD(Buffer.from(String(uid)));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(body, 'base64')), decipher.final()]).toString('utf8');
}
