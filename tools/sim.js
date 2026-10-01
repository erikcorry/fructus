#!/usr/bin/env node
// =============================================================================
// sim.js - the fructus simulator
// =============================================================================
//
// Executes the `semantics` expressions in isa/fructus.toml against the decoder
// in decode.js.  Nothing about the machine is written here: the register width,
// the endianness, which register is sp, and what every instruction does are all
// read from the spec.  What IS written here is the meaning of the twenty-odd
// operators and builtins the semantics are written in.
//
// WHY THE SEMANTICS ARE A LANGUAGE AND NOT JAVASCRIPT.  Eval-ing them as JS
// would have cost nothing and worked immediately.  The reason not to is that
// the spec is meant to drive a hardware description too, and a semantics field
// full of JS is a semantics field that only ever drives JavaScript.  The
// language below is deliberately small enough to re-target: expressions over
// 16-bit values, a register file, two memory widths, no loops, no locals, no
// control flow but a single `if`.  Everything in it has an obvious translation
// to C and a fairly obvious one to Verilog.
//
// Usage:
//     node tools/sim.js <binary> [--pc N] [--sp N] [--trace] [--max N]
// =============================================================================

import { readFileSync } from 'node:fs';
import { loadSpec, nameIndex } from './isa.js';
import { buildDecoder, decode, render } from './decode.js';

// =============================================================================
// The semantics language
// =============================================================================

const PUNCT = ['<<', '>>', '<=', '>=', '==', '!=', '&&', '||',
               '+', '-', '*', '/', '%', '&', '|', '^', '~', '!',
               '<', '>', '=', '(', ')', '[', ']', ',', ';', '?', ':', '.'];

function lex(src) {
  const ts = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9]/.test(c)) {
      const m = /^(0x[0-9a-fA-F]+|[0-9]+)/.exec(src.slice(i));
      ts.push({ t: 'num', v: Number(m[1]) }); i += m[1].length; continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^\w+/.exec(src.slice(i));
      ts.push({ t: 'id', v: m[0] }); i += m[0].length; continue;
    }
    const p = PUNCT.find((q) => src.startsWith(q, i));
    if (!p) throw new Error(`semantics: unexpected character '${c}' in ${JSON.stringify(src)}`);
    ts.push({ t: p }); i += p.length;
  }
  ts.push({ t: 'end' });
  return ts;
}

// Recursive descent.  The precedence ladder is C's, minus the parts the
// semantics do not use.
function parse(src) {
  const ts = lex(src);
  let p = 0;
  const peek = () => ts[p];
  const at   = (t) => ts[p].t === t;
  const eat  = (t) => { if (!at(t)) throw new Error(`semantics: expected ${t}, got ${ts[p].t} in ${JSON.stringify(src)}`); return ts[p++]; };
  const opt  = (t) => at(t) ? (p++, true) : false;

  const binary = (next, ops) => () => {
    let l = next();
    for (;;) {
      const o = ops.find((x) => at(x));
      if (!o) return l;
      p++;
      l = { n: 'bin', op: o, l, r: next() };
    }
  };

  function primary() {
    if (opt('(')) { const e = expr(); eat(')'); return e; }
    if (at('-'))  { p++; return { n: 'un', op: '-', e: primary() }; }
    if (at('~'))  { p++; return { n: 'un', op: '~', e: primary() }; }
    if (at('!'))  { p++; return { n: 'un', op: '!', e: primary() }; }
    if (at('num')) return { n: 'num', v: ts[p++].v };
    if (at('id')) {
      const name = ts[p++].v;
      if (opt('[')) { const e = expr(); eat(']'); return { n: 'mem', space: name, addr: e }; }
      if (opt('(')) {
        const args = [];
        if (!at(')')) do { args.push(expr()); } while (opt(','));
        eat(')');
        return { n: 'call', fn: name, args };
      }
      if (opt('.')) return { n: 'part', name, part: eat('id').v };
      return { n: 'var', name };
    }
    throw new Error(`semantics: unexpected ${ts[p].t} in ${JSON.stringify(src)}`);
  }

  const mul   = binary(primary, ['*', '/', '%']);
  const add   = binary(mul,   ['+', '-']);
  const shift = binary(add,   ['<<', '>>']);
  const rel   = binary(shift, ['<=', '>=', '<', '>']);
  const eqty  = binary(rel,   ['==', '!=']);
  const band  = binary(eqty,  ['&']);
  const bxor  = binary(band,  ['^']);
  const bor   = binary(bxor,  ['|']);
  const land  = binary(bor,   ['&&']);
  const lor   = binary(land,  ['||']);

  function expr() {
    const c = lor();
    if (opt('?')) { const a = expr(); eat(':'); return { n: 'cond', c, a, b: expr() }; }
    return c;
  }

  function stmt() {
    if (at('id') && peek().v === 'if') {
      p++; eat('('); const c = expr(); eat(')');
      return { n: 'if', c, body: stmt() };
    }
    const target = primary();
    eat('=');
    return { n: 'set', target, value: expr() };
  }

  const body = [];
  for (;;) {
    while (opt(';')) {}
    if (at('end')) break;
    body.push(stmt());
  }
  eat('end');
  return body;
}

