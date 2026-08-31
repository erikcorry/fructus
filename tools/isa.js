#!/usr/bin/env node
// =============================================================================
// isa.js - reading isa/fructus.toml
// =============================================================================
//
// The parts of the spec that more than one tool needs.  `decodeEncoding` used
// to live in gen-customasm.js; the simulator needs the SAME reading of an
// `encoding` bit map, and having two copies would let the assembler and the
// simulator disagree about a field's bits while both looked correct.  So it
// lives here and both import it.
//
// tools/check.js deliberately keeps its own walk over `encoding`.  It is the
// validator, and a validator that shares its subject's code cannot catch that
// code being wrong.
// =============================================================================

import { readFileSync } from 'fs';
import { parse } from 'smol-toml';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

export const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export function loadSpec(path = join(root, 'isa/fructus.toml')) {
  return parse(readFileSync(path, 'utf8'));
}

// The values an int optype accepts, as written.  A signed field of n bits runs
// -2^(n-1) .. 2^(n-1)-1; an unsigned one runs 0 .. 2^n-1.
export function intRange(t) {
  return t.signed
    ? [-(1 << (t.bits - 1)), (1 << (t.bits - 1)) - 1]
    : [0, (1 << t.bits) - 1];
}

// The index a reg or enum spelling encodes to.
export function nameIndex(t, v) {
  if (typeof v === 'number') return v;
  const direct = t.names.indexOf(v);
  if (direct >= 0) return direct;
  const target = (t.aliases ?? {})[v];
  if (target !== undefined) return t.names.indexOf(target);
  throw new Error(`no encoding for ${v}`);
}

const FIELD_RE = /^([A-Za-z_]\w*):([A-Za-z_]\w*)(?:\[(\d+)(?::(\d+))?\])?$/;

// Resolve a form's encoding into a run list.  A run is either a literal bit
// string or a contiguous descending slice of one operand's encoded value.
export function decodeEncoding(insn, form) {
  const chars = form.encoding.replace(/[\s_]/g, '').split('');
  const ops   = insn.operands ?? [];

  const occur = new Map();
  chars.forEach((c, i) => {
    if (/[a-z]/.test(c)) {
      if (!occur.has(c)) occur.set(c, []);
      occur.get(c).push(i);
    }
  });

  const at      = new Array(chars.length).fill(null);
  const encType = new Map();

  for (const [letter, positions] of occur) {
    const explicit = form.fields?.[letter];
    let opName, typeName, bitIdx = null;

    if (explicit) {
      const m = FIELD_RE.exec(explicit);
      if (!m) throw new Error(`${insn.mnemonic}: cannot parse field '${explicit}'`);
      opName = m[1]; typeName = m[2];
      if (m[3] !== undefined) {
        const hi = +m[3], lo = m[4] !== undefined ? +m[4] : +m[3];
        bitIdx = [];
        if (hi >= lo) for (let b = hi; b >= lo; b--) bitIdx.push(b);
        else          for (let b = hi; b <= lo; b++) bitIdx.push(b);
      }
    } else {
      const cand = ops.filter((o) => o.name.startsWith(letter));
      if (cand.length !== 1) throw new Error(`${insn.mnemonic}: letter '${letter}' is ambiguous`);
      opName = cand[0].name; typeName = cand[0].type;
    }

    if (!bitIdx) bitIdx = positions.map((_, k) => positions.length - 1 - k);
    encType.set(opName, typeName);
    positions.forEach((p, k) => { at[p] = { op: opName, bit: bitIdx[k] }; });
  }

  const runs = [];
  for (let i = 0; i < chars.length; ) {
    if (at[i]) {
      const op = at[i].op;
      const hi = at[i].bit;
      let lo = hi, j = i + 1;
      while (j < chars.length && at[j] && at[j].op === op && at[j].bit === lo - 1) { lo = at[j].bit; j++; }
      runs.push({ kind: 'field', op, hi, lo });
      i = j;
    } else {
      let j = i, s = '';
      while (j < chars.length && !at[j]) { s += chars[j]; j++; }
      runs.push({ kind: 'lit', bits: s });
      i = j;
    }
  }
  return { runs, encType, nbytes: chars.length / 8 };
}

// An encoded field, as the number of bits it occupies in the instruction.
// A split field's width is the number of bit positions it actually uses, which
// is what `bits` on its optype says, not what the run list happens to show.
export function encodedBits(types, typeName) {
  const t = types[typeName];
  if (!t) throw new Error(`unknown optype ${typeName}`);
  return t.kind === 'reg' ? 3 : t.bits;
}

// Turn a raw encoded field into the value the programmer wrote.  This is the
// inverse of what the assembler does, and it is where the four optype kinds
// stop being interchangeable:
//
//   reg     the index is the value
//   int     a signed field is sign extended; an unsigned one is not
//   table   the index selects from `values`
//   enum    the index selects a NAME, because a condition is not a number
//   combo   the index selects one entry per name in `parts`
//
// Returns undefined for an index no table entry covers - condimm5 has one free
// slot, and a decoder must be able to say "that is not an instruction" rather
// than silently reading past the end of the array.
export function decodeField(types, typeName, raw) {
  const t = types[typeName];
  if (!t) throw new Error(`unknown optype ${typeName}`);
  switch (t.kind) {
    case 'reg':
      return raw;
    case 'int': {
      if (!t.signed) return raw;
      const half = 1 << (t.bits - 1);
      return raw >= half ? raw - (1 << t.bits) : raw;
    }
    case 'table':
      return raw < t.values.length ? t.values[raw] : undefined;
    case 'enum':
      return raw < t.names.length ? t.names[raw] : undefined;
    case 'combo': {
      if (raw >= t.values.length) return undefined;
      const entry = t.values[raw];
      const o = {};
      t.parts.forEach((p, i) => { o[p] = entry[i]; });
      return o;
    }
    default:
      throw new Error(`unknown optype kind ${t.kind}`);
  }
}
