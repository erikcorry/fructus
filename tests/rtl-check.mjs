#!/usr/bin/env node
// =============================================================================
// rtl-check.mjs - rtl/*.sv against the spec, not against themselves
// =============================================================================
//
//   node tests/rtl-check.mjs
//
// The vectors are built here from isa/fructus.toml's own value tables, and the
// Verilog is built by tools/gen-immgen.js and tools/gen-rhs.js from the same
// file.  Neither side reads the other, so agreement means the circuits
// implement the tables rather than that one transcription matches another.
//
// WHAT IS SWEPT.  Every (5-bit field, mode) pair, every (3-bit index, opcode
// bit) pair, and imm10 over its whole 10-bit range - with the untouched bits of
// the instruction register varied, because a circuit that accidentally reads
// them would otherwise pass.  Modes +6 and +7 have no immediate and what immgen drives there is meaningless,
// so they are not checked; what IS checked is the encoding property rhs.sv
// relies on instead - that port B's register number is {byte1[7:6], opcode[0]}
// for every three-operand form.
//
// Needs iverilog.  Skips with a message rather than failing when it is absent,
// so the suite still runs on a machine without the FPGA tools installed.
// =============================================================================

import { loadSpec } from '../tools/isa.js';
import { BUILTIN, test, Machine } from '../tools/sim.js';
import { buildDecoder, decode } from '../tools/decode.js';
import { execFileSync } from 'node:child_process';
import { assemble } from './harness.mjs';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';

const have = (cmd) => {
  try { execFileSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }); return true; }
  catch { return false; }
};
if (!have('iverilog')) {
  console.log('skip  tests/rtl-check.mjs: iverilog not installed');
  process.exit(0);
}

const spec = loadSpec();
const t = spec.optype;
const u16 = (v) => (v >>> 0) & 0xffff;
const sext = (v, n) => (v & (1 << (n - 1))) ? v - (1 << n) : v;

const hex4 = (v) => u16(v).toString(16).padStart(4, '0');
const hex6 = (v) => ((v >>> 0) & 0xffffff).toString(16).padStart(6, '0');

// --- the reference, straight off the tables ---------------------------------
// This is the whole specification of the block.  `insn` is the instruction
// register of rtl/insn.sv: byte 0 in the low eight bits, byte 1 next, byte 2 at
// the top, each at a fixed place for the whole instruction.
const k3 = (insn) => (((insn >> 14) & 3) << 1) | (insn & 1);  // {byte1[7:6], opcode[0]}
const CIMM = spec.optype.condimm5.values.map((e) => e[1]);
const want = (insn, cimm) => {
  // cimm reads +0's five bits as a condimm5 index instead of a signed integer,
  // and is ignored anywhere else - asserting it there is a microcode bug.
  // A five-bit field is byte1[7:3]; imm10 is byte1[7:6] with byte 2 above it,
  // one slice.
  const sel = insn & 7;
  const f5 = (insn >> 11) & 31;
  if (cimm && sel === 0) return CIMM[f5];
  switch (sel) {
    case 0: return sext(f5, 5);                          // imm5
    case 1: return sext((insn >> 14) & 1023, 10);        // imm10
    case 2: case 3: return t.imm3.values[k3(insn)];      // imm3
    case 4: return t.immbit5.values[f5];                 // immbit5
    case 5: return t.immask5.values[f5];                 // immask5
    // 6 and 7 have no immediate: rtl/rhs.sv takes port B's number from the
    // bytes directly, so what immgen drives there is meaningless.
  }
};

// --- where each unary operation sits ------------------------------------------
// Worked out from real bytes, not the generator: decode every unary instruction,
// look its imm3 index up in the spec's table, take bits 2:1 of the value - what
// reaches rtl/unary.sv - and note whether the spec gives it an extra cycle.  The
// bit that tells a pair apart is whichever bit of the code differs within that
// opcode's pair.
const unaryOps = () => {
  const dec = buildDecoder(spec), ops = [];
  for (let op = 0; op < 256; op++)
    for (const b1 of [0x00, 0x40, 0x80, 0xc0]) {
      const d = decode(dec, [op, b1, 0], 0);
      const m = /^R\[d\] = (\w+)\(R\[a\]\)$/.exec(d?.insn.semantics ?? '');
      if (!m || d.nbytes !== 2 || !(m[1] in BUILTIN)) continue;
      const index = ((b1 >> 6) << 1) | (op & 1);
      ops.push({ name: m[1], op, code: (u16(t.imm3.values[index]) >> 1) & 3, slow: (d.insn.extra_cycles ?? 0) > 0 });
    }
  for (const o of ops) {
    const mate = ops.find((x) => x.op === o.op && x !== o);
    const diff = mate ? o.code ^ mate.code : 2;
    o.bit = diff === 1 ? 1 : 2;
    o.level = (o.code >> (o.bit - 1)) & 1;
  }
  return ops;
};

// --- what +6 and +7 carry, checked against the DECODER --------------------
// k3 below asserts that the third register of a three-operand form is
// {byte1[7:6], opcode[0]}.  Rather than trust that reading of the spec, decode
// real bytes with tools/decode.js - the same decoder the roundtrip test uses -
// and compare.  A change to the field layout then fails here instead of quietly
// making this file check the wrong thing.
{
  // rtl/rhs.sv COMPUTES PORT B'S NUMBER AS {byte1[7:6], opcode[0]} without
  // consulting the decoder, so this is where that shortcut is justified.
  //
  // WHICH OPERAND PORT B IS depends on the instruction, and naming it here is
  // the point of the check rather than an inconvenience.  add and shl call it
  // `b`; push and pop call it `c` (and have a `b` of their own, so the name has
  // to be explicit); and br calls it `a`, because the branch's registers are
  // deliberately the other way round from its syntax so that the comparison is
  // an `rsb` - see the br section of isa/fructus.toml.
  // The base opcodes come from the SPEC, not from a list here - they moved once
  // already when a row was renumbered, and a hardcoded 0x86 then checked an
  // opcode that no longer had the operand it named.
  const portB = {};
  for (const insn of spec.insn)
    for (const form of insn.form ?? []) {
      const f = form.fields ?? {};
      const name = Object.entries(f).find(([, v]) => /^[a-z]:reg\[0\]$/.test(v))?.[1]?.[0];
      if (!name) continue;
      const bits = (form.encoding ?? '').split(/\s+/)[0].replace(/_/g, '');
      if (bits.length !== 8) continue;
      portB[parseInt(bits.replace(/[a-z]/g, '0'), 2)] = name;
    }
  const dec = buildDecoder(spec);
  for (const [base, name] of Object.entries(portB)) {
    for (let lowbit = 0; lowbit <= 1; lowbit++)
      for (let byte1 = 0; byte1 < 256; byte1++) {
        const op = Number(base) + lowbit;
        const got = decode(dec, [op, byte1, 0], 0)?.ops?.[name];
        if (got === undefined) {
          console.log(`FAIL  0x${op.toString(16)} has no operand named ${name}`); process.exit(1);
        }
        if (got !== k3((byte1 << 8) | op)) {
          console.log(`FAIL  0x${op.toString(16)} byte1=${byte1}: operand ${name} decodes to `
                    + `r${got}, but {byte1[7:6], opcode[0]} is r${k3((byte1 << 8) | op)}`);
          process.exit(1);
        }
      }
  }
}

