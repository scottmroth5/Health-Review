// Encrypted backup archives (.hrbk). Pure functions, no I/O.
//   archive  = gzip( [4-byte manifest length][manifest JSON][file bytes...] ); the manifest lists each file's
//              name, size and SHA-256, checked on unpack
//   .hrbk    = header + AES-256-GCM(archive) + 16-byte tag, where
//   header   = "HRBK1" | scrypt log2(N) (1 byte) | r (1) | p (1) | salt (16) | nonce (12)
// The key comes from the owner's passphrase through scrypt with a fresh salt per file; the header is the GCM
// associated data, so changing any byte of the file makes decryption fail. Without the passphrase the file
// cannot be read by anyone, including the storage provider.
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';

const MAGIC = Buffer.from('HRBK1');
const HEADER_LEN = MAGIC.length + 3 + 16 + 12;
const TAG_LEN = 16;
/** scrypt cost settings, stored in each file's header. */
export interface Kdf { logN: number; r: number; p: number }
/** A file in an archive: its name, bytes and (after unpack) SHA-256. */
export interface ArchiveFile { name: string; data: Buffer; sha256?: string }

export const DEFAULT_KDF: Kdf = { logN: 17, r: 8, p: 1 };
export const MIN_PASSPHRASE = 16;

const sha256 = (buf: Buffer | string): string => createHash('sha256').update(buf).digest('hex');
const deriveKey = (passphrase: string, salt: Buffer, { logN, r, p }: Kdf): Buffer =>
  scryptSync(String(passphrase).normalize('NFKC'), salt, 32, { N: 2 ** logN, r, p, maxmem: 256 * 2 ** logN * r });

export function checkPassphrase(passphrase: string | undefined): asserts passphrase is string {
  if (!passphrase) throw new Error('HEALTH_BACKUP_PASSPHRASE is not set in .env');
  if (String(passphrase).length < MIN_PASSPHRASE) throw new Error(`The backup passphrase must be at least ${MIN_PASSPHRASE} characters`);
}

/** Packs named files into one gzipped archive. */
export function pack(files: ArchiveFile[]): Buffer {
  const manifest = Buffer.from(JSON.stringify({ version: 1, files: files.map((f) => ({ name: f.name, size: f.data.length, sha256: sha256(f.data) })) }));
  const len = Buffer.alloc(4);
  len.writeUInt32BE(manifest.length);
  return gzipSync(Buffer.concat([len, manifest, ...files.map((f) => f.data)]));
}

/** Unpacks an archive, checking every file's size and SHA-256. */
export function unpack(archive: Buffer): Required<ArchiveFile>[] {
  const raw = gunzipSync(archive);
  const mlen = raw.readUInt32BE(0);
  const { files }: { files: { name: string; size: number; sha256: string }[] } = JSON.parse(raw.subarray(4, 4 + mlen).toString('utf8'));
  let at = 4 + mlen;
  return files.map((f) => {
    const data = raw.subarray(at, at + f.size);
    at += f.size;
    if (data.length !== f.size || sha256(data) !== f.sha256) throw new Error(`Archive file ${f.name} is damaged`);
    return { name: f.name, data: Buffer.from(data), sha256: f.sha256 };
  });
}

/** Encrypts bytes with a passphrase. Every call uses a fresh salt and nonce. */
export function encrypt(plain: Buffer, passphrase: string | undefined, kdf: Kdf = DEFAULT_KDF): Buffer {
  checkPassphrase(passphrase);
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const header = Buffer.concat([MAGIC, Buffer.from([kdf.logN, kdf.r, kdf.p]), salt, nonce]);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(passphrase, salt, kdf), nonce);
  cipher.setAAD(header);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([header, body, cipher.getAuthTag()]);
}

/** Decrypts a .hrbk file. Throws on a wrong passphrase or any change to the file. */
export function decrypt(file: Buffer, passphrase: string): Buffer {
  if (file.length < HEADER_LEN + TAG_LEN || !file.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Not a Health-Review backup file');
  const header = file.subarray(0, HEADER_LEN);
  const [logN, r, p] = header.subarray(MAGIC.length, MAGIC.length + 3);
  if (logN < 14 || logN > 22 || r < 1 || p < 1) throw new Error('Backup file has invalid key settings');
  const salt = header.subarray(MAGIC.length + 3, MAGIC.length + 19);
  const nonce = header.subarray(MAGIC.length + 19, HEADER_LEN);
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(passphrase, salt, { logN, r, p }), nonce);
  decipher.setAAD(header);
  decipher.setAuthTag(file.subarray(file.length - TAG_LEN));
  try {
    return Buffer.concat([decipher.update(file.subarray(HEADER_LEN, file.length - TAG_LEN)), decipher.final()]);
  } catch {
    throw new Error('Could not decrypt the backup: wrong passphrase, or the file was changed or damaged');
  }
}

export { sha256 };
