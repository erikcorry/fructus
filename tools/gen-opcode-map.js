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
const MODES = [
  { id: 'abbrev',  c: '#F8CE8B', label: 'One-byte abbreviation', bits: 'every operand pinned',           note: 'add r0, r0, #1 · mov r0, r1' },
  { id: 'special', c: '#E3A863', label: 'One-byte special',      bits: 'no operands at all',             note: 'ret · nop · halt' },

  { id: 'rrr',     c: '#9AC4E8', label: 'rd, ra, rb',            bits: 'reg 3 (split) + reg 3 + reg 3',  note: 'also the three-register push and pop' },
  { id: 'rr',      c: '#B9D9F2', label: 'rd, ra',                bits: 'reg 3 + reg 3',                  note: 'unary ALU, and the two-register push and pop' },
  { id: 'r',       c: '#D2E7F8', label: 'ra',                    bits: 'reg 3',                          note: 'single push, pop, and call through a register' },

  { id: 'rri3',    c: '#A6D9B4', label: 'rd, ra, #imm3',         bits: 'table 3 (split) + reg 3 + reg 3', note: 'shifts read the same three bits as #shift3' },
  { id: 'rri10',   c: '#CBE5A0', label: 'rd, ra, #imm10',        bits: 'reg 3 + reg 3 + int 10' },

  { id: 'ri5',     c: '#C6BEEC', label: 'rd, #imm5',             bits: 'reg 3 + int 5, signed',          note: '&minus;16 to 15, and the tied load displacement' },
  { id: 'rib5',    c: '#F2D6F2', label: 'rd, #1&lt;&lt;n',            bits: 'reg 3 + table 5',                note: 'the same five bits read as one of 32 masks: 1&lt;&lt;n and its complement' },
  { id: 'ri16',    c: '#DEC6F0', label: 'rd, #imm16',            bits: 'reg 3 + int 16 (split)' },

  { id: 'crrt',    c: '#F5C2DC', label: 'cond, ra, rb, target',  bits: 'reg 3 (split) + cond 3 + reg 3 + int 8' },
  { id: 'ckt',     c: '#E4A2C4', label: 'cond #k, ra, target',   bits: 'reg 3 + cond+const 5 + int 8' },
  { id: 'rmt',     c: '#F2B5A5', label: 'ra, #mask, target',     bits: 'reg 3 + table 5 + int 8',        note: 'brset and brclear' },
  { id: 't8',      c: '#FAD4D4', label: 'target, 8-bit',         bits: 'int 8',                          note: 'the unconditional branch' },
  { id: 't16',     c: '#F0AEAE', label: 'target, 16-bit',        bits: 'int 16 (split)',                 note: 'jmp, jmpr, call, callr' },
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
  cells.push({ b, mode, names, sub, bytes: forms[0].nbytes });
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
.cell .sz{margin-top:auto;font-family:var(--mono);font-size:8.5px;letter-spacing:.1em;
          color:rgba(0,0,0,.42);align-self:flex-end}

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
    if (!c) { w(`  <div class="cell free"><div class="op">${hex2(row * 8 + x)}</div></div>`); continue; }
    const m = MODE[c.mode];
    w(`  <div class="cell" style="background:${m.c}">` +
      `<div class="op">${hex2(c.b)}</div>` +
      `<div class="mn">${esc(c.names.join(' '))}</div>` +
      (c.sub ? `<div class="sub">${esc(c.sub)}</div>` : '') +
      `<div class="sz">${c.bytes}B</div></div>`);
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
w(`</div>`);

process.stdout.write(out.join('\n') + '\n');
