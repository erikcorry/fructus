// =============================================================================
// display.js - what the display shows, a pixel at a time
// =============================================================================
//
// The reference for rtl/video/: docs/vga.md, written as functions of the
// frame buffer, the palette, the font register and the sprites.  Two users:
//
//   - tests/video-check.mjs compares the RTL's pins with pins() for every
//     cycle of a frame, so this file is checked against the hardware;
//   - tools/gpu.js renders whole frames with frame() for the simulator, so
//     what a program shows in the simulator is what the hardware shows.
//
// IT IS NOT CYCLE BY CYCLE.  Each line is drawn from the state the caller
// gives it: a change the hardware would show from the middle of a line - a
// palette write, a sprite attribute after its slot - is either all on the
// line or all off it, as the caller decides.
//
// THE STATE, `st`:
//
//     word(i)     the frame buffer's 16-bit word i, 0 .. 0x3fff
//     font        the font register; its bit 15 is ignored
//     palette     32 bytes in the 8-bit pixel format
//     sprites     for line n: sprites(n), sixteen of { x, y, dh, p, c }, as
//                 decodeSprites() makes them; or null for none
//     patterns    1024 words, sixteen patterns of 64
// =============================================================================

// Background depth codes: bits per pixel and the palette prefix they OR into.
export const DEPTH = [[1, 0x1c], [1, 0x1e], [2, 0x18], [2, 0x08], [3, 0x10], [4, 0x00], [8, 0], [8, 0]];

const byteOf = (st, a) => (st.word((a & 0x7fff) >> 1) >> ((a & 1) * 8)) & 0xff;

// Line n's four table entries: the top 4 KB of the buffer, word arrays of
// 512 entries at 0x7000 (character codes), 0x7400 (foreground colours),
// 0x7800 (background pixels) and 0x7c00 (the mode word).
export const lineTable = (st, n) => ({
  ch: st.word((0x3800 + n) & 0x3fff), co: st.word((0x3a00 + n) & 0x3fff),
  bg: st.word((0x3c00 + n) & 0x3fff), mode: st.word((0x3e00 + n) & 0x3fff),
});

// The background byte at column x: a low depth's pixel ORed into its palette
// prefix, or 8 bpp's byte itself.  docs/vga.md, "Background" and "Unpacking".
export const bgPixel = (st, t, x) => {
  const [bpp, base] = DEPTH[(t.mode >> 8) & 7];
  const p = Math.floor(x / (((t.mode >> 11) & 7) + 1));
  let v;
  if (bpp === 3) {
    const w = st.word(((t.bg & 0x7fff) >> 1) + Math.floor(p / 5) & 0x3fff);
    v = (w >> ((p % 5) * 3)) & 7;
  } else {
    const bit = (t.bg & 0x7fff) * 8 + p * bpp;
    v = (st.word((bit >> 4) & 0x3fff) >> (bit & 15)) & ((1 << bpp) - 1);
  }
  return bpp === 8 ? v : base | v;
};

// The text generator at column x: whether the glyph's bit is set, and the
// cell's foreground byte.  docs/vga.md, "Fonts" and "Text generator".
export const fgPixel = (st, t, x) => {
  const wide = (t.mode >> 14) & 1, off = t.mode >> 15;
  const cell = wide ? x >> 4 : x >> 3;
  const bit = wide ? x & 15 : x & 7;
  const base = st.font + ((t.mode & 0xff) << (wide ? 7 : 6)), code = byteOf(st, t.ch + cell);
  const row = wide ? byteOf(st, base + 2 * code) | byteOf(st, base + 2 * code + 1) << 8
                   : byteOf(st, base + code) << 8;
  return { on: !off && (row >> (15 - bit)) & 1, color: byteOf(st, t.co + cell) };
};

// The sixteen sprites' attribute words, 4 per sprite, as objects.
export const decodeSprites = (attrs) => Array.from({ length: 16 }, (_, s) => {
  const w0 = attrs[4 * s], w2 = attrs[4 * s + 2];
  return { x: w0 & 0x3ff, dh: (w0 >> 10) & 1, p: (w0 >> 11) & 15, y: attrs[4 * s + 1] & 0x3ff,
           c: [w2 & 15, (w2 >> 4) & 15, (w2 >> 8) & 15] };
});

// The sprites' palette index at (x, n): the lowest-numbered sprite with a
// colour that is not 0 there, or 0.  Positions wrap round the 1024-pixel line
// buffer.  docs/vga.md, "Sprites".
export const spritePixel = (st, set, n, x) => {
  for (const a of set) {
    const dy = n + 42 - a.y;
    if (dy < 0 || dy >= (a.dh ? 42 : 21)) continue;
    const row = a.dh ? dy >> 1 : dy;
    const dx = (x + 48 - a.x) & 1023;
    if (dx >= 24) continue;
    const v = (st.patterns[a.p * 64 + row * 3 + (dx >> 3)] >> ((dx & 7) * 2)) & 3;
    if (v && a.c[v - 1]) return a.c[v - 1];
  }
  return 0;
};

// The byte in the 8-bit pixel format that reaches the decoder at (x, n), after
// the palette: sprite, then glyph, then background.
export const pixel = (st, t, set, n, x) => {
  const cp = set ? spritePixel(st, set, n, x) : 0;
  let sel = cp;
  if (!cp) { const fg = fgPixel(st, t, x); sel = fg.on ? fg.color : bgPixel(st, t, x); }
  return sel >> 5 ? sel : st.palette[sel & 31];
};

// A pixel byte's red (0-5), green (0-6) and blue (0-4) levels, or null for the
// codes that show black: a palette entry with t = 000, and c[3:0] = 1111.
export const levels = (px) => {
  const top = px >> 5, c = px & 15;
  if (top === 0 || c === 15) return null;
  return [Math.floor(c / 5) + 3 * ((px >> 4) & 1), top - 1, c % 5];
};

// The nine DAC pins, red [8:6], green [5:3], blue [2:0], as the RTL drives
// them.  docs/vga.md, "Pin encodings".
const G = [0b000, 0b001, 0b010, 0b100, 0b101, 0b110, 0b111];
const R = [0b000, 0b001, 0b010, 0b011, 0b110, 0b111];
const B = [0b000, 0b001, 0b100, 0b101, 0b111];
export const pins = (px) => {
  const l = levels(px);
  return l ? R[l[0]] << 6 | G[l[1]] << 3 | B[l[2]] : 0;
};

// The DAC levels are evenly spaced up to 0.7 V, which a monitor shows as an
// sRGB code in proportion.
const RGB = Array.from({ length: 256 }, (_, px) => {
  const l = levels(px);
  return l ? [Math.round(l[0] * 255 / 5), Math.round(l[1] * 255 / 6), Math.round(l[2] * 255 / 4)] : [0, 0, 0];
});

// A whole frame, `width` x `height`, as packed RGB bytes, from the first
// visible line.  `sprites(n)` may be a constant function.
export const frame = (st, width, height) => {
  const rgb = new Uint8Array(width * height * 3);
  for (let n = 0; n < height; n++) {
    const t = lineTable(st, n), set = st.sprites ? st.sprites(n) : null;
    for (let x = 0, o = n * width * 3; x < width; x++, o += 3) {
      const c = RGB[pixel(st, t, set, n, x)];
      rgb[o] = c[0]; rgb[o + 1] = c[1]; rgb[o + 2] = c[2];
    }
  }
  return { width, height, rgb };
};
