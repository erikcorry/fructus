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
// relies on instead - that port B's register number is {byte1[1:0], opcode[0]}
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
const k3 = (ir, sel) => ((ir & 3) << 1) | (sel & 1);   // {byte1[1:0], opcode[0]}
const CIMM = spec.optype.condimm5.values.map((e) => e[1]);
const want = (ir, sel, cimm) => {
  // cimm reads +0's five bits as a condimm5 index instead of a signed integer,
  // and is ignored anywhere else - asserting it there is a microcode bug.
  if (cimm && sel === 0) return CIMM[ir & 31];
  switch (sel) {
    case 0: return sext(ir & 31, 5);                     // imm5
    case 1: return t.immbit5.values[ir & 31];            // immbit5
    case 2: case 3: return t.imm3.values[k3(ir, sel)];   // imm3
    case 4: return sext(ir & 1023, 10);                  // imm10
    case 5: return t.immask5.values[ir & 31];            // immask5
    // 6 and 7 have no immediate: rtl/rhs.sv takes port B's number from the
    // bytes directly, so immgen drives x and there is nothing to check.
  }
};

// --- what +6 and +7 carry, checked against the DECODER --------------------
// k3 below asserts that the third register of a three-operand form is
// {byte1[1:0], opcode[0]}.  Rather than trust that reading of the spec, decode
// real bytes with tools/decode.js - the same decoder the roundtrip test uses -
// and compare.  A change to the field layout then fails here instead of quietly
// making this file check the wrong thing.
{
  // rtl/rhs.sv COMPUTES PORT B'S NUMBER AS {byte1[1:0], opcode[0]} without
  // consulting the decoder, so this is where that shortcut is justified.
  //
  // WHICH OPERAND PORT B IS depends on the instruction, and naming it here is
  // the point of the check rather than an inconvenience.  add and shl call it
  // `b`; push and pop call it `c` (and have a `b` of their own, so the name has
  // to be explicit); and br calls it `a`, because the branch's registers are
  // deliberately the other way round from its syntax so that the comparison is
  // an `rsb` - see the br section of isa/fructus.toml.
  const portB = { 0x46: 'b', 0x6e: 'b', 0x86: 'c', 0x8e: 'c', 0x96: 'a', 0x9e: 'a' };
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
                    + `r${got}, but {byte1[1:0], opcode[0]} is r${k3(byte1, op & 7)}`);
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
// ALL SIXTEEN CODES ARE SWEPT, the three reserved ones included.  They are not
// meant to be emitted, but they decode as r2/r3/r4 today by accident of the
// wiring and the check pins that: a later change that gives them a meaning has
// to come here and say so rather than silently altering what they do.
{
  // must match tools/gen-rhs.js
  const REG = { 0: 0, 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7 };   // src[3]=0
  const KON = { 0: 0, 1: 1, 2: 2, 6: -2, 7: -1 };                    // src[3]=1
  const MODE_IMM = 3, MODE_CIMM = 4, MODE_PORTB = 5;
  const rows = [];
  const rnd = (() => { let s = 2463534242;
    return () => (s ^= s << 13, s ^= s >>> 17, s ^= s << 5, s >>> 0); })();

  for (let sel = 0; sel <= 7; sel++)
    for (let src = 0; src < 16; src++)
      for (let i = 0; i < 12; i++) {
        const hi = src >> 3, c = src & 7;
        const isReg = !hi || c === MODE_PORTB;
        const isImm = hi && (c === MODE_IMM || c === MODE_CIMM);
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
           .regnum(gnum), .rhs(grhs));
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

process.exit(failed ? 1 : 0);
