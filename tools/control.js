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
  let pc = false, sp = false, pcNamed = null, walked = null;
  for (const stmt of (insn.semantics ?? '').split(';')) {
    const m = stmt.match(/^(.*?[^=!<>])=(?!=)(.*)$/);
    if (!m) continue;
    const [, left, right] = m;
    const all = (s) => [...s.matchAll(/R\[([a-z])\]/g)].map((x) => x[1]);
    const dest = left.trim().match(/^R\[([a-z])\]$/);
    const memw = /M(8|16)\[/.test(left);
    // A POINTER THE INSTRUCTION WALKS is the register it steps from the value
    // it was entered with: `sp = base - 4` for push, `r1 = base + 4` for stm.
    // That register is port A's, whichever it is - and it is the LAST thing
    // such an instruction writes, which is what defines `pop sp`.
    const step = stmt.match(/\b([a-z][a-z0-9]*)\s*=\s*base\s*[-+]\s*\d/);
    if (step && regIndex(step[1]) >= 0) { sp = true; walked = step[1]; }
    if (/\bpc\s*$/.test(left) && /^\s*R\[[a-z]\]\s*$/.test(right)) pc = true;
    // `pc = lr' names its register rather than taking it from a field, and it
    // is still a register the ADDRESS PATH reads - so it belongs on port A
    // with `jmp ra' and `call ra' rather than arriving as a right-hand side.
    // rtl/cpu.sv's address mux then has one source for all three.
    if (/\bpc\s*$/.test(left) && regIndex(right.trim()) >= 0) pcNamed = right.trim();
    if (!dest) all(left).forEach((r) => reads.add(r));
    if (!memw) all(right).forEach((r) => reads.add(r));
  }
  if (portB) reads.delete(portB);
  if (sp) return { kind: 'microcode', reg: regIndex(walked) };
  if (pcNamed) return { kind: 'microcode', reg: regIndex(pcNamed) };
  if (reads.size > 1)
    throw new Error(`${insn.mnemonic}/${form.name}: port A would need ${[...reads].join(' and ')}`);
  if (reads.size === 0) return null;
  return { kind: pc ? 'pc' : 'alu', operand: [...reads][0] };
}

// --- the fields port A reads, as functions of byte 1 ---------------------------
export const LHS_FIELD = { rd: { code: 8, bits: 'insn[10:8]', of: (b) => b & 7 },
                    ra: { code: 9, bits: 'insn[13:11]', of: (b) => (b >> 3) & 7 } };

