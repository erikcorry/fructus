#!/usr/bin/env node
// =============================================================================
// gen-font.mjs - the terminal's 8x17 font, cut into zones, from X11's 9x15
// =============================================================================
//
//   node terminal/gen-font.mjs [9x15.pcf.gz] > terminal/font.cc
//   node terminal/gen-font.mjs [9x15.pcf.gz] --sheet build/font.png [--text file]
//   node terminal/gen-font.mjs [9x15.pcf.gz] --rules
//
// The font defaults to /usr/share/fonts/X11/misc/9x15.pcf.gz, xfonts-base's
// misc-fixed: public domain.  --sheet draws every base, then the accented
// letters, as the terminal will show them, three times size.
//
// THE CELL is 8 pixels by 17 lines (ideas/vt100.md), 28 rows of text in 476
// of the 480 lines:
//
//     0- 2   accents over capitals and ascenders
//     3- 5   capitals and ascenders above the x-height, and the accents over
//            small letters: the riser
//     6-12   the x-height; the baseline is under line 12
//    13-15   descenders, and the accents below: cedilla, ogonek, comma.
//            Line 14 is the underline's, a line's gap under the baseline
//    16      blank but for box drawing and blocks
//
// 9x15's row r is line r + 1: its 12 rows above the baseline are lines 1-12,
// capitals 3-12 and the x-height 6-12, and its 3 below are 13-15.  Its
// glyphs are 9 wide with a blank column each side, and the right one goes;
// where the right one has ink and the left none the glyph moves left, and
// where both have ink a column the same as the one beside it goes, the
// middlemost - an arrow's shaft - or failing that the right one (the
// generator lists those).
//
// FIVE ZONES.  The display reads each line's character codes from its line
// table's pointer, so each zone has an array of 80 codes a text row and its
// own 256 codes: a code in one zone means nothing in another.
//
//     EDGE      lines 0-2 and 13-16, above the capitals and below the baseline
//     RISER     lines 3-5
//     X_TOP     lines 6-7, the top of the x-height
//     X_MIDDLE  lines 8-9
//     X_BOTTOM  lines 10-12, down to the baseline
//
// A zone needs a code for each different slice of the glyphs over its
// lines, not one for each glyph.  The x-height is where glyphs differ most:
// as one zone of 7 lines it ran out at 256, but parts are shared - the tops
// of a c e o s, the bottoms of a d q.  In two, 6-8 and 9-12, it ran out
// again with Greek and Cyrillic; in three it has room.  RISER and EDGE are
// mostly blank, box drawing's strokes and accents.  EDGE's two parts never both hold an
// accent, since a cell has one mark.
//
// UNDERLINE IS IN THE FONT, on line 14, in the text's colour: an underlined
// cell shows UNDERLINED[code] in EDGE for its code.  The line is cut from a
// pixel left of the glyph's leftmost ink below the baseline, lines 13-15, to
// a pixel right of its rightmost, so a descender crosses it with a gap each
// side and the hollow of a hook - g's, j's, y's - is left clear too.  At most
// it doubles EDGE's codes.
//
// THE FONT is the display's 8-pixel font, 256 glyphs a font row, one font
// row per line of the cell: font_line = 4 x line.  Font row L, code k, is
// line L of the slice that code k stands for in line L's zone.  4,352 bytes.
//
// BASES are what a cell holds: 256 of them, a byte.  0x20-0x7e are ASCII but
// for 0x69, which is a dotless ı - the terminal keeps i as ı and a dot above,
// so an accent can take the dot's place.  The rest are REPERTOIRE's, in the
// codes left, 0x00-0x1f and 0x7f-0xff, in order.
//
// THE SECOND SET is more bases, which take no accent: a cell whose mark is
// SECOND, 0x7f - past the 112 marks there are - has a base from it, so a
// base is 9 bits in all, 10 with the third set below.  SECOND_REPERTOIRE is in order of use, mostly
// Markus Kuhn's SECS; as many go in as every zone has room for, and the
// generator lists any left out.
//
// THE THIRD SET is the same again, under the mark THIRD, 0x7d: Hebrew, its
// 27 letters with the final forms, geresh and gershayim, the maqaf and ₪.
// Their points and cantillation are zero width in terminal.cc, dropped.  And
// letters that take no accent, which would fill the first two sets' last
// codes: Catalan's ŀ Ŀ, the long ſ, and Mohawk's ʌ Ʌ.
//
// ACCENTS are 9x15's spacing ones, ´ ` ˆ and so on, never its precomposed
// letters, whose capitals are squashed to make room.  An accent above goes in
// the riser if the base leaves it blank, a small letter, and above the
// capitals otherwise; one below goes under the baseline, or for a cedilla
// under a letter with a descender, ģ, as a turned comma in the riser.  The
// zone it goes in is blank but for it, so it has one code whatever the
// letter: MARK_GLYPH.  The pairs where the letter has ink in that zone get a
// code of their own, an OVERRIDE; and Ľ ľ ť's caron is an apostrophe beside
// the stem.  Latvian's cedilla, under Ģ Ķ Ļ Ņ Ŗ and ķ ļ ņ ŗ, is a comma below,
// as Latvian type has it.  ď is a base of its own: its stem is at the right
// edge, so the whole letter moves a column left.  See font.h for the rule as C.
//
// BIDI CLASSES, for terminal/bidi.cc: each base's Unicode bidirectional
// class, of the ones a row of our bases can have.  JavaScript's regular
// expressions know no Bidi_Class, so bidiClass() says which from scripts,
// categories and lists, for what the repertoires hold.  MIRRORS are the
// pairs a right-to-left run shows as each other, ( as ), all Bidi_Mirrored;
// BOX_MIRRORS box drawing's, for the private mode 2500.
// =============================================================================

import { readFileSync, writeFileSync } from 'node:fs';
import { readPcf } from './pcf.mjs';
import { png } from '../tools/png.js';

