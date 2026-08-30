#!/usr/bin/env node
// =============================================================================
// gen-customasm.js - generate a customasm ruledef from isa/fructus.toml
// =============================================================================
//
// customasm (https://github.com/hlorenzi/customasm) assembles a custom ISA from
// a `#ruledef` file.  This script writes that file, so the assembler and the
// spec cannot drift apart.
//
//   node tools/gen-customasm.js            > build/fructus.asm     (r5 mode on)
//   node tools/gen-customasm.js --noat     > build/fructus-noat.asm
//
// HOW THE TOML MAPS ONTO customasm
// --------------------------------
//   optype reg / enum    -> #subruledef, one entry per name, plus aliases
//   optype enum.swapped  -> a second #subruledef, used by rules that exchange
//                           the two register fields in the encoding
//   [[insn.form]]        -> one rule, or several when a field fans out
//   encoding fixed bits  -> a binary literal, whose digit count IS its width
//   encoding letters     -> `(value >> lo) & mask`N` slices, concatenated with @
//   fix = { d = 0 }      -> $assert(d == 0)
//   tie = { d = "a" }    -> $assert(d == a)      (customasm cannot bind a name
//                           twice, so a tie is a guard, not a repeated binding)
//   int optype range     -> a biased range check, see rangeAssert() below
//   table optype         -> ONE RULE PER TABLE ENTRY, each asserting its exact
//                           value and encoding its index as a literal
//   combo optype         -> one rule per entry; string parts become literal
//                           tokens in the pattern, numeric parts become guards
//   [[alias]]            -> a rule whose body is an asm { } block
//
// TWO THINGS customasm DOES DIFFERENTLY FROM THE SPEC
// ---------------------------------------------------
// The spec says the assembler takes the FIRST form whose constraints hold, with
// forms tried shortest-first.  customasm does the shortest-first part itself,
// but differs in two ways that shape everything below.
//
//  1. IT REFUSES A TIE.  Two rules matching at the same size is an error, not a
//     first-one-wins, so the tiebreak has to be made explicit.  Ties here come
//     in two shapes, and the SAME-SIZE AMBIGUITY block handles them apart:
//
//     a. A TIED-REGISTER form against a form that spends the register on a
//        table immediate - `add rd, rd, #1` fits both in two bytes.  The tie
//        is the discriminator, so the later form is handed its negation and
//        every encoding on both sides survives.
//
//     b. TWO IMMEDIATE VOCABULARIES over the same shape - `and rd, rd, #imm5`
//        against `and rd, rd, #immbit5`.  Nothing structural separates them, so
//        the VALUE has to: the later form is a table, each of its rules pins one
//        constant, and the ones the earlier form already reaches are not emitted
//        at all.  Lossless, because a dropped rule is dropped only when
//        something else encodes the same value in the same number of bytes.
//
//  2. AN asm { } RULE HAS NO COMPARABLE SIZE.  A rule whose body expands to
//     other instructions ties with every other match rather than ranking as
//     longer, so the long-immediate fallbacks cannot simply lose on size.  They
//     guard themselves out instead, on the negation of the widest real range.
//     See tooWide().
//
//  Also: a rule body is a BLOCK whose value is its LAST expression, so several
//  asm { } statements would silently discard all but the final one.  A
//  multi-instruction expansion must be ONE multi-line asm block.  And asm { }
//  interpolation takes a NAME, never an expression, so a computed argument
//  needs a local variable first.
//
// WHAT THIS DOES NOT COVER
// ------------------------
//   [[coalesce]]  customasm has no cross-line peephole, so adjacent push8 /
//                 pop8 pairs are NOT merged.  The pair mnemonics are emitted so
//                 they can be written by hand, but a run of single pushes comes
//                 out one instruction per line, larger than the real assembler
//                 would produce.  This is the one place the generated assembler
//                 is knowingly worse than the spec.
//   prefer        disassembly only; there is nothing to generate.
//
// =============================================================================

