// =============================================================================
// predecode-rows.js - one row of instruction-wide control per opcode
// =============================================================================
//
// Read by tools/gen-classify.js, which builds rtl/classify.sv from them.
// They were written for the byte-serial core's predecode.sv - see rtl/cpu.sv
// for where that core is - and the codes are still that core's, which is why
// some comments below speak of its datapath.  Each row carries the selects,
// the instruction's length and its mnemonics.
// =============================================================================

import { loadSpec } from './isa.js';
import { buildDecoder, decode } from './decode.js';
import { lhsOf, LHS_FIELD, DEST_FIELD, destWritesOf,
         ALU_OPS, ALU_RULES, ALU_ELSEWHERE, ALU_LATER,
         RHS_IMM16, RHS_PCSUM, RHS_ADR, RHS_KON, RHS_MODE, COND_SRC, PC_RULES,
         WRITES_LR } from './control.js';

const spec = loadSpec();
const dec = buildDecoder(spec);
const regs = spec.optype.reg;
const regIndex = (name) => regs.names.indexOf(regs.aliases?.[name] ?? name);
export const X = null;

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
  // A call's right-hand side is the pc adder's sum, which the byte-serial
  // core forced to pc + 2 while this code was selected; rtl/cpu.sv reads it
  // as the next pc.  It is checked first because a call
  // names a register on the left of the pc as well, and that is port A's.
  if (WRITES_LR.test(sem)) return RHS_PCSUM;
  // AN INSTRUCTION THAT WALKS A POINTER WRITES IT BACK AS A RIGHT-HAND OPERAND:
  // the byte-serial core read its address unit before the flop, exactly as a
  // call read the pc adder; rtl/cpu.sv makes it from the pointer in its ALU
  // cycle.  It names the pointer on both sides of a step - `sp = sp - 2` for
  // push, `r1 = r1 + 2` for stm - and the digit is what keeps `pc = pc + off`
  // out, since a branch's displacement is not a constant here.
  if (/\b[a-z][a-z0-9]* = base [-+] \d/.test(sem)) return RHS_ADR;
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
  const writes = destWritesOf(d.insn);
  // AN INSTRUCTION THAT WALKS A POINTER NAMES IT, and that is the write this
  // table carries - sp for push and pop, r1 for stm, r2 for ldm.  The register
  // writes in between are the ones a microcode step overrides, and pop has up
  // to three of them; the pointer write is the one every such instruction ends
  // with, so it is the one worth predecoding.
  const w = writes.find((x) => x.named) ?? writes[0];
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
  const hit = COND_SRC.find(([re]) => re.test(insn.semantics ?? ''));
  return hit ? hit[1] : X;
};

// --- every opcode --------------------------------------------------------------
export const FIELDS = [['alu', 4], ['lhs', 4], ['rhs', 4], ['dest', 4], ['cond', 2], ['pc', 2]];
export const rows = [];
for (let op = 0; op < 256; op++) {
  const seen = new Map();
  for (let b1 = 0; b1 < 256; b1++) {
    const d = decode(dec, [op, b1, 0], 0);
    if (!d || seen.has(d.form)) continue;
    const v = { alu: aluCode(d.insn), lhs: lhsCode(d, op), rhs: rhsCode(d), dest: destCode(d, op),
                cond: condCode(d.insn), pc: pcCode(d) };
    // THE PC ADDER READS THIS FIELD, so a row with a relative target may not
    // leave it to the mapper.  The byte-serial core forced the adder's addend to 1 when
    // the rhs code is RHS_PCSUM - that is how a call gets pc + 2 - so an x on a
    // row whose target is pc + the displacement would let the mapper pick that
    // code and make the jump one byte short.  It is a don't-care to the ALU and
    // NOT to the pc, which is the whole hazard: the field acquired a second
    // reader.  Such a row takes a definite code instead, and the one it takes
    // is what its neighbours already use, so the table pays nothing for it.
    if (v.pc === 1) {
      if (v.rhs === RHS_PCSUM)
        throw new Error(`0x${op.toString(16)} ${d.insn.mnemonic}: a relative target cannot also take the pc adder's sum as its right-hand side`);
      if (v.rhs === X) v.rhs = modeCode('immgen, normal');
    }
    seen.set(d.form, { who: `${d.insn.mnemonic}/${d.form.name}`, v, insn: d.insn, nbytes: d.nbytes });
  }
  if (!seen.size) continue;
  const all = [...seen.values()];
  for (const f of FIELDS.map(([n]) => n))
    if (new Set(all.map((x) => x.v[f])).size > 1)
      throw new Error(`0x${op.toString(16)}: ${all.map((x) => `${x.who} wants ${f} ${x.v[f]}`).join(', ')}`);
  rows.push({ op, who: [...new Set(all.map((x) => x.who.split('/')[0]))].join(' '), v: all[0].v,
              nbytes: all[0].nbytes, insns: [...new Set(all.map((x) => x.insn))] });
}