// Every value of insn[23:11] - the five-bit field, the imm3 index's high bits
// and the whole of imm10 - in every column, with byte 1's low bits and the rest
// of the opcode varied beneath, because a circuit reading them would otherwise
// pass.
const vecs = [];
for (let sel = 0; sel <= 5; sel++)
  for (const cimm of [0, 1])
    for (let top = 0; top < 8192; top++) {
      const insn = (top << 11) | ((((top * 157) ^ (top >> 5)) & 0xff) << 3) | sel;
      vecs.push(`${hex6(insn)} ${cimm} ${hex4(want(insn, cimm))}`);
    }

mkdirSync('build', { recursive: true });
writeFileSync('build/immgen-vectors.txt', vecs.join('\n') + '\n');
writeFileSync('build/immgen-tb.sv', `module tb;
    logic [23:0] insn;
    logic [15:0] expect_, got;
    logic cimm;
    integer f, n = 0, bad = 0, r;
    immgen u (.insn(insn), .cimm(cimm), .imm(got));
    initial begin
        f = $fopen("build/immgen-vectors.txt", "r");
        if (f == 0) begin $display("FAIL cannot open vectors"); $finish; end
        while (!$feof(f)) begin
            r = $fscanf(f, "%h %d %h\\n", insn, cimm, expect_);
            if (r == 3) begin
                #1;
                n = n + 1;
                if (got !== expect_) begin
                    bad = bad + 1;
                    if (bad < 6)
                        $display("  MISMATCH insn=%h cimm=%0d want=%h got=%h",
                                 insn, cimm, expect_, got);
                end
            end
        end
        if (bad == 0) $display("ok    rtl/immgen.sv: %0d vectors from the spec, all correct", n);
        else $display("FAIL  rtl/immgen.sv: %0d of %0d wrong", bad, n);
        $finish;
    end
endmodule
`);

execFileSync('iverilog', ['-g2012', '-o', 'build/immgen-tb.vvp', 'rtl/immgen.sv', 'build/immgen-tb.sv'],
             { stdio: 'inherit' });
const out = execFileSync('vvp', ['build/immgen-tb.vvp'], { encoding: 'utf8' });
process.stdout.write(out.split('\n').filter((l) => /^(ok|FAIL)|MISMATCH/.test(l)).join('\n') + '\n');
for (const f of ['build/immgen-tb.vvp', 'build/immgen-tb.sv', 'build/immgen-vectors.txt']) rmSync(f, { force: true });
let failed = /FAIL/.test(out);

// =============================================================================
// rtl/rhs.sv - the one microcode field on top of immgen
// =============================================================================
// The reference is the module's contract stated once: sixteen codes choosing a
// register, a constant, or immgen in one of its two readings.  regval stands in
// for the register file, so this covers the wiring rather than the file.
//
// ALL SIXTEEN CODES ARE SWEPT, the two reserved ones included.  They are not
// meant to be emitted, but they decode as r2/r3 today by accident of the
// wiring and the check pins that: a later change that gives them a meaning has
// to come here and say so rather than silently altering what they do - as code
// 4 did, when it became the 16-bit immediate.
{
  // must match tools/gen-rhs.js
  const REG = { 0: 0, 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7 };   // src[3]=0
  const KON = { 0: 0, 1: 1, 2: 2, 6: -2, 7: -1 };                    // src[3]=1
  const MODE_IMM = 3, MODE_CIMM = 4, MODE_PORTB = 5;
  const CODE_IMM16 = 4;                                              // src[3]=0
  const movDec = buildDecoder(spec);
  const MOV16 = [...Array(256).keys()].find((op) => {
    const d = decode(movDec, [op, 0, 0], 0);
    return d && d.nbytes === 3 && /^\s*R\[[a-z]\]\s*=\s*imm\s*$/.test(d.insn.semantics ?? '');
  });
  const rows = [];
  const rnd = (() => { let s = 2463534242;
    return () => (s ^= s << 13, s ^= s >>> 17, s ^= s << 5, s >>> 0); })();

  for (let sel = 0; sel <= 7; sel++)
    for (let src = 0; src < 16; src++)
      for (let i = 0; i < 12; i++) {
        const hi = src >> 3, c = src & 7;
        const isReg = (!hi && c !== CODE_IMM16) || (hi && c === MODE_PORTB);
        const isImm = hi && (c === MODE_IMM || c === MODE_CIMM);
        if (!hi && c === CODE_IMM16) {
          // The expected value comes from DECODING `mov rd, #imm16` bytes, laid
          // out as rtl/insn.sv holds them, not from knowing where the slice is.
          const op = MOV16 | (rnd() & 7);
          const b1 = rnd() & 0xff, b2 = rnd() & 0xff, rv = rnd() & 0xffff;
          const v = decode(movDec, [op, b1, b2], 0).ops.imm;
          rows.push(`${hex6((b2 << 16) | (b1 << 8) | op)} ${src} ${hex4(rv)} ${c} ${hex4(v)}`);
          continue;
        }
        // immgen drives x at +6 and +7, so reading it there is a microcode bug
        // rather than a case with an answer.
        if (isImm && sel >= 6) continue;
        const insn = ((rnd() & 0xffff) << 8) | ((rnd() & 0x1f) << 3) | sel;
        const regval = rnd() & 0xffff;
        const num = hi ? k3(insn) : REG[c];
        const rhs = isReg ? regval
                  : isImm ? want(insn, c === MODE_CIMM)
                  : KON[c];
        rows.push(`${hex6(insn)} ${src} ${hex4(regval)} ${num} ${hex4(rhs)}`);
      }

  writeFileSync('build/rhs-vectors.txt', rows.join('\n') + '\n');
  writeFileSync('build/rhs-tb.sv', `module tb;
    logic [23:0] insn;
    logic [15:0] regval, xrhs, grhs;
    logic [2:0] xnum, gnum;
    logic [3:0] src;
    integer f, n = 0, bad = 0, r;
    rhs u (.insn(insn), .src(src), .regval(regval),
           .regnum(gnum), .value(grhs));
    initial begin
        f = $fopen("build/rhs-vectors.txt", "r");
        if (f == 0) begin $display("FAIL cannot open vectors"); $finish; end
        while (!$feof(f)) begin
            r = $fscanf(f, "%h %d %h %d %h\\n",
                        insn, src, regval, xnum, xrhs);
            if (r == 5) begin
                #1; n = n + 1;
                if (grhs !== xrhs || gnum !== xnum) begin
                    bad = bad + 1;
                    if (bad < 6)
                        $display("  MISMATCH insn=%h src=%0d: want rhs=%h num=%0d, got rhs=%h num=%0d",
                                 insn, src, xrhs, xnum, grhs, gnum);
                end
            end
        end
        if (bad == 0) $display("ok    rtl/rhs.sv: %0d vectors from the spec, all correct", n);
        else $display("FAIL  rtl/rhs.sv: %0d of %0d wrong", bad, n);
        $finish;
    end
endmodule
`);
  execFileSync('iverilog', ['-g2012', '-o', 'build/rhs-tb.vvp',
                            'rtl/immgen.sv', 'rtl/rhs.sv', 'build/rhs-tb.sv'], { stdio: 'inherit' });
  const o = execFileSync('vvp', ['build/rhs-tb.vvp'], { encoding: 'utf8' });
  process.stdout.write(o.split('\n').filter((l) => /^(ok|FAIL)|MISMATCH/.test(l)).join('\n') + '\n');
  for (const f of ['build/rhs-tb.vvp', 'build/rhs-tb.sv', 'build/rhs-vectors.txt']) rmSync(f, { force: true });
  if (/FAIL/.test(o)) failed = true;
}

