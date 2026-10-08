// =============================================================================
// png.js - an RGB pixmap as a PNG file, with nothing but node's zlib
// =============================================================================
//
//   writeFileSync('f.png', png({ width, height, rgb }));
//
// 8-bit truecolour, no alpha, every row with filter 0: the frames are small
// and mostly flat colour, which deflate takes care of on its own.
// =============================================================================

import { deflateSync } from 'node:zlib';

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const chunk = (type, data) => {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
};

export const png = ({ width, height, rgb }) => {
  const head = Buffer.alloc(13);
  head.writeUInt32BE(width, 0);
  head.writeUInt32BE(height, 4);
  head[8] = 8;          // bits per channel
  head[9] = 2;          // truecolour
  const raw = Buffer.alloc(height * (1 + 3 * width));
  for (let y = 0; y < height; y++)
    raw.set(rgb.subarray(y * width * 3, (y + 1) * width * 3), y * (1 + 3 * width) + 1);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', head), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
};