// Does this statement assign pc from an expression that mentions pc?  That is
// the whole test for "relative branch", and it reads the spec rather than
// repeating it - see the cost model under [cpu] in isa/fructus.toml.
const PC = 'pc';
function mentionsPc(n) {
  if (!n || typeof n !== 'object') return false;
  if (n.n === 'var') return n.name === PC;
  for (const k of ['l', 'r', 'e', 'c', 'a', 'b', 'addr', 'value', 'body', 'target'])
    if (mentionsPc(n[k])) return true;
  return (n.args ?? []).some(mentionsPc);
}
function isRelativeBranch(st) {
  if (st.n === 'if') return isRelativeBranch(st.body);
  return st.n === 'set' && st.target && st.target.n === 'var' && st.target.name === PC
      && mentionsPc(st.value);
}

// =============================================================================
// The machine
// =============================================================================

const W = 16, MASK = 0xffff, HALF = 0x8000;
const u16 = (v) => v & MASK;
const s16 = (v) => ((v & MASK) ^ HALF) - HALF;

// The branch predicates.  This is the same table check.js proves the condimm5
// entries distinct with; `vs` is signed overflow of x - k, which is what makes
// `vs #1` a "did this counter just overflow" test.
export function test(cond, x, y, w) {
  const m = (1 << w) - 1, half = 1 << (w - 1);
  const sg = (v) => ((v & m) >= half ? (v & m) - (1 << w) : (v & m));
  const xu = x & m, yu = y & m, xs = sg(x), ys = sg(y), d = xs - ys;
  switch (cond) {
    case 'eq': return xu === yu;
    case 'ne': return xu !== yu;
    case 'lt': return xs <  ys;
    case 'le': return xs <= ys;
    case 'gt': return xs >  ys;
    case 'ge': return xs >= ys;
    case 'lo': return xu <  yu;
    case 'ls': return xu <= yu;
    case 'hi': return xu >  yu;
    case 'hs': return xu >= yu;
    case 'vs': return d < -half || d >= half;
    case 'vc': return !(d < -half || d >= half);
    default: throw new Error(`unknown condition ${cond}`);
  }
}

// The unary operations, exported so tests can use the simulator's own
// implementations as their reference rather than a second transcription.
export const BUILTIN = {
  sxt8:     (x) => (((x & 0xff) ^ 0x80) - 0x80),
  shl:      (x, n) => x << n,
  lsr:      (x, n) => (x & MASK) >>> n,
  asr:      (x, n) => s16(x) >> n,
  clz:      (x) => { x &= MASK; if (!x) return W; let n = 0; while (!(x & HALF)) { x <<= 1; n++; } return n; },
  popcount: (x) => { x &= MASK; let n = 0; while (x) { n += x & 1; x >>>= 1; } return n; },
  bitrev:   (x) => { x &= MASK; let r = 0; for (let i = 0; i < W; i++) { r = (r << 1) | ((x >>> i) & 1); } return r; },
  clmul:    (x) => { let r = 0; for (let i = 0; i < 8; i++) if ((x >>> i) & 1) r ^= ((x >>> 8) & 0xff) << i; return r; },
  test:     (c, x, y, w) => (test(c, x, y, w) ? 1 : 0),
};

