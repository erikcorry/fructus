#!/usr/bin/env node
// =============================================================================
// gen-opcode-map.js - an HTML opcode map, from isa/fructus.toml
// =============================================================================
//
//     node tools/gen-opcode-map.js > build/opcodes.html
//
// 256 first bytes, 8 across by 32 down, coloured by ADDRESSING MODE - which is
// derived from each form's actual bit layout rather than from its `name`, since
// form names collide across instructions (ld8's `reg_reg` is rd, [ra, #off]
// while sxt8's is rd, ra).  Two layouts that differ only in which value table a
// field indexes are the same addressing mode and share a colour: imm3 and
// shift3 are the identical three split bits, and the spec says so.
// =============================================================================

import { loadSpec } from './isa.js';
import { buildDecoder, decode, render } from './decode.js';

const spec = loadSpec();
const dec  = buildDecoder(spec);

// --- the modes, in key order -------------------------------------------------
// `hue` is not decoration: the family says what kind of operand the mode takes,
// so the map reads at two levels - the individual colour, and the group.
// `label` names the LAYOUT, not one member's syntax.  Calling the
// three-register layout "rd, ra, rb" was fine while only the ALU used it and
// wrong as soon as push did - a push has no destination.  So the label
// describes the bit shape, `bits` gives the exact widths, `note` names real
// instructions with their real operand letters, and each cell prints its own
// syntax.  Four grains, none of them contradicting another.
const MODES = [
  { id: 'abbrev',  c: '#F8CE8B', label: 'One-byte abbreviation', bits: 'every operand pinned',            note: 'add r0, r0, #1 &middot; mov r0, r1' },
  { id: 'special', c: '#E3A863', label: 'One-byte special',      bits: 'no operands at all',              note: 'ret &middot; nop &middot; halt' },

  { id: 'rrr',     c: '#9AC4E8', label: 'Three registers',       bits: 'reg 3 (split) + reg 3 + reg 3',   note: 'add rd, ra, rb &middot; push ra, rb, rc' },
  { id: 'rr',      c: '#B9D9F2', label: 'Two registers',         bits: 'reg 3 + reg 3',                   note: 'push ra, rb &middot; and the unary ALU ops, whose third operand is the opcode' },
  { id: 'r',       c: '#D2E7F8', label: 'One register',          bits: 'reg 3',                           note: 'push ra &middot; pop ra &middot; call ra' },

  { id: 'rri3',    c: '#A6D9B4', label: 'Two registers, 3-bit table', bits: 'table 3 (split) + reg 3 + reg 3', note: 'ld rd, [ra, #off] &middot; st rs, [ra, #off] &middot; add rd, ra, #imm3. Shifts read the same three bits as #shift3' },
  { id: 'rri10',   c: '#CBE5A0', label: 'Two registers, 10-bit', bits: 'reg 3 + reg 3 + int 10',          note: 'the wide displacement and immediate forms' },

  { id: 'ri5',     c: '#C6BEEC', label: 'One register, 5-bit signed', bits: 'reg 3 + int 5, signed',      note: '&minus;16 to 15, and the tied load displacement' },
  { id: 'rib5',    c: '#F2D6F2', label: 'One register, 5-bit mask',   bits: 'reg 3 + table 5',            note: 'the same five bits read as one of 32 masks: 1&lt;&lt;n and its complement' },
  { id: 'ri16',    c: '#DEC6F0', label: 'One register, 16-bit', bits: 'reg 3 + int 16 (split)',           note: 'mov rd, #imm16' },

  { id: 'crrt',    c: '#F5C2DC', label: 'Condition, two registers, target', bits: 'reg 3 (split) + cond 3 + reg 3 + int 8', note: 'br cond, ra, rb, target' },
  { id: 'ckt',     c: '#E4A2C4', label: 'Packed condition, register, target', bits: 'reg 3 + cond+const 5 + int 8', note: 'one five-bit field holds the condition AND the constant' },
  { id: 'rmt',     c: '#F2B5A5', label: 'Register, mask, target', bits: 'reg 3 + table 5 + int 8',        note: 'brset &middot; brclear' },
  { id: 't8',      c: '#FAD4D4', label: 'Target only, 8-bit',    bits: 'int 8',                           note: 'the short jmpr' },
  { id: 't16',     c: '#F0AEAE', label: 'Target only, 16-bit',   bits: 'int 16 (split)',                  note: 'jmp &middot; jmpr &middot; call &middot; callr' },
];
const MODE = Object.fromEntries(MODES.map((m) => [m.id, m]));

