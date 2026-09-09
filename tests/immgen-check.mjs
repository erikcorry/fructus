#!/usr/bin/env node
// =============================================================================
// immgen-check.mjs - rtl/immgen.sv against the spec, not against itself
// =============================================================================
//
//   node tests/immgen-check.mjs
//
// The vectors are built here from isa/fructus.toml's own value tables, and the
// Verilog is built by tools/gen-immgen.js from the same file.  Neither reads
// the other, so agreement means the circuit implements the tables rather than
// that one transcription matches another.
//
// WHAT IS AND IS NOT SWEPT.  Every (5-bit field, mode) pair is exercised, every
// (3-bit imm3 index, opcode bit) pair, and imm10 over its whole 10-bit range -
// with the untouched upper bits of immreg varied, because a circuit that
// accidentally reads them would otherwise pass.  Modes +6 and +7 are the
// three-register forms and produce no immediate, so they are not checked.
//
// Needs iverilog.  Skips with a message rather than failing when it is absent,
// so the suite still runs on a machine without the FPGA tools installed.
// =============================================================================

import { loadSpec } from '../tools/isa.js';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';

const have = (cmd) => {
  try { execFileSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }); return true; }
  catch { return false; }
};
if (!have('iverilog')) {
  console.log('skip  tests/immgen-check.mjs: iverilog not installed');
  process.exit(0);
}

const t = loadSpec().optype;
const u16 = (v) => (v >>> 0) & 0xffff;
const sext = (v, n) => (v & (1 << (n - 1))) ? v - (1 << n) : v;

// --- the reference, straight off the tables ---------------------------------
// This is the whole specification of the block.  `sel` is opcode[2:0]; `ir` is
// immreg, holding the last two bytes fetched.
const want = (ir, sel) => {
  switch (sel) {
    case 0: return sext(ir & 31, 5);                                  // imm5
    case 1: return t.immbit5.values[ir & 31];                         // immbit5
    case 2: case 3: return t.imm3.values[((ir & 3) << 1) | (sel & 1)]; // imm3
    case 4: return sext(ir & 1023, 10);                               // imm10
    case 5: return t.immask5.values[ir & 31];                         // immask5
  }
};

const vecs = [];
for (let sel = 0; sel <= 5; sel++)
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
process.exit(/FAIL/.test(out) ? 1 : 0);
