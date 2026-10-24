// The Add to Home Screen icons: scripts/make-icons.js draws them, and the committed files match what it draws.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { drawIcon, encodePng } from '../scripts/make-icons.js';
import { repoPath } from '../tools/paths.js';

test('icons: a valid RGB PNG of the right size, blue background with a white line, and the committed files are current', () => {
  const png = encodePng(32, drawIcon(32));
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(png.toString('ascii', 12, 16), 'IHDR');
  assert.equal(png.readUInt32BE(16), 32);
  assert.equal(png.readUInt32BE(20), 32);
  const idat = png.indexOf('IDAT');
  const rows = inflateSync(png.subarray(idat + 4, idat + 4 + png.readUInt32BE(idat - 4)));
  assert.equal(rows.length, 32 * (32 * 3 + 1));
  const pixels = drawIcon(180);
  assert.deepEqual([...pixels.subarray(0, 3)], [0x2a, 0x78, 0xd6], 'corner is the accent blue');
  const center = (90 * 180 + 90) * 3;
  assert.ok(pixels[center] > 200 && pixels[center + 2] > 200, 'the line crosses the middle');
  for (const size of [180, 192, 512]) {
    assert.ok(readFileSync(repoPath('server', 'public', `icon-${size}.png`)).equals(encodePng(size, drawIcon(size))), `icon-${size}.png is current (run node scripts/make-icons.js)`);
  }
});
