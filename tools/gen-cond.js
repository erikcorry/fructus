#!/usr/bin/env node
// =============================================================================
// gen-cond.js - the condition a comparison tests, from isa/fructus.toml
// =============================================================================
//
//   node tools/gen-cond.js > rtl/cond.sv
//
// Chooses the condition rtl/compare.sv evaluates: the cond3 field of a
// two-register branch, the condimm5 table of a packed one, or a fixed eq or ne
// for the mask branches.  The compare unit takes it as a cond3 index and a
// negate bit, and a mode bit that is this block's source field's bit 1.
//
// THE PACKED TABLE IS REWRITTEN HERE, not copied.  Its entries are spelled the
// way a programmer writes the test - `br lt, ra, #4` means R[a] < 4 - while the
// compare unit tests the flags of rhs - lhs, which for this form is imm - R[a].
// Each entry is mirrored to that operand order and then expressed as a cond3
// index and a negate bit, and every one is checked against tools/sim.js's
// `test` for all 65536 register values before anything is emitted.
// =============================================================================

import { loadSpec } from './isa.js';
import { buildDecoder, decode } from './decode.js';
import { test } from './sim.js';

const spec = loadSpec();
const NAMES = spec.optype.cond3.names;
const idx = (n) => {
  const i = NAMES.indexOf(n);
  if (i < 0) throw new Error(`cond3 has no ${n}`);
  return i;
};

// --- the compare unit's reading of (cond3 index, negate) ----------------------
// On the flags of x - y, where x is rhs and y is lhs.  This is rtl/compare.sv's
// formula, restated; tests/rtl-check.mjs checks the circuit itself.
const STRUCT = ['lt', 'lo', 'le', 'ls', 'eq', 'ne', 'vs', 'vc'];
if (STRUCT.some((n, i) => NAMES[i] !== n))
  throw new Error(`cond3 is ${NAMES.join(' ')}; rtl/compare.sv's condition logic assumes ${STRUCT.join(' ')}`);
const hw = (c, neg, x, y) => {
  x &= 0xffff; y &= 0xffff;
  const r = (x - y) & 0xffff;
  const z = r === 0, n = (r & 0x8000) !== 0, carry = x >= y;
  const v = ((x ^ y) & (x ^ r) & 0x8000) !== 0;
  const ord = (c & 1) ? !carry : n !== v;
  const base = (c & 4) ? ((c & 2) ? v : z) : (ord || ((c & 2) !== 0 && z));
  const inv = (c & 4) !== 0 && (c & 1) !== 0;
  return (base !== inv) !== (neg !== 0);
};

// --- the two-register branch: cond3 as it stands -----------------------------
// Port B carries `a`, so rhs - lhs is R[a] - R[b] and no mirror is needed.  Its
// field must be byte1[2:0], which is insn[10:8].
{
  const dec = buildDecoder(spec);
  let seen = 0;
  for (let op = 0; op < 256; op++) {
    const d = decode(dec, [op, 0, 0], 0);
    if (!d || !/^if \(test\(cond, R\[a\], R\[b\], 16\)\)/.test(d.insn.semantics ?? '')) continue;
    for (let b1 = 0; b1 < 256; b1++) {
      const e = decode(dec, [op, b1, 0], 0);
      const got = typeof e.ops.cond === 'string' ? e.ops.cond : NAMES[e.ops.cond];
      if (got !== NAMES[b1 & 7])
        throw new Error(`0x${op.toString(16)} byte1=${b1}: condition ${got} is not byte1[2:0]`);
    }
    seen++;
  }
  if (!seen) throw new Error('no two-register 16-bit branch found');
  const vals = [0, 1, 2, 0x7ffe, 0x7fff, 0x8000, 0x8001, 0xfffe, 0xffff, 0x00ff, 0x0100];
  for (let c = 0; c < 8; c++)
    for (const x of vals) for (const y of vals)
      if (hw(c, 0, x, y) !== test(NAMES[c], x, y, 16))
        throw new Error(`cond3 ${NAMES[c]} on ${x} - ${y} disagrees with the simulator`);
}

// --- the packed table: mirrored, then negated where cond3 cannot say it ------
const MIRROR = { eq: 'eq', ne: 'ne', lt: 'gt', le: 'ge', gt: 'lt', ge: 'le',
                 lo: 'hi', ls: 'hs', hi: 'lo', hs: 'ls' };
