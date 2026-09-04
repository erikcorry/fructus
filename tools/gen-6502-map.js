#!/usr/bin/env node
// =============================================================================
// gen-6502-map.js - the same opcode map, drawn for the NMOS 6502
// =============================================================================
//
//     node tools/gen-6502-map.js       > build/6502.html
//     node tools/gen-6502-map.js --svg > docs/6502.svg
//
// Same layout as tools/gen-opcode-map.js, same palette conventions, different
// machine - so the two can be put side by side.  Read from isa/mos6502.toml,
// which is reference data and not part of Fructus.
//
// THREE DIFFERENCES FROM THE FRUCTUS MAP, all forced by the subject:
//
//   The table cannot stop early.  Fructus has 146 unassigned opcodes in one
//   run at the end, so its map cuts off and says so.  Every one of the 6502's
//   256 decodes to something, so all thirty-two rows are drawn.
//
//   Cells are shorter.  A 6502 mnemonic is three characters and its operand
//   shape is never more than seven, so 44px does what 62 had to on a machine
//   with `push ra, rb, rc`.
//
//   There is a fourteenth key entry that is not an addressing mode.  105 of
//   the 256 are undocumented - the chip decodes them, MOS never published
//   them - and they are drawn grey rather than left blank, because blank
//   would be a claim about the hardware that is not true.
// =============================================================================

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { root } from './isa.js';

const spec = parse(readFileSync(join(root, 'isa/mos6502.toml'), 'utf8'));

// --- read the table ----------------------------------------------------------
const ops = spec.table.ops.map((s, i) => {
  const undoc = s.startsWith('*');
  const [mnemonic, mode, cycles] = (undoc ? s.slice(1) : s).split(/\s+/);
  if (!spec.mode[mode]) throw new Error(`0x${i.toString(16)}: unknown mode '${mode}'`);
  return { code: i, mnemonic, mode, cycles, undoc, ...spec.mode[mode] };
});

// --- the invariants ----------------------------------------------------------
// This is a table typed in by hand from a data sheet, so it gets checked the
// way isa/fructus.toml gets checked.  Every number below is a fact about the
// 6502 that is independently known, which is the point: they cannot all come
// out right by accident.
{
  const fail = [];
  const eq = (what, got, want) => { if (got !== want) fail.push(`${what}: ${got}, want ${want}`); };

  eq('opcodes', ops.length, 256);
  eq('documented', ops.filter((o) => !o.undoc).length, 151);
  eq('undocumented', ops.filter((o) => o.undoc).length, 105);
  eq('addressing modes', Object.keys(spec.mode).length, 13);
  eq('documented mnemonics', new Set(ops.filter((o) => !o.undoc).map((o) => o.mnemonic)).size, 56);

  // THE cc = 01 GROUP IS COMPLETELY REGULAR, and that is the 6502's whole
  // decoding idea: the opcode is aaabbbcc, cc picks the group, bbb the
  // addressing mode, aaa the operation.  All 64 combinations of the eight
  // accumulator operations with the eight modes exist and land where the bits
  // say - with exactly one hole, `STA #`, which cannot mean anything.  If a
  // single one of those 64 entries were mistyped this would catch it.
  const BBB = ['izx', 'zp', 'imm', 'abs', 'izy', 'zpx', 'aby', 'abx'];
  const AAA = ['ORA', 'AND', 'EOR', 'ADC', 'STA', 'LDA', 'CMP', 'SBC'];
  const odd = [];
  for (let c = 1; c < 256; c += 4) {
    const o = ops[c];
    if (o.mnemonic !== AAA[c >> 5] || o.mode !== BBB[(c >> 2) & 7]) odd.push(c);
  }
  if (odd.length !== 1 || odd[0] !== 0x89)
    fail.push(`cc=01 group: deviations at ${odd.map((c) => c.toString(16)).join(', ')}, want just 89`);

  // Every 6502 instruction's length is its mode's length.  The map prints that
  // number, so a mode with the wrong byte count would be a wrong map.
  for (const [name, m] of Object.entries(spec.mode))
    if (![1, 2, 3].includes(m.bytes)) fail.push(`mode ${name}: ${m.bytes} bytes`);

  if (fail.length) throw new Error('isa/mos6502.toml:\n  ' + fail.join('\n  '));
}

