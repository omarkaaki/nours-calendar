// Dependency-free PNG icon generator. Run: node tools/gen-icons.mjs
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

const T = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  T[n] = c;
}
const crc32 = (b) => {
  let c = 0xffffffff;
  for (const byte of b) c = T[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
function encodePng(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const hex = (s) => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];

class Canvas {
  constructor(size) { this.n = size; this.buf = Buffer.alloc(size * size * 4); }
  px(x, y, [r, g, b], a) {
    if (a <= 0 || x < 0 || y < 0 || x >= this.n || y >= this.n) return;
    const i = (y * this.n + x) * 4, d = this.buf;
    const sa = Math.min(1, a), da = d[i + 3] / 255, oa = sa + da * (1 - sa);
    if (oa === 0) return;
    d[i]     = Math.round((r * sa + d[i]     * da * (1 - sa)) / oa);
    d[i + 1] = Math.round((g * sa + d[i + 1] * da * (1 - sa)) / oa);
    d[i + 2] = Math.round((b * sa + d[i + 2] * da * (1 - sa)) / oa);
    d[i + 3] = Math.round(oa * 255);
  }
  // signed distance rounded-rect fill with 1px antialiasing
  roundRect(x, y, w, h, r, color) {
    const c = hex(color);
    const x0 = Math.floor(x) - 2, y0 = Math.floor(y) - 2;
    const x1 = Math.ceil(x + w) + 2, y1 = Math.ceil(y + h) + 2;
    for (let py = y0; py < y1; py++) {
      for (let px = x0; px < x1; px++) {
        const cx = px + 0.5, cy = py + 0.5;
        const dx = Math.max(x + r - cx, 0, cx - (x + w - r));
        const dy = Math.max(y + r - cy, 0, cy - (y + h - r));
        const d = Math.hypot(dx, dy) - r;
        this.px(px, py, c, Math.min(1, Math.max(0, 0.5 - d)));
      }
    }
  }
  circle(cx, cy, r, color) { this.roundRect(cx - r, cy - r, r * 2, r * 2, r, color); }
}

const TEAL = "#7c3aed", DEEP = "#6025d0", WHITE = "#ffffff", AMBER = "#f59e0b", SLATE = "#a99fc4";

function draw(size, maskable) {
  const c = new Canvas(size);
  const s = size / 100;              // 1 unit = 1% of the icon
  const pad = maskable ? 14 : 0;     // maskable icons keep art inside the safe zone

  c.roundRect(0, 0, size, size, maskable ? 0 : size * 0.22, TEAL);

  const bx = (10 + pad * 0.6) * s, bw = size - bx * 2;
  const by = (24 + pad * 0.5) * s, bh = size - by - (12 + pad * 0.5) * s;

  // hanger rings
  const ringY = by - 6 * s;
  c.roundRect(bx + bw * 0.24, ringY, 6 * s, 13 * s, 3 * s, DEEP);
  c.roundRect(bx + bw * 0.70, ringY, 6 * s, 13 * s, 3 * s, DEEP);

  // body + header strip
  c.roundRect(bx, by, bw, bh, 9 * s, WHITE);
  c.roundRect(bx, by, bw, 15 * s, 9 * s, DEEP);
  c.roundRect(bx, by + 8 * s, bw, 7 * s, 0, DEEP);

  // day dots: 4 x 3 grid, one highlighted
  const gx = bx + bw * 0.145, gy = by + 15 * s + bh * 0.20;
  const stepX = (bw * 0.71) / 3, stepY = (bh * 0.46) / 2, r = 4.1 * s;
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 4; col++) {
      const on = row === 1 && col === 2;
      c.circle(gx + col * stepX, gy + row * stepY, on ? r * 1.5 : r, on ? AMBER : SLATE);
    }
  }
  return encodePng(size, size, c.buf);
}

writeFileSync("icons/icon-192.png", draw(192, false));
writeFileSync("icons/icon-512.png", draw(512, false));
writeFileSync("icons/apple-touch-icon.png", draw(180, false));
writeFileSync("icons/icon-maskable-512.png", draw(512, true));
console.log("icons written");
