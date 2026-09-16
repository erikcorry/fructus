#!/usr/bin/env node
// =============================================================================
// gen-predecode.js - control that belongs to the whole instruction
// =============================================================================
//
//   node tools/gen-predecode.js > rtl/predecode.sv
//
// A table over the first byte, loaded into flops in the dispatch cycle, giving
// the selects that are properties of an instruction rather than of one step of
// it: the ALU operation and the lhs, rhs, dest and condition sources.  The
// microcode ROM keeps sequencing and enables.
//
// Every value comes from tools/control.js - the same rules the blocks it drives
// were generated from - applied to every opcode through tools/decode.js.  An
// opcode whose instructions would need different selects for different byte-1
// values makes the generator fail, because one opcode gets one row.
// =============================================================================

import { loadSpec } from './isa.js';
import { buildDecoder, decode } from './decode.js';
import { lhsOf, LHS_FIELD, DEST_FIELD, destWritesOf,
         ALU_OPS, ALU_RULES, ALU_ELSEWHERE, ALU_LATER,
         RHS_IMM16, RHS_KON, RHS_MODE, COND_SRC, PC_RULES } from './control.js';

const spec = loadSpec();
const dec = buildDecoder(spec);
const regs = spec.optype.reg;
const regIndex = (name) => regs.names.indexOf(regs.aliases?.[name] ?? name);
const X = null;

// --- one field at a time -------------------------------------------------------
const aluCode = (insn) => {
  if (ALU_LATER.has(insn.mnemonic)) return X;
  const sem = insn.semantics ?? '';
  if (ALU_ELSEWHERE.some(([re]) => re.test(sem))) return X;
  const rule = ALU_RULES.find(([re]) => re.test(sem));
  if (!rule) throw new Error(`${insn.mnemonic}: no ALU operation matches "${sem}"`);
  const name = typeof rule[1] === 'function' ? rule[1](sem.match(rule[0]), insn) : rule[1];
  return ALU_OPS.find((o) => o.name === name).code;
};

