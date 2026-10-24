// Draws the app icons for Add to Home Screen (server/public/icon-180.png, icon-192.png, icon-512.png): the favicon's
// pulse line in white on the accent blue, full bleed (iOS rounds the corners itself). No dependencies: the line is
// drawn by distance to each segment with 4x4 supersampling, and the PNG is written with node:zlib.
//   node scripts/make-icons.js
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { repoPath } from '../tools/paths.js';

const BACKGROUND = [0x2a, 0x78, 0xd6]; // --accent in app.css (light)
const LINE = [0xff, 0xff, 0xff];
// The favicon's path M1 9h3l2-5 3 9 2-6 1 2h3, in its 16 x 16 box.
const POINTS = [[1, 9], [4, 9], [6, 4], [9, 13], [11, 7], [12, 9], [15, 9]];
const STROKE = 1.6; // in favicon units (the favicon uses 2 at 16 px; a little lighter reads better large)
const INSET = 0.18; // the share of the icon left clear on each side

function distanceToSegment(px, py, [ax, ay], [bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** RGB pixels for a size x size icon. */
export function drawIcon(size) {
  const scale = (size * (1 - 2 * INSET)) / 14; // the path spans x 1 to 15
  const toIcon = ([x, y]) => [size * INSET + (x - 1) * scale, size / 2 + (y - 8.5) * scale];
  const points = POINTS.map(toIcon);
  const half = (STROKE * scale) / 2;
  const pixels = Buffer.alloc(size * size * 3);
  const SAMPLES = 4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let covered = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const px = x + (sx + 0.5) / SAMPLES;
          const py = y + (sy + 0.5) / SAMPLES;
          let d = Infinity;
          for (let i = 1; i < points.length; i++) d = Math.min(d, distanceToSegment(px, py, points[i - 1], points[i]));
          if (d <= half) covered++;
        }
      }
      const a = covered / (SAMPLES * SAMPLES);
      for (let c = 0; c < 3; c++) pixels[(y * size + x) * 3 + c] = Math.round(BACKGROUND[c] * (1 - a) + LINE[c] * a);
    }
  }
  return pixels;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** An 8-bit RGB PNG from size x size pixels. */
export function encodePng(size, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // RGB
  const rows = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) pixels.copy(rows, y * (size * 3 + 1) + 1, y * size * 3, (y + 1) * size * 3);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(rows, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  for (const size of [180, 192, 512]) {
    const path = repoPath('server', 'public', `icon-${size}.png`);
    writeFileSync(path, encodePng(size, drawIcon(size)));
    console.log(`Wrote ${path}`);
  }
}
