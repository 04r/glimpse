'use strict';
// Draws the app icon in code (violet rounded square with a white lens) and encodes it as PNG.
const zlib = require('zlib');

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function encodePNG(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Graphite tile, yellow viewfinder corner brackets, focus dot in the middle (tally red while recording).
function sample(x, y, recording) {
  const r = 0.22, hs = 0.5;
  const qx = Math.abs(x - 0.5) - (hs - r), qy = Math.abs(y - 0.5) - (hs - r);
  const d = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
  if (d > 0) return null;
  const FOCUS = [255, 210, 63], TALLY = [255, 75, 62];
  // brackets: box from 0.2 to 0.8, arms 0.17 long, 0.075 thick
  const lo = 0.2, hi = 0.8, arm = 0.17, th = 0.075;
  const nearX = x >= lo && x <= lo + arm ? 'l' : x <= hi && x >= hi - arm ? 'r' : null;
  const nearY = y >= lo && y <= lo + arm ? 't' : y <= hi && y >= hi - arm ? 'b' : null;
  if (nearX && nearY) {
    const onV = nearX === 'l' ? x <= lo + th : x >= hi - th;
    const onH = nearY === 't' ? y <= lo + th : y >= hi - th;
    if (onV || onH) return FOCUS;
  }
  const dc = Math.hypot(x - 0.5, y - 0.5);
  if (dc < (recording ? 0.13 : 0.075)) return recording ? TALLY : FOCUS;
  const t = y;
  return [Math.round(38 - 10 * t), Math.round(43 - 11 * t), Math.round(52 - 13 * t)];
}

function iconPNG(size, recording = false) {
  const ss = 4;
  const out = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const c = sample((px + (sx + 0.5) / ss) / size, (py + (sy + 0.5) / ss) / size, recording);
          if (c) { r += c[0]; g += c[1]; b += c[2]; a++; }
        }
      }
      const i = (py * size + px) * 4;
      if (a) {
        out[i] = Math.round(r / a);
        out[i + 1] = Math.round(g / a);
        out[i + 2] = Math.round(b / a);
        out[i + 3] = Math.round((a / (ss * ss)) * 255);
      }
    }
  }
  return encodePNG(size, size, out);
}

module.exports = { iconPNG };
