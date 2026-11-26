/**
 * Draws the app icon, build/icon.png (1024×1024 RGBA), with no image tool: a macOS-style rounded
 * square with a prompt chevron and cursor. electron-builder turns it into the .icns. Run it again
 * only to change the icon: `node scripts/icon.mjs`.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { deflateSync } from 'node:zlib';

const N = 1024;
// Apple's icon grid: an 824×824 body centred in 1024, corner radius about 185.
const BODY = 824, RADIUS = 185, INSET = (N - BODY) / 2;
const TOP = [0x2b, 0x3a, 0x67], BOTTOM = [0x10, 0x16, 0x2b], INK = [0xf2, 0xf5, 0xff], ACCENT = [0x5e, 0xea, 0xd4];

/** Signed distance to a rounded rectangle centred at (cx, cy). */
function roundedBox(x, y, cx, cy, hw, hh, r) {
  const qx = Math.abs(x - cx) - hw + r, qy = Math.abs(y - cy) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}
/** Signed distance to a segment of half-width w. */
function segment(x, y, ax, ay, bx, by, w) {
  const px = x - ax, py = y - ay, dx = bx - ax, dy = by - ay;
  const h = Math.max(0, Math.min(1, (px * dx + py * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - dx * h, py - dy * h) - w;
}
const cover = d => Math.max(0, Math.min(1, 0.5 - d));
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

const rows = [];
for (let y = 0; y < N; y++) {
  const row = Buffer.alloc(1 + N * 4); // filter byte 0, then RGBA
  for (let x = 0; x < N; x++) {
    const px = x + 0.5, py = y + 0.5;
    const body = cover(roundedBox(px, py, N / 2, N / 2, BODY / 2, BODY / 2, RADIUS));
    let color = mix(TOP, BOTTOM, (py - INSET) / BODY);
    const chevron = Math.min(segment(px, py, 300, 340, 470, 512, 42), segment(px, py, 470, 512, 300, 684, 42));
    color = mix(color, INK, cover(chevron));
    color = mix(color, ACCENT, cover(roundedBox(px, py, 640, 660, 120, 30, 30)));
    const o = 1 + x * 4;
    row[o] = Math.round(color[0]); row[o + 1] = Math.round(color[1]); row[o + 2] = Math.round(color[2]); row[o + 3] = Math.round(body * 255);
  }
  rows.push(row);
}

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = buf => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body));
  return Buffer.concat([len, body, sum]);
}
const header = Buffer.alloc(13);
header.writeUInt32BE(N, 0); header.writeUInt32BE(N, 4); header[8] = 8; header[9] = 6; // 8-bit RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.concat(rows), { level: 9 })), chunk('IEND', Buffer.alloc(0)),
]);
const out = path.join(import.meta.dirname, '..', 'build', 'icon.png');
writeFileSync(out, png);
console.log(`wrote ${out} (${png.length} bytes)`);