// --- classify one form by its bit layout -------------------------------------
function modeOf(c) {
  const parts = [];
  for (const [op, sl] of c.slices) {
    const w = sl.reduce((n, p) => n + p.hi - p.lo + 1, 0);
    parts.push(`${c.encType.get(op)}:${w}`);
  }
  const has = (t) => parts.some((p) => p.startsWith(t));
  const n = parts.length;

  if (n === 0) return (c.insn.operands ?? []).length ? 'abbrev' : 'special';

  if (c.nbytes === 2) {
    if (n === 3) return has('reg:3') && parts.filter((p) => p === 'reg:3').length === 3 ? 'rrr' : 'rri3';
    if (n === 2) {
      if (parts.every((p) => p === 'reg:3')) return 'rr';
      // Same layout as imm5, different value table - and unlike imm3 against
      // shift3, which are one set of values reinterpreted, these are disjoint
      // vocabularies: signed -16..15 against 32 single-bit masks.
      return has('immbit5') ? 'rib5' : 'ri5';
    }
    return has('reg:3') ? 'r' : 't8';
  }
  // three bytes
  if (n === 1) return 't16';
  if (n === 2) return 'ri16';
  if (n === 3) return has('condimm5') ? 'ckt' : has('immbit5') ? 'rmt' : 'rri10';
  return 'crrt';
}

// --- what a programmer would actually write ----------------------------------
// `or rd, ra, #0` is spelled `mov rd, ra`, and the spec says so with
// `prefer = true` on the alias.  A match is only claimed when the form PINS
// every operand the alias needs as a constant - otherwise a general `or` whose
// immediate happened to decode as 0 would masquerade as a mov.
function preferred(d) {
  for (const a of spec.alias ?? []) {
    if (!a.prefer || a.expand?.mnemonic !== d.insn.mnemonic) continue;
    const params = new Set((a.operands ?? []).map((o) => o.name));
    const fix = d.form.fix ?? {};
    const bind = {};
    let ok = true;
    for (const [target, arg] of Object.entries(a.expand.args ?? {})) {
      if (typeof arg === 'string' && params.has(arg)) { bind[arg] = d.ops[target]; continue; }
      if (!(target in fix) || fix[target] !== arg) { ok = false; break; }
    }
    if (!ok) continue;
    const regs = spec.optype.reg.names;
    const text = (a.syntax ?? '').replace(/\{(\w+)\}/g, (_, n) => {
      const decl = (a.operands ?? []).find((o) => o.name === n);
      const v = bind[n];
      if (v === undefined) return `{${n}}`;
      return decl?.type === 'reg' ? regs[v] : String(v);
    });
    return { mnemonic: a.mnemonic, text };
  }
  return null;
}

// --- the operand shape a programmer writes ----------------------------------
// The syntax template with the operand NAMES left in rather than values, so
// {d}, [{a}, #{off}] reads as rd, [ra, #off].  This is what the tooltip shows,
// because "which addressing mode" is really the question "what do I write".
// The width comes from the ENCODED type, which is a property of the form and
// not of the instruction: `ld rd, [ra, #off]` carries a 3-bit displacement at
// 0x2a and a 10-bit one at 0x2c, and those are the same instruction.  So an
// immediate prints as its operand name plus how many bits this form gives it -
// #off3, #off10, #imm5, #imm16 - which is the number a programmer actually
// needs and the one thing the mnemonic never says.
//
// immbit5 prints its own name instead of a width.  Five bits is not what makes
// it what it is; being 32 single-bit masks is, and #immbit5 says so where
// #imm5 would be an outright lie about which values fit.
function shape(insn, form) {
  const decl = Object.fromEntries((insn.operands ?? []).map((o) => [o.name, o]));

  // TWO OPERANDS JOINED BY `tie` ARE ONE REGISTER FIELD and must print with one
  // name.  `ld rd, [ra, #off5]` is a lie: that form has a single 3-bit register
  // field serving as both destination and address, so it can only ever be
  // `ld rd, [rd, #off5]` - which is the whole reason it fits in two bytes, and
  // the reason it earns its opcode on a load and not on a store.
  //
  // The surviving name is whichever the syntax mentions first, because that is
  // the one the reader meets first.
  const syn = insn.syntax ?? '';
  const pos = (name) => { const i = syn.indexOf('{' + name + '}'); return i < 0 ? 1e9 : i; };
  const same = {};
  for (const [k, v] of Object.entries(form?.form?.tie ?? {})) {
    const win = pos(k) <= pos(v) ? k : v;
    same[k] = win; same[v] = win;
  }

  return syn.replace(/\{(\w+)(?:\.(\w+))?\}/g, (_, raw, part) => {
    if (part) return part;                      // combo parts: cond, imm
    const n = same[raw] ?? raw;
    const d = decl[n];
    if (d?.type === 'reg') return 'r' + n;      // rd, ra, rb, rc, rs
    if (d?.pcrel || n === 'target') return 'target';
    const enc = form?.encType.get(raw);
    if (!enc) return n;                         // pinned or tied: no field
    if (enc === 'immbit5') return 'immbit5';
    // Only a SIZED immediate gets a width.  A condition is an enum - cond3 is
    // the type's name, not a useful thing to print after "cond" - and a target
    // gets its reach from the mode label instead, which says so in words.
    const t = spec.optype[enc];
    return (t?.kind === 'int' || t?.kind === 'table') ? n + t.bits : n;
  });
}

