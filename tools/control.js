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
  { code: 12, name: 'unary', does: 'rtl/unary.sv on lhs, selected by rhs[2:1]' },
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
  [/^R\[d\] = (sxt8|clz|bitrev|popcount)\(R\[a\]\)$/,       'unary'],
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