import { parse } from 'smol-toml';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// --- command line ------------------------------------------------------------
const opt = { at: true, spec: join(root, 'isa/fructus.toml'), scratch: 'r5' };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--noat') opt.at = false;
  else if (a === '--at') opt.at = true;
  else if (a === '--spec') opt.spec = process.argv[++i];
  else if (a === '--scratch') opt.scratch = process.argv[++i];
  else { console.error(`gen-customasm: unknown option ${a}`); process.exit(2); }
}

const spec  = parse(readFileSync(opt.spec, 'utf8'));
const types = spec.optype;

const out = [];
const emit = (s = '') => out.push(s);

// =============================================================================
// Small helpers
// =============================================================================

const hex = (n) => '0x' + (n >>> 0).toString(16);

// Bits `hi..lo` of `expr`, as a customasm value of exactly (hi-lo+1) bits.
// Written as an explicit mask rather than customasm's slice syntax so that
// negative values behave the same way the hardware would read them.
function take(expr, hi, lo) {
  const n = hi - lo + 1;
  const shifted = lo === 0 ? expr : `(${expr} >> ${lo})`;
  return `(${shifted} & ${hex((1 << n) - 1)})\`${n}`;
}

// The index a reg or enum spelling encodes to.
function nameIndex(t, v) {
  if (typeof v === 'number') return v;
  const direct = t.names.indexOf(v);
  if (direct >= 0) return direct;
  const target = (t.aliases ?? {})[v];
  if (target !== undefined) return t.names.indexOf(target);
  throw new Error(`no encoding for ${v}`);
}

// Does a written int16 fit an N-bit field?  Both spellings of a 16-bit pattern
// are legal (int16 has wrap = true), so the check is done on the wrapped value.
// Biasing by 2^(N-1) folds the two valid ranges - the small non-negatives and
// the large near-0xffff ones - into one contiguous window, which is exactly how
// a sign-range check is done in hardware.
// The values an int optype accepts, as written.  A signed field of n bits runs
// -2^(n-1) .. 2^(n-1)-1; an unsigned one runs 0 .. 2^n-1.
function intRange(t) {
  return t.signed
    ? [-(1 << (t.bits - 1)), (1 << (t.bits - 1)) - 1]
    : [0, (1 << t.bits) - 1];
}

function rangeAssert(name, t) {
  if (!t.signed) return [`$assert(${name} >= 0)`, `$assert(${name} <= ${t.bits >= 16 ? '0xffff' : hex((1 << t.bits) - 1)})`];
  if (t.bits >= 16) return [`$assert(${name} >= -0x8000)`, `$assert(${name} <= 0xffff)`];
  const half = 1 << (t.bits - 1), full = 1 << t.bits;
  return [`$assert(((${name} + ${hex(half)}) & 0xffff) < ${hex(full)}, "does not fit ${t.bits} signed bits")`];
}

// A pc-relative displacement is a true signed number, not a wrapping one.
function relAssert(name, t) {
  const half = 1 << (t.bits - 1);
  return [
    `$assert(${name} >= -${hex(half)}, "branch target too far backwards")`,
    `$assert(${name} <= ${hex(half - 1)}, "branch target too far forwards")`,
  ];
}

// =============================================================================
// Reading an `encoding` bit map
// =============================================================================

const FIELD_RE = /^([A-Za-z_]\w*):([A-Za-z_]\w*)(?:\[(\d+)(?::(\d+))?\])?$/;

