#!/usr/bin/env node
// =============================================================================
// gen-font.mjs - the teletext font, 16x19 cells, from bedstead's SAA5050 glyphs
// =============================================================================
//
//   node teletext/gen-font.mjs [bedstead.c] > teletext/font.cc
//   node teletext/gen-font.mjs [bedstead.c] --text 'AgeWy&'
//
// bedstead.c defaults to ~/github/bedstead/bedstead.c.  Its glyph table is the
// SAA5050 family's 5x9 dot matrices, CC0 (the typeface's copyright is not
// infringed by use, CDPA 1988 s55; see its header), and so is what this makes.
//
// THE SAA5050'S OWN ROUNDING, then a map onto the cell.  Each dot becomes 2x2
// subpixels, and every 2x2 clump of dots holding a lone diagonal gets the two
// subpixels in its inner corners - the chip's rule, as bedstead's header draws
// it - giving 10x18 subpixels in a 12x20 cell.  Rows are taken whole: the
// glyph is lines 1-18 and line 0 is blank, so a descender ends one line above
// the next row's capitals.  The chip's blank dot row was at the bottom; at
// the top, capitals and ascenders, which are commoner than descenders, stand
// clear of the edge of a coloured background.  Columns
// go 10 subpixels to 14 pixels, the dots 3,3,2,3,3 wide - symmetric, so the
// stems of A, M and W match - with a blank column each side.  A narrow glyph,
// one that leaves an edge column of dots empty, moves the 2 there: 3,3,3,3,2
// or 2,3,3,3,3, so the middle stroke of l, i, 1 or ! is 3 wide and not 2.
// 25 rows of 19 lines are 475, inside 480.
//
// THE FONT IS ROW-MAJOR, 256 GLYPHS TO A ROW (docs/vga.md, "Fonts"): a row is
// 512 bytes, 4 of font_line's 128-byte steps, and font row r is at F + 512 r.
// 384-byte rows of 192 glyphs would be smaller, 14,592 bytes against 19,456,
// but leave no code spare - 0-31 and 224-255 would be the neighbouring rows'
// glyphs.  Font rows 0-18 are what an upper text row shows and 19-37 a lower
// one; font_line = 4 r for the r-th, as the line table says.
//
//     0x20 - 0x7f   the English (SAA5050) set, the same in rows 0-18 and 19-37
//     0x80 - 0xdf   the same, double height: the top half in 0-18, the bottom
//                   in 19-37, each line twice - line 9 once in each
//     0xe0          the separated mosaics' grid: drawn in the cell's
//                   background colour over the background layer's blocks, the
//                   gap bedstead's domosaic leaves at each block's left and
//                   bottom, 2 pixels and 2 lines
//     0xe1          the grid, double height
//
// The rest are blank.  Mosaic blocks are rows of 6, 7 and 6 lines and columns
// of 8 pixels, the background's pixels at width 8: the SAA5050's 3, 4 and 3
// dots.  A glyph row is a 16-bit word, bit 15 the leftmost pixel.
// =============================================================================

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

const args = process.argv.slice(2);
const textAt = args.indexOf('--text');
const text = textAt >= 0 ? args.splice(textAt, 2)[1] : null;
const source = args[0] ?? `${homedir()}/github/bedstead/bedstead.c`;

const W = 16, H = 19, GLYPH_LINES = 18, ROWS = 2 * H, CODES = 256;
const GRID = 0xe0, GRID_DH = 0xe1;

// --- bedstead's table: {{octal rows}, 0xUUUU or U(UUUU), ...} -----------------
// The first entry for a code point is the one used: the SAA5055's ASCII come
// first, and the English set's extras follow them.
const glyphs = new Map();
for (const m of readFileSync(source, 'utf8').matchAll(
       /\{\{([0-7,\s]*)\},\s*(?:0x([0-9a-fA-F]+)|U\(([0-9a-fA-F]+)\))/g)) {
  const rows = m[1].split(',').map((v) => v.trim()).filter(Boolean).map((v) => parseInt(v, 8));
  if (rows.length > 9) throw new Error(`a glyph of ${rows.length} rows, not 9`);
  const u = parseInt(m[2] ?? m[3], 16);
  if (!glyphs.has(u)) glyphs.set(u, rows.concat(Array(10 - rows.length).fill(0)));
}

// The English set: ASCII but for these (bedstead's NOTES, "English").
const ENGLISH = {
  0x23: 0x00a3, 0x27: 0x0027, 0x5b: 0x2190, 0x5c: 0x00bd, 0x5d: 0x2192, 0x5e: 0x2191,
  0x5f: 0x0023, 0x60: 0x2014, 0x7b: 0x00bc, 0x7c: 0x2016, 0x7d: 0x00be, 0x7e: 0x00f7,
  0x7f: 0x25a0,
};

// --- one glyph to a 16x19 cell, an array of 19 row words ----------------------
function rounded(rows) {
  // bedstead's 6x10 cell: the gap is column 0, and row 9 is always empty.
  const px = (x, y) => x >= 0 && x < 6 && y >= 0 && y < 10 && (rows[y] >> (5 - x)) & 1;
  const s = Array.from({ length: 20 }, () => Array(12).fill(0));
  for (let y = 0; y < 10; y++)
    for (let x = 0; x < 6; x++) {
      if (px(x, y)) for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) s[2 * y + dy][2 * x + dx] = 1;
      const a = px(x, y), b = px(x + 1, y), c = px(x, y + 1), d = px(x + 1, y + 1);
      if (a && d && !b && !c) s[2 * y + 1][2 * x + 2] = s[2 * y + 2][2 * x + 1] = 1;
      if (b && c && !a && !d) s[2 * y + 1][2 * x + 1] = s[2 * y + 2][2 * x + 2] = 1;
    }
  return s;
}