// =============================================================================
// rtl/unary.sv - the unary block
// =============================================================================
// The reference is the SIMULATOR's own implementations, not a transcription of
// them: tools/sim.js evaluates the spec's `semantics` strings against exactly
// these functions, so agreeing with them is agreeing with what the ISA says the
// instructions compute.
//
// Every operation is swept over its WHOLE input space - 65536 values each, four
// operations - because these are cheap to enumerate completely and a sampled
// sweep would miss precisely the interesting inputs: clz at 0 and 1, popcount
// at 0xffff, bitrev's fixed points.
{
  // a sel slow want - the slow pair is checked a clock after its input, since
  // its output is registered; the fast pair is checked at the same time
  const rows = [];
  for (const o of unaryOps())
    for (let a = 0; a < 65536; a++)
      rows.push(`${a.toString(16).padStart(4, '0')} ${o.level} ${o.slow ? 1 : 0} `
              + `${u16(BUILTIN[o.name](a)).toString(16).padStart(4, '0')}`);
  writeFileSync('build/unary-vectors.txt', rows.join('\n') + '\n');
  writeFileSync('build/unary-tb.sv', `module tb;
    logic clk = 0;
    logic [15:0] a, want_;
    wire  [15:0] fast, slow, y;
    logic sel, isslow;
    integer f, n = 0, bad = 0, r;
    unary u (.clk(clk), .a(a), .sel(sel), .fast(fast), .slow(slow));
    assign y = isslow ? slow : fast;
    initial begin
        f = $fopen("build/unary-vectors.txt", "r");
        if (f == 0) begin $display("FAIL cannot open vectors"); $finish; end
        while (!$feof(f)) begin
            r = $fscanf(f, "%h %d %d %h\\n", a, sel, isslow, want_);
            if (r == 4) begin
                #1 clk = 1; #1 clk = 0; #1; n = n + 1;
                if (y !== want_) begin
                    bad = bad + 1;
                    if (bad < 6)
                        $display("  MISMATCH a=%h sel=%0d want=%h got=%h", a, sel, want_, y);
                end
            end
        end
        if (bad == 0) $display("ok    rtl/unary.sv: %0d vectors from the spec, all correct", n);
        else $display("FAIL  rtl/unary.sv: %0d of %0d wrong", bad, n);
        $finish;
    end
endmodule
`);
  execFileSync('iverilog', ['-g2012', '-o', 'build/unary-tb.vvp',
                            'rtl/unary.sv', 'build/unary-tb.sv'], { stdio: 'inherit' });
  const o = execFileSync('vvp', ['build/unary-tb.vvp'], { encoding: 'utf8' });
  process.stdout.write(o.split('\n').filter((l) => /^(ok|FAIL)|MISMATCH/.test(l)).join('\n') + '\n');
  for (const f of ['build/unary-tb.vvp', 'build/unary-tb.sv', 'build/unary-vectors.txt']) rmSync(f, { force: true });
  if (/FAIL/.test(o)) failed = true;
}

// =============================================================================
// rtl/lhs.sv - port A's address
// =============================================================================
// Two things are checked, and the first is about the SPEC rather than the
// circuit: that every multi-byte form's left-hand register follows exactly one
// of byte1[2:0] and byte1[5:3] under tools/decode.js.  The left-hand operand is
// named here by a rule of this file's own - `a`, unless `a` is port B, in which
// case `b`; nothing for push and pop, which read sp - and not by importing the
// generator's reading of the semantics.
//
// The second is the circuit: every such form's decoded register against the
// field code, with a random byte 2 above byte 1 and the opcode below it, so a
// circuit reading the wrong byte fails; the registers the microcode names; and
// all sixteen codes against every byte 1, reserved codes included, pinned to
// what the wiring makes them today.
{
  const rnd = (() => { let s = 88172645;
    return () => (s ^= s << 13, s ^= s >>> 17, s ^= s << 5, s >>> 0); })();
  const dec = buildDecoder(spec);
  const rows = [];
  const row = (src, insn, want) => `${src} ${hex6(insn)} ${want}`;

  // Keyed by opcode and form: byte 1 picks among the unary operations, which
  // share two opcodes, so grouping by opcode alone would skip three of them.
  const forms = new Map();
  for (let op = 0; op < 256; op++)
    for (let b1 = 0; b1 < 256; b1++) {
      const e = decode(dec, [op, b1, 0], 0);
      if (!e || e.nbytes === 1 || /\bsp\s*=\s*sp\b/.test(e.insn.semantics ?? '')) continue;
      const portB = Object.values(e.form.fields ?? {}).find((v) => /^[a-z]:reg\[0\]$/.test(v))?.[0];
      const name = portB === 'a' ? 'b' : 'a';
      if (!(e.insn.operands ?? []).some((o) => o.name === name && o.type === 'reg')) continue;
      const key = `${op}/${e.insn.mnemonic}/${e.form.name}`;
      if (!forms.has(key)) forms.set(key, { op, key, follows: { 8: true, 9: true }, seen: [] });
      const f = forms.get(key);
      if (e.ops[name] !== (b1 & 7)) f.follows[8] = false;
      if (e.ops[name] !== ((b1 >> 3) & 7)) f.follows[9] = false;
      f.seen.push([b1, e.ops[name]]);
    }
  for (const f of forms.values()) {
    const codes = Object.keys(f.follows).filter((k) => f.follows[k]).map(Number);
    if (codes.length !== 1) {
      console.log(`FAIL  0x${f.op.toString(16)} ${f.key}: its left-hand register follows `
                + `${codes.length ? 'both' : 'neither'} of byte1[2:0] and byte1[5:3]`);
      failed = true; continue;
    }
    for (let i = 0; i < 24; i++) {
      const [b1, want] = f.seen[rnd() % f.seen.length];
      rows.push(row(codes[0], ((rnd() & 0xff) << 16) | (b1 << 8) | f.op, want));
    }
  }
  // one-byte forms and push/pop: a register the microcode names
  for (let reg = 0; reg < 8; reg++)
    for (let i = 0; i < 16; i++) rows.push(row(reg, rnd() & 0xffffff, reg));
  // every code against every byte 1
  for (let src = 0; src < 16; src++)
    for (let b1 = 0; b1 < 256; b1++) {
      const insn = ((rnd() & 0xff) << 16) | (b1 << 8) | (rnd() & 0xff);
      rows.push(row(src, insn, src < 8 ? src : (src & 1) ? (b1 >> 3) & 7 : b1 & 7));
    }

  writeFileSync('build/lhs-vectors.txt', rows.join('\n') + '\n');
  writeFileSync('build/lhs-tb.sv', `module tb;
    logic [3:0] src, want_;
    logic [23:0] insn;
    logic [2:0] got;
    integer f, n = 0, bad = 0, r;
    lhs u (.insn(insn), .src(src), .regnum(got));
    initial begin
        f = $fopen("build/lhs-vectors.txt", "r");
        if (f == 0) begin $display("FAIL cannot open vectors"); $finish; end
        while (!$feof(f)) begin
            r = $fscanf(f, "%d %h %d\\n", src, insn, want_);
            if (r == 3) begin
                #1; n = n + 1;
                if (got !== want_[2:0]) begin
                    bad = bad + 1;
                    if (bad < 6)
                        $display("  MISMATCH src=%0d insn=%h: want r%0d, got %b", src, insn, want_, got);
                end
            end
        end
        if (bad == 0) $display("ok    rtl/lhs.sv: %0d vectors, ${forms.size} forms from the decoder, all correct", n);
        else $display("FAIL  rtl/lhs.sv: %0d of %0d wrong", bad, n);
        $finish;
    end
endmodule
`);
  execFileSync('iverilog', ['-g2012', '-o', 'build/lhs-tb.vvp', 'rtl/lhs.sv', 'build/lhs-tb.sv'],
               { stdio: 'inherit' });
  const o = execFileSync('vvp', ['build/lhs-tb.vvp'], { encoding: 'utf8' });
  process.stdout.write(o.split('\n').filter((l) => /^(ok|FAIL)|MISMATCH/.test(l)).join('\n') + '\n');
  for (const f of ['build/lhs-tb.vvp', 'build/lhs-tb.sv', 'build/lhs-vectors.txt']) rmSync(f, { force: true });
  if (/FAIL/.test(o)) failed = true;
}