// Resolve a form's encoding into a run list.  A run is either a literal bit
// string or a contiguous descending slice of one operand's encoded value.
function decodeEncoding(insn, form) {
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

// =============================================================================
// Turning one form into one or more customasm rules
// =============================================================================

// The cartesian product of the per-operand fan-outs a form needs.  Table and
// combo operands each contribute one branch per table entry; everything else
// contributes exactly one.
function product(lists) {
  return lists.reduce((acc, xs) => acc.flatMap((a) => xs.map((x) => [...a, x])), [[]]);
}

function rulesFor(insn, form, formIdx, swapped = false) {
  const { runs, encType, nbytes } = decodeEncoding(insn, form);
  const ops  = insn.operands ?? [];
  const fix  = form.fix ?? {};
  const tie  = form.tie ?? {};
  const swap = swapped ? Object.fromEntries([[insn.swap_operands[0], insn.swap_operands[1]],
                                             [insn.swap_operands[1], insn.swap_operands[0]]]) : {};

  // Per operand: a list of alternatives, each { patt, val, pre, asserts }.
  // `patt` maps a syntax reference to its replacement text.
  const choices = ops.map((op) => {
    const lt = types[op.type];                 // logical type
    const et = types[encType.get(op.name)];    // encoded type, if encoded

    // ---- fixed by the form -------------------------------------------------
    if (op.name in fix) {
      const v = fix[op.name];
      const a = (lt.kind === 'reg' || lt.kind === 'enum')
        ? [`$assert(${op.name} == ${nameIndex(lt, v)}, "this form is fixed at ${v}")`]
        : [`$assert((${op.name} & 0xffff) == ${hex(v & 0xffff)}, "this form is fixed at ${v}")`];
      const pv = (lt.kind === 'reg' || lt.kind === 'enum') ? `${nameIndex(lt, v)}` : `${v & 0xffff}`;
      return [{ patt: { [op.name]: bind(op, lt, swapped) }, val: null, pre: [], asserts: a,
                pins: { [op.name]: pv } }];
    }

    // ---- tied to another operand's bits ------------------------------------
    if (op.name in tie) {
      return [{ patt: { [op.name]: bind(op, lt, swapped) }, val: null, pre: [],
                asserts: [`$assert(${op.name} == ${tie[op.name]}, "this form ties ${op.name} to ${tie[op.name]}")`] }];
    }

    // ---- carried by the bit map --------------------------------------------
    if (et && et.kind === 'table') {
      return et.values.map((v, idx) => ({
        patt: { [op.name]: bind(op, lt, swapped) },
        val: `${idx}`,
        pre: [],
        asserts: [`$assert((${op.name} & 0xffff) == ${hex(v & 0xffff)})`],
        pins: { [op.name]: `${v & 0xffff}` },
      }));
    }

    if (et && et.kind === 'combo') {
      // Every table entry, plus each rewrite spelling - which encodes the index
      // of the entry it canonicalises onto, so `hs #1` assembles as `ne #0`.
      const alts = et.values.map((entry, idx) => ({ entry, idx }));
      for (const rw of et.rewrite ?? []) {
        const idx = et.values.findIndex((v) => v.every((x, k) => x === rw.to[k]));
        if (idx < 0)
          throw new Error(`${insn.mnemonic}: rewrite target [${rw.to}] is not in the table`);
        alts.push({ entry: rw.from, idx });
      }
      return alts.map(({ entry, idx }) => {
        const patt = {}, asserts = [], pins = {};
        et.parts.forEach((part, k) => {
          const v = entry[k];
          if (typeof v === 'string') patt[`${op.name}.${part}`] = v;
          else {
            const b = `${op.name}_${part}`;
            patt[`${op.name}.${part}`] = `{${b}}`;
            asserts.push(`$assert((${b} & 0xffff) == ${hex(v & 0xffff)})`);
            pins[b] = `${v & 0xffff}`;
          }
        });
        return { patt, val: `${idx}`, pre: [], asserts, pins };
      });
    }

    if (et && (et.kind === 'reg' || et.kind === 'enum')) {
      const nm = swap[op.name] ?? op.name;
      return [{ patt: { [op.name]: bind(op, lt, swapped) }, val: nm, pre: [], asserts: [] }];
    }

    if (et && et.kind === 'int') {
      if (op.pcrel) {
        const rel = `rel_${op.name}`;
        return [{ patt: { [op.name]: `{${op.name}}` }, val: `(${rel} & 0xffff)`,
                  pre: [`${rel} = ${op.name} - $ - ${nbytes}`], asserts: relAssert(rel, et) }];
      }
      return [{ patt: { [op.name]: `{${op.name}}` }, val: `(${op.name} & 0xffff)`,
                pre: [], asserts: rangeAssert(op.name, et) }];
    }

    throw new Error(`${insn.mnemonic}/${form.name}: operand '${op.name}' is not determined`);
  });

  return product(choices).map((combo) => {
    const patt = Object.assign({}, ...combo.map((c) => c.patt));
    const val  = Object.fromEntries(ops.map((o, i) => [o.name, combo[i].val]));
    const pre  = combo.flatMap((c) => c.pre);
    const asserts = combo.flatMap((c) => c.asserts);
    const pins = Object.assign({}, ...combo.map((c) => c.pins ?? {}));

    const bits = runs.map((r) => r.kind === 'lit'
      ? `0b${r.bits}`
      // val[] already carries the exchange, so do NOT swap again here.
      : take(val[r.op], r.hi, r.lo)).join(' @ ');

    return { mnemonic: insn.mnemonic, pattern: renderPattern(insn, patt), pre, asserts,
             body: bits, nbytes, formIdx, encType, pins, ties: Object.entries(tie), tag: `${insn.mnemonic}/${form.name ?? 'form'}${swapped ? ' (operands exchanged)' : ''}` };
  });
}

// How an operand appears in the pattern: a typed binding for reg and enum, a
// plain expression binding otherwise.
function bind(op, lt, swapped) {
  if (lt.kind === 'reg')  return `{${op.name}: reg}`;
  if (lt.kind === 'enum') return `{${op.name}: ${op.type}${swapped ? '_swap' : ''}}`;
  return `{${op.name}}`;
}

function renderPattern(insn, patt) {
  const body = (insn.syntax ?? '').replace(/\{([A-Za-z_]\w*(?:\.\w+)?)\}/g, (m, ref) => {
    if (!(ref in patt)) throw new Error(`${insn.mnemonic}: syntax references unknown '${ref}'`);
    return patt[ref];
  });
  return body ? `${insn.mnemonic} ${body}` : insn.mnemonic;
}

// =============================================================================
// Emit
// =============================================================================

emit('; ===========================================================================');
emit('; fructus - customasm ruledef');
emit(';');
emit('; GENERATED by tools/gen-customasm.js from isa/fructus.toml - do not edit.');
emit(`; Immediate mode: ${opt.at ? `${opt.scratch} reserved as assembler scratch` : 'no assembler scratch (compiler mode)'}`);
emit('; ===========================================================================');
emit('; This file defines rules only.  A program that uses it starts with');
emit(';');
emit(';     #include "fructus.asm"');
emit(';');
emit('; and, if it wants an explicit memory layout, a #bankdef.  customasm already');
emit('; defaults to 8 bits per addressable unit, which is what fructus uses.');
emit();

// --- register and condition name tables --------------------------------------
for (const [name, t] of Object.entries(types)) {
  if (t.kind !== 'reg' && t.kind !== 'enum') continue;
  emit(`#subruledef ${name}`);
  emit('{');
  t.names.forEach((n, i) => emit(`    ${n.padEnd(8)} => ${i}\`${t.bits}`));
  for (const [spelling, target] of Object.entries(t.aliases ?? {}))
    emit(`    ${spelling.padEnd(8)} => ${t.names.indexOf(target)}\`${t.bits}   ; = ${target}`);
  emit('}');
  emit();

  if (t.swapped) {
    emit(`; Spellings reached by EXCHANGING the two register operands.  Rules using`);
    emit(`; this table emit the register fields the other way round.`);
    emit(`#subruledef ${name}_swap`);
    emit('{');
    for (const [spelling, target] of Object.entries(t.swapped))
      emit(`    ${spelling.padEnd(8)} => ${t.names.indexOf(target)}\`${t.bits}   ; = ${target}, operands exchanged`);
    emit('}');
    emit();
  }
}

// --- the instruction rules ---------------------------------------------------
const rules = [];
let formIdx = 0;
for (const insn of spec.insn) {
  for (const form of insn.form) {
    rules.push(...rulesFor(insn, form, formIdx, false));
    if (insn.swap_operands) {
      const st = insn.operands.map((o) => types[o.type]).find((t) => t.kind === 'enum' && t.swapped);
      const usesCond = insn.operands.some((o) => types[o.type].kind === 'enum' && !(o.name in (form.fix ?? {})));
      if (st && usesCond) rules.push(...rulesFor(insn, form, formIdx, true));
    }
    formIdx++;
  }
}

// Shortest encoding first, which is what makes rule cascading pick the form the
// spec says it should.  JS sort is stable, so ties keep spec order.
rules.sort((a, b) => a.nbytes - b.nbytes);

// ---------------------------------------------------------------------------
// SAME-SIZE AMBIGUITY
// ---------------------------------------------------------------------------
// The spec says the assembler takes the first form whose constraints hold, with
// forms tried shortest-first.  customasm does shortest-first on its own, but it
// REFUSES A TIE: two rules of the same size both matching is an error, not a
// first-one-wins.  So the tiebreak has to be made explicit here.
//
// Every such tie in this ISA has one shape - a form that TIES two registers to
// buy a wide immediate, against a form that spends the register on a table
// immediate.  `add rd, rd, #1` fits both in two bytes.  The spec lists the tied
// form first, so the table form is handed the negation of the tie.
//
// That is only lossless if the tied form really covers what it takes, so the
// losing form's table values are checked against the winning form's range.  A
// tie of any other shape stops the generator rather than emit a file customasm
// will reject.
const groups = new Map();
for (const r of rules) {
  const key = `${r.pattern}|${r.nbytes}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(r);
}

// Two rules can only collide if nothing PINS them apart.  A form that fixes an
// operand to a constant, or a fan-out branch that pins a table value, is
// disjoint from any rule pinning the same operand to something else - which is
// how `add r0, r0, r1` and `add r1, r1, r0` share a size and a pattern without
// ever being ambiguous.
const disjoint = (x, y) =>
  Object.keys(x.pins).some((k) => k in y.pins && x.pins[k] !== y.pins[k]);

let broken = 0, dropped = 0;
for (const group of groups.values()) {
  const byForm = new Map();
  for (const r of group) {
    if (!byForm.has(r.formIdx)) byForm.set(r.formIdx, []);
    byForm.get(r.formIdx).push(r);
  }
  const forms = [...byForm.keys()].sort((a, b) => a - b);
  if (forms.length < 2) continue;

  for (let i = 1; i < forms.length; i++) {
    const mine = byForm.get(forms[i]);
    for (let j = 0; j < i; j++) {
      const theirs = byForm.get(forms[j]);
      const clash = mine.some((a) => theirs.some((b) => !disjoint(a, b)));
      if (!clash) continue;

      const winner = theirs[0];
      const tieKey = (t) => t.map(([x, y]) => `${x}=${y}`).sort().join(',');

      if (winner.ties.length && tieKey(winner.ties) !== tieKey(mine[0].ties)) {
        // The winner TIES something this form leaves free, so the tie is the
        // discriminator and every encoding on both sides survives.  Only
        // lossless if the winner really covers what it takes, so the loser's
        // table values are checked against the winner's range.
        for (const [opName, tn] of mine[0].encType) {
          const lt = types[tn];
          if (lt.kind !== 'table') continue;
          const wt = types[winner.encType.get(opName)];
          if (!wt || wt.kind !== 'int') continue;
          const [lo, hi] = intRange(wt);
          for (const v of lt.values)
            if (v < lo || v > hi)
              throw new Error(`${mine[0].tag}: table value ${v} is outside ` +
                              `${winner.tag}'s ${wt.bits}-bit range, so negating the ` +
                              `tie would lose an encoding`);
        }

        for (const r of mine)
          for (const [x, y] of winner.ties)
            r.asserts.push(`$assert(${x} != ${y}, "${x} == ${y} is ${winner.tag}, the same size")`);
        broken += mine.length;
      } else {
        // SAME SHAPE, DIFFERENT VOCABULARY.  `and rd, rd, #imm5` against
        // `and rd, rd, #immbit5`: same size, same registers, same tie, so no
        // structural fact separates them and negating a tie is not available.
        // What does separate them is the VALUE.  The loser is a table form, so
        // each of its rules pins exactly one constant - and the ones the winner
        // already reaches are simply not emitted.  #1 is imm5's, #0x8000 is
        // immbit5's, and neither is ever both.
        //
        // This is lossless in the strong sense: a dropped entry is dropped only
        // because the rule that beat it encodes the same value in the same
        // number of bytes.
        let handled = false;
        for (const [opName, tn] of mine[0].encType) {
          const lt = types[tn];
          if (lt.kind !== 'table') continue;
          const wt = types[winner.encType.get(opName)];
          if (!wt || wt.kind !== 'int') continue;
          handled = true;
          const [lo, hi] = intRange(wt);
          for (const r of mine) {
            const p = Number(r.pins[opName]);
            if (Number.isNaN(p)) continue;
            // The winner's range assert folds, so it accepts BOTH spellings of
            // a 16-bit pattern - test the value each way.
            const signed = (p ^ 0x8000) - 0x8000;
            if ((p >= lo && p <= hi) || (signed >= lo && signed <= hi)) {
              r.drop = `${winner.tag} encodes ${hex(p)} in the same ${r.nbytes} bytes`;
              dropped++;
            }
          }
        }
        if (!handled)
          throw new Error(`same-size ambiguity with no tie to negate: ` +
                          `${mine[0].tag} vs ${winner.tag}`);
      }
      break;
    }
  }
}

