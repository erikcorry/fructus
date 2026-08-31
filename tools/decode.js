#!/usr/bin/env node
// =============================================================================
// decode.js - the instruction decoder, built from isa/fructus.toml
// =============================================================================
//
// This is the half of the spec the assembler never exercises.  gen-customasm.js
// turns the TOML into rules that go text -> bytes; this goes bytes -> operands,
// from the same `encoding` strings, and nothing in the assembler's path is
// consulted.  Two independent readings that agree is evidence the encoding is
// unambiguous; agreement enforced by shared code would not be.
//
// THE DECODER IS A 256-ENTRY TABLE indexed by byte 0, because the spec says
// `length_from_first_byte = true`.  buildDecoder() asserts that: every form
// reachable from one first byte must have the same length, or the fetch unit
// would need to look ahead.  The assembler cannot notice a violation - it only
// ever goes the other way - so this is a real check and not a restatement.
// =============================================================================

import { decodeEncoding, decodeField, nameIndex } from './isa.js';

// Fold a form's runs into a mask/value pair over the whole instruction, and a
// per-operand list of where its bits live.
function compile(types, insn, form) {
  const { runs, encType, nbytes } = decodeEncoding(insn, form);
  const width = nbytes * 8;

  let mask = 0, lit = 0, pos = width;
  const slices = new Map();          // operand -> [{ shift, hi, lo }]

  for (const r of runs) {
    if (r.kind === 'lit') {
      for (const c of r.bits) {
        pos--;
        mask |= 1 << pos;
        if (c === '1') lit |= 1 << pos;
      }
    } else {
      const n = r.hi - r.lo + 1;
      pos -= n;
      if (!slices.has(r.op)) slices.set(r.op, []);
      slices.get(r.op).push({ shift: pos, hi: r.hi, lo: r.lo });
    }
  }
  if (pos !== 0) throw new Error(`${insn.mnemonic}: encoding is not ${width} bits`);

  return { insn, form, nbytes, mask: mask >>> 0, lit: lit >>> 0, slices, encType };
}

export function buildDecoder(spec) {
  const types = spec.optype;
  const table = Array.from({ length: 256 }, () => []);

  for (const insn of spec.insn) {
    for (const form of insn.form ?? []) {
      const c = compile(types, insn, form);
      // Which first bytes can reach this form?  Every value that matches the
      // literal bits of byte 0; the operand bits in byte 0 are free.
      const shift = (c.nbytes - 1) * 8;
      const m0 = (c.mask >>> shift) & 0xff;
      const l0 = (c.lit  >>> shift) & 0xff;
      for (let b = 0; b < 256; b++) if ((b & m0) === l0) table[b].push(c);
    }
  }

  // length_from_first_byte, checked rather than assumed.
  for (let b = 0; b < 256; b++) {
    const lens = new Set(table[b].map((c) => c.nbytes));
    if (lens.size > 1) {
      const who = table[b].map((c) => `${c.insn.mnemonic}/${c.form.name} (${c.nbytes}B)`).join(', ');
      throw new Error(`first byte 0x${b.toString(16)} has forms of different lengths: ${who}`);
    }
  }

  return { types, table, len: (b) => (table[b][0]?.nbytes ?? 0) };
}

// Decode one instruction at `addr`.  Returns null if no form matches, which is
// how an unused encoding is reported - condimm5 has a free slot, so "these
// bytes are not an instruction" is a state the machine can genuinely reach.
export function decode(dec, mem, addr) {
  const b0 = mem[addr & 0xffff];
  const cands = dec.table[b0];
  if (!cands.length) return null;

  const nbytes = cands[0].nbytes;
  let word = 0;
  for (let i = 0; i < nbytes; i++) word = (word << 8) | mem[(addr + i) & 0xffff];
  word >>>= 0;

  for (const c of cands) {
    if (((word & c.mask) >>> 0) !== c.lit) continue;

    const ops = {};
    let bad = false;

    for (const [opName, parts] of c.slices) {
      let raw = 0;
      for (const p of parts) {
        const n = p.hi - p.lo + 1;
        raw |= ((word >>> p.shift) & ((1 << n) - 1)) << p.lo;
      }
      const v = decodeField(dec.types, c.encType.get(opName), raw);
      if (v === undefined) { bad = true; break; }
      ops[opName] = v;
    }
    if (bad) continue;

    // Operands the bit map does not carry.
    for (const [k, v] of Object.entries(c.form.fix ?? {})) ops[k] = v;
    for (const [k, v] of Object.entries(c.form.tie ?? {})) ops[k] = ops[v];

    return { insn: c.insn, form: c.form, nbytes, ops, addr };
  }
  return null;
}

// Render a decoded instruction through the same `syntax` template the assembler
// parses, so bytes -> text -> bytes round-trips.  `{off}` on a pcrel operand
// prints the ABSOLUTE target, which is what the assembler accepts back.
export function render(spec, d, labels = null) {
  const regs = spec.optype.reg;
  const emitAlias = regs.emit === 'aliases';
  const regName = (n) => {
    if (emitAlias) {
      for (const [a, t] of Object.entries(regs.aliases ?? {})) if (nameIndex(regs, t) === n) return a;
    }
    return regs.names[n];
  };

  const opByName = Object.fromEntries((d.insn.operands ?? []).map((o) => [o.name, o]));
  const text = (d.insn.syntax ?? '').replace(/\{(\w+)(?:\.(\w+))?\}/g, (_, name, part) => {
    let v = d.ops[name];
    if (part !== undefined) v = v[part];
    const decl = opByName[name];
    if (decl?.type === 'reg') return regName(v);
    if (part === undefined && decl?.pcrel) {
      const target = (d.addr + d.nbytes + v) & 0xffff;
      return labels?.get(target) ?? '0x' + target.toString(16).padStart(4, '0');
    }
    return typeof v === 'string' ? v : String(v);
  });
  return text ? `${d.insn.mnemonic} ${text}` : d.insn.mnemonic;
}