// =============================================================================
// rtl/insn.sv - the instruction register, clocked
// =============================================================================
// A model of the loading discipline run in step with the circuit.  dispatch
// puts the bus byte at byte 0 and restarts the count behind it; fetch puts it
// where the count points; any other cycle - a data byte on the bus, the adder
// busy - leaves the register alone.  Instructions of one, two and three bytes,
// with idle cycles between some of them.
//
// Checked every cycle, before the edge: `q` against what the model has stored,
// and `view` against `q` with the bus byte in place when it is byte 1 or 2 -
// and NOT when it is an opcode, whose cycle still belongs to the previous
// instruction.  Bytes never written since reset are masked rather than guessed.
{
  const rnd = (() => { let s = 1234567;
    return () => (s ^= s << 13, s ^= s >>> 17, s ^= s << 5, s >>> 0); })();
  const rows = [];
  let q = 0, known = 0, n = 0;
  const put = (v, k, b) => (v & ~(0xff << (8 * k)) & 0xffffff) | (b << (8 * k));
  const cycle = (fetch, dispatch, bus) => {
    const load = fetch || dispatch, at = dispatch ? 0 : n;
    let view = q, vknown = known;
    if (load && (at === 1 || at === 2)) { view = put(q, at, bus); vknown |= 0xff << (8 * at); }
    rows.push(`${fetch} ${dispatch} ${bus.toString(16).padStart(2, '0')} `
            + `${hex6(q)} ${hex6(known)} ${hex6(view)} ${hex6(vknown)}`);
    if (load) {
      if (at <= 2) { q = put(q, at, bus); known |= 0xff << (8 * at); }
      n = (at + 1) & 3;
    }
  };
  for (let i = 0; i < 3000; i++) {
    const len = 1 + (rnd() % 3);
    cycle(0, 1, rnd() & 0xff);
    for (let k = 1; k < len; k++) cycle(1, 0, rnd() & 0xff);
    for (let idle = rnd() % 4; idle >= 2; idle--) cycle(0, 0, rnd() & 0xff);
  }

  writeFileSync('build/insn-vectors.txt', rows.join('\n') + '\n');
  writeFileSync('build/insn-tb.sv', `module tb;
    logic clk = 0, fetch, dispatch;
    logic [7:0] bus;
    logic [23:0] wq, wqk, wv, wvk, q, view;
    integer f, n = 0, bad = 0, r;
    insn u (.clk(clk), .bus(bus), .fetch(fetch), .dispatch(dispatch), .q(q), .view(view));
    initial begin
        f = $fopen("build/insn-vectors.txt", "r");
        if (f == 0) begin $display("FAIL cannot open vectors"); $finish; end
        while (!$feof(f)) begin
            r = $fscanf(f, "%d %d %h %h %h %h %h\\n", fetch, dispatch, bus, wq, wqk, wv, wvk);
            if (r == 7) begin
                #1; n = n + 1;
                if ((q & wqk) !== (wq & wqk) || (view & wvk) !== (wv & wvk)) begin
                    bad = bad + 1;
                    if (bad < 6)
                        $display("  MISMATCH cycle %0d fetch=%0d dispatch=%0d bus=%h: want q=%h view=%h, got q=%h view=%h",
                                 n, fetch, dispatch, bus, wq & wqk, wv & wvk, q & wqk, view & wvk);
                end
                clk = 1; #1; clk = 0;
            end
        end
        if (bad == 0) $display("ok    rtl/insn.sv: %0d clocked cycles against the loading model, all correct", n);
        else $display("FAIL  rtl/insn.sv: %0d of %0d wrong", bad, n);
        $finish;
    end
endmodule
`);
  execFileSync('iverilog', ['-g2012', '-o', 'build/insn-tb.vvp', 'rtl/insn.sv', 'build/insn-tb.sv'],
               { stdio: 'inherit' });
  const o = execFileSync('vvp', ['build/insn-tb.vvp'], { encoding: 'utf8' });
  process.stdout.write(o.split('\n').filter((l) => /^(ok|FAIL)|MISMATCH/.test(l)).join('\n') + '\n');
  for (const f of ['build/insn-tb.vvp', 'build/insn-tb.sv', 'build/insn-vectors.txt']) rmSync(f, { force: true });
  if (/FAIL/.test(o)) failed = true;
}

// =============================================================================
// rtl/dest.sv - the write address
// =============================================================================
// First the SPEC: every register a multi-byte form writes - by this file's own
// reading, statements beginning `R[x] =` - must follow exactly one of the four
// fields under tools/decode.js.  Then the circuit: each such register decoded
// from real bytes against its field's code, with random bytes elsewhere in the
// instruction; the registers the microcode names; and all sixteen codes against
// every byte 1 under a spread of opcodes, reserved codes pinned to the wiring.
{
  const rnd = (() => { let s = 362436069;
    return () => (s ^= s << 13, s ^= s >>> 17, s ^= s << 5, s >>> 0); })();
  const dec = buildDecoder(spec);
  const FIELDS = [
    (op, b1) => b1 & 7,                          // 8  rd
    (op, b1) => (b1 >> 3) & 7,                   // 9  ra
    (op) => op & 7,                              // 10 opcode
    (op, b1) => ((b1 >> 6) << 1) | (op & 1),     // 11 port B
  ];
  const rows = [];
  const row = (src, insn, want) => `${src} ${hex6(insn)} ${want}`;

  const forms = new Map();
  for (let op = 0; op < 256; op++)
    for (let b1 = 0; b1 < 256; b1++) {
      const e = decode(dec, [op, b1, 0], 0);
      if (!e || e.nbytes === 1) continue;
      for (const m of (e.insn.semantics ?? '').matchAll(/(?:^|;)\s*R\[([a-z])\]\s*=(?!=)/g)) {
        const name = m[1], key = `${e.insn.mnemonic}/${e.form.name}:${name}`;
        if (!forms.has(key)) forms.set(key, { key, follows: [true, true, true, true], seen: [] });
        const f = forms.get(key);
        FIELDS.forEach((fn, i) => { if (e.ops[name] !== fn(op, b1)) f.follows[i] = false; });
        f.seen.push([op, b1, e.ops[name]]);
      }
    }
  for (const f of forms.values()) {
    const codes = f.follows.map((ok, i) => (ok ? 8 + i : null)).filter((c) => c !== null);
    if (codes.length !== 1) {
      console.log(`FAIL  ${f.key}: the written register follows ${codes.length ? 'several' : 'none'} of the four fields`);
      failed = true; continue;
    }
    for (let i = 0; i < 24; i++) {
      const [op, b1, want] = f.seen[rnd() % f.seen.length];
      rows.push(row(codes[0], ((rnd() & 0xff) << 16) | (b1 << 8) | op, want));
    }
  }
  for (let reg = 0; reg < 8; reg++)
    for (let i = 0; i < 16; i++) rows.push(row(reg, rnd() & 0xffffff, reg));
  for (let src = 0; src < 16; src++)
    for (let b1 = 0; b1 < 256; b1++) {
      const op = rnd() & 0xff;
      const want = src < 8 ? src : FIELDS[src & 3](op, b1);
      rows.push(row(src, ((rnd() & 0xff) << 16) | (b1 << 8) | op, want));
    }

  writeFileSync('build/dest-vectors.txt', rows.join('\n') + '\n');
  writeFileSync('build/dest-tb.sv', `module tb;
    logic [3:0] src, want_;
    logic [23:0] insn;
    logic [2:0] got;
    integer f, n = 0, bad = 0, r;
    dest u (.insn(insn), .src(src), .regnum(got));
    initial begin
        f = $fopen("build/dest-vectors.txt", "r");
        if (f == 0) begin $display("FAIL cannot open vectors"); $finish; end
        while (!$feof(f)) begin
            r = $fscanf(f, "%d %h %d\\n", src, insn, want_);
            if (r == 3) begin
                #1; n = n + 1;
                if (got !== want_[2:0]) begin
                    bad = bad + 1;
                    if (bad < 6)
                        $display("  MISMATCH src=%0d insn=%h: want r%0d, got %b", src, insn, want_, got);
                end
            end
        end
        if (bad == 0) $display("ok    rtl/dest.sv: %0d vectors, ${forms.size} written registers from the decoder, all correct", n);
        else $display("FAIL  rtl/dest.sv: %0d of %0d wrong", bad, n);
        $finish;
    end
endmodule
`);
  execFileSync('iverilog', ['-g2012', '-o', 'build/dest-tb.vvp', 'rtl/dest.sv', 'build/dest-tb.sv'],
               { stdio: 'inherit' });
  const o = execFileSync('vvp', ['build/dest-tb.vvp'], { encoding: 'utf8' });
  process.stdout.write(o.split('\n').filter((l) => /^(ok|FAIL)|MISMATCH/.test(l)).join('\n') + '\n');
  for (const f of ['build/dest-tb.vvp', 'build/dest-tb.sv', 'build/dest-vectors.txt']) rmSync(f, { force: true });
  if (/FAIL/.test(o)) failed = true;
}