const args = process.argv.slice(2);
const sheetAt = args.indexOf('--sheet');
const sheet = sheetAt >= 0 ? args.splice(sheetAt, 2)[1] : null;
const rulesAt = args.indexOf('--rules');
const rules = rulesAt >= 0 && args.splice(rulesAt, 1);
const textAt = args.indexOf('--text');
const text = textAt >= 0 ? args.splice(textAt, 2)[1] : null;
const source = readPcf(args[0] ?? '/usr/share/fonts/X11/misc/9x15.pcf.gz');

const W = 8, H = 17;
const ZONES = [
  { name: 'EDGE', lines: [0, 1, 2, 13, 14, 15, 16] },
  { name: 'RISER', lines: [3, 4, 5] },
  { name: 'X_TOP', lines: [6, 7] },
  { name: 'X_MIDDLE', lines: [8, 9] },
  { name: 'X_BOTTOM', lines: [10, 11, 12] },
];
const EDGE = 0, RISER = 1;
const SECOND = 0x7f;           // the mark of a base from the second set
const TONOS = 0x7e;            // Greek capitals' accent, font.h says how
const THIRD = 0x7d;            // the mark of a base from the third set
const zoneOf = Array(H);
ZONES.forEach((z, i) => z.lines.forEach((l) => { zoneOf[l] = i; }));

const REPERTOIRE = [
  // Latin-1 that is not a letter and a mark.
  '¡¢£¤¥¦§©ª«¬®°±²³µ¶·¸¹º»¼½¾¿ÆÐ×ØÞßæð÷øþ',
  // Latin Extended-A's letters of their own, ď, the dotted i for į, and ȷ.
  'ĐđĦħĲĳŁłŊŋŒœŦŧďiȷ',
  '€ẞ‘’‚“”„‹›•…–—←↑→↓≤≥≠π◆�',
  // Box drawing: light and heavy, double, rounded.
  '─━│┃┌┏┐┓└┗┘┛├┣┤┫┬┳┴┻┼╋',
  '═║╒╓╔╕╖╗╘╙╚╛╜╝╞╟╠╡╢╣╤╥╦╧╨╩╪╫╬',
  '╭╮╯╰',
  // Blocks: halves, shades, quadrants, eighths from below.
  '█▀▄▌▐░▒▓▖▗▘▙▚▛▜▝▞▟▁▂▃▅▆▇',
].join('');

const SECOND_REPERTOIRE = [
  '✓✗■□▲▼►◄○↔↕⇐⇒⇔',                 // marks and status
  '™†‡‰′″№',                          // typography
  '∞√≈≡∑∂∫∀∃∈∅∧∨∩∪⌈⌉⌊⌋',               // maths
  'ĸƏəƒ',                             // letters: Greenlandic, Azerbaijani, florin
  '△‴ⁿ⁰₀₁₂₃∏∇∆⇑⇓⇕⊂⊃☐☑☒♪☺ℕℤℝℚℂ↤↥↦↧',
  // The rest of SECS.
  '‗₧∁∄∉∋∌∓∘∝∟∡∤∥∦∮≃≅≉≙≟≢≪≫⊄⊅⊆⊇⊈⊉⊊⊋⊕⊗⊤⊥⊦⊧⋂⋃⌀⌐⌕⌠⌡☻☼♀♂♫♭♮♯',
  // Claude Code's: its bullets, the result's corner, the prompt, plan mode's
  // pause, warnings, and the IDE's selection.
  '●⎿❯⏸⚠⧉',
  // Greek and Cyrillic that look like no Latin letter (gen-decompose.mjs's
  // LOOKALIKES are the rest), the accented ones whole.
  'ΓΔΘΛΞΠΣΦΨΩΏαβγδεζηθικλξρςστυφχψωάέήίύώϊϋΐΰϑϕϖϱ',
  'ЂЃЄЉЊЋЎЏБГДЖЗИЙЛПУФЦЧШЩЪЫЬЭЮЯҐЍбвгджзийклмнптфцчшщъыьэюяђѓєљњћќџґѝ',
  // Skolt Sámi's: ezh, and with a caron, and the g with a stroke.
  'ƷǮʒǯǤǥ',
].join('');

const THIRD_REPERTOIRE = [
  'אבגדהוזחטיךכלםמןנסעףפץצקרשת',
  '׳״־₪',
  'ŀĿſʌɅ',
].join('');

// Characters drawn as a base that is another's, of either set: the same
// shape, or near enough.  base_of finds them after UNICODE; nothing maps a
// base back to them.  Groff's man pages use the hyphens, the minus and the
// spaces.
const ALIASES = {
  'ʼ': '’', 'ʽ': '‘', '―': '—', '‐': '-', '‑': '-', '−': '-', '∙': '·', '⋅': '·', '∼': '~',
  '\u2329': '‹', '\u232a': '›',   // 〈 〉, the technical ones
  '⋯': '…', 'ʹ': '′',   // Skolt Sámi's palatalisation mark
  'ʻ': '‘',              // Hawaiian's ʻokina
  'ә': 'ə', 'Ә': 'Ə',    // Tatar's and Bashkir's schwa, Azerbaijani's
  '⏺': '●', '⏵': '►', '✔': '✓', '✘': '✗',
  // Stars, as Claude Code's spinner turns through them with · between.
  '✢': '*', '✳': '*', '✶': '*', '✻': '*', '✽': '*',
  '\u2002': ' ', '\u2003': ' ', '\u2004': ' ', '\u2005': ' ', '\u2006': ' ', '\u2007': ' ',
  '\u2008': ' ', '\u2009': ' ', '\u200a': ' ',
};

// --- glyphs: 17 lines of 8 bits, bit 7 the left pixel ------------------------

const blank = () => Array(H).fill(0);
const moved = [], lost = [];

