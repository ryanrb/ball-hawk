/**
 * Generates icon-192.png and icon-512.png using only Node.js built-ins.
 * Design: dark navy background + white golf ball circle + green ring accent.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ── CRC-32 (required by PNG spec) ────────────────────────────────────────────
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const combined = Buffer.concat([typeBuf, data]);
  const crc = crc32(combined);
  const out = Buffer.alloc(4 + 4 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  typeBuf.copy(out, 4);
  data.copy(out, 8);
  out.writeUInt32BE(crc, 8 + data.length);
  return out;
}

// ── PNG builder ───────────────────────────────────────────────────────────────
function makePNG(size) {
  const cx = size / 2;
  const cy = size / 2;
  const ballR  = size * 0.34;
  const ringR  = size * 0.42;
  const ringW  = Math.max(2, size * 0.04);

  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4);
    row[0] = 0; // filter: None
    for (let x = 0; x < size; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const off = 1 + x * 4;

      if (dist <= ballR) {
        // White golf ball body with slight grey dimple tint
        const dimple = 0.85 + 0.15 * Math.cos((dx / ballR) * Math.PI * 4) *
                                     Math.cos((dy / ballR) * Math.PI * 4);
        const v = Math.round(230 * dimple + 25);
        row[off]     = v;
        row[off + 1] = v;
        row[off + 2] = v;
        row[off + 3] = 255;
      } else if (dist >= ringR - ringW && dist <= ringR + ringW) {
        // Green detection-ring accent
        const alpha = Math.round(255 * (1 - Math.abs(dist - ringR) / ringW));
        row[off]     = 0;
        row[off + 1] = 255;
        row[off + 2] = 136;
        row[off + 3] = alpha;
      } else {
        // Dark navy background
        row[off]     = 26;
        row[off + 1] = 26;
        row[off + 2] = 46;
        row[off + 3] = 255;
      }
    }
    rows.push(row);
  }

  const raw = Buffer.concat(rows);
  const compressed = zlib.deflateSync(raw, { level: 9 });

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8]  = 8; // bit depth
  ihdr[9]  = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', compressed), pngChunk('IEND', Buffer.alloc(0))]);
}

// ── Write files ───────────────────────────────────────────────────────────────
const outDir = path.join(__dirname, '..', 'public');
fs.mkdirSync(outDir, { recursive: true });

console.log('Generating icon-192.png…');
fs.writeFileSync(path.join(outDir, 'icon-192.png'), makePNG(192));

console.log('Generating icon-512.png…');
fs.writeFileSync(path.join(outDir, 'icon-512.png'), makePNG(512));

console.log('Done.');