export class Machine {
  constructor(spec) {
    this.spec  = spec;
    this.dec   = buildDecoder(spec);
    this.mem   = new Uint8Array(1 << spec.cpu.addr_bits);
    this.R     = new Uint16Array(spec.optype.reg.names.length);
    this.pc    = 0;
    this.halted = false;

    // THE EXCEPTION STATE, which is not in the register file and is not
    // reachable from one.  `brk` and `rti` move values through these and
    // nothing else touches them, which is why they live here beside `halted`
    // rather than in `named` below - `named` is built from the spec's register
    // list, and a shadow is deliberately not a register.  See isa/fructus.toml.
    //
    // ie STARTS CLEAR because the machine boots with interrupts disabled: the
    // boot stub arms shadow_isp with an `rti` on its way to user code, and an
    // interrupt arriving before that would find a stack pointer nobody set.
    this.ie         = false;
    this.shadow_sp  = 0;
    this.shadow_isp = 0;
    this.shadow_lr  = 0;
    this.vector     = spec.cpu.vectors.brk;
    this.little = spec.cpu.endian === 'little';
    this.count  = 0;
    this.tmp    = {};      // scratch names, cleared at every instruction

    // THE COST MODEL.  See [cpu] in the spec, which is where it is defined, and
    // rtl/cpu.sv, whose dispatch cadence tests/cpu-check.mjs holds this to,
    // instruction by instruction.  The pipeline dispatches one instruction a
    // cycle; step() charges each instruction the cycles from its dispatch to
    // the next one's.
    this.cyc     = 0;      // cycles, dispatch to dispatch
    this.odd     = 0;      // of them, cycles lost to a three-byte instruction at an odd address
    this.bus     = 0;      // data bytes read or written
    this.xfer    = 0;      // data accesses: a byte, or an aligned word
    this.split   = 0;      // of them, cycles lost to words at odd addresses
    this.penalty = spec.cpu.taken_branch_penalty ?? 0;

    // WHICH INSTRUCTIONS PAY IT COMES FROM THE SEMANTICS, not from a list here
    // that would have to be kept in step.  An instruction is a relative branch
    // exactly when it assigns pc from an expression that mentions pc:
    //
    //     pc = pc + off     relative, pays when taken
    //     pc = target       absolute, latched as it is fetched, pays nothing
    //     pc = lr           absolute, straight out of the register file
    this.relative = new Map();

    // sp and lr are register ALIASES in the spec, not hardcoded numbers here.
    const reg = spec.optype.reg;
    // Both the aliases and the registers' OWN names, because an instruction
    // that walks a pointer names it outright - `stm` steps r1 and `ldm` steps
    // r2, the way push and pop step sp - and semantics have to be able to say
    // so.  Operand names are single letters, so nothing here can collide.
    this.named = {};
    reg.names.forEach((n, i) => { this.named[n] = i; });
    for (const [alias, target] of Object.entries(reg.aliases ?? {})) this.named[alias] = nameIndex(reg, target);

    this.sem = new Map();          // insn object -> parsed statement list
    for (const insn of spec.insn) {
      if (insn.semantics === undefined) throw new Error(`${insn.mnemonic}: no semantics`);
      const body = parse(insn.semantics);
      this.sem.set(insn, body);
      this.relative.set(insn, body.some(isRelativeBranch));
    }
  }

  load(bytes, addr = 0) { this.mem.set(bytes, addr); return this; }