// --- colour ------------------------------------------------------------------
// Hue is the operand FAMILY, shade is the variant within it, exactly as in the
// Fructus map: warm for instructions that name no address, green for the zero
// page, blue for absolute, pink for the indirections, coral for a branch.  So
// the map reads at two grains - which mode, and which kind of mode.
const COLOUR = {
  impl: '#F8CE8B', acc: '#E3A863',
  imm:  '#C6BEEC',
  zp:   '#A6D9B4', zpx: '#C2E3B0', zpy: '#DCEDA6',
  abs:  '#9AC4E8', abx: '#B9D9F2', aby: '#D2E7F8',
  izx:  '#E4A2C4', izy: '#F5C2DC', ind: '#F2B5A5',
  rel:  '#FAD4D4',
};
const UNDOC = '#E6E8EC';

// Editorial: what the mode is for, in the words a programmer would use.
const NOTE = {
  impl: 'the operand is the instruction &mdash; INX, PHA, SEI',
  acc:  'the shift group, working on A instead of memory',
  imm:  'the byte after the opcode is the value',
  zp:   'one address byte, so page zero is the register file this chip does not have',
  zpx:  'wraps inside page zero: $ff + 1 is $00, never $0100',
  zpy:  'only LDX and STX, because X is already the other index',
  abs:  'the full 16-bit address, low byte first',
  abx:  'reads cost a cycle more when the index crosses a page; writes always pay it',
  aby:  'the same, indexed by Y',
  ind:  'JMP ($nnnn) alone &mdash; and it cannot fetch a vector that straddles a page',
  izx:  'a pointer chosen from a table in page zero',
  izy:  'a pointer in page zero, then indexed &mdash; the one that walks arrays',
  rel:  'a signed byte from the following instruction: &minus;128 to +127',
};

const MODES = Object.entries(spec.mode).map(([id, m]) => ({
  id, c: COLOUR[id], label: m.label, bytes: m.bytes,
  write: m.write, note: NOTE[id],
  n: ops.filter((o) => !o.undoc && o.mode === id).length,
}));

const nDoc   = ops.filter((o) => !o.undoc).length;
const nUndoc = 256 - nDoc;
const nMnem  = new Set(ops.filter((o) => !o.undoc).map((o) => o.mnemonic)).size;