// Port B's field read on port A, which push needs for its third register.  It
// is not in LHS_FIELD because nothing DECODES to it - no instruction's
// left-hand operand follows it, so tools/gen-predecode.js must not offer it as
// a candidate; only a microcode step names it.
export const LHS_PORTB = 10;

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
export const destWritesOf = (insn) => [...(insn.semantics ?? '').matchAll(/(?:^|;)\s*(R\[([a-z])\]|[a-z][a-z0-9]*)\s*=(?!=)/g)]
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
// Codes 2, 3 and 4 are in the register half but are not registers, and between
// them they have spent every code this field had left.  4 is the 16-bit
// immediate, straight off the bytes.  2 is a call's return address: rtl/cpu.sv's
// pc adder, read before its flop, with its addend forced to 1 so that the sum is
// pc + 2.  3 is the ADDRESS UNIT's sum, read the same way - which is how push,
// pop, stm and ldm write back the pointer they walked, through the ALU's
// pass-through, without a mux on the register file's write port.
export const RHS_REG   = { 0: 'r0', 1: 'r1', 5: 'r5', 6: 'sp (r6)', 7: 'lr (r7)' };
export const RHS_IMM16 = 4;
export const RHS_PCSUM = 2;
export const RHS_ADR   = 3;
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
  // A LOAD ASKS THE ALU FOR NOTHING BUT THE PASS-THROUGH.  Its address is the
  // address unit's add, not this one's; and the bytes that come back are
  // assembled where they land, because each SHIFTS INTO the right-hand operand
  // flop - two of them make a little-endian word in place, one zero extends.
  // So what reaches the register file is the operand itself, which is the same
  // pass-through the short movs and a call's return address already use.
  [/^R\[d\] = M(8|16)\[R\[a\] \+ (off|R\[b\])\]$/,          'rhs',   'the bytes, assembled by the capture'],
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
  // A call's return address is not computed by the ALU: rtl/rhs.sv hands it the
  // pc adder's sum and the pass-through carries it to the register file, which
  // is what lets the write port be wired straight from the ALU.
  [/^lr = pc; pc = /,                                      'rhs',   'the return address'],
  // THE BLOCK MOVES ASK THE ALU FOR THE PASS-THROUGH AND NOTHING ELSE, like a
  // load.  Their addresses are the address unit's, walked a byte at a time;
  // what reaches the register file is the right-hand operand flop, carrying
  // either the words a pop assembled or the stepped pointer the address unit
  // handed to rtl/rhs.sv.  One operation covers every register they write.
  [/^base = [a-z][a-z0-9]*; M16\[base/,                     'rhs',   'the stepped pointer'],
  [/^base = [a-z][a-z0-9]*; R\[a\] = M16\[base/,            'rhs',   'the words, then the pointer'],
  // THE EXCEPTIONS ASK FOR THE PASS-THROUGH AND NOTHING ELSE, like a load.
  // Every value brk and rti move is already a whole 16-bit word - the pc, or
  // one of the three shadows - so what the register file needs is a ROUTE from
  // rtl/cpu.sv's right-hand operand flop, not an operation.  That flop's input
  // mux had a spare arm (`dcap` 3) and taking it is the whole datapath cost.
  //
  // It has to be the pass-through and not a don't-care: these steps write sp
  // and lr through the ordinary write port, so whatever the ALU is doing IS
  // what lands in the register file.
  [/^shadow_lr = lr;/,                                      'rhs',   'the shadows, through the flop'],
  [/^pc = lr; lr = shadow_lr;/,                             'rhs',   'the shadows, through the flop'],
];
export const ALU_ELSEWHERE = [
  [/^$/,                                                'nothing'],
  [/^halted = 1$/,                                      'no datapath'],
  // A store writes no register, so nothing it does passes through the ALU: the
  // address unit adds the address and the register file drives the bus direct.
  [/^M(8|16)\[R\[a\] \+ (off|R\[b\])\] = R\[s\]$/,       'the address unit and the bus'],
  [/^pc = (lr|R\[a\]|target|pc \+ target)$/,             'the pc and its own adder'],
  [/^if \(/,                                            'rtl/compare.sv'],
  // sei and cli move nothing at all: there is no operand, no result and no
  // register write, only a flag that lives in rtl/ucode.sv.
  [/^ie = [01]$/,                                       'no datapath'],
];
export const ALU_LATER = new Set([]);

// =============================================================================
// rtl/cond.sv - which source each branch takes its condition from
// =============================================================================
// The source field's codes, by the semantics of the branch that uses them.  The
// fixed eq and ne serve exactly the mask branches, which is what lets
// rtl/compare.sv take its mode from the field's bit 1.
// =============================================================================
// rtl/cpu.sv's program counter
// =============================================================================

// Where the next address comes from.  Every one of these is prepared in the
// cycle BEFORE it is needed - the sequential address by the incrementer, the
// relative target by the second adder, the wide target by the instruction
// bytes, and a register by the operand flop - so the cycle that presents an
// address only chooses between them.
export const PC_SRC = {
  0: 'the next byte: pc + 1',
  1: 'a relative target: pc + the displacement byte',
  2: 'a wide target: the instruction bytes',
  3: 'a register, through the right-hand operand',
};

// Which source an instruction wants, from its semantics.  An instruction that
// never writes the pc takes 0 and the microcode never loads it.
export const PC_RULES = [
  [/\bpc = pc \+ off\b/,      1],
  [/\bpc = pc \+ target\b/,   1],
  [/\bpc = target\b/,         2],
  [/\bpc = (lr|R\[a\])/,      3],
];

// An instruction whose semantics writes lr before the pc is a call: its
// right-hand side is the pc adder's sum, and the ALU's pass-through carries
// that to the register file like any other result.  tools/gen-predecode.js
// selects RHS_PCSUM from this.
export const WRITES_LR = /^lr = pc;/;

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
