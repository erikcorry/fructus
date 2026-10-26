#!/usr/bin/env node
// =============================================================================
// gen-decompose.mjs - accented letters as a base and one combining mark
// =============================================================================
//
//   node terminal/gen-decompose.mjs > terminal/decompose.cc
//
// A cell holds a base character and at most one mark from Combining
// Diacritical Marks, U+0300-U+036F (ideas/vt100.md).  This is the table that
// splits a precomposed letter into the two, from the JavaScript engine's own
// Unicode data: String.prototype.normalize('NFD').
//
// WHAT IS IN IT.  Latin-1 Supplement and Latin Extended-A whole: every letter
// there whose NFD is a Latin-1 base and one mark.  The marks those use, and
// the comma below for Romanian's ș and ț, are "our" marks; from Latin
// Extended-B and Latin Extended Additional come only letters that are a
// Latin-1 base and one of our marks - not the Vietnamese stacks, not the
// double grave.  A letter with two marks, ǖ say, is not in the table and
// stays a base of its own.  So are the letters that do not decompose at all:
// Æ, Ø, ß, Ł, Œ, ı and the like are their own bases already.
//
// AN OWN BASE, though NFD splits it: ď.  Its caron is an apostrophe beside
// the stem, and the stem is at the cell's right edge, so the letter moves
// over for it (gen-font.mjs).  Ľ, ľ and ť's apostrophes fit beside their
// stems, and they are letters and a caron, which the font draws so.
//
// GREEK AND CYRILLIC LOOKALIKES are the Latin letter they look like, with
// no mark: those 9x15 draws pixel for pixel the same, and Β, μ, і, ј, у,
// which are the same letter drawn a little differently.  And a letter of
// either that is a lookalike and one of our marks is the Latin letter and
// the mark: Ё as Ë, ї as ï, Ќ as Ḱ.  The rest of the two alphabets is not in
// the font.
//
// SPACING ACCENTS: no-break space is a space, soft hyphen a hyphen, and
// Latin-1's ¨ ¯ ´ and the modifier letters ˆ ˇ ˘ ˙ ˛ ˜ ˝ are a space with
// the mark - their NFKD, not their NFD.
//
// THE i RULE IS THE TERMINAL'S, not the table's: i with a mark above is a
// dotless ı with the mark, and j likewise ȷ.  The table says i; terminal.cc
// changes it, using the BELOW bitmap this also writes.
//
// The table is sorted by code point, 4 bytes an entry: code point, base (a
// Latin-1 code), mark (its code point less 0x2ff, as a cell stores it).
// =============================================================================

const MARKS_FIRST = 0x300, MARKS_LAST = 0x36f;
const isMark = (c) => c >= MARKS_FIRST && c <= MARKS_LAST;

// Marks drawn below the letter, canonical combining classes 202, 220 and 233
// among U+0300-U+036F (UnicodeData.txt).
const BELOW = [
  [0x316, 0x319], [0x31c, 0x333], [0x339, 0x33c], [0x345, 0x345], [0x347, 0x349],
  [0x34d, 0x34e], [0x353, 0x356], [0x359, 0x35a], [0x35c, 0x35c], [0x35f, 0x35f],
  [0x362, 0x362],
];
const below = (m) => BELOW.some(([a, b]) => m >= a && m <= b);

const OWN = new Set([0x10f]);
const SPACING = {
  0xa0: [0x20, 0], 0xa8: [0x20, 0x308], 0xad: [0x2d, 0], 0xaf: [0x20, 0x304], 0xb4: [0x20, 0x301],
  0x2c6: [0x20, 0x302], 0x2c7: [0x20, 0x30c], 0x2d8: [0x20, 0x306], 0x2d9: [0x20, 0x307],
  0x2db: [0x20, 0x328], 0x2dc: [0x20, 0x303], 0x2dd: [0x20, 0x30b],
};

const LOOKALIKES = {
  'Α': 'A', 'Β': 'B', 'Ε': 'E', 'Ζ': 'Z', 'Η': 'H', 'Ι': 'I', 'Κ': 'K', 'Μ': 'M', 'Ν': 'N',
  'Ο': 'O', 'Ρ': 'P', 'Τ': 'T', 'Υ': 'Y', 'Χ': 'X', 'μ': 'µ', 'ν': 'v', 'ο': 'o',
  'А': 'A', 'В': 'B', 'Е': 'E', 'К': 'K', 'М': 'M', 'Н': 'H', 'О': 'O', 'Р': 'P', 'С': 'C',
  'Т': 'T', 'Х': 'X', 'Ѕ': 'S', 'І': 'I', 'Ј': 'J',
  'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y', 'х': 'x', 'ѕ': 's', 'і': 'i', 'ј': 'j',
};
const latin = (c) => LOOKALIKES[String.fromCodePoint(c)]?.codePointAt(0) ?? c;

// [base, mark] for a code point, or null.
function split(cp) {
  if (SPACING[cp]) return SPACING[cp];
  if (OWN.has(cp)) return null;
  if (LOOKALIKES[String.fromCodePoint(cp)]) return [latin(cp), 0];
  const d = [...String.fromCodePoint(cp).normalize('NFD')].map((c) => c.codePointAt(0));
  if (d.length !== 2 || latin(d[0]) > 0xff || !isMark(d[1])) return null;
  return [latin(d[0]), d[1]];
}

const entries = [];
const ours = new Set([0x326]);
for (let cp = 0xa0; cp < 0x180; cp++) {
  const s = split(cp);
  if (!s) continue;
  entries.push([cp, ...s]);
  if (s[1]) ours.add(s[1]);
}
for (const [lo, hi] of [[0x180, 0x250], [0x2b0, 0x300], [0x370, 0x530], [0x1e00, 0x1f00]])
  for (let cp = lo; cp < hi; cp++) {
    const s = split(cp);
    if (s && (!s[1] || ours.has(s[1])) && (lo !== 0x370 || /\p{L}/u.test(String.fromCodePoint(s[0]))))
      entries.push([cp, ...s]);
  }

const hex = (v, n) => `0x${v.toString(16).padStart(n, '0')}`;
const lines = [];
for (let i = 0; i < entries.length; i += 4)
  lines.push('  ' + entries.slice(i, i + 4)
    .map(([cp, b, m]) => `{ ${hex(cp, 4)}, ${hex(b, 2)}, ${m ? hex(m - 0x2ff, 2) : '0'} },`).join(' '));

const bits = Array(16).fill(0);
for (let m = MARKS_FIRST; m <= MARKS_LAST; m++)
  if (below(m)) bits[(m - 0x2ff) >> 3] |= 1 << ((m - 0x2ff) & 7);

process.stdout.write(`// Generated by terminal/gen-decompose.mjs from the JavaScript engine's
// Unicode NFD; do not edit.  ${entries.length} characters as a base and a mark or none, sorted
// by code point.  The marks used:
//   ${[...ours].sort((a, b) => a - b).map((m) => hex(m, 4)).join(' ')}
#include "terminal.h"

namespace terminal {

extern const int DECOMPOSITION_COUNT = ${entries.length};
const Decomposition DECOMPOSITIONS[${entries.length}] = {
${lines.join('\n')}
};

// Bit m of the bitmap: mark m, as a cell stores it, is drawn below; 0-127,
// every value the field holds.
const uint8_t MARK_BELOW[16] = { ${bits.map((b) => hex(b, 2)).join(', ')} };

}  // namespace terminal
`);