const modeCode = (label) => 8 + Number(Object.keys(RHS_MODE).find((k) => RHS_MODE[k] === label));
const konCode = (v) => {
  const k = Object.keys(RHS_KON).find((c) => RHS_KON[c] === v);
  if (k === undefined) throw new Error(`rhs.sv has no constant ${v}`);
  return 8 + Number(k);
};
const rhsCode = (d) => {
  const { insn, form } = d, sem = insn.semantics ?? '', fix = form.fix ?? {};
  if (ALU_LATER.has(insn.mnemonic)) return X;
  if (d.nbytes === 1) {
    if ('imm' in fix) return konCode(fix.imm);
    if ('off' in fix) return konCode(fix.off);
    if ('b' in fix) return fix.b;
    if (/^pc = lr$/.test(sem)) return regIndex('lr');
    if (/^pc = R\[a\]$/.test(sem) && 'a' in fix) return fix.a;
    return X;
  }
  // push and pop move sp first; their later steps name other selects themselves
  if (/\bsp = sp - 2\b/.test(sem)) return konCode(-2);
  if (/\bsp = sp \+ 2\b/.test(sem)) return konCode(2);
  if (Object.values(form.fields ?? {}).some((v) => /^[a-z]:reg\[0\]$/.test(v))) return modeCode('port B, from the bytes');
  if ((insn.operands ?? []).some((o) => o.type === 'condimm5')) return modeCode('immgen, as condimm5');
  if (/^R\[[a-z]\] = imm$/.test(sem) && d.nbytes === 3) return RHS_IMM16;
  // an immediate immgen reads: imm, a mask, or a displacement into memory - a
  // branch's `off` is the pc's business, not the ALU's
  const names = new Set((insn.operands ?? []).map((o) => o.name));
  if (names.has('imm') || names.has('mask') || (names.has('off') && /M(8|16)\[/.test(sem)))
    return modeCode('immgen, normal');
  if (/^R\[d\] = \w+\(R\[a\]\)$/.test(sem)) return modeCode('immgen, normal');     // unary: the selector rides the imm3 value
  return X;
};

// Which field an operand follows, over every byte 1 this opcode decodes with.
const follows = (op, form, operand, fields) => {
  const ok = Object.fromEntries(Object.keys(fields).map((k) => [k, true]));
  for (let b1 = 0; b1 < 256; b1++) {
    const e = decode(dec, [op, b1, 0], 0);
    if (!e || e.form !== form) continue;
    for (const k of Object.keys(fields)) if (e.ops[operand] !== fields[k].of(op, b1)) ok[k] = false;
  }
  const hit = Object.keys(ok).filter((k) => ok[k]);
  if (hit.length !== 1) throw new Error(`0x${op.toString(16)}: operand ${operand} follows ${hit.length ? 'several' : 'no'} fields`);
  return hit[0];
};
const lhsFields = Object.fromEntries(Object.values(LHS_FIELD).map((f) => [f.code, { of: (op, b1) => f.of(b1) }]));

const lhsCode = (d, op) => {
  const l = lhsOf(d.insn, d.form);
  if (!l) return X;
  if (l.kind === 'microcode') return l.reg;
  if (d.nbytes === 1) return l.kind === 'pc' ? X : d.ops[l.operand];
  return Number(follows(op, d.form, l.operand, lhsFields));
};

// The FIRST register the instruction writes; a later step that writes another
// names it from the microcode.
const destCode = (d, op) => {
  const w = destWritesOf(d.insn)[0];
  if (!w) return X;
  if (w.named) return regIndex(w.named);
  if (d.nbytes === 1) return d.ops[w.operand];
  return Number(follows(op, d.form, w.operand, DEST_FIELD));
};

// Where this instruction's next address comes from; 0 - the sequential one -
// for everything that does not write the pc.  Every relative target is one
// byte of displacement now, so there is nothing to tell apart.
const pcCode = (d) => {
  const sem = d.insn.semantics ?? '';
  const hit = PC_RULES.find(([re]) => re.test(sem));
  if (!hit) return 0;
  return hit[1];
};

const condCode = (insn) => {
  if (insn.mnemonic === 'br8') return X;
  const hit = COND_SRC.find(([re]) => re.test(insn.semantics ?? ''));
  return hit ? hit[1] : X;
};

// --- every opcode --------------------------------------------------------------
const FIELDS = [['alu', 4], ['lhs', 4], ['rhs', 4], ['dest', 4], ['cond', 2], ['pc', 2]];
const rows = [];
for (let op = 0; op < 256; op++) {
  const seen = new Map();
  for (let b1 = 0; b1 < 256; b1++) {
    const d = decode(dec, [op, b1, 0], 0);
    if (!d || seen.has(d.form)) continue;
    seen.set(d.form, {
      who: `${d.insn.mnemonic}/${d.form.name}`,
      v: { alu: aluCode(d.insn), lhs: lhsCode(d, op), rhs: rhsCode(d), dest: destCode(d, op),
           cond: condCode(d.insn), pc: pcCode(d) },
    });
  }
  if (!seen.size) continue;
  const all = [...seen.values()];
  for (const f of FIELDS.map(([n]) => n))
    if (new Set(all.map((x) => x.v[f])).size > 1)
      throw new Error(`0x${op.toString(16)}: ${all.map((x) => `${x.who} wants ${f} ${x.v[f]}`).join(', ')}`);
  rows.push({ op, who: [...new Set(all.map((x) => x.who.split('/')[0]))].join(' '), v: all[0].v });
}

const bits = (v, w) => (v === X ? 'x'.repeat(w) : v.toString(2).padStart(w, '0'));
const W = FIELDS.reduce((n, [, w]) => n + w, 0);
const cases = rows.map((r) =>
  `        8'h${r.op.toString(16).padStart(2, '0')}: t = ${W}'b${FIELDS.map(([n, w]) => bits(r.v[n], w)).join('_')};    // ${r.who}`)
  .join('\n');
const dontCares = FIELDS.map(([n]) => `${n} ${rows.filter((r) => r.v[n] === X).length}`).join(', ');

process.stdout.write(`// =============================================================================
// predecode.sv - control that belongs to the whole instruction
// =============================================================================
//
// GENERATED by tools/gen-predecode.js from isa/fructus.toml.  Do not edit; edit
// the spec or tools/control.js and run \`npm run rtl\`.
//
// A table over the first byte, loaded into flops in the dispatch cycle - the
// same cycle, and the same \`dispatch\` line, that puts the opcode into
// rtl/insn.sv.  From the next cycle until the next dispatch its outputs come
// straight out of flops:
//
//     alu_op     rtl/alu.sv's operation
//     lhs_src    rtl/lhs.sv's source
//     rhs_src    rtl/rhs.sv's source
//     dest_src   rtl/dest.sv's source: the FIRST register the instruction writes
//     cond_src   rtl/cond.sv's source
//     pc_src     where rtl/cpu.sv's next address comes from
//
// ${rows.length} opcodes, one row each.  An x is a value no step of that instruction reads -
// a branch has no ALU operation, a store no destination - left to the mapper as
// a don't-care.  Rows with an x, per field: ${dontCares}.
//
// THE MICROCODE ROM KEEPS WHAT CHANGES FROM STEP TO STEP: write enables,
// fetch and dispatch, the pc, memory reads and writes, the next address.  What
// is here is what an instruction wants throughout, and a value only has to be
// harmless in a step that does not use it - the ALU operation can sit on the
// ALU through a fetch, because nothing is written.
//
// A STEP THAT NEEDS SOMETHING ELSE SAYS SO.  pop's second and third registers,
// the store after push's decrement: those steps take their select from the
// microcode word instead, which is the consumer's two-way choice and not this
// block's business.
//
// WHY DECODE AT DISPATCH AND NOT FROM THE OPCODE REGISTER.  Each output is an
// eight-input function, so reading it off rtl/insn.sv's opcode byte during the
// instruction would put two LUT levels in front of everything it selects - the
// cimm measurement in rtl/immgen.sv priced exactly that at a level and a
// quarter of the clock.  Decoding the byte while it is on the bus puts those
// levels in the dispatch cycle, where they lead only to flops.
//
// IT IS STILL A TABLE, which is what isa/fructus.toml requires: nothing may
// decode an ALU operation by extracting bits from fixed positions, and nothing
// here does.  One opcode, one row, from the spec.
//
// MEASURED on an iCE40 UP5K, yosys 0.52 -nobram + nextpnr-ice40 0.7, logic
// cells and the median of eight placement seeds, with a real SB_SPRAM256KA on
// the bus:
//
//                                                  cells   critical path  MHz
//     SPRAM -> this table -> flops, alone            136   3 cells       71.8
//     the execute step, selects from this block     1127  11 cells       22.6
//     the execute step, selects from plain flops    1044  12 cells       22.2
//
// The execute step is rtl/insn.sv, rtl/lhs.sv, rtl/rhs.sv with immgen, rtl/cond.sv,
// an 8x16 register file, rtl/alu.sv, rtl/compare.sv and rtl/dest.sv, with the
// ALU's result written back.
//
// THE DISPATCH PATH IS NOT A CONSTRAINT: the table sits behind the memory's
// clock-to-out and still runs at three times the execute step's rate.  AND THE
// SELECTS COST THE STEP NOTHING against the idealised flops every earlier
// harness gave it - the critical path starts at the instruction register's
// fields, not at a select.  So the assumption those harnesses made about
// control arriving at level zero holds with a real table behind it, for 83
// cells.
// =============================================================================

module predecode (
    input  logic        clk,
    input  logic [7:0]  bus,       // the byte on the data bus this cycle
    input  logic        dispatch,  // microcode: it is an opcode - rtl/insn.sv's line too
    output logic [3:0]  alu_op,    // -> rtl/alu.sv
    output logic [3:0]  lhs_src,   // -> rtl/lhs.sv
    output logic [3:0]  rhs_src,   // -> rtl/rhs.sv
    output logic [3:0]  dest_src,  // -> rtl/dest.sv
    output logic [1:0]  cond_src,  // -> rtl/cond.sv
    output logic [1:0]  pc_src     // -> rtl/cpu.sv's address mux
);

    // A table feeding flops that load together is exactly a synchronous ROM,
    // and synthesis will put it in block RAM - with the slow clock-to-out and
    // fixed placement this block exists to avoid.  The attribute keeps it in
    // LUTs, and it has to sit on the case statement itself: yosys ignores it on
    // the always block, on t, and on the flops, and (* keep *) on t does not
    // stop the inference either.  Inside begin/end is where iverilog accepts it.
    logic [${W - 1}:0] t;             // {alu, lhs, rhs, dest, cond}
    always_comb begin
        (* rom_style = "logic" *)
        case (bus)
${cases}
        default: t = ${W}'b${'x'.repeat(W)};
        endcase
    end

    always_ff @(posedge clk)
        if (dispatch) {alu_op, lhs_src, rhs_src, dest_src, cond_src, pc_src} <= t;

endmodule
`);
