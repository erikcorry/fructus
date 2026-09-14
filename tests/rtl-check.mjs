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
// bit) pair, and imm10 over its whole 10-bit range - with the untouched upper
// bits of immreg varied, because a circuit that accidentally reads them would
// otherwise pass.  Modes +6 and +7 have no immediate and immgen drives x there,
// so they are not checked; what IS checked is the encoding property rhs.sv
// relies on instead - that port B's register number is {byte1[7:6], opcode[0]}
// for every three-operand form.
//
// Needs iverilog.  Skips with a message rather than failing when it is absent,
// so the suite still runs on a machine without the FPGA tools installed.
// =============================================================================

import { loadSpec } from '../tools/isa.js';
import { BUILTIN } from '../tools/sim.js';
import { buildDecoder, decode } from '../tools/decode.js';
import { execFileSync } from 'node:child_process';
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

// --- the reference, straight off the tables ---------------------------------
// This is the whole specification of the block.  `sel` is opcode[2:0]; `ir` is
// immreg, holding the last two bytes fetched.
const k3 = (ir, sel) => (((ir >> 6) & 3) << 1) | (sel & 1);  // {byte1[7:6], opcode[0]}
const CIMM = spec.optype.condimm5.values.map((e) => e[1]);
const want = (ir, sel, cimm) => {
  // cimm reads +0's five bits as a condimm5 index instead of a signed integer,
  // and is ignored anywhere else - asserting it there is a microcode bug.
  // A five-bit field is byte1[7:3], and byte 1 is immreg's low half while only
  // two bytes have been fetched.  The ten-bit one is the odd case: its low two
  // bits are byte1[7:6] and its top eight are byte 2, and by the time byte 2
  // has arrived byte 1 has shifted into immreg's high half - so the halves sit
  // at opposite ends of this register though they are adjacent in the
  // instruction stream.  See rtl/immgen.sv's header.
  const f5 = (ir >> 3) & 31;
  if (cimm && sel === 0) return CIMM[f5];
  switch (sel) {
    case 0: return sext(f5, 5);                          // imm5
    case 1: return t.immbit5.values[f5];                 // immbit5
    case 2: case 3: return t.imm3.values[k3(ir, sel)];   // imm3
    case 4: return sext(((ir & 0xff) << 2) | ((ir >> 14) & 3), 10);   // imm10
    case 5: return t.immask5.values[f5];                 // immask5
    // 6 and 7 have no immediate: rtl/rhs.sv takes port B's number from the
    // bytes directly, so immgen drives x and there is nothing to check.
  }
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
        if (got !== k3(byte1, op & 7)) {
          console.log(`FAIL  0x${op.toString(16)} byte1=${byte1}: operand ${name} decodes to `
                    + `r${got}, but {byte1[7:6], opcode[0]} is r${k3(byte1, op & 7)}`);
          process.exit(1);
        }
      }
  }
}

const vecs = [];
for (let sel = 0; sel <= 5; sel++)
  for (const cimm of [0, 1])
    for (let low = 0; low < 1024; low++)
      for (const high of [0x0000, 0xfc00, 0x5400, 0xa800]) {
        const ir = high | low;
        vecs.push(`${u16(ir).toString(16).padStart(4, '0')} ${sel} ${cimm} `
                + `${u16(want(ir, sel, cimm)).toString(16).padStart(4, '0')}`);
      }

