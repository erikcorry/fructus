#!/usr/bin/env node
// =============================================================================
// profile.mjs - where a program's cycles go, on tools/sim.js
// =============================================================================
//
//   node tools/profile.mjs [options] [LABEL=]prog [[LABEL=]prog2]
//                                                     (or: just profile ...)
//
// prog is the ELF tools/fcc writes; prog.bin, beside it, is what runs, set up
// as tools/fcc-run.mjs sets it up.  Every instruction's cycles - what cost()
// in tools/sim.js charged, not an estimate of our own - are added to its
// function, to the kind of cost it was, and to its mnemonic; with -g, to its
// source file and line as well.
//
//   --from SYM --to SYM   count only from entering SYM until entering the
//                         other, e.g. a benchmark's timed part.  Either alone
//                         counts from or to it.
//   --per N               divide every count by N: per iteration, say.
//   --top N               rows in each table, 20 by default.
//   --lines               add a table by source line.  Needs -g.
//   --kinds               add each function's cycles by kind of cost.
//   --output              pass the program's console to stderr.
//   --max N               instructions before giving up, 2e9 by default.
//
// TWO BUILDS ARE COMPARED: of one program at -Os and -O2, or before and after
// a compiler change.  Each table then has both, the difference, and the
// difference's share of the whole gap, sorted by that; a negative row is one
// the second build is slower in.
//
// THE KINDS ARE cost()'S OWN CASES, named by asking the machine what it did:
// load and store (a cycle per access and three or four more, push and pop
// included), mul (the two-step routine), a branch taken or not, a jump, call
// or ret, a plain ALU instruction, and one with three bytes at an odd address,
// which waits a cycle for its last byte.
//
// FUNCTIONS, NOT CALL TREES.  A function's row is the instructions inside it,
// so code inlined into a caller is the caller's - which is what makes two
// builds' function rows hard to compare when only one of them inlined.  The
// file rows are not affected: built with -g, an instruction belongs to the
// line it came from, inlined or not.  -g does not change the code.
//
// CoreMark's timed part, -Os against -O2:
//
//   F='-mmul -g -DITERATIONS=10 -Wno-format'
//   tools/fcc -Os $F tests/coremark/core_*.c -o build/cm-Os
//   tools/fcc -O2 $F tests/coremark/core_*.c -o build/cm-O2
//   just profile --from start_time --to stop_time --per 10 \
//     Os=build/cm-Os O2=build/cm-O2
// =============================================================================

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { loadSpec } from './isa.js';
import { Machine } from './sim.js';

const root = new URL('..', import.meta.url).pathname;
const READELF = `${root}build/binutils/binutils/readelf`;

const args = process.argv.slice(2);
const opt = { from: null, to: null, per: 1, top: 20, lines: false, kinds: false,
              output: false, max: 2e9 };
const builds = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--from') opt.from = args[++i];
  else if (a === '--to') opt.to = args[++i];
  else if (a === '--per') opt.per = Number(args[++i]);
  else if (a === '--top') opt.top = Number(args[++i]);
  else if (a === '--max') opt.max = Number(args[++i]);
  else if (a === '--lines') opt.lines = true;
  else if (a === '--kinds') opt.kinds = true;
  else if (a === '--output') opt.output = true;
  else if (a.startsWith('--')) usage(`unknown option ${a}`);
  else {
    const eq = a.indexOf('=');
    builds.push(eq > 0 ? { label: a.slice(0, eq), elf: a.slice(eq + 1) } : { label: a, elf: a });
  }
}
if (builds.length < 1 || builds.length > 2) usage('one program, or two to compare');

function usage(why) {
  console.error(`profile.mjs: ${why}\n`
    + 'usage: node tools/profile.mjs [--from SYM] [--to SYM] [--per N] [--top N] [--lines] [--kinds]\n'
    + '                              [--output] [--max N] [LABEL=]prog [[LABEL=]prog2]');
  process.exit(2);
}

const readelf = (...a) => execFileSync(READELF, a, { encoding: 'utf8', maxBuffer: 1 << 28 });

