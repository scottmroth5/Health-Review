// Access control, ported from Job-Agent's server/auth.js so the two apps behave the same.
//   AUTH_MODE=none    (default) no login; the server refuses to listen anywhere but localhost and only answers requests
//                     addressed to localhost (blocks DNS rebinding).
//   AUTH_MODE=google  "Sign in with Google" (multi-user, phase 2): anyone may sign in and request access; only approved
//                     users (the users table, checked on every request) reach the app. AUTH_ALLOWED_EMAILS's first address
//                     is the owner (user 1, admin). Every page and API route needs the signed session cookie except
//                     /auth/*, /privacy, /terms, /api/health (the deploy check) and /api/ingest/* (their own token).
//   AUTH_MODE=demo    The public, read-only demo over made-up data: no login, and every request that would change
//                     data is refused. The demo instance (server/index.js) starts without Claude, Google or a sync.
import { createHash, randomBytes } from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';
import { SESSION_COOKIE, LOGIN_COOKIE, sessionKey, sign, verify, parseCookies, cookie } from './session.js';

export const LOOPBACK = ['127.0.0.1', '::1', 'localhost'];
export const MODES = ['none', 'google', 'demo'];
export const SESSION_DAYS = 30;
const LOGIN_MINUTES = 10;
const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
export const CALLBACK_PATH = '/auth/google/callback';
// A user's own Google Sheets permission (read only) for their Workout Log (multi-user, phase 3), asked separately from sign-in.
export const SHEETS_CALLBACK_PATH = '/auth/google/sheets/callback';
export const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';
// "Create my Workout Log": drive.file lets the app create a sheet and open only the files it created (non-sensitive).
export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const SHEETS_COOKIE = 'hr_sheets';
// The app icon and manifest are open too: iOS fetches them for Add to Home Screen without the session cookie (code-only files).
const OPEN_PATHS = [/^\/auth\//, /^\/api\/health$/, /^\/api\/ingest\//, /^\/(manifest\.webmanifest|icon-\d+\.png)$/, /^\/(privacy|terms)$/, /^\/guides(\/[a-z-]+)?$/];
const READ_METHODS = ['GET', 'HEAD', 'OPTIONS'];
export const DEMO_REFUSAL = 'This is a read-only demo with made-up data, so changes are turned off.';

/** Sign-in settings from the environment (.env). */
export function authSettings(env = process.env) {
  return {
    mode: env.AUTH_MODE || 'none',
    publicUrl: (env.PUBLIC_URL || '').replace(/\/+$/, ''),
    clientId: env.GOOGLE_WEB_CLIENT_ID || '',
    clientSecret: env.GOOGLE_WEB_CLIENT_SECRET || '',
    allowed: String(env.AUTH_ALLOWED_EMAILS || '').split(/[,\s]+/).map((e) => e.trim().toLowerCase()).filter(Boolean),
    secret: env.SESSION_SECRET || '',
  };
}

const httpsUrl = (value, what) => {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`PUBLIC_URL must be a full URL such as ${what}.`);
  }
  return url;
};

/** Throws unless the settings are complete and safe for this host. Never includes secret values. */
export function assertSafeBinding({ host, mode = 'none', settings = {} }) {
  if (!MODES.includes(mode)) throw new Error(`AUTH_MODE "${mode}" is not supported. Use none, google or demo.`);
  const loopback = LOOPBACK.includes(host);
  if (mode === 'none') {
    if (!loopback) throw new Error(`AUTH_MODE=none only allows localhost; refusing to listen on ${host}. Set AUTH_MODE=google before exposing the server.`);
    return;
  }
  if (mode === 'demo') {
    if (loopback) return;
    if (!settings.publicUrl) throw new Error('AUTH_MODE=demo needs PUBLIC_URL when the server is reachable from other computers.');
    if (httpsUrl(settings.publicUrl, 'https://demo.example.com').protocol !== 'https:') throw new Error(`PUBLIC_URL must use https when the server listens on ${host}.`);
    return;
  }
  const missing = [
    ['GOOGLE_WEB_CLIENT_ID', settings.clientId],
    ['GOOGLE_WEB_CLIENT_SECRET', settings.clientSecret],
    ['AUTH_ALLOWED_EMAILS', settings.allowed?.length],
    ['SESSION_SECRET', settings.secret],
    ['PUBLIC_URL', settings.publicUrl],
  ].filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) throw new Error(`AUTH_MODE=google needs ${missing.join(', ')} in .env.`);
  sessionKey(settings.secret);
  const url = httpsUrl(settings.publicUrl, 'https://health.example.com or http://localhost:5188');
  if (!loopback && url.protocol !== 'https:') throw new Error(`PUBLIC_URL must use https when the server listens on ${host}.`);
}