function x11(cp) {
  const g = source.glyph(cp);
  if (!g) throw new Error(`9x15 has no U+${cp.toString(16)}`);
  if (g.width !== 9 || g.ascent !== 12 || g.descent !== 3) throw new Error(`U+${cp.toString(16)} is not 9x15`);
  const right = g.rows.some((r) => r & 1), left = g.rows.some((r) => r & 0x100);
  const out = blank();
  if (right && left) {
    // Column x is bit 8 - x.  Drop x where it equals x + 1, nearest the middle.
    const column = (x) => g.rows.map((r) => (r >> (8 - x)) & 1).join('');
    const same = [3, 4, 2, 5, 1, 6, 0, 7].find((x) => column(x) === column(x + 1));
    if (same === undefined) lost.push(String.fromCodePoint(cp));
    const drop = same ?? 8;
    g.rows.forEach((r, y) => {
      const high = r >> (9 - drop) << (8 - drop), low = r & ((1 << (8 - drop)) - 1);
      out[y + 1] = high | low;
    });
    return out;
  }
  if (right) moved.push(String.fromCodePoint(cp));
  g.rows.forEach((r, y) => { out[y + 1] = (right ? r : r >> 1) & 0xff; });
  return out;
}

// Box drawing from its arms: up, down, left, right, each 0 none, 1 light,
// 2 heavy, 3 double.  The middle is column 4, line 8.  A heavy arm is 3
// wide and reaches one past the middle, so corners are solid.  A double arm
// is a heavy one with its middle line taken out from the edge in, which
// leaves its two lines; it reaches past the middle only to meet a double arm
// across it.  A light arm crosses a double one across it to its far line.
const CX = 4, CY = 8;
function box(up, down, left, right) {
  const px = Array.from({ length: H }, () => Array(W).fill(0));
  const set = (x, y, v = 1) => { if (x >= 0 && x < W && y >= 0 && y < H) px[y][x] = v; };
  const arms = [
    { w: up, vertical: true, from: 0, dir: 1 },
    { w: down, vertical: true, from: H - 1, dir: -1 },
    { w: left, vertical: false, from: 0, dir: 1 },
    { w: right, vertical: false, from: W - 1, dir: -1 },
  ];
  const centre = (a) => (a.vertical ? CY : CX);
  const across = (a) => arms.some((b) => b.vertical !== a.vertical && b.w === 3);
  const line = (a, offset, to, v = 1) => {
    for (let p = a.from; a.dir > 0 ? p <= to : p >= to; p += a.dir)
      a.vertical ? set(CX + offset, p, v) : set(p, CY + offset, v);
  };
  for (const a of arms) {
    if (a.w === 2) for (const o of [-1, 0, 1]) line(a, o, centre(a) + a.dir);
    if (a.w === 3) for (const o of [-1, 0, 1]) line(a, o, centre(a) + (across(a) ? a.dir : 0));
  }
  for (const a of arms) if (a.w === 3) line(a, 0, centre(a), 0);
  for (const a of arms) if (a.w === 1) line(a, 0, centre(a) + (across(a) ? a.dir : 0));
  return px.map((r) => r.reduce((v, b, x) => v | b << (7 - x), 0));
}

const ARMS = {
  '─': [0, 0, 1, 1], '━': [0, 0, 2, 2], '│': [1, 1, 0, 0], '┃': [2, 2, 0, 0],
  '┌': [0, 1, 0, 1], '┏': [0, 2, 0, 2], '┐': [0, 1, 1, 0], '┓': [0, 2, 2, 0],
  '└': [1, 0, 0, 1], '┗': [2, 0, 0, 2], '┘': [1, 0, 1, 0], '┛': [2, 0, 2, 0],
  '├': [1, 1, 0, 1], '┣': [2, 2, 0, 2], '┤': [1, 1, 1, 0], '┫': [2, 2, 2, 0],
  '┬': [0, 1, 1, 1], '┳': [0, 2, 2, 2], '┴': [1, 0, 1, 1], '┻': [2, 0, 2, 2],
  '┼': [1, 1, 1, 1], '╋': [2, 2, 2, 2],
  '═': [0, 0, 3, 3], '║': [3, 3, 0, 0], '╒': [0, 1, 0, 3], '╓': [0, 3, 0, 1],
  '╔': [0, 3, 0, 3], '╕': [0, 1, 3, 0], '╖': [0, 3, 1, 0], '╗': [0, 3, 3, 0],
  '╘': [1, 0, 0, 3], '╙': [3, 0, 0, 1], '╚': [3, 0, 0, 3], '╛': [1, 0, 3, 0],
  '╜': [3, 0, 1, 0], '╝': [3, 0, 3, 0], '╞': [1, 1, 0, 3], '╟': [3, 3, 0, 1],
  '╠': [3, 3, 0, 3], '╡': [1, 1, 3, 0], '╢': [3, 3, 1, 0], '╣': [3, 3, 3, 0],
  '╤': [0, 1, 3, 3], '╥': [0, 3, 1, 1], '╦': [0, 3, 3, 3], '╧': [1, 0, 3, 3],
  '╨': [3, 0, 1, 1], '╩': [3, 0, 3, 3], '╪': [1, 1, 3, 3], '╫': [3, 3, 1, 1],
  '╬': [3, 3, 3, 3],
};

// The rounded corners: a light corner whose elbow is a diagonal step.
function rounded(ch) {
  const g = blank();
  const [up, left] = { '╭': [0, 0], '╮': [0, 1], '╯': [1, 1], '╰': [1, 0] }[ch];
  for (let y = 0; y < H; y++) if (up ? y <= CY - 2 : y >= CY + 2) g[y] |= 0x80 >> CX;
  for (let x = 0; x < W; x++) if (left ? x <= CX - 2 : x >= CX + 2) g[CY] |= 0x80 >> x;
  g[CY + (up ? -1 : 1)] |= 0x80 >> (CX + (left ? -1 : 1));
  return g;
}