// --- one cell per first byte -------------------------------------------------
const mem = new Uint8Array(0x10000);
const cells = [];
for (let b = 0; b < 256; b++) {
  const forms = dec.table[b];
  if (!forms.length) { cells.push(null); continue; }

  const mode = modeOf(forms[0]);
  let names = [...new Set(forms.map((f) => f.insn.mnemonic))];

  // A one-byte abbreviation is only interesting for what it abbreviates, so
  // decode it and print the operands it has pinned.
  let sub = '';
  if (forms[0].nbytes === 1 || mode === 't8') {
    mem[0] = b;
    const d = decode(dec, mem, 0);
    if (d) {
      const pref = preferred(d);
      if (pref) { names = [pref.mnemonic]; if (mode === 'abbrev') sub = pref.text; }
      else if (mode === 'abbrev') sub = render(spec, d).slice(d.insn.mnemonic.length).trim();
    }
  }
  // MORE THAN ONE INSTRUCTION ON ONE FIRST BYTE means the literal bits left
  // over in byte 1 are an operation selector, not padding - which is the whole
  // reason the unary operations fit eight operations into two opcodes.  So
  // their shape gets a third operand, `#op`, and reads as
  //
  //     rd, ra, #op
  //
  // which is the same shape as `rd, ra, #imm3` directly above and below them
  // in columns .2 and .3.  That is not a coincidence dressed up: byte 1 really
  // is ddda_aass, two register fields and a small one, and the selector really
  // is the third operand - it just happens to be spelled in the opcode.
  const selector = forms.length > 1;
  const shapes = [...new Set(forms.map((c) => shape(c.insn, c)))];
  cells.push({ b, mode, names, sub, bytes: forms[0].nbytes,
               shape: shapes.join('  /  ') + (selector ? ', #op' : '') });
}

const used  = cells.filter(Boolean).length;