const EXPRESS = { lt: ['lt', 0], le: ['le', 0], lo: ['lo', 0], ls: ['ls', 0], eq: ['eq', 0], ne: ['ne', 0],
                  gt: ['le', 1], ge: ['lt', 1], hi: ['ls', 1], hs: ['lo', 1] };
const table = spec.optype.condimm5.values.map(([C, k], i) => {
  if (!(C in MIRROR)) throw new Error(`condimm5[${i}]: ${C} has no mirror; overflow is not symmetric`);
  const [name, neg] = EXPRESS[MIRROR[C]];
  const c = idx(name);
  for (let x = 0; x < 65536; x++)
    if (hw(c, neg, k, x) !== test(C, x, k, 16))
      throw new Error(`condimm5[${i}] ${C} #${k}: ${neg ? 'not ' : ''}${name} on imm - R[a] is wrong at R[a] = ${x}`);
  return { i, C, k, name, neg, c };
});
if (idx('ne') !== (idx('eq') | 1)) throw new Error('eq and ne must differ in bit 0 only');

const used = [...new Set(table.map((e) => `${e.neg ? 'not ' : ''}${e.name}`))];
const rows = table.map((e) =>
  `//     ${String(e.i).padStart(2)}  ${`${e.C} #${e.k}`.padEnd(12)} ${e.neg ? 'not ' : '    '}${e.name}`).join('\n');
const cases = table.map((e) =>
  `        5'd${e.i}: tab = 4'b${e.neg}_${e.c.toString(2).padStart(3, '0')};    // ${e.C} #${e.k}`).join('\n');

process.stdout.write(`// =============================================================================
// cond.sv - the condition a comparison tests
// =============================================================================
//
// GENERATED by tools/gen-cond.js from isa/fructus.toml.  Do not edit; edit the
// spec or the generator and run \`npm run rtl\`.
//
// A cond3 index, a negate bit and a mode for rtl/compare.sv, from ONE two-bit
// microcode field:
//
//     0  the cond3 field, insn[10:8]      br cond, ra, rb
//     1  the condimm5 table, insn[15:11]  br cond, ra, #imm
//     2  eq                               brclr
//     3  ne                               brset
//
// The fixed eq and ne serve exactly the two mask branches, so bit 1 of the
// field is also the compare unit's mode - \`mask\`, test lhs & rhs rather than
// subtract - and the mode costs no microcode bit.
//
// THE COMPARE UNIT TESTS THE FLAGS OF rhs - lhs.  For the two-register branch
// that is R[a] - R[b], because port B carries a, so the cond3 field goes
// through as it stands.  For the packed branch it is imm - R[a], so every table
// entry has to be turned round, and TURNING IT ROUND IS NOT ENOUGH ON ITS OWN.
//
// \`R[a] >= k\` mirrors to \`k <= R[a]\`, which is le - fine.  But \`R[a] < k\`
// mirrors to \`k > R[a]\`, and cond3 has no gt: it spells gt by exchanging the
// two registers, and a register cannot be exchanged with a constant.  So the
// compare unit takes a NEGATE bit as well, and \`k > R[a]\` is
// \`not (k <= R[a])\`.  It is one XOR on a one-bit result.  (isa/fructus.toml
// says cond3's operand-order bit covers this; for the packed form it does not.)
//
// Every entry, as the programmer writes it and as the compare unit tests it -
// each checked against tools/sim.js for all 65536 values of R[a]:
//
${rows}
//
// The whole table needs only ${used.join(', ')}.
// =============================================================================

module cond (
    input  logic [23:0] insn,    // the instruction, byte 0 low: rtl/insn.sv
    input  logic [1:0]  src,     // microcode: where the condition comes from
    output logic [2:0]  code,    // -> compare's cond: a cond3 index.  Not
                                 // \`cond\`: a port named after its module is
                                 // an error to verilator
    output logic        neg,     // -> compare: invert the answer
    output logic        mask     // -> compare: the mask branches' mode
);

    wire [4:0] k = insn[15:11];
    logic [3:0] tab;             // {neg, cond}
    always_comb case (k)
${cases}
    endcase

    wire [3:0] field = {1'b0, insn[10:8]};
    wire [3:0] fixed = {1'b0, 3'd${idx('eq')} | {2'b00, src[0]}};     // eq, ne

    assign {neg, code} = src[1] ? fixed : (src[0] ? tab : field);
    assign mask        = src[1];

endmodule
`);