console.error(`gen-customasm: ${broken} same-size ties broken, ` +
              `${dropped} duplicate table entries dropped`);

// =============================================================================
// Emit the rules
// =============================================================================
emit('#ruledef fructus');
emit('{');
for (const r of rules) {
  if (r.drop) continue;
  if (r.pre.length === 0 && r.asserts.length === 0) {
    emit(`    ${r.pattern} => ${r.body}   ; ${r.nbytes}B  ${r.tag}`);
  } else {
    emit(`    ${r.pattern} =>`);
    emit(`    {   ; ${r.nbytes} ${r.nbytes === 1 ? 'byte' : 'bytes'} - ${r.tag}`);
    for (const p of r.pre) emit(`        ${p}`);
    for (const a of r.asserts) emit(`        ${a}`);
    emit(`        ${r.body}`);
    emit('    }');
  }
}
emit('}');
emit();

// --- aliases -----------------------------------------------------------------
// An alias has no encoding of its own; it rewrites to a real instruction, which
// is exactly what an asm { } block does.  Form selection then happens on the
// REWRITTEN instruction, so `mov r0, r1` still finds the one-byte `or`.  The two
// mechanisms compose without either knowing about the other, just as the spec
// says.
emit('; --- aliases: assembler-only rewrites, no opcodes of their own ------------');
emit('#ruledef fructus_aliases');
emit('{');
for (const al of spec.alias ?? []) {
  const args = al.expand.args;
  const target = spec.insn.find((i) => i.mnemonic === al.expand.mnemonic
    && i.operands.length === Object.keys(args).length
    && i.operands.every((o) => o.name in args));
  if (!target) throw new Error(`alias ${al.mnemonic}: nothing named ${al.expand.mnemonic} takes those arguments`);

  const own = new Set(al.operands.map((o) => o.name));
  const patt = Object.fromEntries(al.operands.map((o) => {
    const lt = types[o.type];
    return [o.name, lt.kind === 'reg' ? `{${o.name}: reg}` : `{${o.name}}`];
  }));

  // asm { } interpolation takes a NAME, never an expression, so a rewrite that
  // computes something (`sub` negates its immediate) needs a local first.
  const pre = [];
  const call = target.syntax.replace(/\{([A-Za-z_]\w*)\}/g, (m, ref) => {
    const v  = args[ref];
    const ot = types[target.operands.find((o) => o.name === ref).type];

    // A literal filling a register or condition slot has to come back as a
    // SPELLING: the target rule matches names, not numbers.
    if (typeof v === 'number' && (ot.kind === 'reg' || ot.kind === 'enum')) return ot.names[v];
    if (typeof v === 'number') return `${v}`;
    if (typeof v === 'string' && v.startsWith('-') && own.has(v.slice(1))) {
      const nm = `neg_${v.slice(1)}`;
      pre.push(`${nm} = 0 - ${v.slice(1)}`);
      return `{${nm}}`;
    }
    if (typeof v === 'string' && own.has(v)) return `{${v}}`;
    return v;                                    // an enum or register spelling
  });

  const rewrite = `asm { ${al.expand.mnemonic} ${call} }`;
  if (pre.length === 0) {
    emit(`    ${renderPattern(al, patt)} => ${rewrite}   ; ${al.summary ?? ''}`);
  } else {
    emit(`    ${renderPattern(al, patt)} =>`);
    emit(`    {   ; ${al.summary ?? ''}`);
    for (const p of pre) emit(`        ${p}`);
    emit(`        ${rewrite}`);
    emit('    }');
  }
}
emit('}');
emit();