// The map stops after the last assigned row.  Everything past it is one
// unbroken free block, and thirteen blank rows of it say nothing the count
// below the table does not say better.
const lastRow = Math.floor(cells.findLastIndex(Boolean) / 8);
const tailFrom = (lastRow + 1) * 8;
const count = (id) => cells.filter((c) => c && c.mode === id).length;
const esc = (s) => String(s).replace(/&(?!\w+;|#)/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// --- emit --------------------------------------------------------------------
const hex2 = (n) => n.toString(16).padStart(2, '0');

// =============================================================================
// SVG output:  node tools/gen-opcode-map.js --svg > docs/opcodes.svg
// =============================================================================
//
// WHY SVG AND NOT PNG.  GitHub strips <style>, <script>, class and style from
// HTML in a README, so the interactive map cannot be embedded there - but an
// SVG referenced as an image renders fine, stays sharp at any zoom, and is a
// few tens of kilobytes.  A PNG would need a headless browser in the build,
// which is a large dependency for a picture that this file can draw directly.
//
// The one constraint is fonts: a webfont will not load inside a proxied image,
// so this uses generic families only and lays out text on the assumption that
// a monospace advance is 0.6em, which is true of every common one.
if (process.argv.includes('--svg')) {
  const PAD = 26, CW = 104, CH = 62, GAP = 3, GUT = 40, COLH = 20;
  const gridW = GUT + 8 * CW + 7 * GAP;
  const W = PAD * 2 + gridW;
  const MONO = "ui-monospace,'DejaVu Sans Mono','Liberation Mono',Menlo,monospace";
  const SANS = "'DejaVu Sans','Liberation Sans',Helvetica,Arial,sans-serif";
  const INK = '#16181D', MUTED = '#6A7180', FAINT = '#9AA1AE', RULE = '#E2E5EA';

  const g = [];
  // The mono stack is set once on the root and inherited; only sans text
  // carries the attribute.  Deliberately not an internal <style> element - a
  // sanitiser that strips it would take the whole typeface with it, and this
  // file has to survive being served by someone else.
  const t = (x, y, s, o = {}) => g.push(
    `<text x="${x}" y="${y}"` + (o.f === SANS ? ` font-family="${SANS}"` : ``) +
    ` font-size="${o.s ?? 12}"` +
    (o.w ? ` font-weight="${o.w}"` : '') + ` fill="${o.c ?? INK}"` +
    (o.a ? ` text-anchor="${o.a}"` : '') +
    (o.ls ? ` letter-spacing="${o.ls}"` : '') + `>${esc(s)}</text>`);

  // Greedy wrap to a character budget - monospace, so characters are the unit.
  const wrap = (str, budget) => {
    const out = [];
    let line = '';
    for (const word of str.split(' ')) {
      if (!line) line = word;
      else if (line.length + 1 + word.length <= budget) line += ' ' + word;
      else { out.push(line); line = word; }
    }
    if (line) out.push(line);
    return out;
  };

  // --- header ---------------------------------------------------------------
  let y = PAD;
  t(PAD, y + 11, 'FRUCTUS · 16-BIT · FIRST-BYTE DECODE', { s: 10, c: MUTED, ls: 1.4 });
  t(PAD, y + 50, 'Opcode Map', { f: SANS, s: 34, w: 700 });
  t(PAD, y + 72, "Instruction length comes from the first byte alone, so this table is the whole decoder.",
    { f: SANS, s: 12.5, c: MUTED });
  const stats = [[used, 'assigned'], [256 - used, 'free'], [MODES.length, 'addressing modes'],
                 [spec.insn.length, 'instruction entries']];
  let sx = PAD;
  for (const [n, label] of stats) {
    t(sx, y + 104, String(n), { s: 20, w: 600 });
    t(sx, y + 118, label.toUpperCase(), { s: 8.5, c: FAINT, ls: 1.2 });
    sx += Math.max(String(n).length * 13, label.length * 6.2) + 26;
  }
  g.push(`<rect x="${PAD}" y="${y + 130}" width="${gridW}" height="2" fill="${INK}"/>`);

  // --- the matrix -----------------------------------------------------------
  const gridTop = y + 152;
  for (let x = 0; x < 8; x++)
    t(PAD + GUT + x * (CW + GAP) + CW / 2, gridTop + 13, '·' + x,
      { s: 10, c: MUTED, a: 'middle' });

  const rowTop = (r) => gridTop + COLH + r * (CH + GAP);
  for (let row = 0; row <= lastRow; row++) {
    const ry = rowTop(row);
    t(PAD + GUT - 9, ry + CH / 2 + 4, hex2(row * 8), { s: 10, c: MUTED, a: 'end' });
    for (let x = 0; x < 8; x++) {
      const cx = PAD + GUT + x * (CW + GAP);
      const c = cells[row * 8 + x];
      if (!c) {
        g.push(`<rect x="${cx}" y="${ry}" width="${CW}" height="${CH}" rx="3" fill="#fff" stroke="${RULE}"/>`);
        t(cx + 8, ry + 15, hex2(row * 8 + x), { s: 9, c: '#B9BFC9' });
        continue;
      }
      g.push(`<rect x="${cx}" y="${ry}" width="${CW}" height="${CH}" rx="3" fill="${MODE[c.mode].c}"/>`);
      t(cx + 8, ry + 14, hex2(c.b), { s: 9, c: 'rgba(0,0,0,.45)' });
      t(cx + CW - 8, ry + 14, c.bytes + 'B', { s: 8.5, c: 'rgba(0,0,0,.42)', a: 'end' });
      const lines = wrap(c.names.join(' '), Math.floor((CW - 16) / (13 * 0.6)));
      lines.forEach((ln, i) => t(cx + 8, ry + 31 + i * 12, ln, { s: 13, w: 600, c: '#000' }));

      // THE MODE IS PRINTED, NOT HOVERED.  An SVG loaded through <img> - which
      // is how a README embeds it - renders in secure static mode: no script,
      // no pointer events, and <title> tooltips never fire.  So the thing the
      // HTML puts in a tooltip has to be on the face of the cell here.
      //
      // It prints THIS INSTRUCTION'S operand shape rather than the key's mode
      // label, because one label cannot be right for every cell that shares a
      // layout.  `add rd, ra, rb` and `push ra, rb, rc` are the same three
      // register fields and the same colour, but a push has no destination, so
      // calling its first operand rd would be wrong.  A store says rs.  The
      // shape comes from the instruction's own syntax, so it cannot disagree
      // with what the assembler accepts.
      //
      // A one-byte abbreviation shows its pinned operands instead.  Its colour
      // already says which mode it is, and what it abbreviates is the only
      // thing about it worth the room.
      const foot = c.sub ? [c.sub]
                         : wrap(c.shape, Math.floor((CW - 16) / (8.5 * 0.6)));
      foot.forEach((ln, i) => t(cx + 8, ry + 31 + lines.length * 12 + 2 + i * 10, ln,
                                { s: 8.5, c: 'rgba(0,0,0,.62)' }));

      // Nothing may fall out of the bottom of a cell.  Two mnemonic lines and
      // two footer lines would, and today no cell has both - the only
      // two-line mnemonics are the unary ops, whose mode is "rd, ra".  This
      // asserts that rather than trusting it to stay true.
      const lowest = 31 + lines.length * 12 + 2 + (foot.length - 1) * 10 + 3;
      if (lowest > CH)
        throw new Error(`0x${hex2(c.b)}: ${lines.length} name lines and ${foot.length} ` +
                        `footer lines need ${lowest}px, cell is ${CH}px`);
    }
  }
  const gridBottom = rowTop(lastRow) + CH;
  t(PAD, gridBottom + 22,
    `Rows below ${hex2(tailFrom)} are omitted: ${256 - tailFrom} unbroken free opcodes run from ` +
    `${hex2(tailFrom)} to ff.`, { f: SANS, s: 11.5, c: FAINT });

  // --- key ------------------------------------------------------------------
  const keyTop = gridBottom + 52;
  t(PAD, keyTop, 'ADDRESSING MODES', { f: SANS, s: 11.5, w: 700, c: MUTED, ls: 1.5 });
  const COLS = 3, KW = gridW / COLS, KH = 46;
  MODES.forEach((m, i) => {
    const kx = PAD + (i % COLS) * KW, ky = keyTop + 24 + Math.floor(i / COLS) * KH;
    g.push(`<rect x="${kx}" y="${ky}" width="14" height="14" rx="2" fill="${m.c}"/>`);
    t(kx + 22, ky + 11, m.label.replace(/&lt;/g, '<'), { s: 11.5, w: 600 });
    t(kx + 22, ky + 25, m.bits, { s: 9.5, c: MUTED });
    t(kx + KW - 16, ky + 11, String(count(m.id)), { s: 10, c: MUTED, a: 'end' });
  });
  const keyBottom = keyTop + 24 + Math.ceil(MODES.length / COLS) * KH;

  g.push(`<rect x="${PAD}" y="${keyBottom}" width="${gridW}" height="1" fill="${RULE}"/>`);
  t(PAD, keyBottom + 20, 'Generated from isa/fructus.toml by tools/gen-opcode-map.js.',
    { f: SANS, s: 11, c: FAINT });
  const H = keyBottom + 46;

  process.stdout.write(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" ` +
    `viewBox="0 0 ${W} ${H}" role="img" aria-label="Fructus opcode map"` +
    ` font-family="${MONO}" fill="${INK}">\n` +
    `<rect width="${W}" height="${H}" fill="#ffffff"/>\n` + g.join('\n') + `\n</svg>\n`);
  process.exit(0);
}


const out = [];
const w = (s = '') => out.push(s);

w(`<title>Fructus Opcode Map</title>`);
w(`<link rel="preconnect" href="https://fonts.googleapis.com">`);
w(`<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>`);
w(`<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans+Condensed:wght@400;600;700&display=swap">`);
w(`<style>
:root{
  --ground:#ffffff; --ink:#16181D; --muted:#6A7180; --faint:#9AA1AE;
  --rule:#E2E5EA; --empty:#F6F7F9; --empty-ink:#B9BFC9;
  --mono:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,monospace;
  --sans:"IBM Plex Sans Condensed","IBM Plex Sans",system-ui,-apple-system,sans-serif;
}
*{box-sizing:border-box}
body{background:var(--ground);color:var(--ink);font-family:var(--sans);
     margin:0;padding:40px 28px 64px;-webkit-font-smoothing:antialiased}
.page{max-width:940px;margin:0 auto;display:flex;flex-direction:column;gap:36px}

/* --- header ------------------------------------------------------------- */
header{display:flex;flex-direction:column;gap:10px;border-bottom:2px solid var(--ink);padding-bottom:18px}
.eyebrow{font-family:var(--mono);font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--muted)}
h1{font-size:clamp(30px,5vw,44px);font-weight:700;letter-spacing:-.015em;margin:0;text-wrap:balance;line-height:1.02}
.lede{font-size:16px;color:var(--muted);max-width:62ch;margin:0;line-height:1.5}
.census{display:flex;flex-wrap:wrap;gap:28px;margin-top:6px;font-family:var(--mono);
        font-variant-numeric:tabular-nums}
.census div{display:flex;flex-direction:column;gap:2px}
.census b{font-size:22px;font-weight:600;letter-spacing:-.01em}
.census span{font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--faint)}

/* --- the matrix --------------------------------------------------------- */
.matrix-wrap{overflow-x:auto;padding-bottom:4px}
.tail{font-size:12px;color:var(--faint);margin:12px 0 0;font-family:var(--sans)}
.tail code{font-family:var(--mono);font-size:11.5px}
.tail b{font-family:var(--mono);font-weight:600;color:var(--muted);font-variant-numeric:tabular-nums}
.matrix{display:grid;grid-template-columns:auto repeat(8,minmax(84px,1fr));gap:3px;min-width:760px}
.colhead,.rowhead{font-family:var(--mono);font-size:11px;color:var(--muted);
                  display:flex;align-items:center;justify-content:center;letter-spacing:.06em}
.rowhead{justify-content:flex-end;padding-right:9px;min-width:44px}
.corner{}
.cell{border-radius:3px;padding:6px 7px 7px;min-height:50px;display:flex;flex-direction:column;
      gap:2px;background:var(--empty);border:1px solid transparent}
.cell .op{font-family:var(--mono);font-size:9px;letter-spacing:.06em;color:rgba(0,0,0,.45)}
.cell .mn{font-family:var(--mono);font-size:13px;font-weight:600;line-height:1.15;color:#000;
          word-break:break-word}
.cell .sub{font-family:var(--mono);font-size:9.5px;line-height:1.25;color:rgba(0,0,0,.62);
           word-break:break-word}
.cell.free{border:1px solid var(--rule);background:var(--ground)}
.cell.free .op{color:var(--empty-ink)}
.chd{display:flex;justify-content:space-between;align-items:baseline;gap:6px}
.cell .sz{font-family:var(--mono);font-size:8.5px;letter-spacing:.1em;color:rgba(0,0,0,.42)}

/* --- key ---------------------------------------------------------------- */
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
/* --- tooltip ------------------------------------------------------------ */
/* One shared card, positioned from script and living outside .matrix-wrap,
   because that container scrolls and would clip anything drawn inside a cell. */
.cell{cursor:default}
.cell:focus-visible{outline:2px solid var(--ink);outline-offset:1px}
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
w(`  <div class="eyebrow">Fructus &middot; 16-bit &middot; first-byte decode</div>`);
w(`  <h1>Opcode Map</h1>`);
w(`  <p class="lede">Every instruction's length is decided by its first byte alone, so this table is the whole decoder. Columns are the low three bits, rows the high five.</p>`);
w(`  <div class="census">`);
w(`    <div><b>${used}</b><span>assigned</span></div>`);
w(`    <div><b>${256 - used}</b><span>free</span></div>`);
w(`    <div><b>${MODES.length}</b><span>addressing modes</span></div>`);
w(`    <div><b>${spec.insn.length}</b><span>instruction entries</span></div>`);
w(`  </div>`);
w(`</header>`);

w(`<div class="matrix-wrap"><div class="matrix">`);
w(`  <div class="corner"></div>`);
for (let x = 0; x < 8; x++) w(`  <div class="colhead">&middot;${x}</div>`);
for (let row = 0; row <= lastRow; row++) {
  w(`  <div class="rowhead">${hex2(row * 8)}</div>`);
  for (let x = 0; x < 8; x++) {
    const c = cells[row * 8 + x];
    if (!c) {
      // Free cells get a tooltip on hover but are NOT tab stops: 110 assigned
      // cells is already a long tab sequence, and "unassigned" is what the
      // blank cell already says.
      w(`  <div class="cell free" data-op="${hex2(row * 8 + x)}" data-free="1">` +
        `<div class="op">${hex2(row * 8 + x)}</div></div>`);
      continue;
    }
    const m = MODE[c.mode];
    const write = c.sub ? `${c.names[0]} ${c.sub}` : `${c.names.join(' / ')} ${c.shape}`.trim();
    w(`  <div class="cell" tabindex="0" style="background:${m.c}"` +
      ` data-op="${hex2(c.b)}" data-write="${esc(write)}" data-mode="${m.label}"` +
      ` data-bits="${m.bits}" data-size="${c.bytes}" data-colour="${m.c}">` +
      `<div class="chd"><span class="op">${hex2(c.b)}</span>` +
      `<span class="sz">${c.bytes}B</span></div>` +
      `<div class="mn">${esc(c.names.join(' '))}</div>` +
      (c.sub ? `<div class="sub">${esc(c.sub)}</div>` : '') + `</div>`);
  }
}
w(`</div></div>`);
w(`<p class="tail">Rows below <code>${hex2(tailFrom)}</code> are omitted: ` +
  `<b>${256 - tailFrom}</b> unbroken free opcodes run from <code>${hex2(tailFrom)}</code> to <code>ff</code>.</p>`);

w(`<section>`);
w(`<h2>Addressing modes</h2>`);
w(`<div class="key">`);
for (const m of MODES) {
  w(`  <div class="krow">` +
    `<div class="swatch" style="background:${m.c}"></div>` +
    `<div><div class="klabel">${m.label}</div><div class="kbits">${m.bits}</div>` +
    (m.note ? `<div class="knote">${m.note}</div>` : '') + `</div>` +
    `<div class="kcount">${count(m.id)}</div></div>`);
}
w(`</div>`);
w(`</section>`);

w(`<footer>Generated from <code>isa/fructus.toml</code> by <code>tools/gen-opcode-map.js</code>. ` +
  `Modes come from each form's bit layout, not its name. Where two layouts differ only in how one field is <em>read</em> they share a colour: <code>#imm3</code> and <code>#shift3</code> are one set of values reinterpreted, with no extra hardware behind either. <code>#imm5</code> and <code>#1&lt;&lt;n</code> are kept apart because their vocabularies are disjoint &mdash; signed &minus;16 to 15 against 32 masks. `+
  `Opcodes <code>12</code> and <code>13</code> carry several mnemonics apiece: the unary operations share two first bytes and separate on a field in byte&nbsp;1.</footer>`);
w(`<div class="tip" id="tip" role="tooltip" hidden></div>`);
w(`<script>`);
w(`(function () {`);
w(`  var tip = document.getElementById('tip');`);
w(`  function show(cell) {`);
w(`    var d = cell.dataset;`);
w(`    if (d.free) {`);
w(`      tip.innerHTML = '<div class="thead"><span class="top">0x' + d.op + '</span></div>' +`);
w(`        '<div class="twrite">unassigned</div>';`);
w(`    } else {`);
w(`      tip.innerHTML =`);
w(`        '<div class="thead"><span class="tsw" style="background:' + d.colour + '"></span>' +`);
w(`        '<span class="top">0x' + d.op + ' &middot; ' + d.size + ' byte' + (d.size === '1' ? '' : 's') + '</span></div>' +`);
w(`        '<div class="twrite">' + d.write + '</div>' +`);
w(`        '<div class="tmode">' + d.mode + '</div>' +`);
w(`        '<div class="tbits">' + d.bits + '</div>';`);
w(`    }`);
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
