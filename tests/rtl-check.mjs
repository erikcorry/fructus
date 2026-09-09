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
// WHAT IS SWEPT.  All eight modes, every (5-bit field, mode) pair, every
// (3-bit index, opcode bit) pair, and imm10 over its whole 10-bit range - with
// the untouched upper bits of immreg varied, because a circuit that
// accidentally reads them would otherwise pass.  Modes +6 and +7 carry the
// three-operand forms' third REGISTER NUMBER rather than a value, and are
// checked against the encoding's own field spec: reg[0] comes from the opcode
// and reg[2:1] from byte1, which is what makes them the imm3 index's twin.
//
// Needs iverilog.  Skips with a message rather than failing when it is absent,
// so the suite still runs on a machine without the FPGA tools installed.
// =============================================================================

import { loadSpec } from '../tools/isa.js';
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
const want = (ir, sel) => {
  switch (sel) {
    case 0: return sext(ir & 31, 5);                     // imm5
    case 1: return t.immbit5.values[ir & 31];            // immbit5
    case 2: case 3: return t.imm3.values[k3(ir, sel)];   // imm3
    case 4: return sext(ir & 1023, 10);                  // imm10
    case 5: return t.immask5.values[ir & 31];            // immask5
    case 6: case 7: return k3(ir, sel);                  // rb, zero extended
  }
};

// --- what +6 and +7 carry, checked against the DECODER --------------------
// k3 below asserts that the third register of a three-operand form is
// {byte1[1:0], opcode[0]}.  Rather than trust that reading of the spec, decode
// real bytes with tools/decode.js - the same decoder the roundtrip test uses -
// and compare.  A change to the field layout then fails here instead of quietly
// making this file check the wrong thing.
{
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
for (let sel = 0; sel <= 7; sel++)
  for (let low = 0; low < 1024; low++)
    for (const high of [0x0000, 0xfc00, 0x5400, 0xa800]) {
      const ir = high | low;
      vecs.push(`${u16(ir).toString(16).padStart(4, '0')} ${sel} ${u16(want(ir, sel)).toString(16).padStart(4, '0')}`);
    }

mkdirSync('build', { recursive: true });
writeFileSync('build/immgen-vectors.txt', vecs.join('\n') + '\n');
writeFileSync('build/immgen-tb.sv', `module tb;
    logic [15:0] ir, expect_, got;
    logic [2:0] sel;
    integer f, n = 0, bad = 0, r;
    immgen u (.ir(ir), .sel(sel), .imm(got));
    initial begin
        f = $fopen("build/immgen-vectors.txt", "r");
        if (f == 0) begin $display("FAIL cannot open vectors"); $finish; end
        while (!$feof(f)) begin
            r = $fscanf(f, "%h %d %h\\n", ir, sel, expect_);
            if (r == 3) begin
                #1;
                n = n + 1;
                if (got !== expect_) begin
                    bad = bad + 1;
                    if (bad < 6)
                        $display("  MISMATCH ir=%h sel=%0d want=%h got=%h", ir, sel, expect_, got);
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
// rtl/rhs.sv - the four microcode lines on top of immgen
// =============================================================================
// The reference is the module's contract stated once: pick immgen's output or a
// constant, then read that as a value or as a register number.  regval stands in
// for the register file, so the check covers the wiring rather than the file.
{
  const K = [-1, 0, 1, 2];                       // must match tools/gen-rhs.js
  const rows = [];
  const rnd = (() => { let s = 2463534242;
    return () => (s ^= s << 13, s ^= s >>> 17, s ^= s << 5, s >>> 0); })();

  for (let sel = 0; sel <= 7; sel++)
    for (let kUse = 0; kUse <= 1; kUse++)
      for (let k = 0; k < 4; k++)
        for (let asReg = 0; asReg <= 1; asReg++)
          for (let i = 0; i < 24; i++) {
            const ir = rnd() & 0xffff, regval = rnd() & 0xffff;
            const val = kUse ? u16(K[k]) : u16(want(ir, sel));
            const num = kUse ? (u16(K[k]) & 7) : k3(ir, sel);
            const rhs = asReg ? regval : val;
            rows.push([ir, sel, kUse, k, asReg, regval, num, rhs]
              .map((v, j) => (j === 0 || j === 5 || j === 7)
                ? u16(v).toString(16).padStart(4, '0') : v).join(' '));
          }

  writeFileSync('build/rhs-vectors.txt', rows.join('\n') + '\n');
  writeFileSync('build/rhs-tb.sv', `module tb;
    logic [15:0] ir, regval, xrhs, grhs;
    logic [2:0] sel, xnum, gnum;
    logic k_use, as_reg; logic [1:0] k;
    integer f, n = 0, bad = 0, r;
    rhs u (.ir(ir), .sel(sel), .k_use(k_use), .k(k), .as_reg(as_reg),
           .regval(regval), .regnum(gnum), .rhs(grhs));
    initial begin
        f = $fopen("build/rhs-vectors.txt", "r");
        if (f == 0) begin $display("FAIL cannot open vectors"); $finish; end
        while (!$feof(f)) begin
            r = $fscanf(f, "%h %d %d %d %d %h %d %h\\n",
                        ir, sel, k_use, k, as_reg, regval, xnum, xrhs);
            if (r == 8) begin
                #1; n = n + 1;
                if (grhs !== xrhs || gnum !== xnum) begin
                    bad = bad + 1;
                    if (bad < 6) $display("  MISMATCH ir=%h sel=%0d k_use=%0d k=%0d as_reg=%0d: "
                        , ir, sel, k_use, k, as_reg,
                        "want rhs=%h num=%0d, got rhs=%h num=%0d", xrhs, xnum, grhs, gnum);
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

process.exit(failed ? 1 : 0);
