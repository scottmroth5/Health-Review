// US-only access (server/geo.js): requests from outside the allowed countries get the 403 page; ingest posts, the deploy
// check and private addresses always pass; no GEO_ALLOW or no database means nothing is blocked. A fake country lookup;
// no download, no network. Private Relay ranges are made up, in the documentation blocks.
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { openHealthStore } from '../db/store.js';
import { buildApp } from '../server/app.js';
import { countryLookup, geoAllowFromEnv, geoBlocker, isPrivateAddress, parseRelayRanges } from '../server/geo.js';

const COUNTRY = { '8.8.8.8': 'US', '81.2.69.142': 'GB', '203.0.113.9': null };
const lookup = (ip) => COUNTRY[ip] ?? null;

test('settings and private addresses', () => {
  assert.deepEqual(geoAllowFromEnv({ GEO_ALLOW: 'us, ca ,x' }), ['US', 'CA']);
  assert.deepEqual(geoAllowFromEnv({}), []);
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.5', '192.168.1.9', '169.254.1.1', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '172.32.0.1', '81.2.69.142', '2001:4860::8888']) assert.equal(isPrivateAddress(ip), false, ip);
  assert.equal(geoBlocker({ allow: [], lookup })({ ip: '81.2.69.142', url: '/' }), false, 'no allow list: off');
  assert.equal(geoBlocker({ allow: ['US'], lookup: null })({ ip: '81.2.69.142', url: '/' }), false, 'no database: fails open');
});

// The server's own TRUST_PROXY (deploy/compose.yml), so these tests use exactly what production does; requests arrive
// from Caddy on the Docker network with the visitor's address forwarded.
const TRUST_PROXY = /TRUST_PROXY: (\S+)/.exec(readFileSync(new URL('../deploy/compose.yml', import.meta.url), 'utf8'))[1];

async function appFrom(ip, { allow = ['US'], authMode = 'none', look = lookup } = {}) {
  const store = openHealthStore(':memory:');
  const app = await buildApp({ store, authMode, trustProxy: TRUST_PROXY, geo: { allow, lookup: look }, ingest: { token: 'made-up-ingest-token-0123456789', apple: 'rest' } });
  return (url, opts = {}) => app.inject({ url, remoteAddress: '172.18.0.4', ...opts, headers: { 'x-forwarded-for': ip, ...(opts.headers ?? {}) } });
}

test('production TRUST_PROXY: the app sees the visitor, never Caddy, so the block and rate limits work per visitor', async () => {
  assert.ok(!/^\d+$/.test(TRUST_PROXY), 'not a hop count: Fastify would then report the proxy itself');
  const app = await buildApp({ store: openHealthStore(':memory:'), trustProxy: TRUST_PROXY });
  app.get('/__ip', async (req) => ({ ip: req.ip }));
  const seen = (await app.inject({ url: '/__ip', remoteAddress: '172.18.0.4', headers: { 'x-forwarded-for': '81.2.69.142' } })).json().ip;
  assert.equal(seen, '81.2.69.142');
});

test('outside the US: the 403 page on pages and the API; ingest posts and the health check still pass', async () => {
  const uk = await appFrom('81.2.69.142');
  for (const url of ['/', '/api/status', '/privacy', '/guides', '/app.js', '/auth/login']) {
    const res = await uk(url);
    assert.equal(res.statusCode, 403, url);
    assert.match(res.body, /available in the United States only/);
  }
  assert.equal((await uk('/api/health')).statusCode, 200, 'the deploy check');
  const post = await uk('/api/ingest/health', { method: 'POST', headers: { authorization: 'Bearer made-up-ingest-token-0123456789', 'content-type': 'application/json' }, payload: { data: { metrics: [] } } });
  assert.notEqual(post.statusCode, 403, 'Health Auto Export posts from abroad');
  const unknown = await appFrom('203.0.113.9');
  assert.equal((await unknown('/api/status')).statusCode, 403, 'a public address with no country is outside');
});

