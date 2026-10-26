// The app icons (the owner's icon pack, 2026-10-26): each committed PNG is the size its name says, favicon.ico holds
// 16 and 32, and every icon the page head and the manifest name exists.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { repoPath } from '../tools/paths.js';

const pub = (name) => repoPath('server', 'public', name);
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function pngSize(file) {
  const png = readFileSync(file);
  assert.deepEqual([...png.subarray(0, 8)], PNG_SIGNATURE, `${file} is a PNG`);
  assert.equal(png.toString('ascii', 12, 16), 'IHDR');
  return [png.readUInt32BE(16), png.readUInt32BE(20)];
}

test('icons: each PNG is the size it is named for', () => {
  for (const [name, size] of [['icon-16.png', 16], ['icon-32.png', 32], ['apple-touch-icon.png', 180], ['icon-192.png', 192], ['icon-512.png', 512]]) {
    assert.deepEqual(pngSize(pub(name)), [size, size], name);
  }
});

test('icons: favicon.ico is an icon file holding 16 and 32 px images', () => {
  const ico = readFileSync(pub('favicon.ico'));
  assert.equal(ico.readUInt16LE(0), 0);
  assert.equal(ico.readUInt16LE(2), 1, 'type 1 is an icon');
  const sizes = Array.from({ length: ico.readUInt16LE(4) }, (_, i) => ico[6 + i * 16] || 256);
  assert.ok(sizes.includes(16) && sizes.includes(32), `sizes ${sizes}`);
});

test('icons: every icon the page head and the manifest name exists', () => {
  const head = readFileSync(pub('index.html'), 'utf8');
  const linked = [...head.matchAll(/<link rel="(?:icon|apple-touch-icon)"[^>]*href="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(linked.length >= 3, 'favicon, PNG icons and the touch icon are linked');
  const manifest = JSON.parse(readFileSync(pub('manifest.webmanifest'), 'utf8'));
  for (const src of [...linked, ...manifest.icons.map((i) => i.src)]) {
    assert.ok(!src.startsWith('data:') && existsSync(pub(src)), `${src} exists`);
  }
  for (const icon of manifest.icons) assert.deepEqual(pngSize(pub(icon.src)).join('x'), icon.sizes, icon.src);
});

test('Home tiles: each tile has its dashboard icon, a 128 px PNG in tiles/, and every image the page names exists', async () => {
  const { TILES } = await import('../server/public/goals.js');
  const page = readFileSync(pub('index.html'), 'utf8');
  for (const tile of TILES) {
    const name = tile === 'today' ? 'daily-check-in' : tile;
    assert.match(page, new RegExp(String.raw`href="#${tile}"[^>]*>\s*<img class="tile-icon" src="tiles/${name}\.png"`), tile);
    assert.deepEqual(pngSize(pub(`tiles/${name}.png`)), [128, 128], name);
  }
  for (const [, src] of page.matchAll(/<img[^>]*src="([^"]+)"/g)) assert.ok(existsSync(pub(src)), `${src} exists`);
});