  // AN ALIGNED WORD IS ONE ACCESS, any other a byte at a time: memory is a
  // word wide, and rtl/cpu.sv takes a word whole when its address is even.
  rd8 (a)    { this.bus += 1; this.xfer += 1; return this.mem[a & MASK]; }
  wr8 (a, v) { this.bus += 1; this.xfer += 1; this.mem[a & MASK] = v & 0xff; }
  rd16(a)    {
    this.bus += 2; this.xfer += a & 1 ? 2 : 1; this.split += a & 1;
    const lo = this.mem[a & MASK], hi = this.mem[(a + 1) & MASK];
    return this.little ? lo | (hi << 8) : hi | (lo << 8);
  }
  wr16(a, v) {
    this.bus += 2; this.xfer += a & 1 ? 2 : 1; this.split += a & 1;
    const lo = v & 0xff, hi = (v >>> 8) & 0xff;
    this.mem[a & MASK]       = this.little ? lo : hi;
    this.mem[(a + 1) & MASK] = this.little ? hi : lo;
  }

  // --- evaluating one instruction's semantics --------------------------------
  ev(node, ops) {
    switch (node.n) {
      case 'num':  return node.v;
      case 'var': {
        const n = node.name;
        if (n === 'pc')     return this.pc;
        if (n === 'halted') return this.halted ? 1 : 0;
        if (n === 'ie')     return this.ie ? 1 : 0;
        if (n === 'vector') return this.vector;
        if (n === 'shadow_sp')  return this.shadow_sp;
        if (n === 'shadow_isp') return this.shadow_isp;
        if (n === 'shadow_lr')  return this.shadow_lr;
        if (n in this.named) return this.R[this.named[n]];
        if (n in ops)       return ops[n];
        if (n in this.tmp)  return this.tmp[n];
        throw new Error(`semantics: unknown name '${n}'`);
      }
      case 'part': return ops[node.name][node.part];
      case 'mem': {
        const a = this.ev(node.addr, ops);
        if (node.space === 'R')   return this.R[a & (this.R.length - 1)];
        if (node.space === 'M8')  return this.rd8(a);
        if (node.space === 'M16') return this.rd16(a);
        throw new Error(`semantics: unknown space ${node.space}`);
      }
      case 'call': {
        const f = BUILTIN[node.fn];
        if (!f) throw new Error(`semantics: unknown builtin ${node.fn}`);
        return f(...node.args.map((a) => this.ev(a, ops)));
      }
      case 'un': {
        const v = this.ev(node.e, ops);
        return node.op === '-' ? -v : node.op === '~' ? ~v : (v ? 0 : 1);
      }
      case 'cond': return this.ev(node.c, ops) ? this.ev(node.a, ops) : this.ev(node.b, ops);
      case 'bin': {
        const a = this.ev(node.l, ops), b = this.ev(node.r, ops);
        switch (node.op) {
          case '+': return a + b;   case '-': return a - b;
          case '*': return a * b;   case '/': return (a / b) | 0;
          case '%': return a % b;
          case '&': return a & b;   case '|': return a | b;   case '^': return a ^ b;
          case '<<': return a << b; case '>>': return a >> b;
          case '<': return a < b ? 1 : 0;   case '<=': return a <= b ? 1 : 0;
          case '>': return a > b ? 1 : 0;   case '>=': return a >= b ? 1 : 0;
          case '==': return a === b ? 1 : 0; case '!=': return a !== b ? 1 : 0;
          case '&&': return (a && b) ? 1 : 0; case '||': return (a || b) ? 1 : 0;
        }
        throw new Error(`semantics: unknown operator ${node.op}`);
      }
    }
    throw new Error(`semantics: unknown node ${node.n}`);
  }