test('in the US, from inside the server, or with blocking off: everything as usual', async () => {
  assert.equal((await (await appFrom('8.8.8.8'))('/api/status')).statusCode, 200);
  assert.equal((await (await appFrom('172.18.0.1'))('/api/status')).statusCode, 200, "Docker's network (Caddy)");
  assert.equal((await (await appFrom('81.2.69.142', { allow: [] }))('/api/status')).statusCode, 200, 'GEO_ALLOW unset');
  // The demo is covered the same way.
  assert.equal((await (await appFrom('81.2.69.142', { authMode: 'demo' }))('/api/status')).statusCode, 403);
});

test('deploy: the app is US-only, and the demo (made-up data only) is open worldwide (owner\'s choice, 2026-10-27)', () => {
  const compose = readFileSync(new URL('../deploy/compose.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const service = (name) => compose.split(/\n(?=  [a-z]+:\n)/).find((block) => block.startsWith(`  ${name}:\n`)) ?? '';
  const geo = (block) => block.split('\n').filter((l) => /^\s*GEO_ALLOW:/.test(l)).map((l) => l.trim());
  assert.deepEqual(geo(service('app')), ['GEO_ALLOW: US']);
  assert.deepEqual(geo(service('demo')), []);
});

// The shape of Apple's list (https://mask-api.icloud.com/egress-ip-ranges.csv): prefix, country, region, city.
const RELAY_CSV = [
  '192.0.2.0/28,US,US-NY,New York,',
  '192.0.2.16/28,US,US-NY,New York,',
  '192.0.2.64/31,GB,GB-EN,London,',
  '2001:db8:0:10::/60,US,US-CA,Los Angeles,',
  '2001:db8:1::/64,DE,DE-BE,Berlin,',
  'not-an-address/24,US,US-TX,Austin,',
  '198.51.100.0/24,usa,,,',
  '198.51.100.0/33,US,,,',
  '',
].join('\r\n');

test('Private Relay list: each address gets the country Apple lists, edges included; bad lines are skipped', () => {
  const relay = parseRelayRanges(RELAY_CSV);
  assert.equal(relay.size, 5, 'the three bad lines and the blank one are skipped');
  for (const [ip, cc] of [['192.0.2.0', 'US'], ['192.0.2.15', 'US'], ['192.0.2.31', 'US'], ['192.0.2.32', null], ['192.0.2.64', 'GB'],
    ['192.0.2.65', 'GB'], ['192.0.2.66', null], ['::ffff:192.0.2.5', 'US'], ['198.51.100.7', null], ['2001:db8:0:10::', 'US'],
    ['2001:db8:0:1f:ffff:ffff:ffff:ffff', 'US'], ['2001:db8:0:20::1', null], ['2001:DB8:1::abcd', 'DE'], ['2001:db8:1:0:1:2:3:4', 'DE'],
    ['2001:db8:2::1', null], ['8.8.8.8', null], ['junk', null], [undefined, null]]) {
    assert.equal(relay.country(ip), cc, String(ip));
  }
  assert.equal(parseRelayRanges('').size, 0);
  assert.equal(parseRelayRanges('').country('192.0.2.1'), null);
});

test('Private Relay visitors listed in the US get in; relay addresses listed elsewhere are still refused', async () => {
  const relay = parseRelayRanges(RELAY_CSV);
  const reader = { country: (ip) => ({ '192.0.2.5': 'GB', '8.8.8.8': 'US', '81.2.69.142': 'GB' })[ip] ?? null };
  const look = countryLookup(relay, reader);
  assert.equal(countryLookup(relay, null), null, 'no location database: fails open as before');
  assert.equal((await (await appFrom('192.0.2.5', { look }))('/api/status')).statusCode, 200, 'the database says GB, Apple says US');
  assert.equal((await (await appFrom('2001:db8:0:10::9', { look }))('/api/status')).statusCode, 200, 'no country in the database');
  assert.equal((await (await appFrom('192.0.2.64', { look }))('/api/status')).statusCode, 403, 'a London relay');
  assert.equal((await (await appFrom('2001:db8:1::5', { look }))('/api/status')).statusCode, 403, 'a Berlin relay');
  assert.equal((await (await appFrom('8.8.8.8', { look }))('/api/status')).statusCode, 200, 'not a relay: the database decides');
  assert.equal((await (await appFrom('81.2.69.142', { look }))('/api/status')).statusCode, 403);
});
