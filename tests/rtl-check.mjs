#!/usr/bin/env node
// =============================================================================
// rtl-check.mjs - rtl/*.sv against the spec, not against themselves
// =============================================================================
//
//   node tests/rtl-check.mjs
//
// The modules rtl/cpu.sv borrows from the spec - rtl/immgen.sv, rtl/lhs.sv,
// rtl/dest.sv, rtl/cond.sv and rtl/compare.sv, which tools/gen-*.js build from
// isa/fructus.toml - and its ALU, each on its own.  The vectors are built here
// from the spec's own value tables and tools/sim.js, and neither side reads
// the other, so agreement means the circuits implement the tables rather than
// that one transcription matches another.  tests/cpu-check.mjs runs the whole
// processor.
//
// WHAT IS SWEPT.  Every (5-bit field, mode) pair, every (3-bit index, opcode
// bit) pair, and imm10 over its whole 10-bit range - with the untouched bits of
// the instruction register varied, because a circuit that accidentally reads
// them would otherwise pass.  Modes +6 and +7 have no immediate and what immgen drives there is meaningless,
// so they are not checked; what IS checked is the encoding property decode
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

// FRUCTUS_RTL=dir reads the RTL from dir instead of rtl/: tests/dontcare-check.mjs.
const RTL = process.env.FRUCTUS_RTL ?? 'rtl';

const spec = loadSpec();
const t = spec.optype;
const u16 = (v) => (v >>> 0) & 0xffff;
const sext = (v, n) => (v & (1 << (n - 1))) ? v - (1 << n) : v;

const hex4 = (v) => u16(v).toString(16).padStart(4, '0');
const hex6 = (v) => ((v >>> 0) & 0xffffff).toString(16).padStart(6, '0');

// --- the reference, straight off the tables ---------------------------------
// This is the whole specification of the block.  `insn` is the instruction as
// decode sees it: byte 0 in the low eight bits, byte 1 next, byte 2 at the top.
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
    // 6 and 7 have no immediate: decode takes port B's number from the bytes
    // directly, so what immgen drives there is meaningless.
  }
};

// --- where each unary operation sits ------------------------------------------
// Worked out from real bytes, not the generator: decode every unary instruction,
// look its imm3 index up in the spec's table, take bits 2:1 of the value - what
// selects the operation in rtl/alu.sv, from the right-hand operand the value
// arrives as - and note whether the spec gives it an extra cycle.  The
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
      ops.push({ name: m[1], op, value: u16(t.imm3.values[index]),
                 code: (u16(t.imm3.values[index]) >> 1) & 3, slow: (d.insn.extra_cycles ?? 0) > 0 });
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
  // rtl/cpu.sv'S DECODE COMPUTES PORT B'S NUMBER AS {byte1[7:6], opcode[0]} without
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

execFileSync('iverilog', ['-g2012', '-o', 'build/immgen-tb.vvp', `${RTL}/immgen.sv`, 'build/immgen-tb.sv'],
             { stdio: 'inherit' });