// Blocks.  The lower k eighths are round(17 k / 8) lines, so ▄ is 9 and ▀
// the 8 above it; the left half is 4 columns.
const lower = (k) => Math.round(H * k / 8);
const pattern = (f) => Array.from({ length: H }, (_, y) =>
  [...Array(W).keys()].reduce((v, x) => v | (f(x, y) ? 0x80 >> x : 0), 0));
const QUADRANTS = { '▀': 12, '▌': 10, '▐': 5, '▖': 2, '▗': 1, '▘': 8, '▙': 11, '▚': 9,
  '▛': 14, '▜': 13, '▝': 4, '▞': 6, '▟': 7 };   // top left 8, top right 4, ...
function block(ch) {
  const eighths = '▁▂▃▄▅▆▇█'.indexOf(ch);
  if (eighths >= 0) return pattern((x, y) => y >= H - lower(eighths + 1));
  if (ch in QUADRANTS) {
    const q = QUADRANTS[ch];
    return pattern((x, y) => q >> ((y < H - lower(4) ? 2 : 0) + (x < 4 ? 1 : 0)) & 1);
  }
  const shade = { '░': (x, y) => (x + 2 * (y & 1)) % 4 === 0, '▒': (x, y) => (x + y) % 2 === 0,
    '▓': (x, y) => (x + 2 * (y & 1)) % 4 !== 0 }[ch];
  return shade ? pattern(shade) : null;
}