  exec(node, ops) {
    if (node.n === 'if') { if (this.ev(node.c, ops)) this.exec(node.body, ops); return; }
    const v = this.ev(node.value, ops), t = node.target;
    if (t.n === 'mem') {
      const a = this.ev(t.addr, ops);
      if (t.space === 'R')        this.R[a & (this.R.length - 1)] = u16(v);
      else if (t.space === 'M8')  this.wr8(a, v);
      else if (t.space === 'M16') this.wr16(a, v);
      else throw new Error(`semantics: cannot assign to ${t.space}`);
      return;
    }
    if (t.n === 'var') {
      if (t.name === 'pc')     { this.pc = u16(v); this.wrotePc = true; return; }
      if (t.name === 'halted') { this.halted = !!v; return; }
      // THESE MUST BE TESTED BEFORE THE SCRATCH FALLBACK BELOW.  An unknown
      // name becomes a per-instruction temporary, so a misspelling here would
      // not fail - `brk` would assign its shadow to a value that is discarded
      // at the end of the instruction and the interrupt would silently lose
      // the interrupted code's sp.  `vector` is deliberately absent: it is a
      // chip constant and nothing may assign to it.
      if (t.name === 'ie')         { this.ie = !!v; return; }
      if (t.name === 'shadow_sp')  { this.shadow_sp  = u16(v); return; }
      if (t.name === 'shadow_isp') { this.shadow_isp = u16(v); return; }
      if (t.name === 'shadow_lr')  { this.shadow_lr  = u16(v); return; }
      if (t.name in this.named) { this.R[this.named[t.name]] = u16(v); return; }
      // ANY OTHER NAME IS A SCRATCH VALUE that lives for this instruction only.
      // push, pop, stm and ldm use one to hold the pointer they were entered
      // with, so that every address they compute is an offset from it and the
      // pointer's own update can come last - which is what the hardware does
      // and what makes `pop sp` mean something definite.  See isa/fructus.toml.
      this.tmp[t.name] = u16(v); return;
    }
    throw new Error(`semantics: cannot assign to ${JSON.stringify(t)}`);
  }

  // One instruction.  `pc` is advanced BEFORE the semantics run, so `pc` inside
  // them means the address of the next instruction - which is what makes
  // `lr = pc` and `pc = pc + off` read the way the spec's summaries describe.
  step(trace = null) {
    const at = this.pc;
    const d  = decode(this.dec, this.mem, at);
    if (!d) throw new Error(`no instruction at 0x${at.toString(16)} (first byte 0x${this.mem[at].toString(16)})`);
    this.pc = u16(at + d.nbytes);
    const sem = d.insn.semantics ?? '';
    const xfer = this.xfer;
    this.wrotePc = false;
    this.tmp = {};           // no scratch name outlives its instruction
    if (trace) trace(at, d, this);
    for (const s of this.sem.get(d.insn)) this.exec(s, d.ops);
    this.cyc += this.cost(d, at, sem, this.xfer - xfer);
    this.count++;
    return d;
  }

