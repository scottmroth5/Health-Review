// Access control, following Job-Agent's server/auth.js. Today the server is for this computer
// only (AUTH_MODE=none) and refuses to listen anywhere but localhost in that mode. The AWS move
// adds a real login mode here; routes do not change.

export const LOOPBACK = ['127.0.0.1', '::1', 'localhost'];

/** Throws unless the host is allowed for the auth mode. */
export function assertSafeBinding({ host, mode = 'none' }) {
  if (mode === 'none' && !LOOPBACK.includes(host)) {
    throw new Error(`AUTH_MODE=none only allows localhost; refusing to listen on ${host}. Add a login mode before exposing the server.`);
  }
  if (mode !== 'none') throw new Error(`AUTH_MODE "${mode}" is not implemented yet.`);
}

/**
 * Registers the auth hook. With mode 'none' every request is allowed, but only when it is
 * addressed to localhost: a request whose Host header names any other site is rejected, which
 * blocks DNS rebinding (a web page pointing its own domain at 127.0.0.1 to read local data).
 */
export function registerAuth(app, { mode = 'none' } = {}) {
  if (mode !== 'none') throw new Error(`AUTH_MODE "${mode}" is not implemented yet.`);
  app.addHook('onRequest', async (req, reply) => {
    const host = String(req.headers.host ?? '').replace(/:\d+$/, '').replace(/^\[(.*)\]$/, '$1');
    if (!LOOPBACK.includes(host)) return reply.code(403).send({ error: 'This server only answers requests addressed to localhost.' });
  });
}