// =============================================================================
// rtl/alu.sv, rtl/compare.sv and rtl/cond.sv - against the simulator
// =============================================================================
// The reference is tools/sim.js: BUILTIN for the shifts and unary operations,
// and `test` for every condition, which is what the spec's semantics call.
// Nothing here restates the circuits' formulas.
//
// Operands are every pair from a set of edge values - zero, one, the sign
// boundary, all ones, a byte's edge - plus equal pairs and random ones, because
// a comparison is wrong at the edges and right almost everywhere else.
//
// Then END TO END, through cond.sv: real branch bytes decoded with
// tools/decode.js - two-register, packed, brclear and brset - the condition and
// mode cond.sv produces from them, and compare.sv's bit against the semantics.
{
  const rnd = (() => { let s = 521288629;
    return () => (s ^= s << 13, s ^= s >>> 17, s ^= s << 5, s >>> 0); })();
  const NAMES = spec.optype.cond3.names;
  const UN = unaryOps();
  const OP = { add: 0, rsb: 1, iseq: 2, isset: 3, xor: 4, or: 5, and: 6, rhs: 7, shl: 8, lsr: 9, asr: 11, unary: 12, slow: 13 };
  const E = [0, 1, 2, 0x7ffe, 0x7fff, 0x8000, 0x8001, 0xfffe, 0xffff, 0x00ff, 0x0100, 0x5555];
  const pairs = [];
  for (const a of E) for (const b of E) pairs.push([a, b]);
  for (let i = 0; i < 400; i++) { const a = rnd() & 0xffff; pairs.push([a, a], [a, rnd() & 0xffff]); }
  const run = (name, files, tbName) => {
    execFileSync('iverilog', ['-g2012', '-o', `build/${tbName}.vvp`, ...files, `build/${tbName}.sv`], { stdio: 'inherit' });
    const o = execFileSync('vvp', [`build/${tbName}.vvp`], { encoding: 'utf8' });
    process.stdout.write(o.split('\n').filter((l) => /^(ok|FAIL)|MISMATCH/.test(l)).join('\n') + '\n');
    for (const f of [`build/${tbName}.vvp`, `build/${tbName}.sv`, `build/${tbName}.txt`]) rmSync(f, { force: true });
    if (/FAIL/.test(o)) failed = true;
  };

  // --- the ALU: op usel lhs rhs want ------------------------------------------
  const rows = [];
  const row = (op, l, r, w) => `${op} ${hex4(l)} ${hex4(r)} ${hex4(w)}`;
  for (const [l, r] of pairs) {
    rows.push(row(OP.add, l, r, l + r));
    rows.push(row(OP.rsb, l, r, r - l));
    rows.push(row(OP.iseq, l, r, l === r ? 1 : 0));
    rows.push(row(OP.isset, l, r, (l & r) !== 0 ? 1 : 0));
    rows.push(row(OP.xor, l, r, l ^ r));
    rows.push(row(OP.or,  l, r, l | r));
    rows.push(row(OP.and, l, r, l & r));
    rows.push(row(OP.rhs, l, r, r));
    for (const nm of ['shl', 'lsr', 'asr']) rows.push(row(OP[nm], l, r, BUILTIN[nm](l, r & 15)));
    // the operation rides rhs[2:1]; every other bit of rhs is left random, and
    // the slow pair is read through its own operation code
    for (const o of UN)
      rows.push(row(o.slow ? OP.slow : OP.unary, l, (r & ~6) | (o.code << 1), BUILTIN[o.name](l)));
  }
  writeFileSync('build/alu-tb.txt', rows.join('\n') + '\n');
  writeFileSync('build/alu-tb.sv', `module tb;
    logic clk = 0;
    logic [3:0] op;
    logic [15:0] l, r, want_, got;
    integer f, n = 0, bad = 0, rr;
    alu u (.clk(clk), .lhs(l), .rhs(r), .op(op), .y(got));
    initial begin
        f = $fopen("build/alu-tb.txt", "r");
        if (f == 0) begin $display("FAIL cannot open vectors"); $finish; end
        while (!$feof(f)) begin
            rr = $fscanf(f, "%d %h %h %h\\n", op, l, r, want_);
            if (rr == 4) begin
                // one clock, so the registered slow pair has its answer too
                #1 clk = 1; #1 clk = 0; #1; n = n + 1;
                if (got !== want_) begin
                    bad = bad + 1;
                    if (bad < 6) $display("  MISMATCH op=%0d lhs=%h rhs=%h: want %h got %h", op, l, r, want_, got);
                end
            end
        end
        if (bad == 0) $display("ok    rtl/alu.sv: %0d vectors against tools/sim.js, all correct", n);
        else $display("FAIL  rtl/alu.sv: %0d of %0d wrong", bad, n);
        $finish;
    end
endmodule
`);
  run('alu', ['rtl/unary.sv', 'rtl/alu.sv'], 'alu-tb');

  // --- the compare unit on its own: cond neg mask lhs rhs want ------------------
  const cmp = [];
  const crow = (c, ng, mk, l, r, w) => `${c} ${ng} ${mk} ${hex4(l)} ${hex4(r)} ${w}`;
  for (const [l, r] of pairs)
    for (const ng of [0, 1]) {
      for (let c = 0; c < 8; c++) cmp.push(crow(c, ng, 0, l, r, (test(NAMES[c], r, l, 16) ? 1 : 0) ^ ng));
      cmp.push(crow(NAMES.indexOf('eq'), ng, 1, l, r, ((l & r) === 0 ? 1 : 0) ^ ng));
      cmp.push(crow(NAMES.indexOf('ne'), ng, 1, l, r, ((l & r) !== 0 ? 1 : 0) ^ ng));
    }
  writeFileSync('build/compare-tb.txt', cmp.join('\n') + '\n');
  writeFileSync('build/compare-tb.sv', `module tb;
    logic [2:0] c; logic ng, mk, want_; logic [15:0] l, r; wire got;
    integer f, n = 0, bad = 0, rr;
    compare u (.lhs(l), .rhs(r), .cond(c), .neg(ng), .mask(mk), .taken(got));
    initial begin
        f = $fopen("build/compare-tb.txt", "r");
        if (f == 0) begin $display("FAIL cannot open vectors"); $finish; end
        while (!$feof(f)) begin
            rr = $fscanf(f, "%d %d %d %h %h %d\\n", c, ng, mk, l, r, want_);
            if (rr == 6) begin
                #1; n = n + 1;
                if (got !== want_) begin
                    bad = bad + 1;
                    if (bad < 6) $display("  MISMATCH cond=%0d neg=%0d mask=%0d lhs=%h rhs=%h: want %0d got %b", c, ng, mk, l, r, want_, got);
                end
            end
        end
        if (bad == 0) $display("ok    rtl/compare.sv: %0d vectors against tools/sim.js, all correct", n);
        else $display("FAIL  rtl/compare.sv: %0d of %0d wrong", bad, n);
        $finish;
    end
endmodule
`);
  run('compare', ['rtl/compare.sv'], 'compare-tb');

  // --- end to end: branch bytes -> cond.sv -> compare.sv ----------------------
  // The microcode's source for each: 0 the two-register branch (rhs = R[a],
  // lhs = R[b]), 1 the packed one (rhs = the constant, lhs = R[a]), 2 brclear
  // and 3 brset (rhs = the mask, lhs = R[a]).
  const dec = buildDecoder(spec);
  const e2e = [];
  const line = (src, insn, l, r, w) => `${src} ${hex6(insn)} ${hex4(l)} ${hex4(r)} ${w}`;
  const kinds = new Set();
  for (let op = 0; op < 256; op++) {
    const d = decode(dec, [op, 0, 0], 0);
    const sem = d?.insn.semantics ?? '';
    const kind = /^if \(test\(cond, R\[a\], R\[b\], 16\)\)/.test(sem) ? 'two'
               : /^if \(test\(k\.cond, R\[a\], k\.imm, 16\)\)/.test(sem) ? 'packed'
               : /^if \(\(R\[a\] & mask\) == 0\)/.test(sem) ? 'clear'
               : /^if \(\(R\[a\] & mask\) != 0\)/.test(sem) ? 'set' : null;
    if (!kind) continue;
    kinds.add(`${d.insn.mnemonic}/${d.form.name}`);
    for (let b1 = 0; b1 < 256; b1++) {
      const e = decode(dec, [op, b1, 0], 0);
      if (!e) continue;
      const insn = ((rnd() & 0xff) << 16) | (b1 << 8) | op;
      for (let i = 0; i < 4; i++) {
        const [va, vb] = pairs[rnd() % pairs.length];
        if (kind === 'two') {
          const cn = typeof e.ops.cond === 'string' ? e.ops.cond : NAMES[e.ops.cond];
          e2e.push(line(0, insn, vb, va, test(cn, va, vb, 16) ? 1 : 0));
        } else if (kind === 'packed') {
          e2e.push(line(1, insn, va, u16(e.ops.k.imm), test(e.ops.k.cond, va, e.ops.k.imm, 16) ? 1 : 0));
        } else {
          const m = u16(e.ops.mask), hit = (va & m) !== 0;
          e2e.push(line(kind === 'clear' ? 2 : 3, insn, va, m, (kind === 'clear' ? !hit : hit) ? 1 : 0));
        }
      }
    }
  }
  writeFileSync('build/cond-tb.txt', e2e.join('\n') + '\n');
  writeFileSync('build/cond-tb.sv', `module tb;
    logic [1:0] src; logic [23:0] insn; logic [15:0] l, r; logic want_;
    wire [2:0] c; wire ng, mk, got;
    integer f, n = 0, bad = 0, rr;
    cond k (.insn(insn), .src(src), .code(c), .neg(ng), .mask(mk));
    compare u (.lhs(l), .rhs(r), .cond(c), .neg(ng), .mask(mk), .taken(got));
    initial begin
        f = $fopen("build/cond-tb.txt", "r");
        if (f == 0) begin $display("FAIL cannot open vectors"); $finish; end
        while (!$feof(f)) begin
            rr = $fscanf(f, "%d %h %h %h %d\\n", src, insn, l, r, want_);
            if (rr == 5) begin
                #1; n = n + 1;
                if (got !== want_) begin
                    bad = bad + 1;
                    if (bad < 6) $display("  MISMATCH src=%0d insn=%h lhs=%h rhs=%h: want %0d got %b", src, insn, l, r, want_, got);
                end
            end
        end
        if (bad == 0) $display("ok    rtl/cond.sv: %0d branches through the compare unit, ${kinds.size} branch forms, all correct", n);
        else $display("FAIL  rtl/cond.sv: %0d of %0d wrong", bad, n);
        $finish;
    end
endmodule
`);
  run('cond', ['rtl/compare.sv', 'rtl/cond.sv'], 'cond-tb');
}

