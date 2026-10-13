#!/usr/bin/env node
// =============================================================================
// gen-manual.js - the instruction set reference, as a PDF
// =============================================================================
//
//   node tools/gen-manual.js > build/fructus-isa.pdf
//
// A page per mnemonic in the style of Intel's SDM volume 2: a table of every
// encoding, then each encoding drawn bit by bit, the operand tables it uses,
// what it does, and the notes the spec carries for it.  Everything is read
// from isa/fructus.toml - including the notes, which are the comments above
// each [[insn]] and [[insn.form]] - so the manual cannot describe an encoding
// the assembler does not produce.
//
// The cycle counts come from tools/sim.js's own reading of the semantics,
// Machine.classify, turned into text with the rules of Machine.timing.  A
// change to the cost model has to be made in both places; the cost model in
// the spec says which rule each class follows.
// =============================================================================

import { readFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { loadSpec, root, decodeEncoding, encodedBits, intRange } from './isa.js';
import { Machine } from './sim.js';
import { Pdf, A4, width } from './pdf.js';
import { brEquivalents, spellings } from './brequiv.js';

const spec  = loadSpec();
const types = spec.optype;
const machine = new Machine(spec);

// --- notes: the comments the spec keeps beside each entry -------------------
//
// The comment block directly above an [[insn]] or [[insn.form]], plus any
// whole-line comments inside the [[insn]] before its first form.  Banner rules
// are dropped; the rest is split into prose paragraphs and indented blocks,
// which are kept verbatim because they are usually diagrams or tables.

const source = readFileSync(join(root, 'isa/fructus.toml'), 'utf8').split('\n');
const uncomment = (l) => l.replace(/^\s*# ?/, '');
const commentAbove = (i) => {
  const out = [];
  for (let j = i - 1; j >= 0 && /^\s*#/.test(source[j]); j--) out.unshift(uncomment(source[j]));
  return out;
};

const insnNotes = [], formNotes = [], aliasNotes = [];
let inBody = false;
source.forEach((l, i) => {
  const t = l.trim();
  if (t === '[[insn]]') { insnNotes.push(commentAbove(i)); formNotes.push([]); inBody = true; }
  else if (t === '[[alias]]') { aliasNotes.push(commentAbove(i)); inBody = false; }
  else if (t === '[[insn.form]]') { formNotes[formNotes.length - 1].push(commentAbove(i)); inBody = false; }
  else if (t.startsWith('[')) inBody = false;
  else if (inBody && t.startsWith('#') && !/^\s*#/.test(source[i + 1] ?? '') && source[i + 1]?.trim() !== '[[insn.form]]') {
    // A comment inside the body that is not the lead-in to the first form.
    const block = commentAbove(i + 1);
    insnNotes[insnNotes.length - 1].push('', ...block);
  }
});
if (insnNotes.length !== spec.insn.length) throw new Error('gen-manual: [[insn]] count disagrees with the parser');
spec.insn.forEach((insn, i) => {
  if (formNotes[i].length !== insn.form.length) throw new Error(`gen-manual: ${insn.mnemonic}: form count disagrees`);
});

// A comment's own `byte 0:  0 0 1 1 ...` diagram is left out: the page draws
// every encoding from its `encoding`, and a hand-drawn copy can be stale.
const handDiagram = (l) => /^\s*byte \d:\s+([01a-z] ){7}[01a-z]\b/.test(l);

function paragraphs(lines) {
  const out = [];
  let cur = null;
  for (const raw of lines) {
    const t = raw.trim();
    if (handDiagram(raw)) continue;
    if (t === '' || /^(=+|-+|-{3} .* -+)$/.test(t)) { cur = null; continue; }
    if (/^\s{2}/.test(raw)) {
      if (!cur || !cur.pre) out.push(cur = { pre: true, lines: [] });
      cur.lines.push(raw);
    } else {
      if (!cur || cur.pre) out.push(cur = { pre: false, text: '' });
      cur.text += (cur.text ? ' ' : '') + t;
    }
  }
  for (const p of out) {
    if (!p.pre) continue;
    const indent = Math.min(...p.lines.map((l) => l.match(/^ */)[0].length));
    p.lines = p.lines.map((l) => l.slice(indent));
  }
  return out;
}

// --- reading a form ----------------------------------------------------------

const hex2 = (n) => n.toString(16).toUpperCase().padStart(2, '0');
const operand = (insn, name) => insn.operands.find((o) => o.name === name);
// An instruction with a single form need not name it.  An alias's rows are
// its target's forms, and are named as such - mov's own reg_imm5 is not or's.
const formName = (form, insn = null) =>
  (insn?.aliasOf ? `${insn.aliasOf.mnemonic}.` : '') + (form.name ?? '\u2014');

// The raw bits a field holds for a value, for a field an alias pins.
function rawField(typeName, v) {
  const t = types[typeName];
  if (t.kind === 'table') return t.values.indexOf(v);
  if (t.kind === 'reg' || t.kind === 'enum') return typeof v === 'number' ? v : t.names.indexOf(v);
  return v & ((1 << t.bits) - 1);
}

// HOW MANY LOW BITS OF AN OPERAND THE INSTRUCTION READS, when its semantics
// only ever use it through a mask of low bits: `imm & 15` reads four.  The
// field's bits above those are ignored by the hardware, and the manual shows
// them as 0.  Null when the whole value is used.
function usedBits(insn, op) {
  const sem = insn.semantics ?? '';
  const uses = [...sem.matchAll(new RegExp(`\\b${op}\\b(\\s*&\\s*(0x[0-9a-f]+|\\d+))?`, 'gi'))];
  if (!uses.length || uses.some((m) => !m[1])) return null;
  const masks = new Set(uses.map((m) => Number(m[2])));
  if (masks.size !== 1) return null;
  const mask = [...masks][0];
  return (mask & (mask + 1)) === 0 ? Math.log2(mask + 1) : null;
}

// The form's bits, most significant first, each a literal or one bit of an
// operand.  A `fix` on an operand that has a field - which only an alias's
// view of a form has - turns that field into literal bits.
function formInfo(insn, form) {
  const { runs, encType, nbytes } = decodeEncoding(insn, form);
  const bits = [];
  for (const r of runs) {
    if (r.kind === 'lit') for (const c of r.bits) bits.push({ lit: c });
    else for (let b = r.hi; b >= r.lo; b--) {
      const v = form.fix?.[r.op];
      const used = usedBits(insn, r.op);
      if (v !== undefined) bits.push({ lit: String((rawField(encType.get(r.op), v) >> b) & 1) });
      else if (used !== null && b >= used && types[encType.get(r.op)].kind === 'int') bits.push({ lit: '0', op: r.op, bit: b, ignored: true });
      else bits.push({ op: r.op, bit: b });
    }
  }
  for (const op of Object.keys(form.fix ?? {})) encType.delete(op);
  return { encType, nbytes, bits };
}

// One byte of the opcode column.  A byte whose fixed bits are its top bits
// covers a contiguous range of values, and that range is what is printed.
function byteToken(bits8) {
  let n = 0;
  while (n < 8 && bits8[n].lit !== undefined) n++;
  if (n === 0) return 'xx';
  if (bits8.slice(n).some((b) => b.lit !== undefined))
    return bits8.map((b) => b.lit ?? 'x').join('') + 'b';
  const base = parseInt(bits8.slice(0, n).map((b) => b.lit).join('').padEnd(8, '0'), 2);
  return n === 8 ? hex2(base) : `${hex2(base)}–${hex2(base | ((1 << (8 - n)) - 1))}`;
}

const byteTokens = (info) =>
  Array.from({ length: info.nbytes }, (_, i) => byteToken(info.bits.slice(i * 8, i * 8 + 8)));

// How a form writes an operand: the register or value it pins, the operand a
// tie makes it a copy of, or a placeholder naming what the field can hold.
function placeholder(insn, form, info, name, part = null) {
  const t = types[operand(insn, name).type];
  if (form.fix && name in form.fix) {
    const v = form.fix[name];
    if (t.kind === 'reg') return typeof v === 'number' ? types.reg.names[v] : v;
    if (t.kind === 'combo') return String(part ? t.values[v][t.parts.indexOf(part)] : v);
    return String(v);
  }
  if (form.tie && name in form.tie) return placeholder(insn, form, info, form.tie[name], part);
  if (t.kind === 'reg') return 'r' + name;
  if (t.kind === 'enum') return name;
  if (t.kind === 'combo') return part ?? name;
  const et = info.encType.get(name) ?? operand(insn, name).type;
  return et === 'int16' ? 'imm16' : et;
}

const fill = (syntax, f) => syntax.replace(/\{(\w+)(?:\.(\w+))?\}/g, (_, n, p) => f(n, p ?? null));

function formSyntax(insn, form, info) {
  const s = fill(insn.syntax ?? '', (n, p) => placeholder(insn, form, info, n, p));
  return s ? `${insn.mnemonic} ${s}` : insn.mnemonic;
}

// What the fields of a form accept.
function constraints(insn, form, info) {
  const out = [];
  for (const [name, et] of info.encType) {
    const t = types[et];
    const label = placeholder(insn, form, info, name);
    if (t.kind === 'int') {
      if (et === 'int16') { out.push(`${label}: any 16-bit value`); continue; }
      const used = usedBits(insn, name);
      if (used !== null && used < t.bits) {
        const ignored = used === t.bits - 1 ? `bit ${used}` : `bits ${t.bits - 1}:${used}`;
        out.push(`${label}: 0 to ${(1 << used) - 1}; ${ignored} ignored, written 0`);
        continue;
      }
      const [lo, hi] = intRange(t);
      out.push(`${label}: ${lo} to ${hi}${t.signed ? ', sign-extended to 16 bits' : ''}`);
    } else if (t.kind === 'table') out.push(`${label}: one of the ${t.values.length} values below`);
    else if (t.kind === 'combo') out.push(`(${t.parts.join(', ')}): one of the ${t.values.length} pairs below`);
  }
  if (insn.aliasOf) {
    out.push(`Same encoding as ${formSyntax(insn.aliasOf, form, info)}`);
    return out;
  }
  const fixed = Object.keys(form.fix ?? {}).filter((n) => !(insn.syntax ?? '').includes(`{${n}`));
  for (const n of fixed) out.push(`${n} = ${form.fix[n]}, implicitly`);
  if (form.tie) for (const [a, b] of Object.entries(form.tie)) out.push(`r${a} is r${b}`);
  if (!out.length) out.push(info.bits.every((b) => b.lit !== undefined) ? 'All operands implicit' : '');
  return out;
}

// --- cycles ------------------------------------------------------------------
//
// tools/sim.js's Machine.timing, as the text of its cases, with the fetcher
// keeping up.  Which case is Machine.classify's to say.  A redirect's target
// is read the cycle after the redirect and dispatches the cycle after that,
// one later if its instruction reaches into a second word.

function cycles(insn, info) {
  const k = machine.classify(insn);
  const sem = insn.semantics ?? '';
  if (k.fixed) return String(k.fixed);
  if (k.memory) {
    const m8 = (sem.match(/M8\[/g) ?? []).length, m16 = (sem.match(/M16\[/g) ?? []).length;
    return m16 ? `${m8 + m16 + 2}, odd ${m8 + 2 * m16 + 2}` : String(m8 + 2);
  }
  if (k.extra) return String(1 + k.extra);
  if (k.branch) return `1, taken ${spec.cpu.taken_branch_penalty + 2}`;
  if (/(^|;\s*)pc = /.test(sem)) return k.callA ? '5 (lr: 4)' : k.viaReg ? '5' : '4';
  return '1';
}

// --- layout ------------------------------------------------------------------

const [PW, PH] = A4;
const M = 50, W = PW - 2 * M, TOP = M + 24, BOTTOM = PH - M - 10;
const BLUE = [0, 0.3, 0.6], GREY = [0.42, 0.42, 0.42], RULE = [0.55, 0.55, 0.55];
const HEAD = [0.9, 0.93, 0.97];
const SHADES = [[0.80, 0.89, 1], [0.84, 0.95, 0.80], [1, 0.89, 0.74], [0.93, 0.85, 1], [1, 0.84, 0.87], [0.87, 0.87, 0.87]];

function wrap(text, font, size, maxW) {
  const lines = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (width(next, font, size) <= maxW || !line) line = next;
    else { lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

const doc = new Pdf(A4, { title: 'Fructus Instruction Set Reference', author: 'Fructus' });

class Flow {
  constructor(running) { this.running = running; this.page = null; this.y = 0; this.pages = []; }
  newPage() {
    this.page = doc.page();
    this.page.running = this.running;
    this.pages.push(this.page);
    this.y = TOP;
    return this.page;
  }
  need(h) { if (!this.page || this.y + h > BOTTOM) this.newPage(); }

  heading(s) {
    this.need(40);
    this.y += 10;
    this.page.text(M, this.y + 10, s, { font: 'HB', size: 11, color: BLUE });
    this.y += 18;
  }

  para(text, { font = 'H', size = 9.5, color = [0, 0, 0], indent = 0, gap = 4 } = {}) {
    const lead = size * 1.3;
    for (const l of wrap(text, font, size, W - indent)) {
      this.need(lead);
      this.page.text(M + indent, this.y + size, l, { font, size, color });
      this.y += lead;
    }
    this.y += gap;
  }

  code(lines, { size = 8.5, indent = 10, color = [0, 0, 0], font = 'C' } = {}) {
    const lead = size * 1.25;
    for (const l of lines) {
      this.need(lead);
      // An over-long line is split rather than run off the page.
      const max = Math.floor((W - indent) / (0.6 * size));
      for (let s = l; ; s = '  ' + s.slice(max)) {
        this.page.text(M + indent, this.y + size, s.slice(0, max), { font, size, color });
        this.y += lead;
        if (s.length <= max) break;
        this.need(lead);
      }
    }
    this.y += 4;
  }

  notes(lines, { size = 8.5, color = [0.15, 0.15, 0.15], font = 'H', indent = 0 } = {}) {
    for (const p of paragraphs(lines)) {
      if (p.pre) this.code(p.lines, { size: size - 0.5, indent: indent + 10, color });
      else this.para(p.text, { font, size, color, indent, gap: 3 });
    }
  }

  // cols: [{ title, w, font }]; rows: arrays of strings.  The header repeats
  // on every page the table reaches.
  table(cols, rows, { size = 8.2, link = null } = {}) {
    const pad = 3, lead = size * 1.25;
    const header = () => {
      const lines = cols.map((c) => wrap(c.title, 'HB', size, c.w - 2 * pad));
      const h = Math.max(...lines.map((l) => l.length)) * lead + 2 * pad;
      let x = M;
      cols.forEach((c, i) => {
        this.page.rect(x, this.y, c.w, h, { fill: HEAD, stroke: RULE });
        lines[i].forEach((l, j) => this.page.text(x + pad, this.y + pad + size + j * lead, l, { font: 'HB', size }));
        x += c.w;
      });
      this.y += h;
    };
    this.need(3 * lead + 4 * pad);
    header();
    rows.forEach((row, r) => {
      const lines = cols.map((c, i) => wrap(row[i], c.font ?? 'H', size, c.w - 2 * pad));
      const h = Math.max(...lines.map((l) => l.length)) * lead + 2 * pad;
      if (this.y + h > BOTTOM) { this.newPage(); header(); }
      let x = M;
      cols.forEach((c, i) => {
        this.page.rect(x, this.y, c.w, h, { stroke: RULE });
        lines[i].forEach((l, j) => this.page.text(x + pad, this.y + pad + size + j * lead, l, { font: c.font ?? 'H', size }));
        x += c.w;
      });
      if (link?.[r]) this.page.link(M, this.y, W, h, link[r]);
      this.y += h;
    });
    this.y += 6;
  }
}

// --- the bit diagram ---------------------------------------------------------

const BOX = 17, BOXH = 16, BYTEGAP = 10;

function shortName(insn, name) {
  return types[operand(insn, name).type].kind === 'reg' ? name : name[0];
}

function runLabel(insn, info, run) {
  const t = types[operand(insn, run.op).type];
  const name = t.kind === 'reg' ? 'r' + run.op : run.op;
  const bits = encodedBits(types, info.encType.get(run.op));
  if (run.hi === bits - 1 && run.lo === 0) return name;
  return run.hi === run.lo ? `${name}[${run.hi}]` : `${name}[${run.hi}:${run.lo}]`;
}

// THE BITS OF EACH BYTE ARE DRAWN LEAST SIGNIFICANT FIRST, so that with
// byte 0 leftmost the whole instruction reads in ascending significance: a
// field that continues from one byte into the next - imm10's two bits at the
// top of byte 1 and eight in byte 2 - is drawn as one unbroken run, i0 to i9.
// Only the drawing is reversed; the hex is ordinary byte values.
//
// `cells` is the bits in drawing order; a run is a stretch of one operand's
// bits rising by one from cell to cell, which may cross a byte boundary.
function drawnCells(info) {
  return info.bits.map((_, i) => info.bits[(i & ~7) + 7 - (i & 7)]);
}

function drawnRuns(cells) {
  const runs = [];
  cells.forEach((c, i) => {
    const last = runs[runs.length - 1];
    if (c.op === undefined || c.lit !== undefined) return;
    if (last && last.op === c.op && last.end === i - 1 && last.hi === c.bit - 1) { last.hi = c.bit; last.end = i; }
    else runs.push({ op: c.op, lo: c.bit, hi: c.bit, start: i, end: i });
  });
  return runs;
}

// A FIELD OF EIGHT TABLE VALUES IS DRAWN AS EIGHT ROWS.  An imm3 or shift3
// form is eight encodings that differ only in which value the field picks, so
// each gets its own row of boxes with the field's bits filled in, and its hex
// and assembly to the right - there is room, as these forms are two bytes.
// The brackets naming the fields go under the last row only.
function expandedOp(info) {
  for (const [op, et] of info.encType) if (types[et].kind === 'table' && types[et].bits === 3) return op;
  return null;
}

function diagram(flow, insn, form, info, shade) {
  const tokens = byteTokens(info);
  const notes = insn.aliasOf ? [] : formNotes[spec.insn.indexOf(insn)][insn.form.indexOf(form)];
  const op = expandedOp(info);
  const rows = op
    ? types[info.encType.get(op)].values.map((v) => {
        const f = { ...form, fix: { ...form.fix, [op]: v } };
        const ri = formInfo(insn, f);
        return { cells: drawnCells(ri), tokens: byteTokens(ri), syntax: formSyntax(insn, f, ri) };
      })
    : [{ cells: drawnCells(info) }];
  const ROWGAP = 3;
  flow.need(66 + (rows.length - 1) * (BOXH + ROWGAP));
  const p = flow.page;
  let y = flow.y;

  p.text(M, y + 9, formName(form, insn), { font: 'HB', size: 9 });
  const nameW = Math.max(90, width(formName(form, insn), 'HB', 9) + 12);
  p.text(M + nameW, y + 9, tokens.join(' '), { font: 'CB', size: 9 });
  p.text(M + nameW + 100, y + 9, formSyntax(insn, form, info), { font: 'C', size: 9 });
  y += 15;

  const cells = drawnCells(info);
  const xOf = (i) => M + i * BOX + Math.floor(i / 8) * BYTEGAP;
  for (let b = 0; b < info.nbytes; b++) {
    const label = `byte ${b}:  ${tokens[b]}`;
    const cx = xOf(b * 8) + 4 * BOX;
    p.text(cx - width(label, 'H', 7) / 2, y + 7, label, { size: 7, color: GREY });
  }
  y += 10;
  cells.forEach((_, i) => {
    const s = String(i % 8);
    p.text(xOf(i) + BOX / 2 - width(s, 'H', 6) / 2, y + 6, s, { size: 6, color: GREY });
  });
  y += 9;

  const right = xOf(cells.length - 1) + BOX + 14;
  rows.forEach((row, r) => {
    row.cells.forEach((b, i) => {
      const x = xOf(i);
      const field = cells[i].op;
      if (b.lit !== undefined) {
        // A literal in a field's place is one of the expanded values: shaded
        // as the field it is.
        p.rect(x, y, BOX, BOXH, field ? { fill: shade(field), stroke: [0.2, 0.2, 0.2] } : { stroke: [0.2, 0.2, 0.2] });
        p.text(x + BOX / 2 - width(b.lit, 'HB', 9) / 2, y + 11.5, b.lit, { font: 'HB', size: 9 });
      } else {
        p.rect(x, y, BOX, BOXH, { fill: shade(b.op), stroke: [0.2, 0.2, 0.2] });
        const one = encodedBits(types, info.encType.get(b.op)) === 1;
        const s = shortName(insn, b.op) + (one ? '' : b.bit);
        const size = width(s, 'H', 6.5) > BOX - 2 ? 5.5 : 6.5;
        p.text(x + BOX / 2 - width(s, 'H', size) / 2, y + 10.5, s, { size });
      }
    });
    if (row.syntax) {
      p.text(right, y + 11, row.tokens.join(' '), { font: 'CB', size: 8.5 });
      p.text(right + 62, y + 11, row.syntax, { font: 'C', size: 8.5 });
    }
    y += BOXH + (r < rows.length - 1 ? ROWGAP : 0);
  });
  y += 3;

  // A bracket under each run of one operand's bits, named.
  for (const r of drawnRuns(cells)) {
    const x0 = xOf(r.start) + 2, x1 = xOf(r.end) + BOX - 2;
    p.line(x0, y, x0, y + 3, { color: GREY });
    p.line(x0, y + 3, x1, y + 3, { color: GREY });
    p.line(x1, y, x1, y + 3, { color: GREY });
    const s = runLabel(insn, info, r);
    const size = width(s, 'H', 7) > x1 - x0 + 4 ? 6 : 7;
    p.text((x0 + x1) / 2 - width(s, 'H', size) / 2, y + 11, s, { size });
  }
  flow.y = y + 18;
  if (notes.some((l) => l.trim())) {
    flow.notes(notes, { size: 8, color: [0.3, 0.3, 0.3], font: 'HI', indent: 10 });
  }
  flow.y += 6;
}

// --- operand value tables ----------------------------------------------------

function valueTable(flow, name) {
  const t = types[name];
  const entries = t.kind === 'combo'
    ? t.values.map((v) => v.join(' '))
    : t.kind === 'enum' ? t.names
    : t.values.map((v) => (t.values.some((x) => x > 255) ? '0x' + v.toString(16).toUpperCase().padStart(4, '0') : String(v)));
  const desc = t.kind === 'combo' ? `${name}: (${t.parts.join(', ')}) by field value`
    : t.kind === 'enum' ? `${name}: condition by field value` : `${name}: value by field value`;
  flow.need(30);
  flow.para(desc, { font: 'HB', size: 8.5, gap: 1 });
  const per = 8, cw = W / per, lead = 11;
  for (let r = 0; r < entries.length; r += per) {
    flow.need(lead);
    for (let c = 0; c < per && r + c < entries.length; c++) {
      const x = M + c * cw;
      flow.page.text(x, flow.y + 8, String(r + c), { size: 6.5, color: GREY });
      flow.page.text(x + 11, flow.y + 8, entries[r + c], { font: 'C', size: 8 });
    }
    flow.y += lead;
  }
  if (t.kind === 'enum' && (t.aliases || t.swapped)) {
    const extra = [
      ...Object.entries(t.aliases ?? {}).map(([a, b]) => `${a} is ${b}`),
      ...Object.entries(t.swapped ?? {}).map(([a, b]) => `${a} is ${b} with the two operands exchanged`),
    ];
    flow.para('Also accepted: ' + extra.join('; ') + '.', { size: 8, gap: 0 });
  }
  if (t.kind === 'combo' && t.values.length < 1 << t.bits)
    flow.para(`Field values ${t.values.length}–${(1 << t.bits) - 1} are free: no instruction encodes them.`, { size: 8, gap: 0 });
  flow.y += 6;
}

// --- conditions, their spellings, and the branches that are each other ----

// Every condition name in prose, from cond3's `meaning`, in the order a reader
// looks for them: equality, then signed, then unsigned, then overflow.
function conditionPages(flow) {
  const m = types.cond3.meaning ?? {};
  const order = ['eq', 'ne', 'lt', 'le', 'gt', 'ge', 'lo', 'ls', 'hi', 'hs', 'cc', 'cs', 'vs', 'vc'];
  const names = [...order, ...Object.keys(m).filter((n) => !order.includes(n))].filter((n) => m[n]);
  if (!names.length) return;
  flow.heading('Conditions');
  flow.para('A condition compares the first operand, a, with the second, b or the constant, in that order: lt means a < b.  The letters are ARM\'s: signed comparisons say Less and Greater, unsigned ones LOwer and HIgher.', { size: 8.5 });
  flow.table([{ title: 'Name', w: 40, font: 'C' }, { title: 'Branches when', w: W - 40 }],
    names.map((n) => [n, m[n]]), { size: 8.2 });
}

// Each condimm5 entry with every other way of writing it - `le #3` is `lt #4`,
// and `eq #32767` is `ge #32767` because nothing is above 32767.  Found by
// comparing truth sets, as the assemblers do.
function constantSpellings(flow) {
  const t = types.condimm5;
  flow.heading('Spellings of the Constant Comparisons');
  flow.para('Each entry of condimm5 is a test on the register, and most tests can be written more than one way.  The assembler accepts any of them and encodes the entry; a disassembler prints the entry\'s own spelling.', { size: 8.5 });
  const fmt = (c, k) => `${c} #${k}`;
  flow.table([{ title: 'Field', w: 30 }, { title: 'Entry', w: 70, font: 'C' }, { title: 'Also written', w: W - 100, font: 'C' }],
    t.values.map(([c, k], i) => [String(i), fmt(c, k),
      spellings(spec, c, k).filter((s) => !(s.cond === c && (s.imm & 0xffff) === (k & 0xffff)))
        .map((s) => fmt(s.cond, s.imm)).join(', ') || '\u2014']), { size: 8.2 });
}

// The branches that are the same test written with the other instruction,
// listed on both pages: `br lt, ra, #0` assembles as `brset ra, #0x8000`, and
// `brclr ra, #0xfff8` as `br lo, ra, #8`.  From tools/brequiv.js, which the
// assemblers read too.
const EQUIV = brEquivalents(spec);
function twinPages(flow, g) {
  const rows = EQUIV.filter((e) => e.from.mnemonic === g.mnemonic || e.to.mnemonic === g.mnemonic);
  if (!rows.length) return;
  const hex = (v) => '#0x' + v.toString(16).toUpperCase().padStart(4, '0');
  const side = (s, reg) => s.cond === null
    ? `${s.mnemonic} ${reg}, ${hex(s.imm)}`
    : `${s.mnemonic} ${s.cond}, ${reg}, #${s.imm >= 0x8000 && !['lo', 'ls', 'hi', 'hs'].includes(s.cond) ? s.imm - 0x10000 : s.imm}`;
  // One row per target, with every spelling that reaches it.
  const byTarget = new Map();
  for (const e of rows) {
    const k = side(e.to, 'ra');
    if (!byTarget.has(k)) byTarget.set(k, []);
    byTarget.get(k).push(side(e.from, 'ra'));
  }
  flow.heading('Same Test, Other Instruction');
  flow.para('Some comparisons against a constant are bit tests: R[a] <u 256 holds exactly when none of bits 8–15 is set, and R[a] < 0 when bit 15 is.  When the test written has no encoding of its own but the other instruction encodes the same test, the assembler uses that instead, in either direction - same length, same cycles, same branch.  A disassembler prints what was encoded.', { size: 8.5 });
  // One spelling to a row, since a spelling has commas of its own, and the
  // target repeated on each so that no row is read against an empty cell.
  flow.table([{ title: 'Written', w: W - 150, font: 'C' }, { title: 'Assembles as', w: 150, font: 'C' }],
    [...byTarget].flatMap(([to, from]) => from.map((f) => [f, to])), { size: 8.2 });
}

// --- one mnemonic's page(s) --------------------------------------------------

const groups = [];
for (const insn of spec.insn) {
  let g = groups.find((x) => x.mnemonic === insn.mnemonic);
  if (!g) groups.push(g = { mnemonic: insn.mnemonic, insns: [], aliases: [] });
  g.insns.push(insn);
}
// An alias is listed on its own mnemonic's page, which it has to itself when
// no instruction shares its name.
for (const a of spec.alias) {
  let g = groups.find((x) => x.mnemonic === a.mnemonic);
  if (!g) groups.push(g = { mnemonic: a.mnemonic, insns: [], aliases: [] });
  g.aliases.push(a);
}
groups.sort((x, y) => (x.mnemonic < y.mnemonic ? -1 : x.mnemonic > y.mnemonic ? 1 : 0));

const aliasTargetInsn = (a) => spec.insn.find((i) => i.mnemonic === a.expand.mnemonic &&
  Object.keys(a.expand.args).every((n) => i.operands.some((o) => o.name === n)) &&
  i.operands.every((o) => o.name in a.expand.args));

// A PREFERRED ALIAS IS LISTED AS AN INSTRUCTION: `mov rd, ra` gets rows and
// diagrams of its own, which are the target's forms that can hold the
// alias's constants, with those constants drawn as the literal bits they are.
// A form is left out when the assembler would never pick it - when a form
// with no pinned registers of its own is shorter, or as short and tried
// first - and when it only covers an alias's operands being equal.  What is returned looks like an [[insn]], named after the alias but
// with the target's operands, so the alias's registers are named for the
// operands they become: mov's `rs` is or's `ra`.
function aliasView(a) {
  const target = aliasTargetInsn(a);
  const args = a.expand.args;
  const literal = Object.fromEntries(Object.entries(args).filter(([, v]) => typeof v === 'number'));
  const becomes = (n) => Object.keys(args).find((k) => args[k] === n);
  const accepts = (form) => Object.entries(literal).every(([k, v]) => {
    if (form.fix && k in form.fix) return form.fix[k] === v;
    const et = decodeEncoding(target, form).encType.get(k);
    const t = et && types[et];
    if (!t) return false;
    if (t.kind === 'table') return t.values.includes(v);
    if (t.kind !== 'int') return false;
    const [lo, hi] = intRange(t);
    return et === 'int16' || (v >= lo && v <= hi);
  });
  // A form that ties two of the alias's own operands together only covers
  // the case where they are equal - for mov, `mov rd, rd`, which does nothing
  // - so it is not listed even when the assembler would pick it.
  const collapses = (f) => Object.entries(f.tie ?? {}).some(([x, y]) =>
    a.operands.some((o) => o.name === args[x]) && a.operands.some((o) => o.name === args[y]));
  const candidates = target.form.filter((f) => accepts(f) && !collapses(f)).map((f) => ({ ...f, fix: { ...f.fix, ...literal } }));
  const len = (f) => decodeEncoding(target, f).nbytes;
  const general = (f) => !f.tie && Object.keys(f.fix).every((k) => k in literal);
  const forms = candidates.filter((f, i) => !candidates.some((h, j) => j !== i && general(h) &&
    (len(h) < len(f) || (len(h) === len(f) && j < i && general(f)))));
  const renamed = (s) => s.replace(/\br([a-z])\b/g, (m, n) =>
    a.operands.some((o) => o.name === n && types[o.type].kind === 'reg') && becomes(n) ? 'r' + becomes(n) : m);
  let semantics = target.semantics ?? '';
  for (const [k, v] of Object.entries(literal)) semantics = semantics.replace(new RegExp(`\\b${k}\\b`, 'g'), String(v));
  return {
    ...target,
    mnemonic: a.mnemonic,
    syntax: fill(a.syntax, (n) => `{${becomes(n)}}`),
    summary: renamed(a.summary),
    semantics,
    form: forms,
    aliasOf: target,
    alias: a,
  };
}
for (const g of groups) {
  g.views = [...g.insns, ...g.aliases.filter((a) => a.prefer).map(aliasView)];
  g.aliases = g.aliases.filter((a) => !a.prefer);
}

function aliasRows(a) {
  const target = aliasTargetInsn(a);
  const show = (n) => {
    const o = a.operands.find((x) => x.name === n);
    return o ? (types[o.type].kind === 'reg' ? 'r' + n : n) : null;
  };
  const arg = (n) => {
    const v = a.expand.args[n];
    if (typeof v === 'number') return String(v);
    return show(v) ?? v;
  };
  return [
    `${a.mnemonic} ${fill(a.syntax, show)}`,
    `${target.mnemonic} ${fill(target.syntax, arg)}`,
    a.summary + (a.prefer ? ' (the opcode map\'s name for it)' : ''),
  ];
}

const aliasTarget = (a) => groups.find((g) => g.mnemonic === a.expand.mnemonic);
const groupSummaries = (g) => [...new Set((g.views.length ? g.views : g.aliases).map((x) => x.summary))];

function instructionPages(g) {
  const flow = new Flow(g.mnemonic.toUpperCase());
  flow.newPage();
  g.firstPage = flow.page;

  const summaries = groupSummaries(g);
  const title = `${g.mnemonic.toUpperCase()} — ${summaries.join('; ')}`;
  for (const l of wrap(title, 'HB', 15, W)) {
    flow.page.text(M, flow.y + 15, l, { font: 'HB', size: 15, color: BLUE });
    flow.y += 19;
  }
  if (!g.views.length) flow.para('An assembler alias: it has no encoding of its own.', { font: 'HI', size: 9 });
  flow.y += 4;

  const all = g.views.flatMap((insn) => insn.form.map((form) => ({ insn, form, info: formInfo(insn, form) })));
  if (all.length) {
    flow.table([
      { title: 'Opcode', w: 78, font: 'C' },
      { title: 'Instruction', w: 136, font: 'C' },
      { title: 'Bytes', w: 30 },
      { title: 'Cycles', w: 50 },
      { title: 'Form', w: 72 },
      { title: 'Operands', w: W - 366 },
    ], all.map(({ insn, form, info }) => [
      byteTokens(info).join(' '),
      formSyntax(insn, form, info),
      String(info.nbytes),
      cycles(insn.aliasOf ?? insn, info),
      formName(form, insn),
      constraints(insn, form, info).join('; '),
    ]));
  }

  if (g.aliases.length) {
    flow.heading('Assembler Aliases');
    flow.table([
      { title: 'Written', w: 130, font: 'C' },
      { title: 'Assembles as', w: 130, font: 'C' },
      { title: 'Description', w: W - 260 },
    ], g.aliases.map(aliasRows));
    const elsewhere = [...new Set(g.aliases.map(aliasTarget).filter((t) => t !== g))];
    for (const t of elsewhere) {
      flow.para(`Encodings: see ${t.mnemonic.toUpperCase()}.`, { size: 9, color: BLUE });
      flow.page.link(M, flow.y - 16, W, 14, t);   // a group until it has a page; resolved at the end
    }
  }

  if (all.length) {
    flow.heading('Encodings');
    flow.para('Byte 0 is at the lowest address, and within each byte bit 0 is on the left, so an operand that runs on from one byte into the next reads left to right.  Shaded bits are operand fields; a bracket names the operand and, where it is split, which of its bits it holds.', { size: 8.5, color: GREY });
    flow.y += 2;
    for (const insn of g.views) {
      const shade = (op) => SHADES[(insn.operands ?? []).findIndex((o) => o.name === op) % SHADES.length];
      for (const form of insn.form) diagram(flow, insn, form, formInfo(insn, form), shade);
    }

    const used = [...new Set(all.flatMap(({ info }) => [...info.encType.values()]))]
      .filter((n) => ['table', 'combo', 'enum'].includes(types[n].kind));
    if (used.length) {
      flow.heading('Operand Values');
      for (const n of used) valueTable(flow, n);
    }
    if (used.includes('cond3')) conditionPages(flow);
    if (used.includes('condimm5')) constantSpellings(flow);
    twinPages(flow, g);

    flow.heading('Operation');
    for (const insn of g.views) {
      if (g.views.length > 1) flow.para(`${insn.mnemonic} ${fill(insn.syntax ?? '', (n, p) => p ?? (types[operand(insn, n).type].kind === 'reg' ? 'r' + n : n))}`, { font: 'HB', size: 8.5, gap: 1 });
      const sem = (insn.semantics ?? '').trim();
      flow.code(sem ? sem.split(/;\s*/).map((s) => s + ';') : ['(nothing)']);
      const signed = [...new Set(insn.form.flatMap((f) => [...formInfo(insn, f).encType.values()]))]
        .filter((n) => n !== 'int16' && types[n].kind === 'int' && types[n].signed)
        .filter((n) => insn.form.some((f) => [...formInfo(insn, f).encType].some(([op, et]) => et === n && !(usedBits(insn, op) < types[n].bits))));
      if (signed.length) flow.para(`${signed.join(' and ')} ${signed.length > 1 ? 'are' : 'is'} sign-extended to 16 bits before use.`, { size: 8.5 });
      if (insn.swap_operands) flow.para(`A condition the encoding lacks is written by exchanging ${insn.swap_operands.join(' and ')}; see the condition table.`, { size: 8.5 });
      if (insn.extra_cycles) flow.para(`Takes ${insn.extra_cycles} cycle${insn.extra_cycles > 1 ? 's' : ''} beyond the one an ALU instruction costs.`, { size: 8.5 });
    }

    const noted = g.insns.filter((insn) => insnNotes[spec.insn.indexOf(insn)].some((l) => l.trim()));
    const views = g.views.filter((v) => v.aliasOf);
    const aliasedHere = spec.alias.filter((a) => a.prefer && g.insns.includes(aliasTargetInsn(a)));
    if (noted.length || views.length || aliasedHere.length) flow.heading('Notes');
    for (const v of views) {
      const as = formSyntax(v.aliasOf, { fix: Object.fromEntries(Object.entries(v.alias.expand.args).filter(([, x]) => typeof x === 'number')) }, { encType: new Map() });
      flow.para(`${v.mnemonic} ${fill(v.syntax, (n) => 'r' + n)} has no opcode of its own: it is an assembler alias for ${as}, and shares that instruction's encodings, so a disassembler prints it as ${v.aliasOf.mnemonic}.`, { size: 8.5, gap: 3 });
      flow.notes(aliasNotes[spec.alias.indexOf(v.alias)]);
    }
    for (const a of aliasedHere) {
      const v = groups.find((x) => x.mnemonic === a.mnemonic).views.find((x) => x.alias === a);
      const as = formSyntax(v.aliasOf, { fix: Object.fromEntries(Object.entries(a.expand.args).filter(([, x]) => typeof x === 'number')) }, { encType: new Map() });
      flow.para(`${as} is also written ${v.mnemonic} ${fill(v.syntax, (n) => 'r' + n)}; see ${v.mnemonic.toUpperCase()}.`, { size: 8.5, gap: 3, color: BLUE });
      flow.page.link(M, flow.y - 16, W, 14, groups.find((x) => x.mnemonic === a.mnemonic));
    }
    for (const insn of noted) flow.notes(insnNotes[spec.insn.indexOf(insn)]);
  }
  return flow.pages;
}

// --- front matter ------------------------------------------------------------

const LEGEND = [
  ['Opcode', 'The instruction\'s bytes in hex, byte 0 first.  A range such as 3E–3F means the low bits of that byte belong to an operand field, so any value in the range is this instruction; xx is a byte made entirely of operand fields.  The first byte alone decides the length of an instruction.'],
  ['Instruction', 'The assembly syntax for that encoding.  rd, ra, rb, rs and rc are any of r0–r7 (sp is r6 and lr is r7); a name such as r0 is a register the encoding pins.  imm5, imm10, off8 and similar are signed fields of that many bits, sign-extended to 16 bits; immbit5, immask5, imm3 and shift3 are table fields whose values are listed on the page.'],
  ['Bytes, Cycles', 'Length, and the cycles from this instruction\'s dispatch to the next one\'s, when the fetcher keeps up - see The cost model.  "odd" is the cost when a word in memory is at an odd address; "taken" is a conditional branch that branches.  A taken branch, a jump, a call, a return, brk and rti cost one more when the instruction at their target reaches into a second word: two bytes at an odd address, or three at any.'],
  ['Form', 'The form\'s name in isa/fructus.toml, which also labels its diagram under Encodings.  The assembler picks the shortest form that can hold the operands written.'],
  ['Operation', 'The spec\'s semantics, which tools/sim.js executes.  pc is already the address of the next instruction; R[n] is a register, M8[] and M16[] are memory (16-bit values little-endian); everything is truncated to 16 bits when stored.'],
];

// What the counts on the instruction pages mean - isa/fructus.toml's cost
// model, in short.
const CYCLES = [
  'The processor reads instructions ahead of itself: a fetcher brings in a word, two bytes, in every cycle the bus is free, into a buffer of three words, and an instruction dispatches once all its bytes are there.  The count on each page is the instruction\'s own, from its dispatch to the next one\'s, when the next one\'s bytes are already in the buffer.',
  'Usually they are.  An ALU instruction of one or two bytes takes no more than the fetcher brings, and an instruction of two cycles or more - mul, a load, a store - lets it gain.  The fetcher falls behind in a run of three-byte instructions, which take more than two bytes a cycle, and after a run of loads and stores, which take the bus.  A taken branch, a jump, a call, a return, brk and rti empty the buffer and read their target, and their count includes that, the target arriving with nothing to spare.  On the benchmark kernels in tests/bench, 6% of all cycles are spent waiting for the fetcher; tools/sim.js models it, and its counts are exact.',
  'Built in blit mode, for a system whose data can be at the far side of the chip, ld, ld8 and ldm take a cycle more.',
  'Code may not write just ahead of itself.  A store to the six bytes after the instruction being dispatched reaches memory but not the fetcher\'s copy.  Code that writes instructions must reach them through a taken branch, a jump, a call, a return or rti, each of which empties the buffer and reads memory afresh.',
];

// The version is the date and hash of the commit the spec is at.  A spec with
// uncommitted changes is not that commit, so it gets today's date and the
// hash is marked.
function version() {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  try {
    const [date, hash] = git('log', '-1', '--format=%cs %h').split(' ');
    if (!git('status', '--porcelain', '--', 'isa/fructus.toml')) return `${date} \u00b7 ${hash}`;
    return `${new Date().toISOString().slice(0, 10)} \u00b7 ${hash}+ (uncommitted changes)`;
  } catch {
    return 'unversioned';
  }
}

const REPO = 'https://github.com/erikcorry/fructus';

function cover(flow) {
  const p = flow.newPage();
  p.cover = true;
  const centre = (s, y, o) => p.text(PW / 2 - width(s, o.font, o.size) / 2, y, s, o);
  centre('Fructus', PH * 0.36, { font: 'HB', size: 40, color: BLUE });
  centre('Instruction Set Reference', PH * 0.36 + 34, { font: 'H', size: 20, color: BLUE });
  centre(version(), PH * 0.36 + 70, { font: 'H', size: 11, color: GREY });
  centre(REPO, PH * 0.36 + 88, { font: 'H', size: 10, color: BLUE });
  p.link(PW / 2 - width(REPO, 'H', 10) / 2, PH * 0.36 + 78, width(REPO, 'H', 10), 13, REPO);
}

// THE OPCODE MAP, drawn from the SVG tools/gen-opcode-map.js writes - run
// here rather than read from docs/, which is only as fresh as the last
// `npm run map`.  It is full width and taller than a page, so it is cut in
// two where the first byte's top bit changes: 00-7F on one page and 80-FF on
// the next, which repeats the column headings.  A half that outgrows its page
// is an error rather than a second, arbitrary cut.
const MAP_SVG = execFileSync(process.execPath, [join(root, 'tools/gen-opcode-map.js'), '--svg'], { encoding: 'utf8' });

function mapPages(flow) {
  const svgNum = (name) => +new RegExp(`<svg\\b[^>]*\\b${name}="([\\d.]+)"`).exec(MAP_SVG)[1];
  const mapW = svgNum('width'), mapH = svgNum('height');
  const scale = W / mapW, band = (BOTTOM - TOP) / scale;
  const attr = (name, s) => +new RegExp(`\\b${name}="([\\d.]+)"`).exec(s)[1];

  // A row is its label - `<text ... text-anchor="end">80</text>` - and the
  // cells that follow it; the first of those gives the row's top and bottom.
  const row = (label) => {
    const m = new RegExp(`<text\\b[^>]*text-anchor="end">${label}</text>\\s*<rect\\b([^>]*)>`).exec(MAP_SVG);
    if (!m) throw new Error(`gen-manual: no row ${label} in the opcode map`);
    return { top: attr('y', m[1]), bottom: attr('y', m[1]) + attr('height', m[1]) };
  };
  const heading = /<text\b([^>]*)>\u00b70<\/text>/.exec(MAP_SVG);
  if (!heading) throw new Error('gen-manual: no column headings in the opcode map');
  const head = { from: attr('y', heading[1]) - 1.3 * attr('font-size', heading[1]), to: row('00').top - 2 };
  const cut = (row('78').bottom + row('80').top) / 2;

  const parts = [
    [{ from: 0, to: cut }],
    [head, { from: cut, to: mapH }],
  ];
  return parts.map((bands) => {
    const p = flow.newPage();
    p.running = 'OPCODE MAP';
    let y = TOP;
    for (const { from, to } of bands) {
      p.svg(MAP_SVG, { x: M, y, scale, from, to });
      y += (to - from) * scale;
    }
    if (y > BOTTOM) throw new Error('gen-manual: half the opcode map does not fit a page');
    return p;
  });
}

function frontMatter(entries, offset) {
  const flow = new Flow('');
  cover(flow);
  const map = mapPages(flow);
  flow.newPage();
  flow.page.text(M, flow.y + 26, 'Fructus Instruction Set Reference', { font: 'HB', size: 24, color: BLUE });
  flow.y += 38;
  flow.para(`Generated from isa/fructus.toml by tools/gen-manual.js.  ${spec.cpu.word_bits}-bit registers r0–r7, ` +
    `a ${spec.cpu.addr_bits}-bit address space, ${spec.cpu.endian}-endian data, and instructions one to three bytes long.`, { size: 10 });

  flow.heading('Reading an Instruction Page');
  flow.table([{ title: 'Section', w: 80 }, { title: 'Meaning', w: W - 80 }], LEGEND, { size: 8.5 });

  flow.heading('Cycle Counts');
  for (const text of CYCLES) flow.para(text, { size: 8.5 });

  flow.heading('Contents');
  const lead = 12.5;
  [{ mnemonic: '', summary: 'Opcode map', page: flow.pages.indexOf(map[0]) + 1 - offset, target: map[0] }, ...entries].forEach((e) => {
    const lines = wrap(e.summary, 'H', 9, W - 70 - 30);
    flow.need(lead * lines.length);
    const p = flow.page, y = flow.y + 9;
    p.text(M, y, e.mnemonic, { font: 'CB', size: 9 });
    lines.forEach((l, j) => p.text(M + 70, y + j * lead, l, { size: 9, color: e.alias ? GREY : [0, 0, 0] }));
    const n = String(e.page + offset);
    p.text(M + W - width(n, 'H', 9), y, n, { size: 9 });
    p.link(M, flow.y, W, lead * lines.length, e.target);
    flow.y += lead * lines.length;
  });
  frontMatter.map = map[0];
  return flow.pages;
}

// --- putting it together -----------------------------------------------------

const body = [];
for (const g of groups) body.push(...instructionPages(g));

// Links made before their target page existed point at a group; resolve them.
for (const p of doc.pages) for (const l of p.links) if (l.target?.firstPage) l.target = l.target.firstPage;

const entries = groups.map((g) => ({
  mnemonic: g.mnemonic,
  summary: groupSummaries(g).join('; ') + (g.views.length ? '' : '  (alias)'),
  alias: !g.views.length,
  page: body.indexOf(g.firstPage) + 1,
  target: g.firstPage,
}));

// The contents' own length decides every page number in it, so lay it out
// once to count its pages and again with the count.
let front = frontMatter(entries, 0);
doc.pages.splice(doc.pages.length - front.length, front.length);
front = frontMatter(entries, front.length);
doc.pages.splice(doc.pages.length - front.length, front.length);
doc.pages.unshift(...front);

doc.outline('Opcode map', frontMatter.map);
for (const g of groups) doc.outline(`${g.mnemonic}${g.views.length ? '' : ' (alias)'}`, g.firstPage);

doc.pages.forEach((p, i) => {
  if (p.cover) return;
  const n = String(i + 1);
  p.text(PW / 2 - width(n, 'H', 8) / 2, PH - M + 6, n, { size: 8, color: GREY });
  if (p.running) {
    p.text(M, M + 4, 'FRUCTUS INSTRUCTION SET REFERENCE', { font: 'HB', size: 7, color: GREY });
    p.text(M + W - width(p.running, 'HB', 7), M + 4, p.running, { font: 'HB', size: 7, color: GREY });
    p.line(M, M + 8, M + W, M + 8, { color: RULE });
  }
});

process.stdout.write(doc.bytes());