// A glyph from rows of # and ., the first on line `top`.
function drawn(top, rows) {
  const g = blank();
  rows.forEach((r, i) => { g[top + i] = parseInt(r.padEnd(W, '.').replace(/#/g, '1').replace(/\./g, '0'), 2); });
  return g;
}

function glyphOf(ch) {
  if (ARMS[ch]) return box(...ARMS[ch]);
  if ('╭╮╯╰'.includes(ch)) return rounded(ch);
  const b = block(ch);
  if (b) return b;
  switch (ch) {
  case 'ď': {   // d a column to the left, and an apostrophe where its stem was
    const g = x11(0x64).map((r) => (r << 1) & 0xff);
    g[3] |= 0x01, g[4] |= 0x01, g[5] |= 0x02;
    return g;
  }
  case 'ȷ': return x11(0x6a).map((r, l) => (l < 6 ? 0 : r));    // 9x15 has none
  // 9x15's are 9 wide with ink at both edges and no column to spare: drawn
  // again, the faces and the arrow 8 wide and the sun 7, in its lines.
  case '☺': return drawn(4, ['..####..', '.#....#.', '#.#..#.#', '#......#', '#......#',
                             '#.#..#.#', '#..##..#', '.#....#.', '..####..']);
  case '☻': return drawn(4, ['..####..', '.######.', '##.##.##', '########', '########',
                             '##.##.##', '###..###', '.######.', '..####..']);
  case '⇔': return drawn(5, ['..#..#..', '.#....#.', '.######.', '#......#', '.######.', '.#....#.', '..#..#..']);
  case '☼': return drawn(4, ['...#...', '#..#..#', '.##.##.', '.#...#.', '##...##',
                             '.#...#.', '.##.##.', '#..#..#', '...#...']);
  // Claude Code's that 9x15 has not.
  case '❯': return drawn(5, ['.##....', '..##...', '...##..', '....##.', '...##..', '..##...', '.##....']);
  case '⏸': return drawn(5, ['.##.##.', '.##.##.', '.##.##.', '.##.##.', '.##.##.', '.##.##.', '.##.##.']);
  case '⚠': return drawn(4, ['...#...', '..#.#..', '..#.#..', '.#.#.#.', '.#.#.#.', '#..#..#',
                             '#.....#', '#..#..#', '#######']);
  case '⧉': return drawn(5, ['#####..', '#...#..', '#.#####', '#.#.#.#', '#####.#', '..#...#', '..#####']);
  // Ukrainian's Ґ ґ: 9x15's upturn is a pixel, so Г г at a glance; two.
  case 'Ґ': case 'ґ': {
    const g = x11(ch.codePointAt(0)), top = g.findIndex((r) => r);
    g[top - 1] = g[top];
    return g;
  }
  // 9x15's Ǯ is squashed for its caron: Ʒ and the caron as Č has it.
  case 'Ǯ': return accented(x11(0x1b7), 0x30c);
  case 'ǯ': return accented(x11(0x292), 0x30c);
  // Zero with a dot in its middle, to tell it from O.
  case '0': {
    const g = x11(0x30), ink = g.map((r, l) => (r ? l : -1)).filter((l) => l >= 0);
    const cols = g.reduce((a, r) => a | r, 0);
    const x = (Math.clz32(cols) - 24 + 7 - (31 - Math.clz32(cols & -cols))) >> 1;   // leftmost and rightmost ink
    const mid = (ink[0] + ink.at(-1)) >> 1;
    g[mid] |= 0x80 >> x, g[mid + 1] |= 0x80 >> x;
    return g;
  }
  // The integral's halves stack, so their stems reach the cell's edge.
  case '⌠': return x11(0x2320).map((r, l, g) => (l === 16 ? g[15] : r));
  case '⌡': return x11(0x2321).map((r, l, g) => (l === 0 ? g[1] : r));
  case '‗': return blank().map((_, l) => (l === 13 || l === 15 ? 0xff : 0));   // joins, as _ does
  // 9x15's maqaf is over the letters, on line 2; Hebrew's hyphen joins
  // them at the top of the x-height, where their bars are.
  case '־': return drawn(6, ['.######.']);
  // 9x15 has ʌ but not Ʌ: V upside down.
  case 'Ʌ': {
    const g = x11(0x56), ink = g.map((r, l) => (r ? l : -1)).filter((l) => l >= 0);
    return g.map((r, l) => (l >= ink[0] && l <= ink.at(-1) ? g[ink[0] + ink.at(-1) - l] : r));
  }
  case '◆': return pattern((x, y) => Math.abs(x - CX) + Math.abs(y - CY) <= 3);
  // Triangles 7 wide, about the middle as ◆ is: ▲ ▼ 8 lines of 1, 1, 3, 3,
  // 5, 5, 7, 7, and ► ◄ 7 columns of 7, 7, 5, 5, 3, 3, 1 lines.
  case '▲': return pattern((x, y) => y >= 5 && y <= 12 && Math.abs(x - CX) <= (y - 5) >> 1);
  case '▼': return pattern((x, y) => y >= 5 && y <= 12 && Math.abs(x - CX) <= (12 - y) >> 1);
  case '△': return pattern((x, y) => y >= 5 && y <= 12 && (Math.abs(x - CX) === (y - 5) >> 1 || y === 12 && x >= 1));
  case '►': return pattern((x, y) => x >= 1 && Math.abs(y - CY) <= (7 - x) >> 1);
  case '◄': return pattern((x, y) => x >= 1 && Math.abs(y - CY) <= (x - 1) >> 1);
  }
  return x11(ch.codePointAt(0));
}

// --- bases --------------------------------------------------------------------

const bases = Array(256).fill(null);         // code -> { ch, glyph }
for (let c = 0x20; c < 0x7f; c++) bases[c] = { ch: String.fromCharCode(c) };
bases[0x69] = { ch: 'ı' };
const free = [...Array(256).keys()].filter((c) => !bases[c]);
const extra = [...REPERTOIRE];
if (extra.length > free.length) throw new Error(`${extra.length} bases past ASCII, room for ${free.length}`);
extra.forEach((ch, i) => { bases[free[i]] = { ch }; });
for (const b of bases) if (b) b.glyph = glyphOf(b.ch);
const codeOf = new Map();
bases.forEach((b, c) => { if (b) codeOf.set(b.ch, c); });

// --- accents ------------------------------------------------------------------

// mark -> { above, rows } from 9x15's spacing accent, its lines with ink.
const inked = (cp) => x11(cp).filter((r) => r);
const SPACING = {
  0x300: 0x60, 0x301: 0xb4, 0x302: 0x2c6, 0x303: 0x2dc, 0x304: 0xaf, 0x306: 0x2d8,
  0x307: 0x2d9, 0x308: 0xa8, 0x30a: 0x2da, 0x30b: 0x2dd, 0x30c: 0x2c7, 0x327: 0xb8, 0x328: 0x2db,
};
const accents = new Map();
for (const [m, s] of Object.entries(SPACING)) accents.set(+m, { above: +m < 0x320, rows: inked(s) });
accents.set(0x326, { above: false, rows: [0x0c, 0x04, 0x08] });   // comma below
// The dot and the macron below a line under the baseline, as ˙ and ¯ are drawn.
accents.set(0x323, { above: false, rows: [0, ...inked(0x2d9)] });
accents.set(0x331, { above: false, rows: [0, ...inked(0xaf)] });
const TURNED_COMMA = [0x08, 0x0c];                                  // ģ's

// In three lines from first: one line's gap below an accent of less.
function above(rows, first) {
  if (rows.length > 3) throw new Error('an accent taller than 3 lines');
  const g = blank();
  rows.forEach((r, i) => { g[first + (rows.length === 3 ? 0 : 2 - rows.length) + i] = r; });
  return g;
}
function below(rows) {
  const g = blank();
  rows.forEach((r, i) => { g[13 + i] = r; });
  return g;
}

// A mark's slices in the two zones it can go in, null where it cannot.
const markSlices = new Map();
for (const [m, a] of accents)
  markSlices.set(m, a.above
    ? [above(a.rows, 0), above(a.rows, 3)]
    : [below(a.rows), m === 0x327 ? above(TURNED_COMMA, 3) : null]);

// --- slices and codes ---------------------------------------------------------

const key = (g, z) => ZONES[z].lines.map((l) => g[l]).join(',');
const empty = (g, z) => ZONES[z].lines.every((l) => !g[l]);
const codes = ZONES.map(() => new Map());             // slice key -> code
const slices = ZONES.map(() => Array(256).fill(null));

// A slice's code: a base's own code if that is free in the zone, so ASCII is
// close to the identity, else the lowest free one.
function code(z, g, want) {
  const k = key(g, z);
  if (codes[z].has(k)) return codes[z].get(k);
  const c = want !== undefined && !slices[z][want] ? want : slices[z].findIndex((s) => !s);
  if (c < 0) throw new Error(`zone ${ZONES[z].name} needs more than 256 codes`);
  codes[z].set(k, c);
  slices[z][c] = g;
  return c;
}
const BLANK = 0x20;
ZONES.forEach((_, z) => code(z, blank(), BLANK));

const GLYPH = ZONES.map(() => Array(256).fill(BLANK));
bases.forEach((b, c) => { if (b) ZONES.forEach((_, z) => { GLYPH[z][c] = code(z, b.glyph, c); }); });

const MARK_GLYPH = [EDGE, RISER].map(() => Array(TONOS + 1).fill(BLANK));
for (const [m, gs] of markSlices) gs.forEach((g, z) => { if (g) MARK_GLYPH[z][m - 0x2ff] = code(z, g); });

// The rule, as font.h has it in C: the zone codes of a cell.
function rule(base, mark, overrides) {
  if (mark === SECOND) return second[base].codes.slice();
  if (mark === THIRD) return third[base].codes.slice();
  const c = ZONES.map((_, z) => GLYPH[z][base]);
  if (!mark) return c;
  const os = overrides.filter((o) => o.base === base && o.mark === mark);
  if (os.length) {
    for (const o of os) c[o.zone] = o.code;
    return c;
  }
  const a = accents.get(mark + 0x2ff);
  const order = a && a.above ? [RISER, EDGE] : [EDGE, RISER];
  for (const z of order)
    if (c[z] === BLANK && MARK_GLYPH[z][mark] !== BLANK) {
      c[z] = MARK_GLYPH[z][mark];
      break;
    }
  return c;
}

// What a pair should look like: the accent ORed into the letter where the
// rule would put it if the zone were blank.
const ideal = (base, m) => accented(bases[base].glyph, m);
function accented(letter, m) {
  const g = letter.slice(), a = accents.get(m);
  const [edge, riser] = markSlices.get(m);
  const pick = a.above ? (empty(g, RISER) ? riser : edge) : (ZONES[EDGE].lines.slice(3).every((l) => !g[l]) ? edge : riser);
  if (pick) pick.forEach((r, l) => { g[l] |= r; });
  return g;
}

// Every letter Unicode composes from one of our bases and one of our marks.
const OVERRIDES = [];
const pairs = [];
for (const [lo, hi] of [[0xc0, 0x250], [0x1e00, 0x1f00]])
  for (let u = lo; u < hi; u++) {
    const d = [...String.fromCodePoint(u).normalize('NFD')];
    if (d.length !== 2 || !accents.has(d[1].codePointAt(0))) continue;
    const m = d[1].codePointAt(0);
    let b = d[0];
    if (accents.get(m).above && (b === 'i' || b === 'j')) b = b === 'i' ? 'ı' : 'ȷ';
    if (codeOf.has(b)) pairs.push([codeOf.get(b), m]);
  }
// Ά Έ Ή Ί Ό Ύ: the letter, and the tonos a tick beside its top in the first
// column - or where a stem is next to it, Έ Ή Ύ, an acute above that column,
// which a tick would only thicken.
function tonos(letter) {
  const g = letter.slice();
  if ((g[3] | g[4]) & 0x40) g[0] |= 0x20, g[1] |= 0x40, g[2] |= 0x80;
  else g[3] |= 0x80, g[4] |= 0x80;
  return g;
}
for (const ch of 'AEHIOY') pairs.push([codeOf.get(ch), 0x2ff + TONOS]);
const APOSTROPHE = { L: 4, l: 6, t: 6 };      // Ľ ľ ť: the column right of the stem
const LATVIAN = 'GKLNRklnr';                   // Ģ Ķ ķ ...: the cedilla drawn as a comma
for (const [base, m] of pairs) {
  const ch = bases[base].ch;
  let g = m === 0x2ff + TONOS ? tonos(bases[base].glyph) : ideal(base, m === 0x327 && LATVIAN.includes(ch) ? 0x326 : m);
  if (m === 0x30c && ch in APOSTROPHE) {
    g = bases[base].glyph.slice();
    const col = APOSTROPHE[ch];
    g[3] |= 0x80 >> col, g[4] |= 0x80 >> col, g[5] |= 0x80 >> (col - 1);
  }
  const want = rule(base, m - 0x2ff, []);
  ZONES.forEach((_, zone) => {
    if (key(g, zone) !== key(slices[zone][want[zone]], zone))
      OVERRIDES.push({ base, mark: m - 0x2ff, zone, code: code(zone, g) });
  });
}
OVERRIDES.sort((a, b) => a.base - b.base || a.mark - b.mark);

// Each EDGE code's slice underlined.  A code no slice has maps to the
// blank's; an underlined slice's own entry is never used, and is itself.
// --- the second and third sets -------------------------------------------------

// Each zone must have a candidate's slice or room for it, and EDGE stay at
// 128 or under, so that its underlined slices fit beside it.
const leftOut = [];
function fill(repertoire) {
  const set = [];
  for (const ch of repertoire) {
    const g = glyphOf(ch);
    const fits = ZONES.every((_, z) => codes[z].has(key(g, z)) ||
      (z === EDGE ? codes[z].size < 128 : slices[z].includes(null)));
    if (!fits || set.length === 256) leftOut.push(ch);
    else set.push({ ch, glyph: g, codes: ZONES.map((_, z) => code(z, g)) });
  }
  return set;
}
const second = fill(SECOND_REPERTOIRE), third = fill(THIRD_REPERTOIRE);
// A character of either set: [set's mark, index], or null.
const ofSets = (ch) => {
  const s = second.findIndex((s) => s.ch === ch), t = third.findIndex((s) => s.ch === ch);
  return s >= 0 ? [SECOND, s] : t >= 0 ? [THIRD, t] : null;
};
const SET_FLAG = { [SECOND]: 0x100, [THIRD]: 0x200 };

// --- bidi ---------------------------------------------------------------------

// As font.h's enum has them.
const BIDI = ['L', 'R', 'EN', 'ES', 'ET', 'CS', 'ON', 'WS'];
function bidiClass(ch) {
  if (ch === ' ') return 'WS';
  if (/\p{Script=Hebrew}/u.test(ch)) return 'R';
  if (/[0-9\u00b2\u00b3\u00b9\u2070\u2074-\u2079\u2080-\u2089]/u.test(ch)) return 'EN';
  if ('+-\u207a\u208a'.includes(ch)) return 'ES';
  if (/\p{Sc}/u.test(ch) || '#%°±‰‱′″‴∓℮'.includes(ch)) return 'ET';
  if (',./:'.includes(ch)) return 'CS';
  if (/\p{L}/u.test(ch)) return 'L';
  return 'ON';
}

// A base as base_of gives it: SECOND_SET or THIRD_SET | base for those sets.
const baseOf = (ch) => {
  if (codeOf.has(ch)) return codeOf.get(ch);
  const s = ofSets(ch);
  if (!s) throw new Error(`${ch} is not a base`);
  return SET_FLAG[s[0]] | s[1];
};
const mirrorPairs = (pairs, mirrored) => pairs.flatMap((p) => {
  const [a, b] = [...p];
  if (mirrored && !/\p{Bidi_M}/u.test(a + b)) throw new Error(`${p} is not Bidi_Mirrored`);
  return [[baseOf(a), baseOf(b)], [baseOf(b), baseOf(a)]];
}).sort((x, y) => x[0] - y[0]);
const MIRRORS = mirrorPairs(['()', '<>', '[]', '{}', '«»', '‹›', '≤≥', '≪≫', '⌈⌉', '⌊⌋',
                             '⊂⊃', '⊆⊇', '⊄⊅', '⊈⊉', '⊊⊋', '∈∋', '∉∌'], true);
const BOX_MIRRORS = mirrorPairs(['┌┐', '└┘', '├┤', '┏┓', '┗┛', '┣┫', '╒╕', '╓╖', '╔╗', '╘╛',
                                 '╙╜', '╚╝', '╞╡', '╟╢', '╠╣', '╭╮', '╰╯'], false);

// Each base's class, and font.h's BIDI_MIRRORED and BIDI_BOX_MIRRORED if it
// has a pair, so that bidi.cc looks for one only then.
const inPairs = (ps, b) => ps.some(([from]) => from === b);
const classes = (set, flag) => set.map((b, i) => BIDI.indexOf(bidiClass(b ? b.ch : '\ufffd')) |
  (b && inPairs(MIRRORS, flag | i) ? 0x08 : 0) | (b && inPairs(BOX_MIRRORS, flag | i) ? 0x10 : 0));
const BIDI_CLASS = classes(bases, 0), SECOND_BIDI = classes(second, 0x100), THIRD_BIDI = classes(third, 0x200);

const UNDER_LINE = 14;
const UNDERLINED = [...Array(256).keys()];
for (const c of slices[EDGE].map((g, c) => (g ? c : -1)).filter((c) => c >= 0)) {
  const g = slices[EDGE][c].slice(), below = g[13] | g[14] | g[15];
  let span = 0;
  for (let x = 0; x < W; x++)
    if (below & ~(0xff >> (x + 1)) & 0xff && below & 0xff >> x) span |= 0x80 >> x;   // ink at or left, at or right
  g[UNDER_LINE] = (0xff & ~(span | span << 1 | span >> 1)) | g[UNDER_LINE];
  UNDERLINED[c] = code(EDGE, g);
}
for (let c = 0; c < 256; c++) if (!slices[EDGE][c]) UNDERLINED[c] = UNDERLINED[BLANK];

// --- the font -----------------------------------------------------------------

const FONT = Array.from({ length: H }, (_, l) => slices[zoneOf[l]].map((g) => (g ? g[l] : 0)));
const shown = (base, mark, under) => {
  const c = rule(base, mark, OVERRIDES);
  if (under) c[EDGE] = UNDERLINED[c[EDGE]];
  return FONT.map((row, l) => row[c[zoneOf[l]]]);
};

const counts = ZONES.map((z, i) => `${z.name} ${codes[i].size}`).join(', ');
process.stderr.write(`${bases.filter(Boolean).length} bases; codes in each zone: ${counts}; ` +
  `${OVERRIDES.length} overrides of ${pairs.length} accented letters\n`);
process.stderr.write(`second set ${second.length} of ${SECOND_REPERTOIRE.length}, ` +
  `third ${third.length} of ${THIRD_REPERTOIRE.length}` +
  (leftOut.length ? `; no room for ${leftOut.join('')}` : '') + '\n');
if (moved.length) process.stderr.write(`moved a column left: ${moved.join('')}\n`);
if (lost.length) process.stderr.write(`ink in both edge columns, the right one lost: ${lost.join('')}\n`);

// --rules: every base with no mark and with each of ours, and the codes the
// rule gives, for check.mjs to hold font.h's glyphs() to.
if (rules) {
  const out = [];
  const line = (base, m) => `${base} ${m} ${rule(base, m, OVERRIDES).join(' ')} ${UNDERLINED[rule(base, m, OVERRIDES)[EDGE]]}`;
  bases.forEach((b, base) => {
    if (b) for (const m of [0, ...[...accents.keys()].map((m) => m - 0x2ff), TONOS]) out.push(line(base, m));
  });
  second.forEach((_, i) => out.push(line(i, SECOND)));
  third.forEach((_, i) => out.push(line(i, THIRD)));
  process.stdout.write(out.join('\n') + '\n');
  process.exit(0);
}

if (sheet) {
  // With --text, its lines as the terminal shows them, cells touching; a
  // character followed by U+0332, combining low line, underlined.
  const lines = text && readFileSync(text, 'utf8').replace(/\n$/, '').split('\n');
  const width_ = (l) => [...l.replace(/\u0332/g, '')].length;
  const SCALE = 3, GAP = lines ? 0 : 2, COLS = lines ? Math.max(...lines.map(width_)) : 32;
  let cells = bases.map((b, c) => (b ? [c, 0] : null)).filter(Boolean);
  for (const [b, m] of pairs) cells.push([b, m - 0x2ff]);
  second.forEach((_, i) => cells.push([i, SECOND]));
  third.forEach((_, i) => cells.push([i, THIRD]));
  cells.push([0x69, 0x307 - 0x2ff]);
  if (lines) {
    cells = [];
    for (const l of lines) {
      const row = [];
      for (const ch of l) {
        if (ch === '\u0332') {
          row[row.length - 1][2] = true;
          continue;
        }
        const s = ofSets(ch);
        if (s) {
          row.push([s[1], s[0], false]);
          continue;
        }
        const [b, m] = codeOf.has(ch) ? [ch] : [...ch.normalize('NFD')];
        const mark = m ? m.codePointAt(0) : b === 'i' ? 0x307 : 0;
        const dotless = mark && accents.get(mark)?.above && (b === 'i' || b === 'j');
        const base = codeOf.get(dotless ? (b === 'i' ? 'ı' : 'ȷ') : b) ?? codeOf.get('\ufffd');
        row.push([base, mark ? mark - 0x2ff : 0, false]);
      }
      while (row.length < COLS) row.push([0x20, 0, false]);
      cells.push(...row);
    }
  }
  const width = COLS * (W + GAP) * SCALE, height = Math.ceil(cells.length / COLS) * (H + GAP) * SCALE;
  const rgb = Buffer.alloc(width * height * 3, 0x40);
  cells.forEach(([b, m, under], i) => {
    const g = shown(b, m, under), cx = (i % COLS) * (W + GAP), cy = Math.floor(i / COLS) * (H + GAP);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++)
        for (let d = 0; d < SCALE * SCALE; d++) {
          const at = (((cy + y) * SCALE + (d / SCALE | 0)) * width + (cx + x) * SCALE + d % SCALE) * 3;
          rgb[at] = rgb[at + 1] = rgb[at + 2] = (g[y] >> (7 - x)) & 1 ? 0xf0 : 0;
        }
  });
  writeFileSync(sheet, png({ width, height, rgb }));
  process.exit(0);
}

// --- out ----------------------------------------------------------------------

const hex = (v) => `0x${v.toString(16).padStart(2, '0')}`;
const table = (a, indent) => {
  const out = [];
  for (let i = 0; i < a.length; i += 16) out.push(indent + a.slice(i, i + 16).map(hex).join(', ') + ',');
  return out.join('\n');
};
const named = (c) => (c & 0x100 ? second[c & 0xff] : c & 0x200 ? third[c & 0xff] : bases[c]).ch;
const big = (c) => (c > 0xff ? `0x${c.toString(16)}` : hex(c));
const pairTable = (ps) => ps.map(([a, b]) => `  { ${big(a)}, ${big(b)} },  // ${named(a)} ${named(b)}`).join('\n');
const unicode = bases.map((b, c) => [b && b.ch.codePointAt(0), c])
  .filter(([u, c]) => u !== undefined && u !== null && !(u === c && c !== 0x69))
  .concat(second.map((s, i) => [s.ch.codePointAt(0), 0x100 | i]))
  .concat(third.map((s, i) => [s.ch.codePointAt(0), 0x200 | i]))
  .sort((a, b) => a[0] - b[0]);
const aliases = Object.entries(ALIASES).map(([from, to]) => {
  const s = ofSets(to);
  if (!codeOf.has(to) && !s) throw new Error(`the alias ${from} is of ${to}, not a base`);
  return [from.codePointAt(0), codeOf.has(to) ? codeOf.get(to) : SET_FLAG[s[0]] | s[1]];
}).sort((a, b) => a[0] - b[0]);

process.stdout.write(`// Generated by terminal/gen-font.mjs from X11's 9x15; do not edit.
// Codes in each zone: ${counts}.
#include "font.h"

namespace terminal {

__attribute__((section(".font"))) const uint8_t FONT[LINES * 256] = {
${FONT.map((r, l) => `  /* line ${l}, ${ZONES[zoneOf[l]].name} */\n${table(r, '  ')}`).join('\n')}
};

const uint8_t ZONE_OF_LINE[LINES] = { ${zoneOf.join(', ')} };
const uint8_t DOTTED_I = ${hex(codeOf.get('i'))}, DOTLESS_J = ${hex(codeOf.get('ȷ'))}, FALLBACK = ${hex(codeOf.get('\ufffd'))};

const uint8_t GLYPH[ZONES][256] = {
${GLYPH.map((g, z) => `  { /* ${ZONES[z].name} */\n${table(g, '    ')}\n  },`).join('\n')}
};

const uint8_t UNDERLINED[256] = {
${table(UNDERLINED, '  ')}
};

const uint8_t MARK_GLYPH[2][TONOS + 1] = {
${MARK_GLYPH.map((g, z) => `  { /* ${ZONES[z].name} */\n${table(g, '    ')}\n  },`).join('\n')}
};

extern const int SECOND_COUNT = ${second.length};
const uint8_t SECOND_GLYPH[${second.length}][ZONES] = {
${second.map((s) => `  { ${s.codes.map(hex).join(', ')} },  // ${s.ch}`).join('\n')}
};

extern const int THIRD_COUNT = ${third.length};
const uint8_t THIRD_GLYPH[${third.length}][ZONES] = {
${third.map((s) => `  { ${s.codes.map(hex).join(', ')} },  // ${s.ch}`).join('\n')}
};

const uint8_t BIDI_CLASS[256] = {
${table(BIDI_CLASS, '  ')}
};
const uint8_t SECOND_BIDI[${second.length}] = {
${table(SECOND_BIDI, '  ')}
};
const uint8_t THIRD_BIDI[${third.length}] = {
${table(THIRD_BIDI, '  ')}
};

extern const int MIRROR_COUNT = ${MIRRORS.length}, BOX_MIRROR_COUNT = ${BOX_MIRRORS.length};
const Pair MIRRORS[${MIRRORS.length}] = {
${pairTable(MIRRORS)}
};
const Pair BOX_MIRRORS[${BOX_MIRRORS.length}] = {
${pairTable(BOX_MIRRORS)}
};

extern const int OVERRIDE_COUNT = ${OVERRIDES.length};
const Override OVERRIDES[${OVERRIDES.length}] = {
${OVERRIDES.map((o) => `  { ${hex(o.base)}, ${hex(o.mark)}, ${o.zone}, ${hex(o.code)} },  // ${(bases[o.base].ch + String.fromCodePoint(o.mark + 0x2ff)).normalize('NFC')}`).join('\n')}
};

extern const int UNICODE_COUNT = ${unicode.length};
const Unicode UNICODE[${unicode.length}] = {
${unicode.map(([u, c]) => `  { 0x${u.toString(16).padStart(4, '0')}, ${c > 0xff ? `0x${c.toString(16)}` : hex(c)} },`).join('\n')}
};

extern const int ALIAS_COUNT = ${aliases.length};
const Unicode ALIASES[${aliases.length}] = {
${aliases.map(([u, c]) => `  { 0x${u.toString(16).padStart(4, '0')}, ${hex(c)} },  // ${String.fromCodePoint(u)} as ${(c & 0x100 ? second[c & 0xff] : c & 0x200 ? third[c & 0xff] : bases[c]).ch}`).join('\n')}
};

}  // namespace terminal
`);