  // The cycles from this instruction's dispatch to the next one's, on the
  // pipeline in rtl/cpu.sv.  `moved` is the data accesses it made: a byte,
  // or a word at an even address.
  cost(d, at, sem, moved) {
    // AN EXCEPTION IS SIX CYCLES, and it is recognised by naming a shadow -
    // which only `brk' and `rti' do: a microcode routine that moves sp and lr
    // through the shadows, and a redirect of the fetch through taken_q.  sei
    // and cli are routines too, without the redirect, and cost five.
    if (/shadow_lr|shadow_sp/.test(sem)) return 6;
    if (/^ie = [01]$/.test(sem)) return 5;
    // A MEMORY INSTRUCTION STOPS DISPATCH until its last address is out, and
    // makes an access a cycle: a word when it is aligned, a byte when not.  A
    // load's first address comes straight out of the ALU's adder, so N
    // accesses cost N + 3; a store registers its address first and costs
    // N + 4.  ld8 and an aligned ld 4, an odd one 5; st8 and an aligned st 5,
    // an odd one 6; push of three registers 7 aligned, 10 not.  How many
    // accesses is what the semantics made.
    if (/M(8|16)\[/.test(sem)) {
      const stores = sem.split(';').some((s) => /^\s*M(8|16)\[/.test(s.trim()));
      return moved + (stores ? 4 : 3);
    }
    // mul, clz and popcount run a two-step routine: `extra_cycles` beyond one.
    if (d.insn.extra_cycles) return 1 + d.insn.extra_cycles;
    // A CONDITIONAL BRANCH FLOWS DOWN THE PIPE LIKE AN ALU INSTRUCTION, with
    // dispatch carrying on behind it.  TAKEN, it squashes the three behind it
    // and fetches the target: `taken_branch_penalty` more.  Taken means the
    // assignment to pc RAN, not that pc ended up somewhere else - a branch to
    // the very next instruction still pays, which tests/branch-cost.s pins.
    if (/^if /.test(sem) && this.relative.get(d.insn)) {
      if (this.wrotePc) return 1 + this.penalty;
    } else if (this.wrotePc) {
      // A JUMP OR CALL stops dispatch behind it and fetches the target in its
      // ALU cycle: three cycles.  Through a register - jmp ra, call ra, ret -
      // the target goes through taken_q, a cycle later: four.  `call lr` goes
      // to the NEW lr, the next pc, which is no register read: three.
      const viaReg = /\bpc = (lr|R\[[a-z]\])$/.test(sem)
                  && !(/^lr = pc; pc = R\[a\]$/.test(sem) && d.ops.a === this.named.lr);
      return viaReg ? 4 : 3;
    }
    // ANYTHING ELSE IS ONE CYCLE, unless its bytes cannot be there in time.
    // Memory is a word wide and the fetch holds the word after the pc's: three
    // bytes at an odd address reach into the word after that, which arrives a
    // cycle late.
    if (d.nbytes === 3 && (at & 1)) { this.odd++; return 2; }
    return 1;
  }

  // Run until halted, until `stopAt` is reached, or until `max` instructions.
  run({ max = 1e7, stopAt = null, trace = null } = {}) {
    while (!this.halted && this.count < max) {
      if (stopAt !== null && this.pc === stopAt) return 'stopped';
      this.step(trace);
    }
    return this.halted ? 'halted' : 'ran out';
  }

  regs() { return Array.from(this.R); }
  // Zero the cost counters.  Tests used to open-code this, and open-coded the
  // SUM as well - which is how the taken-branch penalty went unnoticed by every
  // cycle assertion in the suite the moment it was added.  One definition.
  reset() { this.cyc = this.odd = this.bus = this.xfer = this.split = 0; return this; }
  cycles() { return this.cyc; }
}

// =============================================================================
// CLI
// =============================================================================

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const opt = { pc: 0, sp: 0xfffe, trace: false, max: 1e6, file: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--trace') opt.trace = true;
    else if (a === '--pc')  opt.pc  = Number(args[++i]);
    else if (a === '--sp')  opt.sp  = Number(args[++i]);
    else if (a === '--max') opt.max = Number(args[++i]);
    else opt.file = a;
  }
  if (!opt.file) { console.error('usage: sim.js <binary> [--pc N] [--sp N] [--trace] [--max N]'); process.exit(2); }

  const spec = loadSpec();
  const m = new Machine(spec).load(readFileSync(opt.file));
  m.pc = opt.pc;
  m.R[m.named.sp] = opt.sp;

  const trace = opt.trace
    ? (at, d, mm) => console.log(`${at.toString(16).padStart(4, '0')}  ${render(spec, d).padEnd(30)} ` +
        mm.regs().map((v, i) => `${spec.optype.reg.names[i]}=${v.toString(16).padStart(4, '0')}`).join(' '))
    : null;

  const why = m.run({ max: opt.max, trace });
  console.log(`${why} after ${m.count} instructions`);
  console.log(m.regs().map((v, i) => `${spec.optype.reg.names[i]}=${v.toString(16).padStart(4, '0')}`).join(' '));
}