// The functions: FUNC symbols, which C's are, and global labels without a
// type, which libc/'s assembly exports.  An address belongs to the last one
// at or below it.
function symbols(elf) {
  const syms = [];
  for (const line of readelf('-sW', elf).split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length < 8 || !/^\d+:$/.test(f[0])) continue;
    const [, value, size, type, bind, , ndx, name] = f;
    if (name.startsWith('.') || ndx === 'UND' || ndx === 'ABS') continue;
    if (type === 'FUNC' || (type === 'NOTYPE' && bind === 'GLOBAL'))
      syms.push({ name, addr: parseInt(value, 16), size: Number(size) });
  }
  syms.sort((a, b) => a.addr - b.addr);
  const owner = new Array(0x10000).fill('?');
  syms.forEach((s, i) => {
    for (let a = s.addr, end = syms[i + 1]?.addr ?? 0x10000; a < end; a++) owner[a] = s.name;
  });
  return { syms, owner };
}

// The line table, from -g: each address's file and line, the last row at or
// below it.  null without one.
function lines(elf) {
  const rows = [];
  for (const line of readelf('--debug-dump=decodedline', elf).split('\n')) {
    const m = /^(\S+)\s+(\d+)\s+(0x[0-9a-f]+)/.exec(line);
    if (m) rows.push({ file: m[1], line: Number(m[2]), addr: parseInt(m[3], 16) });
  }
  if (!rows.length) return null;
  rows.sort((a, b) => a.addr - b.addr);    // stable: the last of equal addresses wins
  const at = new Array(0x10000).fill(null);
  rows.forEach((r, i) => {
    for (let a = r.addr, end = rows[i + 1]?.addr ?? r.addr + 1; a < end; a++) at[a] = r;
  });
  return at;
}

const spec = loadSpec();

function profile({ elf }) {
  const { syms, owner } = symbols(elf);
  const where = lines(elf);
  const addr = (name) => {
    if (name === null) return null;
    const s = syms.find((x) => x.name === name);
    if (!s) usage(`${elf} has no symbol ${name}`);
    return s.addr;
  };
  const FROM = addr(opt.from), TO = addr(opt.to);

  const m = new Machine(spec, { io: true });
  m.load(readFileSync(elf + '.bin'));
  m.pc = 0;
  m.R[m.named.sp] = 0;      // crt0 sets it from __stack_top
  const wr8 = m.wr8.bind(m);
  m.wr8 = (a, v) => {
    if ((a & 0xffff) !== spec.cpu.io.console) return wr8(a, v);
    m.bus += 1;
    if (opt.output) process.stderr.write(String.fromCharCode(v & 0xff));
  };

  const p = { cycles: 0, insns: 0, fn: {}, kind: {}, mnem: {}, file: where && {}, line: where && {},
              fnKind: {}, size: Object.fromEntries(syms.map((s) => [s.name, s.size])) };
  const add = (t, key, c) => { const r = (t[key] ??= { cycles: 0, insns: 0 }); r.cycles += c; r.insns++; };
  const guard = spec.cpu.vectors.io_guard;
  let on = FROM === null;
  while (!m.halted && m.count < opt.max) {
    const pc = m.pc;
    if (pc === guard) throw new Error(`${elf}: I/O page guard touched before 0x${m.R[m.named.lr].toString(16)}`);
    if (pc === FROM) on = true;
    if (pc === TO) { on = false; if (FROM === null) break; }
    const c0 = m.cyc;
    const d = m.step();
    if (!on) continue;
    const c = m.cyc - c0;
    const k = m.icache[pc]?.kind ?? { fixed: 6 };       // a trap's step has no entry
    const kind = k.fixed ? 'exception'
      : k.memory ? (k.stores ? 'store' : 'load')
      : k.extra ? 'mul'
      : k.branch ? (m.wrotePc ? 'branch taken' : 'branch not taken')
      : m.wrotePc ? 'jump, call, ret'
      : c > 1 ? 'alu, odd 3-byte' : 'alu';
    const f = owner[pc];
    add(p.fn, f, c); add(p.kind, kind, c); add(p.mnem, d.insn.mnemonic, c);
    const fk = (p.fnKind[f] ??= {});
    fk[kind] = (fk[kind] ?? 0) + c;
    if (where) {
      const w = where[pc];
      add(p.file, w ? w.file : `(${f})`, c);
      add(p.line, w ? `${w.file}:${w.line}` : `(${f})`, c);
    }
    p.cycles += c; p.insns++;
  }
  if (!m.halted && m.count >= opt.max) throw new Error(`${elf}: still running after ${opt.max} instructions`);
  return p;
}

