#!/usr/bin/env node
// =============================================================================
// gen-lhs.js - the ALU's left-hand register, from isa/fructus.toml
// =============================================================================
//
//   node tools/gen-lhs.js > rtl/lhs.sv
//
// Chooses the register file port A address: a register the microcode names, or
// one of byte 1's two register fields.  A second microcode line, `latch`, holds
// that choice across the fetch of a third byte, which shifts byte 1 out of the
// place the fields are read from.
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
const FIELD = { rd: { code: 8, bits: 'ir[2:0]', of: (b) => b & 7 },
                ra: { code: 9, bits: 'ir[5:3]', of: (b) => (b >> 3) & 7 } };
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
// and ONE microcode line, \`latch\`, that says whether that choice is made now or
// the previous one kept.
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
// WHY THE LATCH.  immreg is a shift register, so fetching a third byte moves
// byte 1 up into the high half, and the fields are no longer at ir[5:3] and
// ir[2:0].  The imm10 forms need their register in the SAME cycle as the
// immediate, which is after that shift.  So the microcode opens the latch in
// the step where byte 1 is still low, and closes it for the step after byte 2
// arrives; the register NUMBER is held, and the file delivers the register's
// current value in whichever cycle reads it.  Nothing writes that register
// between the two cycles, so the number and the value are equivalent - for
// three flops rather than sixteen.
//
// IT IS TRANSPARENT WHILE OPEN, which is what makes it a latch rather than a
// register.  A two-byte instruction reads port A in the same cycle it chooses
// the register, so a plain clock-enabled flop would deliver the choice a cycle
// late.  On an iCE40 it is built as a flop and a bypass mux, not a latch
// primitive: level-sensitive storage is something nextpnr cannot time.
//
// \`held\` has no reset, deliberately.  The microcode opens the latch in the
// first step of every instruction that reads port A, so the flops are never
// read before they are written; an x in simulation says a step forgot to.
//
// MEASURED on an iCE40 UP5K, yosys 0.52 -nobram + nextpnr-ice40 0.7, beside a
// real 8x16 register file whose other port is idle, so port A is the only
// logic path.  Logic cells, and the median of three placement seeds:
//
//                                         file read -> flop    read + add -> flop
//     no latch: broken for imm10              295   64.6 MHz        329   43.4 MHz
//     flop + bypass - THIS FILE               349   57.6            348   38.7
//     "hold" as a src code, no latch line     351   57.9            349   40.6
//     no latch, a third field ir[13:11]       356   59.3            352   39.1
//     flop only, no bypass                    295   76.3            335   49.1
//
// THE THREE THAT WORK COST THE SAME, within the few MHz the seeds wander by:
// 55 to 60 cells on the read and about 20 through the add, and a tenth of the
// clock either way, over the broken baseline.  Holding
// the choice is no dearer than reaching for byte 1 where the shift left it,
// and it does not have to be taught to each consumer of a register field.
//
// THE LAST ROW IS THE ONE WORTH HAVING: an address straight out of a flop, a
// third faster than the bypass on the read and a quarter faster through the
// add.  It is not a drop-in - it presents the choice one cycle after the latch
// opens - so it needs the choice made in the cycle byte 1 is ON THE BUS rather
// than in immreg: the fields read off the incoming byte, the microcode's
// selection valid a cycle earlier.  Whether the microcode can be there in time
// is a question about the ROM, not about this block.
//
// Two traps in measuring this, both of which produced plausible numbers first.
// A parity of the outputs let yosys push the XOR through the read mux and read
// one parity bit per register; and a file read followed by a flop is exactly a
// synchronous block RAM, which yosys inferred - the part cannot do that here,
// see docs/fpga-toolchain.md.  So the harness shifts its result out bit by bit
// and synthesises with -nobram.
// =============================================================================

module lhs (
    input  logic        clk,
    input  logic [15:0] ir,      // immreg: the last two instruction bytes
    input  logic [3:0]  src,     // microcode: where the left-hand register comes from
    input  logic        latch,   // microcode: choose now, or keep the last choice
    output logic [2:0]  regnum   // -> register file port A address
);

    // src[0] picks the field and src[2:0] is the register, so the field choice
    // costs no decode: codes 8 and 9 differ in exactly the bit that selects.
    wire [2:0] pick = src[3] ? (src[0] ? ir[5:3] : ir[2:0]) : src[2:0];

    logic [2:0] held;
    always_ff @(posedge clk) if (latch) held <= pick;

    assign regnum = latch ? pick : held;

endmodule
`);