// =============================================================================
// Long-immediate expansion  (ASSEMBLER POLICY, not part of the ISA)
// =============================================================================
// Nothing below comes from the TOML.  These are the last rules in each cascade,
// reached only when every real encoding has failed its range check.
//
// The FIRST variant of each pair needs no scratch register at all: it builds the
// constant in the DESTINATION and then reads it back as the second source.  That
// works whenever the destination is not also a source, which is the common case
// - so the reserved register is needed far less often than it looks.  The second
// variant covers the rest, and stores always need it because a store has no
// destination register to borrow.
//
// --noat emits only the scratch-free variants, which is the mode a compiler
// wants: it never needs the assembler to synthesise anything, and would rather
// have the whole register file.
// The widest immediate any real form of this mnemonic can encode.
function widestImmBits(mnemonic, opName) {
  let bits = 0;
  for (const insn of spec.insn) {
    if (insn.mnemonic !== mnemonic) continue;
    for (const form of insn.form) {
      const tn = decodeEncoding(insn, form).encType.get(opName);
      const t = tn && types[tn];
      if (t && t.kind === 'int') bits = Math.max(bits, t.bits);
    }
  }
  if (!bits) throw new Error(`no immediate form of ${mnemonic} carries '${opName}'`);
  return bits;
}

// WHY THE FALLBACKS GUARD THEMSELVES OUT.
//
// customasm cannot compare the size of an asm { } expansion against a real
// encoding: a rule whose body is an asm block ties with every other match
// instead of being ranked as longer, and a tie is an error.  So these rules
// cannot simply sit at the bottom of the cascade and lose on size - they have
// to be mutually exclusive with the real forms by construction.
//
// The guard is the negation of the WIDEST real immediate range, so a fallback
// fires only when nothing real could have encoded the value.
function tooWide(name, bits) {
  return `$assert(((${name} + ${hex(1 << (bits - 1))}) & 0xffff) >= ${hex(1 << bits)}, ` +
         `"a real ${bits}-bit form already encodes this")`;
}