/** The Sheets exchange: code -> tokens (the refresh token is what is kept, sealed). */
export function googleTokenExchange(settings) {
  return async ({ code, codeVerifier, redirectUri }) => {
    const client = new OAuth2Client({ clientId: settings.clientId, clientSecret: settings.clientSecret, redirectUri });
    const { tokens } = await client.getToken({ code, codeVerifier, redirect_uri: redirectUri });
    return tokens;
  };
}

/** The real Google exchange: code -> verified ID token payload (signature, audience, issuer, expiry). */
export function googleExchange(settings) {
  return async ({ code, codeVerifier, redirectUri }) => {
    const client = new OAuth2Client({ clientId: settings.clientId, clientSecret: settings.clientSecret, redirectUri });
    const { tokens } = await client.getToken({ code, codeVerifier, redirect_uri: redirectUri });
    if (!tokens.id_token) throw new Error('Google did not return an ID token.');
    const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: settings.clientId });
    return ticket.getPayload();
  };
}

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const b64url = (buf) => Buffer.from(buf).toString('base64url');
const page = (title, body) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title>` +
  '<style>body{font:16px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#f4f3f0;color:#1d1d1b}' +
  '@media (prefers-color-scheme: dark){body{background:#121211;color:#e8e7e3}a{color:#6da7ec}}main{max-width:420px;padding:24px}</style></head>' +
  `<body><main><h1 style="font-size:20px">${escapeHtml(title)}</h1>${body}</main></body></html>`;
/** Only same-site paths are allowed as the place to return to after signing in. */
const safeNext = (next) => (typeof next === 'string' && /^\/(?!\/)/.test(next) && !next.startsWith('/auth/') ? next : '/');

/**
 * Registers the auth hook and routes. In google mode, req.user is the signed-in email on every allowed request.
 * @param {{ mode: string, settings?: object, exchange?: Function, now?: () => number }} opts  exchange: googleExchange(settings) (tests pass a fake)
 */
/**
 * @param {object} [users]  findUser(email) -> users row or null; registerUser({ email, name }) -> creates a pending user and
 *   tells the admin (google mode)
 */
export function registerAuth(app, { mode = 'none', settings = {}, exchange, now = () => Date.now(), findUser = () => null, registerUser = async () => {},
  sheetsExchange, connectSheets = async () => {}, createSheet = async () => { throw new Error('Creating sheets is not available'); }, supportEmail = null } = {}) {
  // The published support address on the sign-in pages (escaped; null leaves the line out).
  const contact = supportEmail ? `<p>Questions: <a href="mailto:${escapeHtml(supportEmail)}">${escapeHtml(supportEmail)}</a></p>` : '';
  app.get('/api/me', {
    schema: { summary: 'The signed-in user (google mode), or the open or demo mode', response: { 200: { type: 'object', additionalProperties: true } } },
  }, async (req) => ({ authMode: mode, email: req.user ?? null, name: req.userName ?? null, ...(mode === 'demo' ? { demo: true } : {}) }));

  if (mode === 'none') {
    app.addHook('onRequest', async (req, reply) => {
      const host = String(req.headers.host ?? '').replace(/:\d+$/, '').replace(/^\[(.*)\]$/, '$1');
      if (!LOOPBACK.includes(host)) return reply.code(403).send({ error: 'This server only answers requests addressed to localhost.' });
    });
    return;
  }
  if (mode === 'demo') {
    app.addHook('onRequest', async (req, reply) => {
      if (READ_METHODS.includes(req.method)) return;
      return reply.code(403).send({ error: DEMO_REFUSAL });
    });
    return;
  }
  if (mode !== 'google') throw new Error(`AUTH_MODE "${mode}" is not supported.`);

  const key = sessionKey(settings.secret);
  const origin = new URL(settings.publicUrl).origin;
  const secure = settings.publicUrl.startsWith('https://');
  const redirectUri = `${settings.publicUrl}${CALLBACK_PATH}`;
  const signIn = exchange ?? googleExchange(settings);

  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0];
    if (OPEN_PATHS.some((re) => re.test(path))) return;
    const session = verify(parseCookies(req.headers.cookie)[SESSION_COOKIE], key, now());
    if (!session) {
      if (path.startsWith('/api/')) return reply.code(401).send({ error: 'Sign in required.' });
      return reply.redirect(`/auth/login?next=${encodeURIComponent(req.url)}`);
    }
    // Changes must come from this site (on top of SameSite cookies).
    if (!READ_METHODS.includes(req.method) && req.headers.origin !== origin) {
      return reply.code(403).send({ error: 'Requests that change data must come from this site.' });
    }
    // The users row behind the address (multi-user): only an approved one gets in, checked on every request, so pausing
    // or rejecting someone locks them out at once. req.uid scopes every query of the request to them (db/scope.js).
    // No row yet: request access first; pending or rejected: their page. Approved and paused users get in.
    const user = findUser(session.email);
    const where = !user ? '/auth/register' : user.status === 'pending' ? '/auth/waiting' : user.status === 'rejected' ? '/auth/not-approved' : null;
    if (where) {
      if (path.startsWith('/api/')) return reply.code(403).send({ error: user ? 'This account is not approved yet.' : 'Request access first.' });
      return reply.redirect(where);
    }
    req.user = session.email;
    req.uid = user.id;
    req.role = user.role;
    req.userName = typeof session.name === 'string' ? session.name : null;
  });

  app.get('/auth/login', { schema: { hide: true } }, async (req, reply) => {
    const state = b64url(randomBytes(24));
    const nonce = b64url(randomBytes(24));
    const codeVerifier = b64url(randomBytes(32));
    const challenge = createHash('sha256').update(codeVerifier).digest('base64url');
    const login = sign({ state, nonce, codeVerifier, next: safeNext(req.query?.next), exp: now() + LOGIN_MINUTES * 60_000 }, key);
    const url = new URL(GOOGLE_AUTH);
    for (const [k, v] of Object.entries({
      client_id: settings.clientId, redirect_uri: redirectUri, response_type: 'code', scope: 'openid email profile',
      state, nonce, code_challenge: challenge, code_challenge_method: 'S256', prompt: 'select_account',
    })) url.searchParams.set(k, v);
    reply.header('Set-Cookie', cookie(LOGIN_COOKIE, login, { maxAge: LOGIN_MINUTES * 60, secure }));
    return reply.redirect(url.toString());
  });

  app.get(CALLBACK_PATH, { schema: { hide: true } }, async (req, reply) => {
    const fail = (status, title, body) => reply.code(status).type('text/html').header('Set-Cookie', cookie(LOGIN_COOKIE, '', { maxAge: 0, secure })).send(page(title, body));
    const again = '<p><a href="/auth/login">Try again</a></p>';
    const login = verify(parseCookies(req.headers.cookie)[LOGIN_COOKIE], key, now());
    if (req.query?.error) return fail(400, 'Sign-in cancelled', `<p>Google returned: ${escapeHtml(req.query.error)}.</p>${again}`);
    if (!login || !req.query?.state || req.query.state !== login.state || !req.query?.code) {
      return fail(400, 'Sign-in expired', `<p>The sign-in link was used already or took too long.</p>${again}`);
    }
    let claims;
    try {
      claims = await signIn({ code: req.query.code, codeVerifier: login.codeVerifier, redirectUri });
    } catch (err) {
      console.warn(`[auth] Google sign-in failed: ${err.name}`);
      return fail(502, 'Sign-in failed', `<p>Google could not confirm the sign-in.</p>${again}`);
    }
    if (claims?.nonce !== login.nonce) return fail(400, 'Sign-in failed', `<p>The sign-in response did not match this request.</p>${again}`);
    if (!claims.email || claims.email_verified !== true) return fail(403, 'Email not verified', `<p>That Google account's email address is not verified.</p>${again}`);
    // The first name (profile scope) is shown in the header; never logged.
    const name = String(claims.given_name || claims.name || '').trim().slice(0, 60) || null;
    const session = sign({ email: claims.email.toLowerCase(), ...(name ? { name } : {}), exp: now() + SESSION_DAYS * 86_400_000, v: 1 }, key);
    reply.header('Set-Cookie', [cookie(SESSION_COOKIE, session, { maxAge: SESSION_DAYS * 86_400, secure }), cookie(LOGIN_COOKIE, '', { maxAge: 0, secure })]);
    return reply.redirect(login.next);
  });

  // ---- Connecting a user's own Google Sheets (read only), for their Workout Log (multi-user, phase 3) ----
  // ?create=1 ("Create my Workout Log") also asks for drive.file, then creates their sheet (createSheet) on the way back.
  // Only an approved user, after signing in; the refresh token goes to connectSheets (sealed there), never to a log.
  const sheetsRedirect = `${settings.publicUrl}${SHEETS_CALLBACK_PATH}`;
  const tokensFor = sheetsExchange ?? googleTokenExchange(settings);
  app.get('/auth/google/sheets', { schema: { hide: true } }, async (req, reply) => {
    const session = verify(parseCookies(req.headers.cookie)[SESSION_COOKIE], key, now());
    if (findUser(session?.email ?? '')?.status !== 'approved') return reply.redirect('/auth/login');
    const state = b64url(randomBytes(24));
    const codeVerifier = b64url(randomBytes(32));
    const create = req.query?.create === '1';
    const pending = sign({ state, codeVerifier, email: session.email, create, exp: now() + LOGIN_MINUTES * 60_000 }, key);
    const url = new URL(GOOGLE_AUTH);
    for (const [k, v] of Object.entries({
      client_id: settings.clientId, redirect_uri: sheetsRedirect, response_type: 'code', scope: create ? `${SHEETS_SCOPE} ${DRIVE_FILE_SCOPE}` : SHEETS_SCOPE, access_type: 'offline',
      prompt: 'consent', login_hint: session.email, state, code_challenge: createHash('sha256').update(codeVerifier).digest('base64url'), code_challenge_method: 'S256',
    })) url.searchParams.set(k, v);
    reply.header('Set-Cookie', cookie(SHEETS_COOKIE, pending, { maxAge: LOGIN_MINUTES * 60, secure }));
    return reply.redirect(url.toString());
  });
  app.get(SHEETS_CALLBACK_PATH, { schema: { hide: true } }, async (req, reply) => {
    const clear = cookie(SHEETS_COOKIE, '', { maxAge: 0, secure });
    const back = (result) => reply.header('Set-Cookie', clear).redirect(`/#settings/sheets-${result}`);
    const pending = verify(parseCookies(req.headers.cookie)[SHEETS_COOKIE], key, now());
    const session = verify(parseCookies(req.headers.cookie)[SESSION_COOKIE], key, now());
    if (req.query?.error) return back('cancelled');
    if (!pending || !session || pending.email !== session.email || req.query?.state !== pending.state || !req.query?.code) return back('expired');
    try {
      const tokens = await tokensFor({ code: req.query.code, codeVerifier: pending.codeVerifier, redirectUri: sheetsRedirect });
      const granted = String(tokens?.scope ?? (pending.create ? '' : SHEETS_SCOPE));
      if (!tokens?.refresh_token || !granted.includes(SHEETS_SCOPE) || (pending.create && !granted.includes(DRIVE_FILE_SCOPE))) return back('incomplete');
      await connectSheets({ email: session.email, refreshToken: tokens.refresh_token });
      if (!pending.create) return back('connected');
    } catch (err) {
      console.warn(`[auth] Google Sheets connection failed: ${err.name}`);
      return back('failed');
    }
    try {
      await createSheet({ email: session.email });
      return back('created');
    } catch (err) {
      console.warn(`[auth] creating a Workout Log failed: ${err.name}`);
      return back('create-failed');
    }
  });

  // ---- Requesting access (anyone signed in with Google whose address has no users row) ----
  // Plain HTML forms post url-encoded bodies; only these routes take them.
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 4096 }, (req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body)));
  });
  const sessionOf = (req) => verify(parseCookies(req.headers.cookie)[SESSION_COOKIE], key, now());
  const statusPage = (user) => (!user ? null : user.status === 'pending' ? '/auth/waiting' : user.status === 'rejected' ? '/auth/not-approved' : '/');
  const signOut = '<form method="post" action="/auth/logout?then=page"><button type="submit">Sign out</button></form>';
  app.get('/auth/register', { schema: { hide: true } }, async (req, reply) => {
    const session = sessionOf(req);
    if (!session) return reply.redirect('/auth/login');
    const there = statusPage(findUser(session.email));
    if (there) return reply.redirect(there);
    return reply.type('text/html').send(page('Request access to Health Review', `
      <p>You're asking to use <strong>Health Review with your own data</strong>. It's a private app shared by invitation, and the owner approves each request.</p>
      <p>Health Review turns your Apple Health data, workouts and daily check-ins into charts, tracks your goals and training programs, and can write a weekly review with AI. It's free; AI uses your own Claude key, only if you add one.</p>
      <p>Signed in as <strong>${escapeHtml(session.email)}</strong>.</p>
      <p><strong>No AI is used</strong> until you add your own Claude API key in Settings; everything else works without one.</p>
      <p>Requests are approved by hand, usually within 24 hours, and you get an email when you're in.</p>
      <form method="post" action="/auth/register">
        <p><strong>What will you use?</strong> (you can change this later in Settings; <a href="/guides" target="_blank">setup guides</a>)</p>
        <p><label><input type="checkbox" name="appleHealth" checked> Apple Health, sent from Health Auto Export on your iPhone</label><br>
        <label><input type="checkbox" name="workoutLog"> A Workout Log in Google Sheets</label><br>
        <label><input type="checkbox" name="manual" checked> Check-ins, drinks, meds and labs entered in the app</label></p>
        <p><label><input type="checkbox" name="agree" required> I agree to the <a href="/terms" target="_blank">terms</a> and the <a href="/privacy" target="_blank">privacy policy</a>.</label></p>
        <p><button type="submit">Request access</button></p>
      </form>${signOut}`));
  });
  app.post('/auth/register', { schema: { hide: true } }, async (req, reply) => {
    if (req.headers.origin !== origin) return reply.code(403).send({ error: 'Requests that change data must come from this site.' });
    const session = sessionOf(req);
    if (!session) return reply.redirect('/auth/login');
    if (!findUser(session.email)) {
      if (req.body?.agree !== 'on') return reply.redirect('/auth/register');
      const feeds = Object.fromEntries(['appleHealth', 'workoutLog', 'manual'].map((f) => [f, req.body?.[f] === 'on']));
      await registerUser({ email: session.email, name: typeof session.name === 'string' ? session.name : null, feeds });
    }
    return reply.redirect(statusPage(findUser(session.email)) ?? '/');
  });
  app.get('/auth/waiting', { schema: { hide: true } }, async (req, reply) => {
    const email = sessionOf(req)?.email;
    return reply.type('text/html').send(page('Thanks, your request is in', `<p>Your request to use Health Review is waiting for the owner's approval, usually within 24 hours.</p>
      <p>You'll get an email${email ? ` at <strong>${escapeHtml(email)}</strong>` : ''} when you're in; then just open the app again and sign in with the same Google account.</p>${contact}${signOut}`));
  });
  app.get('/auth/not-approved', { schema: { hide: true } }, async (req, reply) =>
    reply.type('text/html').send(page('Access was not approved', `<p>This account can't use Health Review.</p>${contact}${signOut}`)));

  app.post('/auth/logout', { schema: { hide: true } }, async (req, reply) => {
    if (req.headers.origin && req.headers.origin !== origin) return reply.code(403).send({ error: 'Requests that change data must come from this site.' });
    reply.header('Set-Cookie', cookie(SESSION_COOKIE, '', { maxAge: 0, secure }));
    // From the plain pages above (a form post) go to the signed-out page; the app's own button expects 204.
    return req.query?.then === 'page' ? reply.redirect('/auth/signed-out') : reply.code(204).send();
  });

  app.get('/auth/signed-out', { schema: { hide: true } }, async (req, reply) =>
    reply.type('text/html').send(page('Signed out', '<p><a href="/auth/login">Sign in again</a></p>')));
}