// The subpixel column each of pixels 1-14 shows, for each place of the
// narrow dot: dots 1-5 are subpixels 2-11.  A 3-pixel dot left of the middle
// shows its first subpixel once and its second twice, right of it the other
// way, so that the left-right mirror of a glyph is drawn mirrored.
const XMAP = {
  middle: [0, 1, 1, 2, 3, 3, 4, 5, 6, 6, 7, 8, 8, 9],
  right: [0, 1, 1, 2, 3, 3, 4, 5, 5, 6, 7, 7, 8, 9],
  left: [0, 1, 2, 2, 3, 4, 4, 5, 6, 6, 7, 8, 8, 9],
};
for (const k in XMAP) XMAP[k] = XMAP[k].map((c) => c + 2);

// Where a glyph's narrow dot goes: an edge column it never lights, the right
// one first, or the middle.  Dot columns 0-4 are bits 4-0 of a row.
function narrow(rows) {
  const used = rows.reduce((a, r) => a | r, 0);
  return !(used & 0x01) ? 'right' : !(used & 0x10) ? 'left' : 'middle';
}

function cell(rows) {
  const s = rounded(rows), map = XMAP[narrow(rows)];
  const out = Array(H).fill(0);
  for (let y = 0; y < GLYPH_LINES; y++)
    map.forEach((sx, i) => { if (s[y][sx]) out[1 + y] |= 0x8000 >> (1 + i); });
  return out;
}

function grid() {
  const out = Array(H).fill(0);
  for (let y = 0; y < H; y++)
    out[y] = [4, 5, 11, 12, 17, 18].includes(y) ? 0xffff : 0xc0c0;
  return out;
}

// --- the font: ROWS x CODES words ---------------------------------------------
const font = Array.from({ length: ROWS }, () => Array(CODES).fill(0));
const single = (code, c) => { for (let r = 0; r < ROWS; r++) font[r][code] = c[r % H]; };
const double = (code, c) => { for (let r = 0; r < ROWS; r++) font[r][code] = c[r >> 1]; };

const cells = new Map();
for (let code = 0x20; code < 0x80; code++) {
  const u = ENGLISH[code] ?? code;
  if (!glyphs.has(u)) throw new Error(`no glyph for U+${u.toString(16)} at 0x${code.toString(16)}`);
  const c = cell(glyphs.get(u));
  cells.set(code, c);
  single(code, c);
  double(code + 0x60, c);
}
single(GRID, grid());
double(GRID_DH, grid());

// --- out ----------------------------------------------------------------------
if (text !== null) {
  // Each character's cell, single height, then the whole font row by row for
  // the first one double height, as an upper and a lower text row show it.
  const codes = [...text].map((ch) => ch.charCodeAt(0));
  const line = (words) => words.map((w) => [...Array(W)].map((_, x) => (w & (0x8000 >> x) ? '#' : '.')).join('')).join('');
  for (let r = 0; r < H; r++) console.log(`${String(r).padStart(2)} ${line(codes.map((c) => font[r][c]))}`);
  console.log();
  for (let r = 0; r < ROWS; r++) console.log(`${String(r).padStart(2)} ${line(codes.map((c) => font[r][c + 0x60]))}`);
  process.exit(0);
}

const hex = (v) => `0x${v.toString(16).padStart(4, '0')}`;
const body = [];
for (let r = 0; r < ROWS; r++) {
  body.push(`  /* font row ${r} */`);
  for (let c = 0; c < CODES; c += 8) body.push(`  ${font[r].slice(c, c + 8).map(hex).join(', ')},`);
}
process.stdout.write(`// Generated by teletext/gen-font.mjs from bedstead's SAA5050 glyphs
// (CC0); do not edit.  ${ROWS} font rows of ${CODES} glyphs, 16x${H} cells: see the
// generator for the layout.  In .font, which ld/fructus-writethru.ld puts at
// __font, the address the display reads it at.
#include <stdint.h>

extern const uint16_t teletext_font[${ROWS} * ${CODES}];
__attribute__((section(".font"))) const uint16_t teletext_font[${ROWS} * ${CODES}] = {
${body.join('\n')}
};
`);