mkdirSync('build', { recursive: true });
writeFileSync('build/immgen-vectors.txt', vecs.join('\n') + '\n');
writeFileSync('build/immgen-tb.sv', `module tb;
    logic [15:0] ir, expect_, got;
    logic [2:0] sel;
    logic cimm;
    integer f, n = 0, bad = 0, r;
    immgen u (.ir(ir), .sel(sel), .cimm(cimm), .imm(got));
    initial begin
        f = $fopen("build/immgen-vectors.txt", "r");
        if (f == 0) begin $display("FAIL cannot open vectors"); $finish; end
        while (!$feof(f)) begin
            r = $fscanf(f, "%h %d %d %h\\n", ir, sel, cimm, expect_);
            if (r == 4) begin
                #1;
                n = n + 1;
                if (got !== expect_) begin
                    bad = bad + 1;
                    if (bad < 6)
                        $display("  MISMATCH ir=%h sel=%0d cimm=%0d want=%h got=%h",
                                 ir, sel, cimm, expect_, got);
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
          // The expected value comes from DECODING `mov rd, #imm16` bytes, not
          // from the byte swap: immreg is {byte1, byte2} once byte 2 is in.
          const b1 = rnd() & 0xff, b2 = rnd() & 0xff, rv = rnd() & 0xffff;
          const v = u16(decode(movDec, [MOV16, b1, b2], 0).ops.imm);
          rows.push([(b1 << 8) | b2, sel, src, rv, c, v]
            .map((x, j) => (j === 0 || j === 3 || j === 5)
              ? u16(x).toString(16).padStart(4, '0') : x).join(' '));
          continue;
        }
        // immgen drives x at +6 and +7, so reading it there is a microcode bug
        // rather than a case with an answer.
        if (isImm && sel >= 6) continue;
        const ir = rnd() & 0xffff, regval = rnd() & 0xffff;
        const num = hi ? k3(ir, sel) : REG[c];
        const rhs = isReg ? regval
                  : isImm ? u16(want(ir, sel, c === MODE_CIMM))
                  : u16(KON[c]);
        rows.push([ir, sel, src, regval, num, rhs]
          .map((v, j) => (j === 0 || j === 3 || j === 5)
            ? u16(v).toString(16).padStart(4, '0') : v).join(' '));
      }

  writeFileSync('build/rhs-vectors.txt', rows.join('\n') + '\n');
  writeFileSync('build/rhs-tb.sv', `module tb;
    logic [15:0] ir, regval, xrhs, grhs;
    logic [2:0] sel, xnum, gnum;
    logic [3:0] src;
    integer f, n = 0, bad = 0, r;
    rhs u (.ir(ir), .sel(sel), .src(src), .regval(regval),
           .regnum(gnum), .value(grhs));
    initial begin
        f = $fopen("build/rhs-vectors.txt", "r");
        if (f == 0) begin $display("FAIL cannot open vectors"); $finish; end
        while (!$feof(f)) begin
            r = $fscanf(f, "%h %d %d %h %d %h\\n",
                        ir, sel, src, regval, xnum, xrhs);
            if (r == 6) begin
                #1; n = n + 1;
                if (grhs !== xrhs || gnum !== xnum) begin
                    bad = bad + 1;
                    if (bad < 6)
                        $display("  MISMATCH ir=%h sel=%0d src=%0d: want rhs=%h num=%0d, got rhs=%h num=%0d",
                                 ir, sel, src, xrhs, xnum, grhs, gnum);
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
// rtl/unary.sv - the eight-way unary block
// =============================================================================
// The reference is the SIMULATOR's own implementations, not a transcription of
// them: tools/sim.js evaluates the spec's `semantics` strings against exactly
// these functions, so agreeing with them is agreeing with what the ISA says the
// instructions compute.
//
// Every operation is swept over its WHOLE input space - 65536 values each, five
// operations - because these are cheap to enumerate completely and a sampled
// sweep would miss precisely the interesting inputs: clz at 0 and 1, popcount
// at 0xffff, bitrev's fixed points.
{
  const OPS = { 0: 'sxt8', 1: 'zxt8', 2: 'clz', 3: 'bitrev', 4: 'popcount' };
  const rows = [];
  for (const [sel, name] of Object.entries(OPS))
    for (let a = 0; a < 65536; a++)
      rows.push(`${a.toString(16).padStart(4, '0')} ${sel} `
              + `${u16(BUILTIN[name](a)).toString(16).padStart(4, '0')}`);
  writeFileSync('build/unary-vectors.txt', rows.join('\n') + '\n');
  writeFileSync('build/unary-tb.sv', `module tb;
    logic [15:0] a, y, want_;
    logic [2:0] sel;
    integer f, n = 0, bad = 0, r;
    unary u (.a(a), .sel(sel), .y(y));
    initial begin
        f = $fopen("build/unary-vectors.txt", "r");
        if (f == 0) begin $display("FAIL cannot open vectors"); $finish; end
        while (!$feof(f)) begin
            r = $fscanf(f, "%h %d %h\\n", a, sel, want_);
            if (r == 3) begin
                #1; n = n + 1;
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
// rtl/lhs.sv - port A's address, and the latch that holds it
// =============================================================================
// Two things are checked, and the first is about the SPEC rather than the
// circuit: that every multi-byte form's left-hand register follows exactly one
// of byte1[2:0] and byte1[5:3] under tools/decode.js.  The left-hand operand is
// named here by a rule of this file's own - `a`, unless `a` is port B, in which
// case `b`; nothing for push and pop, which read sp - and not by importing the
// generator's reading of the semantics.
//
// The second is the circuit, CLOCKED, driven in instruction-shaped runs:
//
//   two bytes     latch open, the field code, byte 1 low          -> the operand
//   three bytes   the same, then byte 2 shifts byte 1 up and the
//                 latch closes, with the field code replaced by
//                 noise, and again for a write cycle              -> still it
//   one byte      latch open, the pinned register from microcode  -> that
//
// shuffled, so a held number from one instruction meeting the next one's
// choice is exercised too.  All sixteen codes are also swept against every
// byte 1 with the latch open, reserved codes included, pinned to what the
// wiring makes them today.
{
  const rnd = (() => { let s = 88172645;
    return () => (s ^= s << 13, s ^= s >>> 17, s ^= s << 5, s >>> 0); })();
  const dec = buildDecoder(spec);
  const runs = [];
  const row = (latch, src, ir, want) => `${latch} ${src} ${u16(ir).toString(16).padStart(4, '0')} ${want}`;
  const DONT = 8;

  // --- the spec property, and the runs built from it -------------------------
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
      if (!forms.has(key)) forms.set(key, { op, key, nbytes: e.nbytes, follows: { 8: true, 9: true }, seen: [] });
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
      const run = [row(1, codes[0], ((rnd() & 0xff) << 8) | b1, want)];
      if (f.nbytes === 3) {
        run.push(row(0, rnd() & 15, (b1 << 8) | (rnd() & 0xff), want));
        run.push(row(0, rnd() & 15, rnd() & 0xffff, want));
      }
      runs.push(run);
    }
  }
  // one-byte forms and push/pop: a register the microcode names
  for (let i = 0; i < 200; i++) {
    const reg = rnd() & 7;
    runs.push([row(1, reg, rnd() & 0xffff, reg), row(0, rnd() & 15, rnd() & 0xffff, reg)]);
  }
  for (let i = runs.length - 1; i > 0; i--) {
    const j = rnd() % (i + 1); [runs[i], runs[j]] = [runs[j], runs[i]];
  }
  const rows = runs.flat();
  // the combinational sweep, latch open
  for (let src = 0; src < 16; src++)
    for (let b1 = 0; b1 < 256; b1++) {
      const ir = ((rnd() & 0xff) << 8) | b1;
      const want = src < 8 ? src : (src & 1) ? (b1 >> 3) & 7 : b1 & 7;
      rows.push(row(1, src, ir, want));
    }
  // and a closed latch never follows its inputs, whatever they do
  rows.push(row(1, 5, 0, 5));
  for (let i = 0; i < 64; i++) rows.push(row(0, rnd() & 15, rnd() & 0xffff, 5));

  writeFileSync('build/lhs-vectors.txt', rows.join('\n') + '\n');
  writeFileSync('build/lhs-tb.sv', `module tb;
    logic clk = 0, latch;
    logic [3:0] src, want_;
    logic [15:0] ir;
    logic [2:0] got;
    integer f, n = 0, bad = 0, r;
    lhs u (.clk(clk), .ir(ir), .src(src), .latch(latch), .regnum(got));
    initial begin
        f = $fopen("build/lhs-vectors.txt", "r");
        if (f == 0) begin $display("FAIL cannot open vectors"); $finish; end
        while (!$feof(f)) begin
            r = $fscanf(f, "%d %d %h %d\\n", latch, src, ir, want_);
            if (r == 4) begin
                #1; n = n + 1;
                if (want_ != ${DONT} && got !== want_[2:0]) begin
                    bad = bad + 1;
                    if (bad < 6)
                        $display("  MISMATCH row %0d latch=%0d src=%0d ir=%h: want r%0d, got %b",
                                 n, latch, src, ir, want_, got);
                end
                clk = 1; #1; clk = 0;
            end
        end
        if (bad == 0) $display("ok    rtl/lhs.sv: %0d clocked vectors, ${forms.size} forms from the decoder, all correct", n);
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

process.exit(failed ? 1 : 0);