const out = execFileSync('vvp', ['build/immgen-tb.vvp'], { encoding: 'utf8' });
process.stdout.write(out.split('\n').filter((l) => /^(ok|FAIL)|MISMATCH/.test(l)).join('\n') + '\n');
for (const f of ['build/immgen-tb.vvp', 'build/immgen-tb.sv', 'build/immgen-vectors.txt']) rmSync(f, { force: true });
let failed = /FAIL/.test(out);

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
      // step sp, stm and ldm step r5 and r1.  The digit is what keeps branches
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
  execFileSync('iverilog', ['-g2012', '-o', 'build/lhs-tb.vvp', `${RTL}/lhs.sv`, 'build/lhs-tb.sv'],
               { stdio: 'inherit' });
  const o = execFileSync('vvp', ['build/lhs-tb.vvp'], { encoding: 'utf8' });
  process.stdout.write(o.split('\n').filter((l) => /^(ok|FAIL)|MISMATCH/.test(l)).join('\n') + '\n');
  for (const f of ['build/lhs-tb.vvp', 'build/lhs-tb.sv', 'build/lhs-vectors.txt']) rmSync(f, { force: true });
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
  execFileSync('iverilog', ['-g2012', '-o', 'build/dest-tb.vvp', `${RTL}/dest.sv`, 'build/dest-tb.sv'],
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

  // --- the ALU: op lhs rhs want -----------------------------------------------
  // rtl/alu.sv's `alu` for every one-cycle operation, its `slow` for clz and
  // popcount and its `mul` for the product, each of which answers for the
  // operands of the edge before.  Op 13 is the sequencer's word, which the
  // bench drives with rhs; 16 names `slow` here, and 17, 18 and 19 `mul`'s
  // three halves - mul, mulhu, mulhs - not codes the processor has.
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
    rows.push(row(13, l, r, r));
    rows.push(row(17, l, r, Math.imul(l, r)));
    rows.push(row(18, l, r, BUILTIN.mulhu(l, r)));
    rows.push(row(19, l, r, BUILTIN.mulhs(l, r)));
    for (const nm of ['shl', 'lsr', 'asr']) rows.push(row(OP[nm], l, r, BUILTIN[nm](l, r & 15)));
    // the operation rides bits 2:1 of the right-hand operand, which is the
    // imm3 value its encoding names - exactly what the processor puts there;
    // clz and popcount are the ALU's too, a clock later - 16 below
    for (const o of UN) rows.push(row(o.slow ? 16 : OP.unary, l, o.value, BUILTIN[o.name](l)));
  }
  const aluRows = rows.join('\n') + '\n';
  writeFileSync('build/alu-tb.txt', aluRows);
  const aluTb = `module tb;
    logic clk = 0;
    logic [4:0] op;
    logic [15:0] l, r, want_, y, sy, py, got;
    integer f, n = 0, bad = 0, rr;
    // 16 is clz or popcount: the unary code with two set, finished from the
    // ALU's own flop after the bench's one clock.
    // The fast group is one code, 4, and a select, as rtl/classify.sv makes it:
    // the bench's codes for its eight members become that select.
    wire grp = op == 2 || op == 3 || (op >= 4 && op <= 7) || op == 10 || op == 13;
    wire [2:0] ls = op == 2 ? 3'd6 : op == 3 ? 3'd7 : op == 10 ? 3'd4 : op == 13 ? 3'd5 : op[2:0] - 3'd4;
    alu  u (.clk(clk), .lhs(l), .rhs(r), .op(op == 16 ? 4'd12 : grp ? 4'd4 : op[3:0]), .two(op == 16),
            .lsel(ls), .mdata(r), .y(y), .sum());
    // mul's z as rtl/classify.sv's lsel has it: a 0 for the half kept.
    mul  m (.clk(clk), .a(l), .b(r), .z(op == 18 ? 3'b101 : op == 19 ? 3'b011 : 3'b110), .p(py));
    initial begin
        f = $fopen("build/alu-tb.txt", "r");
        if (f == 0) begin $display("FAIL cannot open vectors"); $finish; end
        while (!$feof(f)) begin
            rr = $fscanf(f, "%d %h %h %h\\n", op, l, r, want_);
            if (rr == 4) begin
                // one clock, so slow and mul have their answers too
                #1 clk = 1; #1 clk = 0; #1 clk = 1; #1 clk = 0; #1; n = n + 1;
                got = op >= 17 ? py : y;
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
  run('alu', [`${RTL}/alu.sv`], 'alu-tb');

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
    run('alu', ['-DCPU_CELLS', cells, `${RTL}/alu.sv`], 'alu-tb');
  } else console.log("skip  rtl/alu.sv's SB_MAC16: yosys's ice40 cell models not found");

  // --- recip, against tools/sim.js ------------------------------------------------
  // Each one through the cycles rtl/cpu.sv gives it - aq in the first, e_cnt
  // counting 4 down to 0, lsel 111 - and its answer read in the last; and the
  // answer must be zero in every other cycle, since it is ORed into the
  // product.  All 65536 operands, so the top bit is seen to be ignored, in a
  // shuffled order.  Behavioural, and then through yosys's SB_MAC16 model.
  {
    let seed = 12345;
    const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 8;
    const vec = [];
    for (let x = 0; x < 0x10000; x++) vec.push([4, x]);
    for (let i = vec.length - 1; i > 0; i--) { const j = rnd() % (i + 1); [vec[i], vec[j]] = [vec[j], vec[i]]; }
    writeFileSync('build/recip-tb.hex', vec.map(([k, a]) =>
      `${k} ${hex4(a)} ${hex4(BUILTIN.recip(a, 0))}`).join('\n') + '\n');
    var recipTb = `module tb;
    logic clk = 0, go = 0; logic [2:0] cnt = 0; logic [15:0] a = 0, xa, want_; wire [15:0] p;
    integer f, rr, len, k, n = 0, bad = 0, stray = 0;
    recip u (.clk(clk), .a(a), .go(go), .cnt(cnt), .p(p));
    initial begin
        f = $fopen("build/recip-tb.hex", "r");
        #1 clk = 1; #1 clk = 0;          // p's first value, zero
        #1 clk = 1; #1 clk = 0;
        while (!$feof(f)) begin
            rr = $fscanf(f, "%d %h %h\\n", len, xa, want_);
            if (rr == 3) begin
                n = n + 1;
                for (k = len; k >= 0; k = k - 1) begin
                    // aq holds the operand in the first cycle only
                    a = k == len ? xa : $random;
                    go = 1; cnt = k[2:0];
                    #1; if (k != 0 && p !== 16'd0) stray = stray + 1;
                    if (k == 0 && p !== want_) begin
                        bad = bad + 1;
                        if (bad < 6) $display("  MISMATCH d=%h: want %h got %h", xa, want_, p);
                    end
                    #1 clk = 1; #1 clk = 0;
                end
            end
        end
        if (bad == 0 && stray == 0) $display("ok    rtl/recip.sv\${WHICH}: %0d operands against tools/sim.js, and zero between", n);
        else $display("FAIL  rtl/recip.sv\${WHICH}: %0d of %0d wrong, %0d cycles not zero", bad, n, stray);
        $finish;
    end
endmodule
`;
  }
  writeFileSync('build/recip-tb.sv', recipTb.replaceAll('\${WHICH}', ''));
  run('recip', [`${RTL}/recip.sv`], 'recip-tb');
  if (cells && existsSync(cells)) {
    writeFileSync('build/recip-tb.sv', recipTb.replaceAll('\${WHICH}', ", with yosys's SB_MAC16 model"));
    run('recip', ['-DCPU_CELLS', cells, `${RTL}/recip.sv`], 'recip-tb');
  } else console.log("skip  rtl/recip.sv's SB_MAC16: yosys's ice40 cell models not found");
  rmSync('build/recip-tb.hex', { force: true });

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
  run('compare', [`${RTL}/compare.sv`], 'compare-tb');

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
  run('cond', [`${RTL}/compare.sv`, `${RTL}/cond.sv`], 'cond-tb');
}

process.exit(failed ? 1 : 0);