const P = builds.map(profile);
const n = (x) => Math.round(x / opt.per).toLocaleString('en');
const pct = (x, of) => (of ? (100 * x / of).toFixed(1) : '-');
const cpi = (p) => (p.cycles / p.insns).toFixed(2);

function table(title, pick, width = 28) {
  const t = P.map(pick);
  if (t.some((x) => !x)) return;
  console.log(`\n${title}`);
  const keys = [...new Set(t.flatMap(Object.keys))];
  const cyc = (i, k) => t[i][k]?.cycles ?? 0, ins = (i, k) => t[i][k]?.insns ?? 0;
  let head, row, order;
  if (P.length === 1) {
    head = ['cycles', '%', 'insns', 'CPI'];
    row = (k) => [n(cyc(0, k)), pct(cyc(0, k), P[0].cycles), n(ins(0, k)), (cyc(0, k) / ins(0, k)).toFixed(2)];
    order = (a, b) => cyc(0, b) - cyc(0, a);
  } else {
    const gap = P[0].cycles - P[1].cycles;
    const [A, B] = builds.map((b) => b.label);
    head = [A, B, `${A} - ${B}`, '% of gap', `${A} insns`, `${B} insns`];
    row = (k) => [n(cyc(0, k)), n(cyc(1, k)), n(cyc(0, k) - cyc(1, k)), pct(cyc(0, k) - cyc(1, k), gap),
                  n(ins(0, k)), n(ins(1, k))];
    order = (a, b) => (cyc(0, b) - cyc(1, b)) - (cyc(0, a) - cyc(1, a)) || cyc(0, b) - cyc(0, a);
  }
  const w = head.map((h) => Math.max(h.length, 10));
  const line = (name, cells) => console.log(name.padEnd(width) + cells.map((c, i) => String(c).padStart(w[i] + 1)).join(''));
  line('', head);
  const sorted = keys.sort(order);
  for (const k of sorted.slice(0, opt.top)) line(k.length > width - 1 ? k.slice(0, width - 2) + '…' : k, row(k));
  if (sorted.length > opt.top) console.log(`  ... ${sorted.length - opt.top} more`);
}

const per = opt.per === 1 ? '' : ` per ${opt.per}`;
for (const [i, b] of builds.entries())
  console.log(`${b.label}: ${n(P[i].cycles)} cycles, ${n(P[i].insns)} instructions${per}, CPI ${cpi(P[i])}`);
table('By kind of cost', (p) => p.kind);
table('By function', (p) => p.fn);
table('By source file (-g)', (p) => p.file);
if (opt.lines) table('By source line (-g)', (p) => p.line, 34);
table('By mnemonic', (p) => p.mnem);

if (opt.kinds) {
  const kinds = [...new Set(P.flatMap((p) => Object.keys(p.kind)))]
    .sort((a, b) => (P[0].kind[b]?.cycles ?? 0) - (P[0].kind[a]?.cycles ?? 0));
  console.log('\nEach function by kind of cost, with its bytes');
  const head = ['bytes', ...kinds.map((k) => k.slice(0, 11))];
  const w = head.map((h) => Math.max(h.length, 8));
  const line = (name, cells) => console.log(name.padEnd(36) + cells.map((c, i) => String(c).padStart(w[i] + 1)).join(''));
  line('', head);
  const fns = [...new Set(P.flatMap((p) => Object.keys(p.fn)))]
    .sort((a, b) => Math.max(...P.map((p) => p.fn[b]?.cycles ?? 0)) - Math.max(...P.map((p) => p.fn[a]?.cycles ?? 0)));
  for (const f of fns.slice(0, opt.top))
    for (const [i, p] of P.entries()) {
      if (!p.fn[f]) continue;
      const name = (P.length > 1 ? `${builds[i].label} ` : '') + f;
      line(name.length > 35 ? name.slice(0, 34) + '…' : name,
           [p.size[f] ?? '', ...kinds.map((k) => n(p.fnKind[f][k] ?? 0))]);
    }
}
