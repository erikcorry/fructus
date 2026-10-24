#!/usr/bin/env node
// =============================================================================
// tti.mjs - a .tti teletext page to the bytes teletext/rx.h takes
// =============================================================================
//
//   node teletext/tti.mjs PAGE.tti [SUBPAGE] > page.bin
//
// A .tti file is a page as an inserter like VBIT2 keeps it: lines of
// KEY,value.  PN starts a subpage, and OL,row,text is a row of it, 1-24 -
// row 0, the header, is the inserter's own.  In the text a control code is
// ESC and the code + 0x40, and the rest is the row's bytes, bit 7 ignored.
// Rows not given are blank.  Teefax's pages are such files, in Subversion at
// http://teastop.plus.com/svn/teletext/ (vbit2's scripts/known_services.json).
//
// Out comes one page for rx.h: 1000 bytes, 25 rows of 40, and the 0 that
// ends it.  A 0 in a row - not a level 1 code - becomes a space.  Row 0 is
// made here: the page number and subpage in white.  SUBPAGE counts from 1,
// in the order the file gives them.
// =============================================================================

import { readFileSync } from 'node:fs';

const [file, sub = '1'] = process.argv.slice(2);
if (!file) {
  console.error('usage: node teletext/tti.mjs PAGE.tti [SUBPAGE]');
  process.exit(1);
}

const subpages = [];
let page = null, number = '';
for (const line of readFileSync(file, 'latin1').split(/\r?\n/)) {
  const comma = line.indexOf(',');
  if (comma < 0) continue;
  const key = line.slice(0, comma), value = line.slice(comma + 1);
  if (key === 'PN') {
    number = value;
    page = { number, rows: [] };
    subpages.push(page);
  } else if (key === 'OL' && page) {
    const comma2 = value.indexOf(',');
    const row = parseInt(value.slice(0, comma2), 10), text = value.slice(comma2 + 1);
    const bytes = [];
    for (let i = 0; i < text.length && bytes.length < 40; i++) {
      let b = text.charCodeAt(i) & 0x7f;
      if (b === 0x1b && i + 1 < text.length) b = (text.charCodeAt(++i) - 0x40) & 0x7f;
      bytes.push(b === 0 ? 0x20 : b);
    }
    if (row >= 1 && row <= 24) page.rows[row] = bytes;
  }
}

const chosen = subpages[parseInt(sub, 10) - 1];
if (!chosen) {
  console.error(`${file}: no subpage ${sub} of ${subpages.length}`);
  process.exit(1);
}

const header = ` P${chosen.number.slice(0, 3)}  ${chosen.number.slice(3)}/${subpages.length}  TEEFAX`;
const out = [];
for (let r = 0; r < 25; r++) {
  const row = r === 0 ? [...header].map((c) => c.charCodeAt(0)) : chosen.rows[r] ?? [];
  for (let c = 0; c < 40; c++) out.push(row[c] ?? 0x20);
}
out.push(0);
process.stdout.write(Uint8Array.from(out));