// --- what each cell says -----------------------------------------------------
// The operand shape, then the cycles.  Cycle count is the one fact a 6502
// programmer looks up most and the one a mnemonic never carries, so it goes on
// the face of the cell rather than into a tooltip that a README cannot fire.
const hex2 = (n) => n.toString(16).padStart(2, '0').toUpperCase();
const esc = (s) => String(s).replace(/&(?!\w+;|#)/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// =============================================================================
// SVG
// =============================================================================
if (process.argv.includes('--svg')) {
  const PAD = 26, CW = 104, CH = 44, GAP = 3, GUT = 40, COLH = 20;
  const gridW = GUT + 8 * CW + 7 * GAP;
  const W = PAD * 2 + gridW;
  const MONO = "ui-monospace,'DejaVu Sans Mono','Liberation Mono',Menlo,monospace";
  const SANS = "'DejaVu Sans','Liberation Sans',Helvetica,Arial,sans-serif";
  const INK = '#16181D', MUTED = '#6A7180', FAINT = '#9AA1AE', RULE = '#E2E5EA';

  const g = [];
  const t = (x, y, s, o = {}) => g.push(
    `<text x="${x}" y="${y}"` + (o.f === SANS ? ` font-family="${SANS}"` : ``) +
    ` font-size="${o.s ?? 12}"` +
    (o.w ? ` font-weight="${o.w}"` : '') + ` fill="${o.c ?? INK}"` +
    (o.a ? ` text-anchor="${o.a}"` : '') +
    (o.ls ? ` letter-spacing="${o.ls}"` : '') + `>${esc(s)}</text>`);

  let y = PAD;
  t(PAD, y + 11, 'MOS 6502 · NMOS · FIRST-BYTE DECODE', { s: 10, c: MUTED, ls: 1.4 });
  t(PAD, y + 50, '6502 Opcode Map', { f: SANS, s: 34, w: 700 });
  t(PAD, y + 72, 'Every instruction’s length is fixed by its opcode byte, so this table is the whole decoder.',
    { f: SANS, s: 12.5, c: MUTED });
  const stats = [[nDoc, 'documented'], [nUndoc, 'undocumented'], [MODES.length, 'addressing modes'],
                 [nMnem, 'instructions']];
  let sx = PAD;
  for (const [n, label] of stats) {
    t(sx, y + 104, String(n), { s: 20, w: 600 });
    t(sx, y + 118, label.toUpperCase(), { s: 8.5, c: FAINT, ls: 1.2 });
    sx += Math.max(String(n).length * 13, label.length * 6.2) + 26;
  }
  g.push(`<rect x="${PAD}" y="${y + 130}" width="${gridW}" height="2" fill="${INK}"/>`);

  const gridTop = y + 152;
  for (let x = 0; x < 8; x++)
    t(PAD + GUT + x * (CW + GAP) + CW / 2, gridTop + 13, '·' + x,
      { s: 10, c: MUTED, a: 'middle' });

  const rowTop = (r) => gridTop + COLH + r * (CH + GAP);
  for (let row = 0; row < 32; row++) {
    const ry = rowTop(row);
    t(PAD + GUT - 9, ry + CH / 2 + 4, hex2(row * 8), { s: 10, c: MUTED, a: 'end' });
    for (let x = 0; x < 8; x++) {
      const cx = PAD + GUT + x * (CW + GAP);
      const o = ops[row * 8 + x];
      const ink = o.undoc ? 'rgba(0,0,0,.55)' : '#000';
      g.push(`<rect x="${cx}" y="${ry}" width="${CW}" height="${CH}" rx="3" ` +
             `fill="${o.undoc ? UNDOC : COLOUR[o.mode]}"` +
             (o.undoc ? ` stroke="#D6D9DF"` : '') + `/>`);
      t(cx + 8, ry + 13, hex2(o.code), { s: 9, c: 'rgba(0,0,0,.45)' });
      t(cx + CW - 8, ry + 13, o.bytes + 'B', { s: 8.5, c: 'rgba(0,0,0,.42)', a: 'end' });
      // The mnemonic, with a leading dot on the ones MOS never published - so
      // the distinction survives being printed in grey on a grey screen.
      t(cx + 8, ry + 28, (o.undoc ? '·' : '') + o.mnemonic,
        { s: 13, w: 600, c: ink });
      t(cx + 8, ry + 39, o.write || '—', { s: 8.5, c: 'rgba(0,0,0,.62)' });
      t(cx + CW - 8, ry + 39, o.cycles, { s: 8.5, c: 'rgba(0,0,0,.5)', a: 'end' });

      // The operand shape and the cycle count share the last line, one from
      // each end, and an SVG will happily draw them straight through each
      // other.  A monospace advance is 0.6em, so this is arithmetic rather
      // than a guess - and it is checked because the alternative is finding
      // out by looking at a picture.
      const adv = 8.5 * 0.6;
      const left = 8 + (o.write || '—').length * adv;
      const right = CW - 8 - o.cycles.length * adv;
      if (left > right - 4)
        throw new Error(`${hex2(o.code)}: "${o.write}" and "${o.cycles}" collide in a ${CW}px cell`);
    }
  }
  const gridBottom = rowTop(31) + CH;
  t(PAD, gridBottom + 22,
    'Cycles are the no-page-crossing case: + adds one when an indexed address crosses a page, ' +
    '++ is a branch (+1 taken, +2 taken across a page).',
    { f: SANS, s: 11.5, c: FAINT });

  const keyTop = gridBottom + 54;
  t(PAD, keyTop, 'ADDRESSING MODES', { f: SANS, s: 11.5, w: 700, c: MUTED, ls: 1.5 });
  const COLS = 3, KW = gridW / COLS, KH = 46;
  const rows = [...MODES, { id: 'undoc', c: UNDOC, label: 'Undocumented', bytes: null,
                            write: '', note: 'decoded by the chip, never published', n: nUndoc }];
  rows.forEach((m, i) => {
    const kx = PAD + (i % COLS) * KW, ky = keyTop + 24 + Math.floor(i / COLS) * KH;
    g.push(`<rect x="${kx}" y="${ky}" width="14" height="14" rx="2" fill="${m.c}"` +
           (m.id === 'undoc' ? ` stroke="#D6D9DF"` : '') + `/>`);
    t(kx + 22, ky + 11, m.label, { s: 11.5, w: 600 });
    t(kx + 22, ky + 25, m.bytes ? `${m.bytes} byte${m.bytes > 1 ? 's' : ''}` +
      (m.write ? `  ${m.write}` : '') : 'various', { s: 9.5, c: MUTED });
    t(kx + KW - 16, ky + 11, String(m.n), { s: 10, c: MUTED, a: 'end' });
  });
  const keyBottom = keyTop + 24 + Math.ceil(rows.length / COLS) * KH;

  g.push(`<rect x="${PAD}" y="${keyBottom}" width="${gridW}" height="1" fill="${RULE}"/>`);
  t(PAD, keyBottom + 20,
    'Generated from isa/mos6502.toml by tools/gen-6502-map.js. Counts are of documented opcodes.',
    { f: SANS, s: 11, c: FAINT });
  const H = keyBottom + 46;

  process.stdout.write(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" ` +
    `viewBox="0 0 ${W} ${H}" role="img" aria-label="MOS 6502 opcode map"` +
    ` font-family="${MONO}" fill="${INK}">\n` +
    `<rect width="${W}" height="${H}" fill="#ffffff"/>\n` + g.join('\n') + `\n</svg>\n`);
  process.exit(0);
}

// =============================================================================
// HTML
// =============================================================================
const out = [];
const w = (s = '') => out.push(s);

w(`<title>6502 Opcode Map</title>`);
w(`<link rel="preconnect" href="https://fonts.googleapis.com">`);
w(`<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>`);
w(`<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans+Condensed:wght@400;600;700&display=swap">`);
w(`<style>
:root{
  --ground:#ffffff; --ink:#16181D; --muted:#6A7180; --faint:#9AA1AE;
  --rule:#E2E5EA; --undoc:${UNDOC}; --undoc-edge:#D6D9DF;
  --mono:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,monospace;
  --sans:"IBM Plex Sans Condensed","IBM Plex Sans",system-ui,-apple-system,sans-serif;
}
*{box-sizing:border-box}
body{background:var(--ground);color:var(--ink);font-family:var(--sans);
     margin:0;padding:40px 28px 64px;-webkit-font-smoothing:antialiased}
.page{max-width:940px;margin:0 auto;display:flex;flex-direction:column;gap:36px}

header{display:flex;flex-direction:column;gap:10px;border-bottom:2px solid var(--ink);padding-bottom:18px}
.eyebrow{font-family:var(--mono);font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--muted)}
h1{font-size:clamp(30px,5vw,44px);font-weight:700;letter-spacing:-.015em;margin:0;text-wrap:balance;line-height:1.02}
.lede{font-size:16px;color:var(--muted);max-width:62ch;margin:0;line-height:1.5}
.census{display:flex;flex-wrap:wrap;gap:28px;margin-top:6px;font-family:var(--mono);
        font-variant-numeric:tabular-nums}
.census div{display:flex;flex-direction:column;gap:2px}
.census b{font-size:22px;font-weight:600;letter-spacing:-.01em}
.census span{font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--faint)}

.matrix-wrap{overflow-x:auto;padding-bottom:4px}
.tail{font-size:12px;color:var(--faint);margin:12px 0 0;line-height:1.5}
.tail code{font-family:var(--mono);font-size:11.5px}
.matrix{display:grid;grid-template-columns:auto repeat(8,minmax(84px,1fr));gap:3px;min-width:760px}
.colhead,.rowhead{font-family:var(--mono);font-size:11px;color:var(--muted);
                  display:flex;align-items:center;justify-content:center;letter-spacing:.06em}
.rowhead{justify-content:flex-end;padding-right:9px;min-width:44px}
.cell{border-radius:3px;padding:5px 7px 6px;min-height:40px;display:flex;flex-direction:column;
      gap:1px;border:1px solid transparent;cursor:default}
.cell.undoc{border-color:var(--undoc-edge)}
.cell .op{font-family:var(--mono);font-size:9px;letter-spacing:.06em;color:rgba(0,0,0,.45)}
.cell .mn{font-family:var(--mono);font-size:13px;font-weight:600;line-height:1.15;color:#000}
.cell.undoc .mn{color:rgba(0,0,0,.55)}
.cell .sz{font-family:var(--mono);font-size:8.5px;letter-spacing:.1em;color:rgba(0,0,0,.42)}
.chd,.cft{display:flex;justify-content:space-between;align-items:baseline;gap:6px}
.cell .wr{font-family:var(--mono);font-size:9.5px;line-height:1.2;color:rgba(0,0,0,.62)}
.cell .cy{font-family:var(--mono);font-size:9px;color:rgba(0,0,0,.5);font-variant-numeric:tabular-nums}
.cell:focus-visible{outline:2px solid var(--ink);outline-offset:1px}

h2{font-size:13px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;margin:0 0 14px;
   color:var(--muted)}
.key{display:grid;grid-template-columns:repeat(auto-fill,minmax(288px,1fr));gap:2px 24px}
.krow{display:grid;grid-template-columns:20px 1fr auto;gap:11px;align-items:baseline;
      padding:7px 0;border-bottom:1px solid var(--rule)}
.swatch{width:20px;height:20px;border-radius:3px;position:relative;top:4px}
.klabel{font-family:var(--mono);font-size:12.5px;font-weight:600;color:var(--ink)}
.kbits{font-family:var(--mono);font-size:10.5px;color:var(--muted);margin-top:2px}
.knote{font-size:11.5px;color:var(--faint);margin-top:2px;line-height:1.35}
.kcount{font-family:var(--mono);font-size:11px;color:var(--muted);font-variant-numeric:tabular-nums}
footer{font-size:12px;color:var(--faint);line-height:1.6;border-top:1px solid var(--rule);padding-top:16px}
footer code{font-family:var(--mono);font-size:11.5px;color:var(--muted)}
footer p{margin:0 0 10px}
footer p:last-child{margin:0}

.tip{position:fixed;z-index:20;pointer-events:none;max-width:340px;
     background:var(--ink);color:#F4F5F7;border-radius:5px;padding:9px 12px 10px;
     box-shadow:0 6px 20px rgba(20,24,34,.28);opacity:0;transition:opacity .07s linear}
.tip.on{opacity:1}
.tip .thead{display:flex;align-items:center;gap:7px;margin-bottom:5px}
.tip .tsw{width:10px;height:10px;border-radius:2px;flex:none}
.tip .top{font-family:var(--mono);font-size:10px;letter-spacing:.1em;color:#9AA3B4}
.tip .twrite{font-family:var(--mono);font-size:13px;font-weight:500;color:#fff;
             margin-bottom:6px;word-break:break-word}
.tip .tmode{font-size:12px;color:#DDE1E8;line-height:1.35}
.tip .tbits{font-family:var(--mono);font-size:10.5px;color:#8F97A8;margin-top:3px}
@media (prefers-reduced-motion: reduce){ .tip{transition:none} }
</style>`);

w(`<div class="page">`);
w(`<header>`);
w(`  <div class="eyebrow">MOS 6502 &middot; NMOS &middot; first-byte decode</div>`);
w(`  <h1>6502 Opcode Map</h1>`);
w(`  <p class="lede">Every instruction's length is fixed by its opcode byte, so this table is the whole decoder. Columns are the low three bits, rows the high five.</p>`);
w(`  <div class="census">`);
w(`    <div><b>${nDoc}</b><span>documented</span></div>`);
w(`    <div><b>${nUndoc}</b><span>undocumented</span></div>`);
w(`    <div><b>${MODES.length}</b><span>addressing modes</span></div>`);
w(`    <div><b>${nMnem}</b><span>instructions</span></div>`);
w(`  </div>`);
w(`</header>`);

w(`<div class="matrix-wrap"><div class="matrix">`);
w(`  <div class="corner"></div>`);
for (let x = 0; x < 8; x++) w(`  <div class="colhead">&middot;${x}</div>`);
for (let row = 0; row < 32; row++) {
  w(`  <div class="rowhead">${hex2(row * 8)}</div>`);
  for (let x = 0; x < 8; x++) {
    const o = ops[row * 8 + x];
    const write = `${o.mnemonic}${o.write ? ' ' + o.write : ''}`;
    w(`  <div class="cell${o.undoc ? ' undoc' : ''}" tabindex="0"` +
      ` style="background:${o.undoc ? UNDOC : COLOUR[o.mode]}"` +
      ` data-op="${hex2(o.code)}" data-write="${esc(write)}" data-mode="${esc(o.label)}"` +
      ` data-bits="${o.bytes} byte${o.bytes > 1 ? 's' : ''} &middot; ${esc(o.cycles)} cycles"` +
      ` data-undoc="${o.undoc ? 1 : ''}" data-colour="${o.undoc ? UNDOC : COLOUR[o.mode]}">` +
      `<div class="chd"><span class="op">${hex2(o.code)}</span>` +
      `<span class="sz">${o.bytes}B</span></div>` +
      `<div class="mn">${o.undoc ? '&middot;' : ''}${o.mnemonic}</div>` +
      `<div class="cft"><span class="wr">${esc(o.write || '—')}</span>` +
      `<span class="cy">${esc(o.cycles)}</span></div></div>`);
  }
}
w(`</div></div>`);
w(`<p class="tail">Cycles are the case where nothing crosses a page. <code>+</code> adds one when an indexed address crosses a page boundary; <code>++</code> marks a branch, which costs one more when taken and two when taken across a page. A dot before the mnemonic marks one of the ${nUndoc} opcodes MOS never documented.</p>`);

w(`<section>`);
w(`<h2>Addressing modes</h2>`);
w(`<div class="key">`);
for (const m of MODES) {
  w(`  <div class="krow">` +
    `<div class="swatch" style="background:${m.c}"></div>` +
    `<div><div class="klabel">${esc(m.label)}</div>` +
    `<div class="kbits">${m.bytes} byte${m.bytes > 1 ? 's' : ''}${m.write ? '  ' + esc(m.write) : ''}</div>` +
    `<div class="knote">${m.note}</div></div>` +
    `<div class="kcount">${m.n}</div></div>`);
}
w(`  <div class="krow">` +
  `<div class="swatch" style="background:${UNDOC};border:1px solid var(--undoc-edge)"></div>` +
  `<div><div class="klabel">Undocumented</div><div class="kbits">various</div>` +
  `<div class="knote">decoded by the chip, never published by MOS</div></div>` +
  `<div class="kcount">${nUndoc}</div></div>`);
w(`</div>`);
w(`</section>`);

w(`<footer>`);
w(`<p>Generated from <code>isa/mos6502.toml</code> by <code>tools/gen-6502-map.js</code>, which refuses to draw a map that fails its own arithmetic: 256 opcodes, ${nDoc} documented, ${nMnem} instructions, ${MODES.length} addressing modes.</p>`);
w(`<p><b>The regular part.</b> An opcode is <code>aaabbbcc</code>: <code>cc</code> picks the group, <code>bbb</code> the addressing mode, <code>aaa</code> the operation. Column <code>cc&nbsp;=&nbsp;01</code> &mdash; the accumulator group, every fourth cell starting at <code>01</code> &mdash; is all 64 combinations of eight operations with eight modes, and every one of them lands exactly where the bits say. It has one hole: <code>89</code> would be <code>STA&nbsp;#</code>, storing to a constant, so nothing was put there.</p>`);
w(`<p><b>The undocumented part.</b> Column <code>cc&nbsp;=&nbsp;11</code> is empty in the data sheet and full on the die. Those 64 opcodes drive the read-modify-write group and the accumulator group at once, which is why they do two things at a time and why their names are portmanteaux: <code>SLO</code> is <code>ASL</code> then <code>ORA</code>, <code>DCP</code> is <code>DEC</code> then <code>CMP</code>. Twelve more hang the processor until reset. They are drawn here because the alternative &mdash; blank cells &mdash; would describe a chip that was never made.</p>`);
w(`</footer>`);
w(`<div class="tip" id="tip" role="tooltip" hidden></div>`);
w(`<script>`);
w(`(function () {`);
w(`  var tip = document.getElementById('tip');`);
w(`  function show(cell) {`);
w(`    var d = cell.dataset;`);
w(`    tip.innerHTML =`);
w(`      '<div class="thead"><span class="tsw" style="background:' + d.colour + '"></span>' +`);
w(`      '<span class="top">$' + d.op + (d.undoc ? ' &middot; undocumented' : '') + '</span></div>' +`);
w(`      '<div class="twrite">' + d.write + '</div>' +`);
w(`      '<div class="tmode">' + d.mode + '</div>' +`);
w(`      '<div class="tbits">' + d.bits + '</div>';`);
w(`    tip.hidden = false;`);
w(`    var r = cell.getBoundingClientRect(), t = tip.getBoundingClientRect();`);
w(`    var x = r.left + r.width / 2 - t.width / 2;`);
w(`    x = Math.max(8, Math.min(x, window.innerWidth - t.width - 8));`);
w(`    var above = r.top - t.height - 8;`);
w(`    tip.style.left = x + 'px';`);
w(`    tip.style.top = (above > 8 ? above : r.bottom + 8) + 'px';`);
w(`    tip.classList.add('on');`);
w(`  }`);
w(`  function hide() { tip.classList.remove('on'); tip.hidden = true; }`);
w(`  var grid = document.querySelector('.matrix');`);
w(`  grid.addEventListener('mouseover', function (e) {`);
w(`    var c = e.target.closest('.cell'); if (c) show(c);`);
w(`  });`);
w(`  grid.addEventListener('mouseout', function (e) {`);
w(`    if (!e.relatedTarget || !e.relatedTarget.closest('.cell')) hide();`);
w(`  });`);
w(`  grid.addEventListener('focusin', function (e) {`);
w(`    var c = e.target.closest('.cell'); if (c) show(c);`);
w(`  });`);
w(`  grid.addEventListener('focusout', hide);`);
w(`  window.addEventListener('scroll', hide, true);`);
w(`  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') hide(); });`);
w(`}());`);
w(`</` + `script>`);
w(`</div>`);

process.stdout.write(out.join('\n') + '\n');
console.error(`gen-6502-map: 256 opcodes, ${nDoc} documented, ${nUndoc} undocumented, ` +
              `${nMnem} instructions, ${MODES.length} addressing modes`);
