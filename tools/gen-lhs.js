#!/usr/bin/env node
// =============================================================================
// gen-lhs.js - the ALU's left-hand register, from isa/fructus.toml
// =============================================================================
//
//   node tools/gen-lhs.js > rtl/lhs.sv
//
// Chooses the register file port A address: a register the microcode names, or
// one of byte 1's two register fields, read from rtl/insn.sv where they stay put
// for the whole instruction.
//
// WHICH OPERAND IS THE LEFT-HAND SIDE is worked out here from each instruction's
// `semantics`, and WHERE IT SITS from tools/decode.js on real bytes - so the
// field table in the header is a measurement of the spec rather than a claim
// about it.  An instruction whose left-hand register is in neither field makes
// the generator fail, because the circuit below could not reach it.
// =============================================================================

import { loadSpec } from './isa.js';
import { buildDecoder, decode } from './decode.js';

const spec = loadSpec();
const dec = buildDecoder(spec);
const regs = spec.optype.reg;
const regIndex = (name) => {
  const target = regs.aliases?.[name] ?? name;
  return regs.names.indexOf(target);
};
const regName = (n) => {
  const alias = Object.entries(regs.aliases ?? {}).find(([, t]) => regs.names.indexOf(t) === n)?.[0];
  return alias ? `${alias} (${regs.names[n]})` : regs.names[n];
};

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
function lhsOf(insn, form) {
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

// --- where it sits, per opcode ------------------------------------------------
// Decode every byte 1 and see which field the operand follows.  A tied form
// (`add rd, rd, #imm5`) follows byte1[2:0] only; nothing may follow both.
const FIELD = { rd: { code: 8, bits: 'insn[10:8]', of: (b) => b & 7 },
                ra: { code: 9, bits: 'insn[13:11]', of: (b) => (b >> 3) & 7 } };
const COLUMN = { 0: 'rd', 1: 'rd', 5: 'rd', 2: 'ra', 3: 'ra', 4: 'ra', 6: 'ra', 7: 'ra' };

const opcodes = [];        // { op, who, field, pc } for multi-byte forms
const micro = new Map();   // register -> [who]
const note = (reg, who) => micro.set(reg, [...(micro.get(reg) ?? []), who]);

// Keyed by opcode AND form, because byte 1 can change the instruction: the
// unary operations share two opcodes and differ only in byte1[7:6].
const probe = new Map();
for (let op = 0; op < 256; op++)
  for (let b1 = 0; b1 < 256; b1++) {
    const e = decode(dec, [op, b1, 0], 0);
    if (!e) continue;
    const l = lhsOf(e.insn, e.form);
    if (!l) continue;
    const who = `${e.insn.mnemonic}/${e.form.name}`;
    if (l.kind === 'microcode') { if (b1 === 0) note(l.reg, e.insn.mnemonic); continue; }
    if (e.nbytes === 1) {
      // ret and jmp r5 ride port B; see rhs.sv
      if (b1 === 0 && l.kind !== 'pc') note(e.ops[l.operand], who);
      continue;
    }
    const key = `${op}/${who}`;
    if (!probe.has(key)) probe.set(key, { op, who, pc: l.kind === 'pc', ok: { rd: true, ra: true } });
    const p = probe.get(key);
    for (const f of Object.keys(p.ok)) if (e.ops[l.operand] !== FIELD[f].of(b1)) p.ok[f] = false;
  }
for (const p of probe.values()) {
  const fields = Object.keys(p.ok).filter((f) => p.ok[f]);
  if (fields.length !== 1)
    throw new Error(`0x${p.op.toString(16)} ${p.who}: its left-hand register is ${fields.length ? 'in both fields' : 'in neither register field'}`);
  opcodes.push({ op: p.op, who: p.who, field: fields[0], pc: p.pc });
}

// --- the header tables --------------------------------------------------------
const hex = (n) => `0x${n.toString(16).padStart(2, '0')}`;
// Words after `first`, continuing at `indent`, filled to 79 columns.
const wrap = (words, first, indent, width = 79) => {
  const lines = [];
  let cur = first, fresh = true;
  for (const w of words) {
    if (!fresh && cur.length + 1 + w.length > width) { lines.push(cur); cur = indent; fresh = true; }
    cur += (fresh ? '' : ' ') + w;
    fresh = false;
  }
  lines.push(cur);
  return lines.join('\n');
};
const byField = (f) => {
  const names = [...new Set(opcodes.filter((o) => o.field === f).map((o) => o.who.split('/')[0]))];
  return wrap(names, '//             ', '//             ');
};
const offColumn = opcodes.filter((o) => COLUMN[o.op & 7] !== o.field);
const offText = offColumn.length
  ? offColumn.map((o) => `//     ${hex(o.op)}  ${o.who}, column +${o.op & 7}, ${o.field} field${o.pc ? ' - a pc transfer, not an ALU operation' : ''}`).join('\n')
  : '//     (none)';
const microText = [...micro.entries()].sort(([a], [b]) => a - b)
  .map(([r, who]) => {
    const list = [...new Set(who)];
    const words = list.map((w, i) => (i < list.length - 1 ? `${w},` : w));
    return wrap(words, `//     ${regName(r).padEnd(10)}`, `//     ${' '.repeat(10)}`);
  })
  .join('\n');

process.stdout.write(`// =============================================================================
// lhs.sv - which register the ALU's left-hand side reads this cycle
// =============================================================================
//
// GENERATED by tools/gen-lhs.js from isa/fructus.toml.  Do not edit; edit the
// spec or the generator and run \`npm run rtl\`.
//
// The address for register file port A, from ONE four-bit microcode field:
//
//    0..7   the register src[2:0], named by the microcode
//    8      byte1[2:0], the rd field
//    9      byte1[5:3], the ra field
//   10..15  reserved: they decode as 8 and 9 alternately, by src[0]
//
// EVERY REGISTER OPERAND IN THE ISA IS IN ONE OF THREE PLACES: byte1[2:0],
// byte1[5:3], or {byte1[7:6], opcode[0]}.  The third is port B's, and
// rtl/rhs.sv takes it; the other two are this block's.  The only exceptions are
// the one-byte forms, whose operands are all pinned, and \`mov rd, #imm16\`, whose
// register is in the opcode and is never read.
//
// FOUND BY DECODING, every multi-byte form whose left-hand side is a register
// from the instruction:
//
//   rd field  ${FIELD.rd.bits}
${byField('rd')}
//   ra field  ${FIELD.ra.bits}
${byField('ra')}
//
// THE COLUMN NEARLY DECIDES IT - +0, +1 and +5 are rd, the rest ra - and the
// exceptions, computed rather than remembered, are:
//
${offText}
//
// So the choice is a microcode bit rather than a decode of opcode[2:0].  That
// is also the cheaper place for it on its own merits: a registered microcode
// line arrives at LUT level zero, which is the lesson rtl/immgen.sv's cimm
// measurement already paid for.
//
// THE REGISTERS THE MICROCODE NAMES are the one-byte forms' pinned left-hand
// sides and the stack pointer:
//
${microText}
//
// \`ret\` and \`jmp r5\` are not here: they take their target on port B, through
// rhs.sv's lr and r5 codes.  Port A could carry them just as well - nothing
// below cares - which would put every pc-from-register transfer on one port.
//
// NOTHING IS HELD.  rtl/insn.sv puts byte 1 at insn[15:8] from the cycle it
// arrives until the next dispatch, so the fields do not move when byte 2 is
// fetched, and the imm10 forms read ra in the same cycle as their immediate.
//
// This file once sat on a shifting immreg, where byte 1 moved up as byte 2 came
// in, and it needed a microcode line and a transparent latch - a flop and a
// bypass - to keep its choice across the shift.  MEASURED, that version against
// this one, on an iCE40 UP5K, yosys 0.52 -nobram + nextpnr-ice40 0.7, beside a
// real 8x16 register file whose other port is idle; logic cells and the median
// of five placement seeds:
//
//                                     file read -> flop    read + add -> flop
//     latch on immreg                     362   58.5 MHz        341   39.8 MHz
//     THIS FILE, on insn.sv               316   64.0            332   44.8
//
// So the fixed register gives back what holding the choice cost: 46 cells and
// a tenth of the clock on the read, an eighth through the add.
//
// An address straight out of a flop is faster still, and with insn.sv it needs
// no new mechanism: register this block's output from insn.sv's \`view\`, which
// shows byte 1 in the cycle it is on the bus.  rtl/insn.sv's header measures
// that placement against the others.
//
// Two traps in measuring this, both of which produced plausible numbers first.
// A parity of the outputs let yosys push the XOR through the read mux and read
// one parity bit per register; and a file read followed by a flop is exactly a
// synchronous block RAM, which yosys inferred - the part cannot do that here,
// see docs/fpga-toolchain.md.  So the harness shifts its result out bit by bit
// and synthesises with -nobram.
// =============================================================================

module lhs (
    input  logic [23:0] insn,    // the instruction, byte 0 low: rtl/insn.sv
    input  logic [3:0]  src,     // microcode: where the left-hand register comes from
    output logic [2:0]  regnum   // -> register file port A address
);

    // src[0] picks the field and src[2:0] is the register, so the field choice
    // costs no decode: codes 8 and 9 differ in exactly the bit that selects.
    assign regnum = src[3] ? (src[0] ? insn[13:11] : insn[10:8]) : src[2:0];

endmodule
`);
