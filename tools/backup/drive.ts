// A minimal Google Drive client for the encrypted backups, over HTTPS with the app's OAuth client. It needs only
// the drive.file scope, so it can see and change nothing in Drive except the files this app created. Fakeable:
// tests pass an object with the same four methods.
import type { OAuth2Client } from 'google-auth-library';

const API = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const FOLDER = 'application/vnd.google-apps.folder';

/** A file in the backup folder, as Drive lists it (size is a string of digits). */
export interface DriveFile { id: string; name: string; size?: string }

/** The calls the backups make; tests pass a fake with the same shape. */
export interface DriveClient {
  ensureFolder(name: string): Promise<string>;
  upload(folderId: string, name: string, data: Buffer): Promise<DriveFile>;
  list(folderId: string): Promise<DriveFile[]>;
  remove(id: string): Promise<void>;
  download(id: string): Promise<Buffer>;
}

const quote = (s: string): string => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

function scopeHint(err: any): unknown {
  const status = err?.response?.status ?? err?.status;
  if (status === 403 || status === 401) {
    return new Error('Google Drive refused the request. Sign in again with npm run google:login so the app gets the drive.file permission.');
  }
  return err;
}

export function createDriveClient(auth: OAuth2Client): DriveClient {
  const call = async (opts: Parameters<OAuth2Client['request']>[0]): Promise<any> => {
    try { return (await auth.request(opts)).data; } catch (err) { throw scopeHint(err); }
  };
  return {
    /** The id of the app's backup folder, created on first use. */
    async ensureFolder(name) {
      const q = `name = ${quote(name)} and mimeType = '${FOLDER}' and trashed = false`;
      const found = await call({ url: API, params: { q, fields: 'files(id)', spaces: 'drive' } });
      if (found.files?.length) return found.files[0].id;
      return (await call({ url: API, method: 'POST', data: { name, mimeType: FOLDER }, params: { fields: 'id' } })).id;
    },
    /** Uploads bytes as a new file in the folder (multipart). */
    async upload(folderId, name, data) {
      const boundary = `hrbk${Date.now().toString(36)}`;
      const meta = JSON.stringify({ name, parents: [folderId], mimeType: 'application/octet-stream' });
      const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`),
        data,
        Buffer.from(`\r\n--${boundary}--`),
      ]);
      return call({ url: UPLOAD, method: 'POST', params: { uploadType: 'multipart', fields: 'id,name,size' },
        headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body });
    },
    /** The folder's files: [{ id, name, size }]. */
    async list(folderId) {
      const out: DriveFile[] = [];
      let pageToken: string | undefined;
      do {
        const r = await call({ url: API, params: { q: `${quote(folderId)} in parents and trashed = false`, fields: 'nextPageToken, files(id,name,size)', pageSize: 100, pageToken } });
        out.push(...(r.files ?? []));
        pageToken = r.nextPageToken;
      } while (pageToken);
      return out;
    },
    async remove(id) {
      await call({ url: `${API}/${encodeURIComponent(id)}`, method: 'DELETE' });
    },
    async download(id) {
      return Buffer.from(await call({ url: `${API}/${encodeURIComponent(id)}`, params: { alt: 'media' }, responseType: 'arraybuffer' }));
    },
  };
}
