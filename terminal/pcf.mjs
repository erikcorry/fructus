// pcf.mjs - the glyphs of an X11 PCF font, as gen-font.mjs needs them.
//
//   import { readPcf } from './pcf.mjs';
//   const font = readPcf('/usr/share/fonts/X11/misc/9x15.pcf.gz');
//   font.glyph(0x41) -> { width, ascent, descent, left, rows } or undefined
//
// rows are the glyph's bitmap from its top line, ascent lines above the
// baseline and descent below; bit (width - 1 - x) of a row is column x of
// the character cell, the cell's left edge at x = 0.  Only what fixed-width
// misc fonts use is read: metrics, bitmaps and the encodings, the formats
// documented in X.Org's libXfont (src/bitmap/pcfread.c).

import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

const METRICS = 1 << 2, BITMAPS = 1 << 3, ENCODINGS = 1 << 5;

export function readPcf(path) {
  let data = readFileSync(path);
  if (path.endsWith('.gz')) data = gunzipSync(data);
  if (data.toString('latin1', 0, 4) !== '\x01fcp') throw new Error(`${path}: not a PCF file`);
  const tables = new Map();
  for (let i = 0, n = data.readUInt32LE(4); i < n; i++) {
    const at = 8 + 16 * i;
    tables.set(data.readUInt32LE(at), { format: data.readUInt32LE(at + 4), offset: data.readUInt32LE(at + 12) });
  }

  // Each table starts with its format, little-endian; bit 2 says the rest
  // is big-endian.
  function table(type) {
    const { offset } = tables.get(type);
    const format = data.readUInt32LE(offset);
    const big = format & 4;
    let at = offset + 4;
    const r = {
      format,
      i32: () => { const v = big ? data.readInt32BE(at) : data.readInt32LE(at); at += 4; return v; },
      i16: () => { const v = big ? data.readInt16BE(at) : data.readInt16LE(at); at += 2; return v; },
      u16: () => { const v = big ? data.readUInt16BE(at) : data.readUInt16LE(at); at += 2; return v; },
      u8: () => data[at++],
      at: () => at,
    };
    return r;
  }

  const m = table(METRICS);
  const metrics = [];
  if (m.format & 0x100) {
    for (let i = 0, n = m.i16(); i < n; i++) {
      const [left, right, width, ascent, descent] = [0, 0, 0, 0, 0].map(() => m.u8() - 0x80);
      metrics.push({ left, right, width, ascent, descent });
    }
  } else {
    for (let i = 0, n = m.i32(); i < n; i++) {
      const [left, right, width, ascent, descent] = [0, 0, 0, 0, 0].map(() => m.i16());
      m.i16();
      metrics.push({ left, right, width, ascent, descent });
    }
  }

  const b = table(BITMAPS);
  const count = b.i32();
  const offsets = Array.from({ length: count }, () => b.i32());
  for (let i = 0; i < 4; i++) b.i32();
  const base = b.at();
  const pad = 1 << (b.format & 3), msbBit = b.format & 8, msbByte = b.format & 4;
  const unit = 1 << ((b.format >> 4) & 3);

  const e = table(ENCODINGS);
  const [min2, max2, min1, max1] = [e.i16(), e.i16(), e.i16(), e.i16()];
  e.i16();
  const index = new Map();
  for (let b1 = min1; b1 <= max1; b1++)
    for (let b2 = min2; b2 <= max2; b2++) {
      const g = e.u16();
      if (g !== 0xffff) index.set(b1 << 8 | b2, g);
    }

  function bit(byteAt, x) {
    // A scan unit's bytes in the file's order, then the bit in the byte.
    const u = Math.floor(x / (8 * unit)), inUnit = x % (8 * unit);
    let byte = Math.floor(inUnit / 8);
    if (!msbByte) byte = unit - 1 - byte;    // LSB first: the unit's bytes reversed
    const v = data[byteAt + u * unit + byte];
    const k = inUnit % 8;
    return (msbBit ? v >> (7 - k) : v >> k) & 1;
  }

  return {
    glyph(code) {
      const g = index.get(code);
      if (g === undefined) return undefined;
      const { left, right, width, ascent, descent } = metrics[g];
      const w = right - left, stride = Math.ceil(w / (8 * pad)) * pad;
      const rows = [];
      for (let y = 0; y < ascent + descent; y++) {
        let row = 0;
        for (let x = 0; x < w; x++)
          if (bit(base + offsets[g] + y * stride, x)) row |= 1 << (width - 1 - (left + x));
        rows.push(row);
      }
      return { width, ascent, descent, rows };
    },
    codes: () => [...index.keys()],
  };
}