const S  = opt.scratch;              // spelling, for use inside asm { } blocks
const SN = nameIndex(types.reg, S);  // number, for use inside $assert
const ALU = ['add', 'rsb', 'xor', 'or', 'and'];

emit('; --- long immediates ------------------------------------------------------');
emit('; Reached only when no real encoding fits.  Assembler policy, not ISA:');
emit('; see the comment in tools/gen-customasm.js.');
emit('#ruledef fructus_long_imm');
emit('{');
for (const op of ALU) {
  emit(`    ${op} {d: reg}, {a: reg}, #{imm} =>`);
  emit('    {   ; no scratch: build the constant in the destination');
  emit(`        ${tooWide('imm', widestImmBits(op, 'imm'))}`);
  emit('        $assert(d != a, "destination doubles as the scratch, so it must differ from the source")');
  emit('        asm {');
  emit('            mov {d}, #{imm}');
  emit(`            ${op} {d}, {a}, {d}`);
  emit('        }');
  emit('    }');
  if (opt.at) {
    emit(`    ${op} {d: reg}, {a: reg}, #{imm} =>`);
    emit(`    {   ; via the reserved scratch ${S}`);
    emit(`        ${tooWide('imm', widestImmBits(op, 'imm'))}`);
    emit('        $assert(d == a, "no scratch is needed unless the destination is also the source")');
    emit(`        $assert(a != ${SN}, "source would be destroyed by the scratch")`);
    emit('        asm {');
    emit(`            mov ${S}, #{imm}`);
    emit(`            ${op} {d}, {a}, ${S}`);
    emit('        }');
    emit('    }');
  }
}
for (const ld of ['ld8', 'ld16']) {
  emit(`    ${ld} {d: reg}, [{a: reg}, #{off}] =>`);
  emit('    {   ; no scratch: compute the address in the destination');
  emit(`        ${tooWide('off', widestImmBits(ld, 'off'))}`);
  emit('        $assert(d != a, "destination doubles as the scratch, so it must differ from the address")');
  emit('        asm {');
  emit('            mov {d}, #{off}');
  emit('            add {d}, {a}, {d}');
  emit(`            ${ld} {d}, [{d}, #0]`);
  emit('        }');
  emit('    }');
  if (opt.at) {
    emit(`    ${ld} {d: reg}, [{a: reg}, #{off}] =>`);
    emit(`    {   ; via the reserved scratch ${S}`);
    emit(`        ${tooWide('off', widestImmBits(ld, 'off'))}`);
    emit('        $assert(d == a, "no scratch is needed unless the destination is also the address")');
    emit(`        $assert(a != ${SN}, "address would be destroyed by the scratch")`);
    emit('        asm {');
    emit(`            mov ${S}, #{off}`);
    emit(`            add ${S}, {a}, ${S}`);
    emit(`            ${ld} {d}, [${S}, #0]`);
    emit('        }');
    emit('    }');
  }
}
if (opt.at) {
  // A store has no destination to borrow, so this is the one case that
  // genuinely cannot be done without a reserved scratch.
  for (const st of ['st8', 'st16']) {
    emit(`    ${st} {s: reg}, [{a: reg}, #{off}] =>`);
    emit(`    {   ; a store has no destination to borrow, so ${S} is required`);
    emit(`        ${tooWide('off', widestImmBits(st, 'off'))}`);
    emit(`        $assert(a != ${SN}, "address would be destroyed by the scratch")`);
    emit(`        $assert(s != ${SN}, "source would be destroyed by the scratch")`);
    emit('        asm {');
    emit(`            mov ${S}, #{off}`);
    emit(`            add ${S}, {a}, ${S}`);
    emit(`            ${st} {s}, [${S}, #0]`);
    emit('        }');
    emit('    }');
  }
}
emit('}');

process.stdout.write(out.join('\n') + '\n');
console.error(`gen-customasm: ${rules.filter((r) => !r.drop).length} rules from ${spec.insn.length} instruction entries` +
              `, ${(spec.alias ?? []).length} aliases, ${opt.at ? `${S} reserved as scratch` : 'no scratch'}`);
