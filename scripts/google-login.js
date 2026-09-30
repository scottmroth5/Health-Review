// Copied from Job-Agent's scripts/google-login.js; only the app name differs.
// One-time Google sign-in. Opens the browser, receives the consent redirect on a local
// port, and saves the refresh token to data/google/token.json (gitignored).
// Run again any time the sign-in is revoked or the token file is lost.
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { OAuth2Client, CodeChallengeMethod } from 'google-auth-library';
import { SCOPES, TOKEN_PATH, loadClientCredentials } from '../tools/google/auth.js';

const TIMEOUT_MS = 5 * 60 * 1000;

function openBrowser(url) {
  const [cmd, args] =
    process.platform === 'win32'
      ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}

const page = (msg) => `<!doctype html><meta charset="utf-8"><title>Health Review</title><p style="font:16px system-ui;margin:40px">${msg}</p>`;

async function main() {
  const { clientId, clientSecret } = loadClientCredentials();
  const state = randomBytes(16).toString('hex');

  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const redirectUri = `http://127.0.0.1:${server.address().port}`;
  const client = new OAuth2Client({ clientId, clientSecret, redirectUri });
  const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();

  const authUrl = client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent', // always returns a refresh token, even on a repeat sign-in
    scope: SCOPES,
    state,
    code_challenge_method: CodeChallengeMethod.S256,
    code_challenge: codeChallenge,
  });

  const result = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for the Google sign-in (5 minutes).')), TIMEOUT_MS);
    server.on('request', async (req, res) => {
      const url = new URL(req.url, redirectUri);
      if (url.pathname !== '/') {
        res.writeHead(404).end();
        return;
      }
      const finish = (status, msg, err) => {
        res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' }).end(page(msg));
        clearTimeout(timer);
        err ? reject(err) : resolve();
      };
      if (url.searchParams.get('state') !== state) return finish(400, 'Sign-in failed: state mismatch.', new Error('State mismatch; try again.'));
      const error = url.searchParams.get('error');
      if (error) return finish(400, `Sign-in cancelled (${error}).`, new Error(`Google returned: ${error}`));
      try {
        const { tokens } = await client.getToken({ code: url.searchParams.get('code'), codeVerifier, redirect_uri: redirectUri });
        if (!tokens.refresh_token) throw new Error('Google did not return a refresh token.');
        const granted = String(tokens.scope ?? '').split(/\s+/);
        const missing = SCOPES.filter((s) => !granted.includes(s));
        mkdirSync(dirname(TOKEN_PATH), { recursive: true });
        writeFileSync(
          TOKEN_PATH,
          JSON.stringify({ refresh_token: tokens.refresh_token, scope: tokens.scope, obtained_at: new Date().toISOString() }, null, 2),
          { mode: 0o600 },
        );
        if (missing.length) {
          return finish(200, 'Signed in, but some permissions were not granted. See the terminal.',
            new Error(`Signed in, but these permissions were unchecked on the consent screen: ${missing.join(', ')}. ` +
              'Run "npm run google:login" again and leave every box checked.'));
        }
        finish(200, 'Signed in. You can close this tab and return to the terminal.');
      } catch (err) {
        finish(500, 'Sign-in failed. See the terminal.', err);
      }
    });
  });

  console.log('Opening your browser for Google sign-in. If it does not open, visit:\n');
  console.log(authUrl + '\n');
  console.log('Google will warn that the app is unverified: choose Advanced, then "Go to Health-Review".');
  openBrowser(authUrl);

  try {
    await result;
    console.log(`Signed in. Refresh token saved to ${TOKEN_PATH}`);
  } finally {
    server.close();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
