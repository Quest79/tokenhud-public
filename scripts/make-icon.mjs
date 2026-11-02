// One-off: draws the TokenHUD X glyph and writes tray/icons/icon.ico (PNG-compressed, 256 px). Run: node scripts/make-icon.mjs
import fs from 'node:fs';
import zlib from 'node:zlib';
const N = 256, SS = 4;
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const segT = (px, py, ax, ay, bx, by) => { const dx = bx - ax, dy = by - ay; const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy))); return [t, Math.hypot(px - ax - t * dx, py - ay - t * dy)]; };
function sample(x, y) {
  const [t2, d2] = segT(x, y, 0.84, 0.16, 0.16, 0.84);
  if (d2 <= 0.1) return [...mix([144, 88, 248], [194, 107, 255], t2), 1];
  const [t1, d1] = segT(x, y, 0.16, 0.16, 0.84, 0.84);
  if (d1 <= 0.1) return [...mix([38, 237, 243], [0, 160, 248], t1), 1];
  return [0, 0, 0, 0];
}
const raw = Buffer.alloc(N * (N * 4 + 1));
for (let y = 0; y < N; y++) {
  raw[y * (N * 4 + 1)] = 0;
  for (let x = 0; x < N; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const c = sample((x + (sx + 0.5) / SS) / N, (y + (sy + 0.5) / SS) / N);
      r += c[0] * c[3]; g += c[1] * c[3]; b += c[2] * c[3]; a += c[3];
    }
    const o = y * (N * 4 + 1) + 1 + x * 4, n = SS * SS;
    raw[o] = a ? Math.round(r / a) : 0; raw[o + 1] = a ? Math.round(g / a) : 0; raw[o + 2] = a ? Math.round(b / a) : 0; raw[o + 3] = Math.round((a / n) * 255);
  }
}
const crcT = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc = (b) => { let c = -1; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
const chunk = (type, data) => { const t = Buffer.from(type), l = Buffer.alloc(4), c = Buffer.alloc(4); l.writeUInt32BE(data.length); c.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([l, t, data, c]); };
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4); ihdr[8] = 8; ihdr[9] = 6;
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
const dir = Buffer.alloc(22); dir.writeUInt16LE(1, 2); dir.writeUInt16LE(1, 4); dir[6] = 0; dir[7] = 0; dir.writeUInt16LE(1, 10); dir.writeUInt16LE(32, 12); dir.writeUInt32LE(png.length, 14); dir.writeUInt32LE(22, 18);
fs.mkdirSync('tray/icons', { recursive: true });
fs.writeFileSync('tray/icons/icon.ico', Buffer.concat([dir, png]));
console.log('wrote tray/icons/icon.ico', png.length, 'bytes of PNG');
