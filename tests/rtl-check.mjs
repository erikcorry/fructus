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
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

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
  // An opcode with THREE operations needs both bits of rhs[2:1], and then the
  // block's select is the code itself rather than one bit of it.
  const wide = ops.some((o) => ops.filter((x) => x.op === o.op).length > 2);
  for (const o of ops) {
    const mate = ops.find((x) => x.op === o.op && x !== o);
    const diff = mate ? o.code ^ mate.code : 2;
    o.bit = diff === 1 ? 1 : 2;
    o.level = (o.code >> (o.bit - 1)) & 1;
    o.sel = wide ? o.code : o.level;
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
// ALL SIXTEEN CODES ARE SWEPT, and nothing in the low half is reserved any
// more.  The rule this check has now enforced three times is that a code which
// acquires a meaning must come HERE and say so, rather than quietly ceasing to
// be what the wiring made it: code 4 did that when it became the 16-bit
// immediate, code 2 when it became a call's return address, and CODE 3 HAS NOW
// DONE IT - it is the ADDRESS UNIT's sum, which push, pop, stm and ldm write
// back as the pointer they walked.  Both adder sums arrive on ports of their
// own, which this bench drives rather than infers.
{
  // must match tools/gen-rhs.js
  const REG = { 0: 0, 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7 };   // src[3]=0
  const KON = { 0: 0, 1: 1, 2: 2, 6: -2, 7: -1 };                    // src[3]=1
  const MODE_IMM = 3, MODE_CIMM = 4, MODE_PORTB = 5;
  const CODE_IMM16 = 4;                                              // src[3]=0
  const CODE_PCSUM = 2;                                              // src[3]=0
  const CODE_ADR   = 3;                                              // src[3]=0
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
        const isReg = (!hi && c !== CODE_IMM16 && c !== CODE_PCSUM && c !== CODE_ADR)
                   || (hi && c === MODE_PORTB);
        const isImm = hi && (c === MODE_IMM || c === MODE_CIMM);
        if (!hi && c === CODE_IMM16) {
          // The expected value comes from DECODING `mov rd, #imm16` bytes, laid
          // out as rtl/insn.sv holds them, not from knowing where the slice is.
          const op = MOV16 | (rnd() & 7);
          const b1 = rnd() & 0xff, b2 = rnd() & 0xff, rv = rnd() & 0xffff;
          const ps = rnd() & 0xffff, ad = rnd() & 0xffff;
          const v = decode(movDec, [op, b1, b2], 0).ops.imm;
          rows.push(`${hex6((b2 << 16) | (b1 << 8) | op)} ${src} ${hex4(rv)} ${hex4(ps)} ${hex4(ad)} ${c} ${hex4(v)}`);
          continue;
        }
        // immgen drives x at +6 and +7, so reading it there is a microcode bug
        // rather than a case with an answer.
        if (isImm && sel >= 6) continue;
        const insn = ((rnd() & 0xffff) << 8) | ((rnd() & 0x1f) << 3) | sel;
        const regval = rnd() & 0xffff;
        const pcsum = rnd() & 0xffff;
        const adr = rnd() & 0xffff;
        const num = hi ? k3(insn) : REG[c];
        // Codes 2 and 3 are ADDER SUMS - the pc's and the address unit's - and
        // each comes in on a port of its own rather than through the register
        // file or immgen, so neither is isReg or isImm and the bench drives
        // both with values of its own.
        const rhs = isReg ? regval
                  : isImm ? want(insn, c === MODE_CIMM)
                  : (!hi && c === CODE_PCSUM) ? pcsum
                  : (!hi && c === CODE_ADR)   ? adr
                  : KON[c];
        rows.push(`${hex6(insn)} ${src} ${hex4(regval)} ${hex4(pcsum)} ${hex4(adr)} ${num} ${hex4(rhs)}`);
      }

  writeFileSync('build/rhs-vectors.txt', rows.join('\n') + '\n');
  writeFileSync('build/rhs-tb.sv', `module tb;
    logic [23:0] insn;
    logic [15:0] regval, pcsum, adr, xrhs, grhs;
    logic [2:0] xnum, gnum;
    logic [3:0] src;
    integer f, n = 0, bad = 0, r;
    rhs u (.insn(insn), .src(src), .regval(regval), .pcsum(pcsum), .adr(adr),
           .regnum(gnum), .value(grhs));
    initial begin
        f = $fopen("build/rhs-vectors.txt", "r");
        if (f == 0) begin $display("FAIL cannot open vectors"); $finish; end
        while (!$feof(f)) begin
            r = $fscanf(f, "%h %d %h %h %h %d %h\\n",
                        insn, src, regval, pcsum, adr, xnum, xrhs);
            if (r == 7) begin
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
// Every operation is swept over its WHOLE input space - 65536 values each, all
// operations - because these are cheap to enumerate completely and a sampled
// sweep would miss precisely the interesting inputs: clz at 0 and 1, popcount
// at 0xffff, bitrev's fixed points.
{
  // a sel slow want - the slow pair is checked a clock after its input, since
  // its output is registered; the fast pair is checked at the same time
  const rows = [];
  for (const o of unaryOps())
    for (let a = 0; a < 65536; a++)
      rows.push(`${a.toString(16).padStart(4, '0')} ${o.sel} ${o.slow ? 1 : 0} `
              + `${u16(BUILTIN[o.name](a)).toString(16).padStart(4, '0')}`);
  writeFileSync('build/unary-vectors.txt', rows.join('\n') + '\n');
  writeFileSync('build/unary-tb.sv', `module tb;
    logic clk = 0;
    logic [15:0] a, want_;
    wire  [15:0] fast, slow, y;
    logic [1:0] sel;      // the low bit alone reaches a one-bit select
    logic isslow;
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
      // An instruction that WALKS A POINTER reads it on port A, and the
      // microcode names it rather than the encoding carrying it - push and pop
      // step sp, stm and ldm step r1 and r2.  The digit is what keeps branches
      // out: `pc = pc + off` has the same shape and its register IS a field.
      if (!e || e.nbytes === 1
             || /\b[a-z][a-z0-9]* = base [-+] \d/.test(e.insn.semantics ?? '')) continue;
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
  // Every code against every byte 1.  Codes 8 and 9 are the rd and ra fields;
  // 10 is port B's, {byte1[7:6], opcode[0]}, which push reaches for its third
  // register.  The rest are reserved and pinned to what the wiring makes them:
  // src[1] picks port B's field and src[0] picks between rd and ra otherwise.
  for (let src = 0; src < 16; src++)
    for (let b1 = 0; b1 < 256; b1++) {
      const op = rnd() & 0xff;
      const insn = ((rnd() & 0xff) << 16) | (b1 << 8) | op;
      const field = (src & 2) ? ((((b1 >> 6) & 3) << 1) | (op & 1))
                  : (src & 1) ? (b1 >> 3) & 7
                  :             b1 & 7;
      rows.push(row(src, insn, src < 8 ? src : field));
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
// tools/decode.js - two-register, packed, brclr and brset - the condition and
// mode cond.sv produces from them, and compare.sv's bit against the semantics.
{
  const rnd = (() => { let s = 521288629;
    return () => (s ^= s << 13, s ^= s >>> 17, s ^= s << 5, s >>> 0); })();
  const NAMES = spec.optype.cond3.names;
  const UN = unaryOps();
  const OP = { add: 0, rsb: 1, iseq: 2, isset: 3, xor: 4, or: 5, and: 6, rhs: 7, shl: 8, lsr: 9, movhi: 10, asr: 11, unary: 12, slow: 13, mul: 14 };
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
    rows.push(row(OP.movhi, l, r, ((r & 0xff) << 8) | (l & 0xff)));
    rows.push(row(OP.mul, l, r, Math.imul(l, r)));   // registered, like the slow pair
    for (const nm of ['shl', 'lsr', 'asr']) rows.push(row(OP[nm], l, r, BUILTIN[nm](l, r & 15)));
    // the operation rides rhs[2:1]; every other bit of rhs is left random, and
    // the slow pair is read through its own operation code
    for (const o of UN)
      rows.push(row(o.slow ? OP.slow : OP.unary, l, (r & ~6) | (o.code << 1), BUILTIN[o.name](l)));
  }
  const aluRows = rows.join('\n') + '\n';
  writeFileSync('build/alu-tb.txt', aluRows);
  const aluTb = `module tb;
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
        if (bad == 0) $display("ok    rtl/alu.sv\${WHICH}: %0d vectors against tools/sim.js, all correct", n);
        else $display("FAIL  rtl/alu.sv\${WHICH}: %0d of %0d wrong", bad, n);
        $finish;
    end
endmodule
`;
  writeFileSync('build/alu-tb.sv', aluTb.replaceAll('\${WHICH}', ''));
  run('alu', ['rtl/unary.sv', 'rtl/alu.sv'], 'alu-tb');

  // AND AGAIN WITH THE SB_MAC16 THAT SYNTHESIS GETS.  Everything above runs the
  // behavioural product rtl/alu.sv gives iverilog; this runs the same vectors
  // through the DSP instance and its parameters, in yosys's own model of the
  // cell, which is what would catch a register or an output select set wrong.
  const cells = have('yosys')
    ? join(dirname(execFileSync('sh', ['-c', 'command -v yosys'], { encoding: 'utf8' }).trim()), '../share/yosys/ice40/cells_sim.v')
    : null;
  if (cells && existsSync(cells)) {
    writeFileSync('build/alu-tb.txt', aluRows);
    writeFileSync('build/alu-tb.sv', aluTb.replaceAll('\${WHICH}', ", with yosys's SB_MAC16 model"));
    run('alu', ['-DSYNTHESIS', cells, 'rtl/unary.sv', 'rtl/alu.sv'], 'alu-tb');
  } else console.log("skip  rtl/alu.sv's SB_MAC16: yosys's ice40 cell models not found");

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
  // lhs = R[b]), 1 the packed one (rhs = the constant, lhs = R[a]), 2 brclr
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
// brclr and brset.  Loads, stores, push, pop and calls take microcode steps
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
      if (!d) continue;
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
  // Three pools, because what is safe to put in a random program differs.  An
  // ALU form and a LOAD are safe with any registers at all: neither writes
  // memory, so wild addresses only read bytes the simulator reads too.  A STORE
  // is not - it would scribble on the program, and although both machines would
  // scribble identically, the RTL would then trap on an opcode the ROM does not
  // implement where the simulator executed it, and the disagreement would be
  // about the corruption rather than about memory.  So stores go in programs of
  // their own, with registers drawn from a window well clear of the program;
  // nothing in such a program writes a register, so every address stays there.
  const pool = { alu: new Map(), ld: new Map(), st: new Map() };
  for (let op = 0; op < 256; op++)
    for (let b1 = 0; b1 < 256; b1++) {
      const d = decode(dec, [op, b1, 0], 0);
      if (!d) continue;
      const sem = d.insn.semantics ?? '';
      // The `;` test comes FIRST and applies to every kind.  pop's semantics is
      // `R[a] = M16[sp]; sp = sp + 2`, which matches the load pattern on its
      // first statement - so a test that excluded multi-statement semantics on
      // the ALU branch alone drew pops into the load programs, and the RTL
      // rightly trapped on an instruction the ROM does not implement.
      // The block moves go in with their own kind of traffic: push and stm
      // WRITE memory, so they belong with the stores, and the only register
      // either one writes is the pointer it walked - which stays in the safe
      // window by construction.  pop and ldm write registers from memory, which
      // is unsafe beside a store but harmless beside a load.
      const kind = /M16\[base[^\]]*\] = R\[a\]/.test(sem)   ? 'st'
                 : /R\[a\] = M16\[base/.test(sem)          ? 'ld'
                 : sem.includes(';')                     ? null
                 : /^R\[[a-z]\] = M(8|16)\[/.test(sem)   ? 'ld'
                 : /^M(8|16)\[/.test(sem)                ? 'st'
                 : /^R\[[a-z]\] = /.test(sem)            ? 'alu' : null;
      if (!kind) continue;
      const key = `${d.insn.mnemonic}/${d.form.name}@${op}`;
      if (!pool[kind].has(key)) pool[kind].set(key, { op, nbytes: d.nbytes, b1s: [] });
      pool[kind].get(key).b1s.push(b1);
    }
  const all    = [...pool.alu.values()];
  const loads  = [...pool.ld.values()];
  const stores = [...pool.st.values()];
  // Even, and far above any program these make: the widest displacement is ten
  // signed bits and an index is another register from the same window.
  const safe = () => 0x2000 + ((rnd() % 0x1000) & ~1);
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
            brclr r1, #0xf0f0, clear
            halt
    clear:  add  r1, r1, #1
            jmpr done
    odd:    mov  r1, #0xdead
    done:   call tail
            halt
    tail:   mov  r5, #3
            halt`,
    `       mov  r0, #0
            mov  r1, #target
            jmp  r1
            mov  r2, #0xbad
    target: call sub
            mov  r3, #7
            halt
    sub:    mov  r4, #9
            ret`,
  ];
  const assembled = SOURCES.map((src, i) => {
    const f = `build/cpu-src-${i}.s`;
    writeFileSync(f, src.split('\n').map((l) => l.trim()).join('\n') + '\n');
    const { code } = assemble(f);
    rmSync(f, { force: true });
    return [...code];
  });

  // THE TERMINATOR COMES FROM THE SPEC.  It was a literal 0x00 with `halt' in
  // a comment beside it, which stopped being halt the day brk took opcode
  // zero - and a random program that ends in a trap instead of a stop tests
  // the trap handler, which is not what any of this is for.
  const HALT = parseInt(spec.insn.find((i) => i.mnemonic === 'halt')
                            .form[0].encoding.replace(/[\s_]/g, ''), 2);

  const N_ALU = 40, N_LD = 10, N_ST = 10;
  const PROGRAMS = N_ALU + N_LD + N_ST + assembled.length;
  const programs = [];
  const some = (xs) => Array.from({ length: 30 }, () => xs[rnd() % xs.length]);
  for (let p = 0; p < PROGRAMS; p++) {
    // The first program of each batch runs every form in it, so each is covered
    // whatever the random ones pick.
    let picks = null, draws = val;
    if (p < N_ALU)                       picks = p === 0 ? all : some(all);
    else if (p < N_ALU + N_LD)           picks = p === N_ALU ? loads : some([...all, ...loads]);
    else if (p < N_ALU + N_LD + N_ST) { picks = p === N_ALU + N_LD ? stores : some(stores); draws = safe; }
    const bytes = picks ? picks.flatMap(draw).concat([HALT])
                        : assembled[p - N_ALU - N_LD - N_ST];
    const reg = Array.from({ length: 8 }, draws);
    const m = new Machine(spec).load(bytes, 0);
    reg.forEach((v, k) => { m.R[k] = v; });
    const trace = [];
    for (let guard = 0; !m.halted && guard < 1000; guard++) {
      const d = decode(dec, [m.mem[m.pc], m.mem[(m.pc + 1) & 0xffff], m.mem[(m.pc + 2) & 0xffff]], 0);
      // What blit mode charges a cycle: every load but pop, which keeps its
      // ordinary routine and reads the processor's own memory.
      const sem = d?.insn.semantics ?? '';
      const entry = { pc: m.pc, R: Array.from(m.R), loads: /= M(8|16)\[/.test(sem) && !/^base = sp;/.test(sem) },
            before = m.cycles();
      m.step();
      entry.len = m.cycles() - before;       // the simulator's cost model, extra cycles included
      trace.push(entry);
    }
    // WHAT A STORE DID IS NOT IN ANY REGISTER, so the registers and the pc
    // cannot see it.  Both machines fold their whole memory into one number
    // instead: a store to the wrong address, of the wrong byte, or in the wrong
    // order changes it, and a load that wrote memory would change it too.
    let hash = 0;
    for (let k = 0; k < 65536; k++) hash = (Math.imul(hash, 31) + m.mem[k]) & 0x7fffffff;
    programs.push({ bytes, reg, trace, hash });
    writeFileSync(`build/cpu-prog-${p}.hex`, bytes.map((b) => b.toString(16).padStart(2, '0')).join('\n') + '\n');
    writeFileSync(`build/cpu-reg-${p}.hex`, reg.map(hex4).join('\n') + '\n');
  }

  // THREE PASSES OVER THE SAME PROGRAMS.  The processor as it is; built with
  // FRUCTUS_BLIT but with the mode off, which must be the same machine; and
  // with the mode on, where the memory below hands every byte back a second
  // time, on mem_late, one edge later than on mem_rdata - so ld, ld8 and ldm
  // must take the late copy, and nothing else may: pop keeps mem_rdata.  Blit
  // mode charges exactly one cycle more to each of those three, and nothing
  // else.
  const variants = [
    { label: '', define: [], blit: null },
    { label: ', built for blit mode with it off', define: ['-DFRUCTUS_BLIT'], blit: 0 },
    { label: ', in blit mode, ld, ld8 and ldm a cycle late', define: ['-DFRUCTUS_BLIT'], blit: 1 },
  ];
  for (const v of variants) {
  writeFileSync('build/cpu-tb.sv', `module tb;
    logic clk = 0, rst = 1;
    logic [7:0] mem [0:65535];
    logic [7:0] rdata;
    logic [15:0] regs [0:7];
    wire [15:0] addr;
    wire [7:0] wdata;
    wire we;
    wire halted, trapped;
    logic [15:0] addr_q;
    logic [7:0] late;
    cpu u (.clk(clk), .rst(rst), .mem_addr(addr), .mem_rdata(rdata),
           .mem_wdata(wdata), .mem_we(we), .irq(1'b0), .halted(halted), .trapped(trapped),
           ${v.blit === null ? '' : `.blit(1'b${v.blit}), .mem_late(late), `}.result());
    // IRQ IS TIED LOW HERE AND THAT COSTS NOTHING, because this is functional
    // simulation rather than synthesis: there is no timing number to distort by
    // letting the take path fold away.  tools/fpga-top.sv must NOT do this -
    // a constant there would delete the ie flop, the take term and the vector
    // arm before anything measured them.  These programs exercise the datapath,
    // and brk and rti are reached by executing them, not by a pin.
    // ONE PORT, as the part has: the address is sampled at the edge, the byte
    // read appears after it, and a write lands at that same edge.  A read in a
    // writing cycle sees what was there before - which is what the microcode
    // expects, since the byte on the bus during a store is ignored.
    // The late copy: the byte at the address sampled two edges ago, read at
    // the second edge - so it sees a write made at the first.
    always @(posedge clk) begin
        rdata <= mem[addr];
        addr_q <= addr;
        late <= mem[addr_q];
        if (we) mem[addr] <= wdata;
    end
    integer p, k, cyc, lastcyc, pcnow, h;
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
            h = 0;
            for (k = 0; k < 65536; k = k + 1) h = (h * 31 + mem[k]) & 32'h7fffffff;
            $display("END %0d %0d %0d %0d", p, halted, trapped, h);
        end
        $finish;
    end
endmodule
`);
  execFileSync('iverilog', ['-g2012', ...v.define, '-o', 'build/cpu-tb.vvp',
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
    if (f[0] === 'END') ends[+f[1]] = { halted: f[2] === '1', trapped: f[3] === '1', hash: +f[4] };
  }
  let bad = 0, instructions = 0;
  const complain = (msg) => { if (bad++ < 6) console.log(`  MISMATCH ${msg}`); };
  programs.forEach(({ trace, hash }, p) => {
    const got = steps[p];
    if (!ends[p]?.halted || ends[p]?.trapped) complain(`program ${p}: ended ${ends[p]?.trapped ? 'trapped' : 'without halting'}`);
    if (ends[p] && ends[p].hash !== hash)
      complain(`program ${p}: memory folds to ${ends[p].hash} on the RTL and ${hash} on the simulator`);
    if (got.length !== trace.length) complain(`program ${p}: ${got.length} dispatches, the simulator ran ${trace.length} instructions`);
    for (let i = 0; i < Math.min(got.length, trace.length); i++) {
      const g = got[i], t = trace[i];
      if (g.pc !== t.pc || g.R.some((v, k) => v !== t.R[k]))
        complain(`program ${p} instruction ${i} at 0x${t.pc.toString(16)}: rtl pc ${g.pc.toString(16)} r=${g.R.map(hex4).join(' ')}, sim r=${t.R.map(hex4).join(' ')}`);
      const len = trace[i - 1]?.len + (v.blit && trace[i - 1]?.loads ? 1 : 0);
      if (i > 0 && g.cyc - got[i - 1].cyc !== len)
        complain(`program ${p} instruction ${i - 1}: ${g.cyc - got[i - 1].cyc} cycles where the simulator counts ${len}`);
      instructions++;
    }
  });
  if (bad === 0) console.log(`ok    rtl/cpu.sv${v.label}: ${PROGRAMS} programs, ${instructions} instructions over ${all.length + loads.length + stores.length} forms, pc, registers, memory and cycles all agree with tools/sim.js`);
  else { console.log(`FAIL  rtl/cpu.sv${v.label}: ${bad} disagreements with tools/sim.js`); failed = true; }
  }

  // --- the interrupt line ---------------------------------------------------------
  // THE SAME PROGRAMS, INTERRUPTED EVERY FEW CYCLES.  The vector holds nothing
  // but rti, so an interrupt entered and left must leave a program exactly as
  // if it had never come: the same registers and the same memory at the halt
  // as the simulator's run without one.  The line goes up 17 to 39 cycles
  // after each take, at random, and down at the next, so the interrupts land
  // after every kind of instruction.  NOT ON A FIXED PERIOD: an entry and its
  // rti take about ten cycles, and a period that brings the line back just as
  // the interrupted instruction is dispatched again starves it forever - as a
  // level-sensitive line would on the part.  tools/sim.js has no interrupt
  // line, and needs none for this.
  //
  // AND ONCE AT THE HALT, the other place one is taken.  The machine must go
  // on AFTER the halt, as isa/fructus.toml says, so a second halt is put
  // there: the pc must end a byte further on than it waited at.  Returning to
  // the first halt instead would leave it where it was.
  //
  // This is what brk alone never reached: an interrupt taken where no
  // instruction is dispatched, which rtl/predecode.sv therefore never decoded.
  {
    const RTI = parseInt(spec.insn.find((i) => i.mnemonic === 'rti').form[0].encoding.replace(/[\s_]/g, ''), 2);
    const VECTOR = spec.cpu.vectors.brk;
    const finals = programs.map(({ bytes, reg }) => {
      const m = new Machine(spec).load(bytes, 0);
      m.mem[VECTOR] = RTI;
      reg.forEach((v, k) => { m.R[k] = v; });
      for (let guard = 0; !m.halted && guard < 1000; guard++) m.step();
      m.mem[m.pc] = HALT;                    // as the test bench puts after the halt
      let hash = 0;
      for (let k = 0; k < 65536; k++) hash = (Math.imul(hash, 31) + m.mem[k]) & 0x7fffffff;
      return { R: Array.from(m.R), hash };
    });
    writeFileSync('build/cpu-irq-tb.sv', `module tb;
    logic clk = 0, rst = 1, irq = 0, drop;
    integer next, lfsr;
    logic [7:0] mem [0:65535];
    logic [7:0] rdata;
    logic [15:0] regs [0:7];
    wire [15:0] addr;
    wire [7:0] wdata;
    wire we, halted, trapped;
    cpu u (.clk(clk), .rst(rst), .mem_addr(addr), .mem_rdata(rdata),
           .mem_wdata(wdata), .mem_we(we), .irq(irq), .halted(halted), .trapped(trapped),
           .result());
    always @(posedge clk) begin
        rdata <= mem[addr];
        if (we) mem[addr] <= wdata;
    end
    integer p, k, cyc, takes, h, pc1;
    reg [8*64:1] name;
    // One cycle.  With \`raise\`, the line goes up at \`next\`; it drops after a
    // take, and \`next\` is then 17 to 39 cycles on.
    task tick(input integer raise);
        begin
            if (raise && cyc == next) irq = 1;
            drop = u.u.take;
            if (drop) takes = takes + 1;
            #1 clk = 1; #1 clk = 0;
            if (drop) begin
                irq = 0;
                lfsr = (lfsr * 1103515245 + 12345) & 32'h7fffffff;
                next = cyc + 17 + (lfsr >> 8) % 23;
            end
            cyc = cyc + 1;
        end
    endtask
    initial begin
        for (p = 0; p < ${PROGRAMS}; p = p + 1) begin
            for (k = 0; k < 65536; k = k + 1) mem[k] = 8'h00;
            $sformat(name, "build/cpu-prog-%0d.hex", p); $readmemh(name, mem);
            $sformat(name, "build/cpu-reg-%0d.hex", p);  $readmemh(name, regs);
            mem[${VECTOR}] = 8'h${RTI.toString(16).padStart(2, '0')};
            irq = 0;
            rst = 1;
            repeat (3) begin #1 clk = 1; #1 clk = 0; end
            for (k = 0; k < 8; k = k + 1) u.R[k] = regs[k];
            rst = 0; cyc = 0; takes = 0; next = 5 + p % 7; lfsr = p + 1;
            u.u.ie = 1'b1;                     // as sei would
            while (!halted && !trapped && cyc < 50000) tick(1);
            // At the halt: a second one after it, and the line once more.
            pc1 = u.pc;
            mem[pc1] = 8'h${HALT.toString(16).padStart(2, '0')};
            irq = 1;
            k = cyc;
            while (irq && cyc < k + 50) tick(0);
            repeat (40) tick(0);
            h = 0;
            for (k = 0; k < 65536; k = k + 1) h = (h * 31 + mem[k]) & 32'h7fffffff;
            $display("IRQ %0d %0d %0d %0d %0d %h %h %h %h %h %h %h %h %0d %0d", p, halted, trapped, takes, h,
                     u.R[0], u.R[1], u.R[2], u.R[3], u.R[4], u.R[5], u.R[6], u.R[7], pc1, u.pc);
        end
        $finish;
    end
endmodule
`);
    execFileSync('iverilog', ['-g2012', '-o', 'build/cpu-irq-tb.vvp',
      'rtl/cpu.sv', 'rtl/ucode.sv', 'rtl/insn.sv', 'rtl/predecode.sv', 'rtl/lhs.sv', 'rtl/immgen.sv',
      'rtl/rhs.sv', 'rtl/unary.sv', 'rtl/alu.sv', 'rtl/dest.sv', 'rtl/cond.sv', 'rtl/compare.sv',
      'build/cpu-irq-tb.sv'], { stdio: 'inherit' });
    const out = execFileSync('vvp', ['build/cpu-irq-tb.vvp'], { encoding: 'utf8', maxBuffer: 1 << 26 });
    let bad = 0, takes = 0;
    const complain = (msg) => { if (bad++ < 6) console.log(`  MISMATCH ${msg}`); };
    const seen = new Set();
    for (const line of out.split('\n')) {
      const f = line.trim().split(/\s+/);
      if (f[0] !== 'IRQ') continue;
      const p = +f[1], R = f.slice(6, 14).map((x) => parseInt(x, 16));
      seen.add(p);
      takes += +f[4];
      if (f[2] !== '1' || f[3] !== '0') complain(`program ${p}: ${f[3] === '1' ? 'trapped' : 'did not halt'} under interrupts`);
      if (+f[4] < 1) complain(`program ${p}: no interrupt taken`);
      if (+f[5] !== finals[p].hash) complain(`program ${p}: memory folds to ${f[5]} under interrupts and ${finals[p].hash} without`);
      if (+f[15] !== +f[14] + 1)
        complain(`program ${p}: waited at 0x${(+f[14]).toString(16)} and ended at 0x${(+f[15]).toString(16)}, not a byte on, after the interrupt at the halt`);
      if (R.some((v, k) => v !== finals[p].R[k]))
        complain(`program ${p}: r=${R.map(hex4).join(' ')} under interrupts, sim r=${finals[p].R.map(hex4).join(' ')}`);
    }
    if (seen.size !== PROGRAMS) complain(`${PROGRAMS - seen.size} programs printed nothing`);
    if (bad === 0) console.log(`ok    rtl/cpu.sv, interrupted: ${PROGRAMS} programs under ${takes} interrupts, the last at each halt, end as tools/sim.js does without them`);
    else { console.log(`FAIL  rtl/cpu.sv, interrupted: ${bad} disagreements`); failed = true; }
    for (const f of ['build/cpu-irq-tb.vvp', 'build/cpu-irq-tb.sv']) rmSync(f, { force: true });
  }

  for (let p = 0; p < PROGRAMS; p++) for (const f of [`build/cpu-prog-${p}.hex`, `build/cpu-reg-${p}.hex`]) rmSync(f, { force: true });
  for (const f of ['build/cpu-tb.vvp', 'build/cpu-tb.sv']) rmSync(f, { force: true });
}

process.exit(failed ? 1 : 0);