// =============================================================================
// rtl/predecode.sv - the whole execute step, against the simulator
// =============================================================================
// The table is not checked against a restatement of itself.  Instead every
// single-step instruction is EXECUTED: tools/sim.js runs real bytes from random
// registers, and the RTL does the same step with nothing but what predecode
// supplies - its sources and operation driving rtl/lhs.sv, rtl/rhs.sv (with
// immgen), rtl/alu.sv, rtl/cond.sv, rtl/compare.sv and rtl/dest.sv against a
// register file.  For a register-writing instruction the check is the register
// the step writes and the value it writes; for a 16-bit branch, whether it is
// taken.  So a wrong row fails because the instruction computes the wrong thing,
// which is the only way a row can matter.
//
// Single-step means one write and no memory: every ALU operation, mov, the unary
// operations, iseq and isset, the one-byte forms that touch no memory, and br,
// brclear and brset.  Loads, stores, push, pop and calls take microcode steps
// that override these selects, so predecode alone does not decide them.
{
  const rnd = (() => { let s = 1103515245;
    return () => (s ^= s << 13, s ^= s >>> 17, s ^= s << 5, s >>> 0); })();
  const dec = buildDecoder(spec);
  const EDGE = [0, 1, 2, 0x7fff, 0x8000, 0xffff, 0x00ff, 0x0100];
  const val = () => (rnd() % 4 === 0 ? EDGE[rnd() % EDGE.length] : rnd() & 0xffff);
  const rows = [];
  const covered = new Set();

  for (let op = 0; op < 256; op++) {
    const forms = new Map();
    for (let b1 = 0; b1 < 256; b1++) {
      const d = decode(dec, [op, b1, 0], 0);
      if (!d || d.insn.mnemonic === 'br8') continue;
      const sem = d.insn.semantics ?? '';
      const write = /^R\[[a-z]\] = /.test(sem) && !/M(8|16)\[/.test(sem) && !sem.includes(';');
      const branch = /^if \(/.test(sem);
      if (!write && !branch) continue;
      if (!forms.has(d.form)) forms.set(d.form, { d, write, b1s: [] });
      forms.get(d.form).b1s.push(b1);
    }
    for (const { d, write, b1s } of forms.values()) {
      covered.add(`${d.insn.mnemonic}/${d.form.name}`);
      for (let i = 0; i < 24; i++) {
        const b1 = b1s[rnd() % b1s.length], b2 = rnd() & 0xff;
        const bytes = d.nbytes === 1 ? [op] : d.nbytes === 2 ? [op, b1] : [op, b1, b2];
        const m = new Machine(spec).load(bytes, 0x100);
        m.pc = 0x100;
        const reg = Array.from({ length: 8 }, val);
        reg.forEach((v, k) => { m.R[k] = v; });
        const e = m.step();
        const insn = (d.nbytes >= 3 ? b2 << 16 : 0) | (d.nbytes >= 2 ? b1 << 8 : 0) | op;
        let kind, wreg = 0, wval = 0;
        if (write) {
          const name = /^R\[([a-z])\] = /.exec(e.insn.semantics)[1];
          kind = 0; wreg = e.ops[name]; wval = m.R[wreg];
        } else {
          kind = 1; wval = m.wrotePc ? 1 : 0;
        }
        rows.push(`${hex6(insn)} ${reg.map(hex4).join(' ')} ${kind} ${wreg} ${hex4(wval)}`);
      }
    }
  }

  writeFileSync('build/predecode-tb.txt', rows.join('\n') + '\n');
  writeFileSync('build/predecode-tb.sv', `module tb;
    logic clk = 0, dispatch = 0;
    logic [7:0] bus;
    logic [23:0] insn;
    logic [15:0] r0, r1, r2, r3, r4, r5, r6, r7, wval;
    logic [15:0] R [0:7];
    integer kind, wreg;
    wire [3:0] alu_op, lhs_src, rhs_src, dest_src; wire [1:0] cond_src;
    wire [2:0] an, bn, wn, c; wire ng, mk, taken;
    wire [15:0] bval, y;
    predecode p (.clk(clk), .bus(bus), .dispatch(dispatch), .alu_op(alu_op), .lhs_src(lhs_src),
                 .rhs_src(rhs_src), .dest_src(dest_src), .cond_src(cond_src));
    lhs l (.insn(insn), .src(lhs_src), .regnum(an));
    rhs r (.insn(insn), .src(rhs_src), .regval(R[bn]), .regnum(bn), .value(bval));
    alu a (.clk(clk), .lhs(R[an]), .rhs(bval), .op(alu_op), .y(y));
    cond k (.insn(insn), .src(cond_src), .code(c), .neg(ng), .mask(mk));
    compare x (.lhs(R[an]), .rhs(bval), .cond(c), .neg(ng), .mask(mk), .taken(taken));
    dest w (.insn(insn), .src(dest_src), .regnum(wn));
    integer f, n = 0, bad = 0, rr;
    initial begin
        f = $fopen("build/predecode-tb.txt", "r");
        if (f == 0) begin $display("FAIL cannot open vectors"); $finish; end
        while (!$feof(f)) begin
            rr = $fscanf(f, "%h %h %h %h %h %h %h %h %h %d %d %h\\n",
                         insn, r0, r1, r2, r3, r4, r5, r6, r7, kind, wreg, wval);
            if (rr == 12) begin
                // the dispatch cycle: the opcode is on the bus
                bus = insn[7:0]; dispatch = 1; #1 clk = 1; #1 clk = 0; dispatch = 0;
                R[0] = r0; R[1] = r1; R[2] = r2; R[3] = r3; R[4] = r4; R[5] = r5; R[6] = r6; R[7] = r7;
                // one clock with nothing dispatched: predecode holds, and a
                // registered slow result fills, as the SLOW step lets it
                #1 clk = 1; #1 clk = 0; #1; n = n + 1;
                if (kind == 0 ? (wn !== wreg[2:0] || y !== wval) : (taken !== wval[0])) begin
                    bad = bad + 1;
                    if (bad < 6)
                        $display("  MISMATCH insn=%h: want %s, got r%0d=%h taken=%b (alu %0d lhs %0d rhs %0d dest %0d cond %0d)",
                                 insn, kind == 0 ? "a write" : "a branch", wn, y, taken,
                                 alu_op, lhs_src, rhs_src, dest_src, cond_src);
                end
            end
        end
        if (bad == 0) $display("ok    rtl/predecode.sv: %0d executed steps, ${covered.size} forms, all agree with tools/sim.js", n);
        else $display("FAIL  rtl/predecode.sv: %0d of %0d steps wrong", bad, n);
        $finish;
    end
endmodule
`);
  execFileSync('iverilog', ['-g2012', '-o', 'build/predecode-tb.vvp',
    'rtl/predecode.sv', 'rtl/lhs.sv', 'rtl/immgen.sv', 'rtl/rhs.sv', 'rtl/unary.sv', 'rtl/alu.sv',
    'rtl/cond.sv', 'rtl/compare.sv', 'rtl/dest.sv', 'build/predecode-tb.sv'], { stdio: 'inherit' });
  const o = execFileSync('vvp', ['build/predecode-tb.vvp'], { encoding: 'utf8' });
  process.stdout.write(o.split('\n').filter((l) => /^(ok|FAIL)|MISMATCH/.test(l)).join('\n') + '\n');
  for (const f of ['build/predecode-tb.vvp', 'build/predecode-tb.sv', 'build/predecode-tb.txt']) rmSync(f, { force: true });
  if (/FAIL/.test(o)) failed = true;
}

// =============================================================================
// rtl/cpu.sv - programs, against the simulator
// =============================================================================
// Random programs of every instruction rtl/ucode.sv implements, ending in halt,
// run from random registers on both the RTL and tools/sim.js.  At every dispatch
// the RTL's pc and all eight registers must equal the simulator's state entering
// that instruction, and the cycles between two dispatches must equal the
// simulator's count for that instruction - one cycle per byte, plus any cycles
// the spec declares - which is its cost model and not an assumption made here.
//
// Which instructions to use is not taken from the ROM generator: it is every
// form whose semantics write one register with no memory, found by decoding -
// the one-byte abbreviations included, which cost two cycles because their
// operands are read in a step of their own - and a program containing one the
// ROM does not implement traps and fails.  The first program runs every such form in turn, so each is covered
// whatever the random ones pick.
{
  const rnd = (() => { let s = 2654435761;
    return () => (s ^= s << 13, s ^= s >>> 17, s ^= s << 5, s >>> 0); })();
  const dec = buildDecoder(spec);
  const EDGE = [0, 1, 2, 0x7fff, 0x8000, 0xffff, 0x00ff, 0x0100];
  const val = () => (rnd() % 4 === 0 ? EDGE[rnd() % EDGE.length] : rnd() & 0xffff);

  // --- the forms, and a way to draw real bytes for each ----------------------
  const forms = new Map();   // form -> { op, b1s: [] , nbytes }
  for (let op = 0; op < 256; op++)
    for (let b1 = 0; b1 < 256; b1++) {
      const d = decode(dec, [op, b1, 0], 0);
      if (!d || ['br8', 'push8', 'pop8'].includes(d.insn.mnemonic)) continue;
      const sem = d.insn.semantics ?? '';
      if (!/^R\[[a-z]\] = /.test(sem) || sem.includes(';') || /M(8|16)\[/.test(sem)) continue;
      const key = `${d.insn.mnemonic}/${d.form.name}@${op}`;
      if (!forms.has(key)) forms.set(key, { op, nbytes: d.nbytes, b1s: [] });
      forms.get(key).b1s.push(b1);
    }
  const all = [...forms.values()];
  const draw = (f) => {
    if (f.nbytes === 1) return [f.op];
    const bytes = [f.op, f.b1s[rnd() % f.b1s.length]];
    if (f.nbytes === 3) bytes.push(rnd() & 0xff);
    return bytes;
  };

  // --- and the control flow, assembled rather than drawn ----------------------
  // The random programs above are straight-line by construction: every form in
  // them writes one register.  A branch needs a target that lands on an
  // instruction, so these are written as source and assembled, and they cover
  // what the microcode's pc families do - a loop whose branch is taken four
  // times and falls through once, a short relative jump, a wide absolute one,
  // and a call, whose return address the register comparison checks.
  const SOURCES = [
    `       mov  r0, #5
            mov  r1, #0
    loop:   add  r1, r1, r0
            add  r0, r0, #-1
            br   ne, r0, #0, loop
            jmpr skip
            mov  r2, #0x1234
    skip:   jmp  wide
            mov  r3, #0x5678
    wide:   call sub
            halt
    sub:    mov  r4, #7
            halt`,
    `       mov  r0, #0
            brset r0, #1, odd
            mov  r1, #0x0f0f
            brclear r1, #0xf0f0, clear
            halt
    clear:  add  r1, r1, #1
            jmpr done
    odd:    mov  r1, #0xdead
    done:   call tail
            halt
    tail:   mov  r5, #3
            halt`,
  ];
  const assembled = SOURCES.map((src, i) => {
    const f = `build/cpu-src-${i}.s`;
    writeFileSync(f, src.split('\n').map((l) => l.trim()).join('\n') + '\n');
    const { code } = assemble(f);
    rmSync(f, { force: true });
    return [...code];
  });

  const PROGRAMS = 40 + assembled.length;
  const programs = [];
  for (let p = 0; p < PROGRAMS; p++) {
    const picks = p === 0 ? all : Array.from({ length: 30 }, () => all[rnd() % all.length]);
    const bytes = p >= 40 ? assembled[p - 40]
                          : picks.flatMap(draw).concat([0x00]);    // halt
    const reg = Array.from({ length: 8 }, val);
    const m = new Machine(spec).load(bytes, 0);
    reg.forEach((v, k) => { m.R[k] = v; });
    const trace = [];
    for (let guard = 0; !m.halted && guard < 1000; guard++) {
      const entry = { pc: m.pc, R: Array.from(m.R) }, before = m.cycles();
      m.step();
      entry.len = m.cycles() - before;       // the simulator's cost model, extra cycles included
      trace.push(entry);
    }
    programs.push({ bytes, reg, trace });
    writeFileSync(`build/cpu-prog-${p}.hex`, bytes.map((b) => b.toString(16).padStart(2, '0')).join('\n') + '\n');
    writeFileSync(`build/cpu-reg-${p}.hex`, reg.map(hex4).join('\n') + '\n');
  }

  writeFileSync('build/cpu-tb.sv', `module tb;
    logic clk = 0, rst = 1;
    logic [7:0] mem [0:65535];
    logic [7:0] rdata;
    logic [15:0] regs [0:7];
    wire [15:0] addr;
    wire halted, trapped;
    cpu u (.clk(clk), .rst(rst), .mem_addr(addr), .mem_rdata(rdata), .halted(halted), .trapped(trapped),
           .result());
    always @(posedge clk) rdata <= mem[addr];
    integer p, k, cyc, lastcyc, pcnow;
    reg [8*64:1] name;
    initial begin
        for (p = 0; p < ${PROGRAMS}; p = p + 1) begin
            for (k = 0; k < 65536; k = k + 1) mem[k] = 8'h00;
            $sformat(name, "build/cpu-prog-%0d.hex", p); $readmemh(name, mem);
            $sformat(name, "build/cpu-reg-%0d.hex", p);  $readmemh(name, regs);
            rst = 1;
            repeat (3) begin #1 clk = 1; #1 clk = 0; end
            for (k = 0; k < 8; k = k + 1) u.R[k] = regs[k];
            rst = 0; cyc = 0;
            while (!halted && !trapped && cyc < 5000) begin
                if (u.dispatch) begin
                    pcnow = u.pc;
                    #1 clk = 1; #1 clk = 0;
                    $display("STEP %0d %0d %h %h %h %h %h %h %h %h %h", p, cyc, pcnow[15:0],
                             u.R[0], u.R[1], u.R[2], u.R[3], u.R[4], u.R[5], u.R[6], u.R[7]);
                end else begin
                    #1 clk = 1; #1 clk = 0;
                end
                cyc = cyc + 1;
            end
            $display("END %0d %0d %0d", p, halted, trapped);
        end
        $finish;
    end
endmodule
`);
  execFileSync('iverilog', ['-g2012', '-o', 'build/cpu-tb.vvp',
    'rtl/cpu.sv', 'rtl/ucode.sv', 'rtl/insn.sv', 'rtl/predecode.sv', 'rtl/lhs.sv', 'rtl/immgen.sv',
    'rtl/rhs.sv', 'rtl/unary.sv', 'rtl/alu.sv', 'rtl/dest.sv', 'rtl/cond.sv', 'rtl/compare.sv',
    'build/cpu-tb.sv'], { stdio: 'inherit' });
  const out = execFileSync('vvp', ['build/cpu-tb.vvp'], { encoding: 'utf8', maxBuffer: 1 << 26 });

  // --- compare ----------------------------------------------------------------
  // A STEP line is printed at each dispatch, after the edge that ends it: the
  // pc is the new opcode's address and the registers are the state entering
  // that instruction.
  const steps = Array.from({ length: PROGRAMS }, () => []);
  const ends = [];
  for (const line of out.split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f[0] === 'STEP') steps[+f[1]].push({ cyc: +f[2], pc: parseInt(f[3], 16), R: f.slice(4, 12).map((h) => parseInt(h, 16)) });
    if (f[0] === 'END') ends[+f[1]] = { halted: f[2] === '1', trapped: f[3] === '1' };
  }
  let bad = 0, instructions = 0;
  const complain = (msg) => { if (bad++ < 6) console.log(`  MISMATCH ${msg}`); };
  programs.forEach(({ trace }, p) => {
    const got = steps[p];
    if (!ends[p]?.halted || ends[p]?.trapped) complain(`program ${p}: ended ${ends[p]?.trapped ? 'trapped' : 'without halting'}`);
    if (got.length !== trace.length) complain(`program ${p}: ${got.length} dispatches, the simulator ran ${trace.length} instructions`);
    for (let i = 0; i < Math.min(got.length, trace.length); i++) {
      const g = got[i], t = trace[i];
      if (g.pc !== t.pc || g.R.some((v, k) => v !== t.R[k]))
        complain(`program ${p} instruction ${i} at 0x${t.pc.toString(16)}: rtl pc ${g.pc.toString(16)} r=${g.R.map(hex4).join(' ')}, sim r=${t.R.map(hex4).join(' ')}`);
      if (i > 0 && g.cyc - got[i - 1].cyc !== trace[i - 1].len)
        complain(`program ${p} instruction ${i - 1}: ${g.cyc - got[i - 1].cyc} cycles where the simulator counts ${trace[i - 1].len}`);
      instructions++;
    }
  });
  if (bad === 0) console.log(`ok    rtl/cpu.sv: ${PROGRAMS} programs, ${instructions} instructions over ${all.length} forms, pc, registers and cycles all agree with tools/sim.js`);
  else { console.log(`FAIL  rtl/cpu.sv: ${bad} disagreements with tools/sim.js`); failed = true; }
  for (let p = 0; p < PROGRAMS; p++) for (const f of [`build/cpu-prog-${p}.hex`, `build/cpu-reg-${p}.hex`]) rmSync(f, { force: true });
  for (const f of ['build/cpu-tb.vvp', 'build/cpu-tb.sv']) rmSync(f, { force: true });
}

process.exit(failed ? 1 : 0);
