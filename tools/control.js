// =============================================================================
// control.js - what each instruction asks of the datapath, and the codes for it
// =============================================================================
//
// The rules that turn an instruction's `semantics` into control, and the codes
// the RTL uses to carry that control, in one place.  Each rtl generator that
// used to hold one of these imports it from here, and tools/gen-predecode.js
// imports all of them - so the predecoded table and the blocks it drives cannot
// disagree about what a code means or which instruction needs it.
//
// Nothing here writes anything; it only reads the spec.
// =============================================================================

import { loadSpec } from './isa.js';

const spec = loadSpec();
const regs = spec.optype.reg;
const regIndex = (name) => regs.names.indexOf(regs.aliases?.[name] ?? name);

// =============================================================================
// rtl/lhs.sv
// =============================================================================

// --- which register the ALU reads on its left --------------------------------
// Every `R[x]` the semantics READS, less three kinds that are not port A:
//
//   the destination        R[x] = ...           written, not read
//   memory write data      M16[...] = R[x]      goes to the bus, not the ALU
//   port B                 the operand whose low bit is opcode[0]; rhs.sv
//                          reaches it, and br's registers are deliberately
//                          swapped so that it is `a` there and `b` here
//
// What is left is at most one register.  `pc = R[x]` is kept apart: it is a
// transfer to the pc rather than an ALU operation, but in a multi-byte form it
// still needs port A, because port B cannot address byte1[2:0].
//
// push and pop read sp, which the microcode names; they are recognised by the
// `sp = sp +/- n` step rather than listed.
export function lhsOf(insn, form) {
  // A one-byte form has no fields at all; its pinned `b` is port B, which is
  // how tools/gen-rhs.js reads it too.
  const portB = Object.values(form.fields ?? {}).find((v) => /^[a-z]:reg\[0\]$/.test(v))?.[0]
             ?? ('b' in (form.fix ?? {}) ? 'b' : undefined);
  const reads = new Set();
  let pc = false, sp = false;
  for (const stmt of (insn.semantics ?? '').split(';')) {
    const m = stmt.match(/^(.*?[^=!<>])=(?!=)(.*)$/);
    if (!m) continue;
    const [, left, right] = m;
    const all = (s) => [...s.matchAll(/R\[([a-z])\]/g)].map((x) => x[1]);
    const dest = left.trim().match(/^R\[([a-z])\]$/);
    const memw = /M(8|16)\[/.test(left);
    if (/\bsp\s*=\s*sp\s*[-+]/.test(stmt)) sp = true;
    if (/\bpc\s*$/.test(left) && /^\s*R\[[a-z]\]\s*$/.test(right)) pc = true;
    if (!dest) all(left).forEach((r) => reads.add(r));
    if (!memw) all(right).forEach((r) => reads.add(r));
  }
  if (portB) reads.delete(portB);
  if (sp) return { kind: 'microcode', reg: regIndex('sp') };
  if (reads.size > 1)
    throw new Error(`${insn.mnemonic}/${form.name}: port A would need ${[...reads].join(' and ')}`);
  if (reads.size === 0) return null;
  return { kind: pc ? 'pc' : 'alu', operand: [...reads][0] };
}

// --- the fields port A reads, as functions of byte 1 ---------------------------
export const LHS_FIELD = { rd: { code: 8, bits: 'insn[10:8]', of: (b) => b & 7 },
                    ra: { code: 9, bits: 'insn[13:11]', of: (b) => (b >> 3) & 7 } };

// =============================================================================
// rtl/dest.sv
// =============================================================================

// --- the four fields, as functions of the opcode and byte 1 ------------------
// Codes 8 and 9 are the same fields under the same codes as rtl/lhs.sv, so a
// microcode step that reads a register and writes it back names it once.
export const DEST_FIELD = {
  8:  { name: 'rd field',     bits: 'insn[10:8]',             of: (op, b1) => b1 & 7 },
  9:  { name: 'ra field',     bits: 'insn[13:11]',            of: (op, b1) => (b1 >> 3) & 7 },
  10: { name: 'opcode field', bits: 'insn[2:0]',              of: (op) => op & 7 },
  11: { name: 'port B field', bits: '{insn[15:14], insn[0]}', of: (op, b1) => ((b1 >> 6) << 1) | (op & 1) },
};

// --- what each form writes --------------------------------------------------
// A statement beginning `R[x] =` writes operand x; one beginning `sp =` or
// `lr =` writes a register the microcode names.  `pc =` is not the register
// file's.
export const destWritesOf = (insn) => [...(insn.semantics ?? '').matchAll(/(?:^|;)\s*(R\[([a-z])\]|[a-z]+)\s*=(?!=)/g)]
  .map((m) => m[2] ? { operand: m[2] } : { named: m[1] })
  .filter((w) => w.operand || regs.names.includes(regs.aliases?.[w.named] ?? w.named));

// =============================================================================
// rtl/rhs.sv
// =============================================================================

// --- the sixteen codes -------------------------------------------------------
// src[3] = 0 is a register and src[2:0] IS its number, so the low half is pure
// wiring.  src[3] = 1 reads src[2:0] as a 3-bit SIGNED constant, which is why
// -2 and -1 are codes 14 and 15 rather than in numeric order: 110 and 111 are
// -2 and -1.  The three patterns left over - 011, 100, 101, which would have
// been 3, -4 and -3 - are the modes.
//
// Code 4 is in the register half but is not a register: it is the 16-bit
// immediate, straight off the bytes.
export const RHS_REG   = { 0: 'r0', 1: 'r1', 5: 'r5', 6: 'sp (r6)', 7: 'lr (r7)' };
export const RHS_IMM16 = 4;
export const RHS_KON   = { 0: 0, 1: 1, 2: 2, 6: -2, 7: -1 };
export const RHS_MODE  = { 3: 'immgen, normal', 4: 'immgen, as condimm5', 5: 'port B, from the bytes' };

// =============================================================================
// rtl/alu.sv
// =============================================================================

// --- the operations -----------------------------------------------------------
export const ALU_OPS = [
  { code: 0,  name: 'add',   does: 'lhs + rhs' },
  { code: 1,  name: 'rsb',   does: 'rhs - lhs' },
  { code: 2,  name: 'iseq',  does: 'lhs == rhs, as 0 or 1' },
  { code: 3,  name: 'isset', does: '(lhs & rhs) != 0, as 0 or 1' },
  { code: 4,  name: 'xor',   does: 'lhs ^ rhs' },
  { code: 5,  name: 'or',    does: 'lhs | rhs' },
  { code: 6,  name: 'and',   does: 'lhs & rhs' },
  { code: 7,  name: 'rhs',   does: 'rhs' },
  { code: 8,  name: 'shl',   does: 'lhs << rhs[3:0]' },
  { code: 9,  name: 'lsr',   does: 'lhs >> rhs[3:0]' },
  { code: 11, name: 'asr',   does: 'lhs >>> rhs[3:0]' },
  { code: 12, name: 'unary', does: "rtl/unary.sv's fast pair on lhs: sxt8 or bitrev" },
  { code: 13, name: 'slow',  does: "rtl/unary.sv's slow pair, registered a cycle earlier: clz or popcount" },
];

// --- which operation each instruction needs, from its semantics ---------------
export const ALU_RULES = [
  [/^R\[d\] = M(8|16)\[R\[a\] \+ off\]$/,                  'add',   'the address'],
  [/^M(8|16)\[R\[a\] \+ off\] = R\[s\]$/,                  'add',   'the address'],
  [/^R\[d\] = imm$/,                                      'rhs'],
  [/^R\[d\] = R\[a\] \+ (R\[b\]|imm)$/,                    'add'],
  [/^R\[d\] = (R\[b\]|imm) - R\[a\]$/,                     'rsb'],
  [/^R\[d\] = R\[a\] \^ (R\[b\]|imm)$/,                    'xor'],
  [/^R\[d\] = R\[a\] \| (R\[b\]|imm)$/,                    'or'],
  [/^R\[d\] = R\[a\] & (R\[b\]|imm)$/,                     'and'],
  [/^R\[d\] = (shl|asr|lsr)\(R\[a\], (R\[b\]|imm) & 15\)$/, (m) => m[1]],
  // an operation that declares extra cycles is one whose result is registered
  [/^R\[d\] = (sxt8|clz|bitrev|popcount)\(R\[a\]\)$/,       (m, insn) => (insn.extra_cycles ? 'slow' : 'unary')],
  [/^R\[d\] = R\[a\] == (R\[b\]|\(imm & 0xffff\))$/,        'iseq'],
  [/^R\[d\] = \(R\[a\] & mask\) != 0$/,                    'isset'],
  [/^sp = sp - 2; M16\[sp\] = R\[a\]/,                      'add',   'sp and #-2, per register'],
  [/^R\[a\] = M16\[sp\]; sp = sp \+ 2/,                     'add',   'sp and #2, per register'],
];
export const ALU_ELSEWHERE = [
  [/^$/,                                                'nothing'],
  [/^halted = 1$/,                                      'no datapath'],
  [/^(lr = pc; )?pc = (lr|R\[a\]|target|pc \+ target)$/, 'the pc and its own adder'],
  [/^if \(/,                                            'rtl/compare.sv'],
];
export const ALU_LATER = new Set(['br8', 'push8', 'pop8']);

// =============================================================================
// rtl/cond.sv - which source each branch takes its condition from
// =============================================================================
// The source field's codes, by the semantics of the branch that uses them.  The
// fixed eq and ne serve exactly the mask branches, which is what lets
// rtl/compare.sv take its mode from the field's bit 1.
export const COND_SRC = [
  [/^if \(test\(cond, R\[a\], R\[b\], 16\)\) /,    0, 'the cond3 field'],
  [/^if \(test\(k\.cond, R\[a\], k\.imm, 16\)\) /, 1, 'the condimm5 table'],
  [/^if \(\(R\[a\] & mask\) == 0\) /,              2, 'eq'],
  [/^if \(\(R\[a\] & mask\) != 0\) /,              3, 'ne'],
];

// =============================================================================
// rtl/unary.sv - which unary operation sits where
// =============================================================================
// A unary form is a two-byte encoding whose byte 1 is two literal bits followed
// by \`aaaddd\`.  {byte1[7:6], opcode[0]} is an imm3 index; rtl/unary.sv sees the
// imm3 VALUE on the rhs bus, and an operation that declares extra cycles has its
// result registered.  So the fast operations must share an opcode, the slow
// ones must share the other, and one bit of the value has to tell each pair's
// two operations apart - the same bit for both, since it is one wire.
export function unaryLayout() {
  const imm3 = spec.optype.imm3.values;
  const ops = [];
  for (const insn of spec.insn)
    for (const form of insn.form ?? []) {
      const bits = (form.encoding ?? '').replace(/[\s_]/g, '');
      const m = /^([01]{8})([01]{2})a{3}d{3}$/.exec(bits);
      if (!m) continue;
      const op = parseInt(m[1], 2), index = (parseInt(m[2], 2) << 1) | (op & 1);
      const value = imm3[index];
      ops.push({ mnemonic: insn.mnemonic, op, index, value,
                 code: ((value & 0xffff) >> 1) & 3, slow: (insn.extra_cycles ?? 0) > 0 });
    }
  if (!ops.length) throw new Error('no unary forms found in the spec');
  if (new Set(ops.map((o) => o.code)).size !== ops.length) throw new Error('two unary operations read the same rhs[2:1]');
  const groups = {};
  for (const [name, slow] of [['fast', false], ['slow', true]]) {
    const g = ops.filter((o) => o.slow === slow);
    if (!g.length) continue;
    if (new Set(g.map((o) => o.op)).size !== 1) throw new Error(`the ${name} unary operations are not on one opcode`);
    if (g.length > 2) throw new Error(`more than two ${name} unary operations`);
    groups[name] = g;
  }
  if (groups.fast && groups.slow && groups.fast[0].op === groups.slow[0].op)
    throw new Error('the fast and slow unary operations share an opcode');
  const bitOf = (g) => {
    if (g.length < 2) return null;
    const d = g[0].code ^ g[1].code;
    if (d !== 1 && d !== 2) throw new Error(`${g[0].mnemonic} and ${g[1].mnemonic} differ in both bits of rhs[2:1]`);
    return d === 1 ? 1 : 2;
  };
  const bits = [...new Set(Object.values(groups).map(bitOf).filter((b) => b !== null))];
  if (bits.length > 1) throw new Error('the two unary pairs are told apart by different bits of rhs');
  const selBit = bits[0] ?? 1;
  const level = (o) => ((o.code >> (selBit - 1)) & 1);
  const pair = (g) => [0, 1].map((l) => g?.find((o) => level(o) === l)?.mnemonic ?? null);
  return { ops, selBit, level, fast: pair(groups.fast), slow: pair(groups.slow),
           fastOp: groups.fast?.[0].op, slowOp: groups.slow?.[0].op };
}
