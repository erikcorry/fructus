// Branches that are the same test spelled with a different instruction.
//
// `br cond, ra, #k` and `brclr ra, #mask` / `brset ra, #mask` are all one
// question asked of one register, and sometimes the same question: `x <u 256`
// is `(x & 0xff00) == 0`, and `x < 0` is `(x & 0x8000) != 0`.  When the
// spelling a programmer writes has no encoding of its own but its twin in the
// other instruction does, the assembler takes the twin - in both directions:
//
//     br lo, ra, #256, L      ->  brclr ra, #0xff00, L   (condimm5 lacks it)
//     brclr ra, #0xfff8, L    ->  br lo, ra, #8, L       (neither mask table has it)
//
// Decided on TRUTH SETS, the way condimm5's own spellings are, and not on a
// rule about powers of two.  Both sides reduce to a set of register values:
// a comparison's set is a circular interval of the 2^16, and a mask test's
// set is every x whose bits lie inside (or outside) the mask.  Two spellings
// are the same branch exactly when their sets are equal.
//
// Read by gen-asm.js and gen-customasm.js, so the two assemblers accept the
// same lines; check.js keeps the condimm5 table from duplicating a mask test,
// which is what makes the derivation one-sided in practice.  gcc works the
// same equivalence out for itself from fructus-isa.h's tables.
//
// Nothing here names an instruction.  The compare branch is the one whose
// operand is a condimm5; the mask branches are the ones whose semantics test
// `R[a] & mask` against zero; their mask tables are whatever their forms'
// fields read.

import { decodeEncoding } from './isa.js';

const M = 0x10000, H = 0x8000;

// The truth set of a comparison as a circular interval [start, start + len).
// null for a condition that is not an ordered comparison or equality.
export function cmpInterval(cond, k) {
  const u = k & 0xffff, s = u >= H ? u - M : u;
  let st, ln;
  switch (cond) {
    case 'eq': st = u;     ln = 1;          break;
    case 'ne': st = u + 1; ln = M - 1;      break;
    case 'lo': st = 0;     ln = u;          break;
    case 'hs': st = u;     ln = M - u;      break;
    case 'ls': st = 0;     ln = u + 1;      break;
    case 'hi': st = u + 1; ln = M - u - 1;  break;
    case 'lt': st = H;     ln = s + H;      break;
    case 'ge': st = u;     ln = H - s;      break;
    case 'le': st = H;     ln = s + H + 1;  break;
    case 'gt': st = u + 1; ln = H - s - 1;  break;
    default:   return null;
  }
  if (ln <= 0) return [0, 0];
  if (ln >= M) return [0, M];
  return [st & 0xffff, ln];
}

// The truth set of a mask test, as an interval when it is one.  `(x & m) == 0`
// holds on the x that fit inside ~m; that is an interval only when ~m is a run
// of low ones, so this checks the set directly rather than assuming the shape.
export function maskInterval(m, set) {
  const u = ~m & 0xffff;
  let pop = 0;
  for (let b = u; b; b &= b - 1) pop++;
  // A sub-mask set of size 2^pop is an interval starting at 0 exactly when its
  // largest member is 2^pop - 1, i.e. when ~m is 2^pop - 1.
  if (u !== (1 << pop) - 1) return null;
  const len = 1 << pop;
  if (!set) return len >= M ? [0, M] : [0, len];
  return len >= M ? [0, 0] : [len, M - len];
}

const key = ([s, l]) => `${s}:${l}`;

// Find the instructions by what they do.
function branches(spec) {
  let cmp = null;
  const masks = [];                          // { insn, set, tables }
  for (const insn of spec.insn) {
    const ops = insn.operands ?? [];
    if (ops.some((o) => o.type === 'condimm5')) cmp = insn;
    const m = /^if \(\(R\[a\] & mask\) (==|!=) 0\)/.exec(insn.semantics ?? '');
    if (!m) continue;
    const tables = insn.form.map((f) => decodeEncoding(insn, f).encType.get('mask'));
    masks.push({ insn, set: m[1] === '!=', tables });
  }
  if (!cmp) throw new Error('brequiv: no instruction takes a condimm5');
  if (masks.length !== 2) throw new Error(`brequiv: ${masks.length} mask branches, expected brclr and brset`);
  return { cmp, masks };
}

// Every equivalence the assemblers need, as
//   { from: { mnemonic, cond, imm }, to: { mnemonic, cond, imm } }
// with cond null on the mask side and imm a 16-bit unsigned value.  Only
// spellings that do NOT encode directly are listed, and only targets that do.
export function brEquivalents(spec) {
  const t = spec.optype;
  const { cmp, masks } = branches(spec);
  const conds = t.cond3.names.concat(Object.keys(t.cond3.swapped ?? {}))
    .filter((c) => cmpInterval(c, 0) !== null);

  // condimm5's own predicates: these encode, whichever way they are spelled.
  const tableSet = new Map();                // interval key -> entry
  for (const [c, k] of t.condimm5.values) {
    const iv = cmpInterval(c, k);
    if (!tableSet.has(key(iv))) tableSet.set(key(iv), { cond: c, imm: k & 0xffff });
  }

  // The masks each mask branch encodes, and the predicates they reach.
  const maskSet = new Map();                 // interval key -> { mnemonic, imm }
  const encodable = new Map();               // mnemonic -> Set of masks
  for (const mb of masks) {
    const vals = new Set();
    for (const tn of mb.tables) for (const v of t[tn].values) vals.add(v & 0xffff);
    encodable.set(mb.insn.mnemonic, vals);
    for (const v of vals) {
      const iv = maskInterval(v, mb.set);
      if (iv && !maskSet.has(key(iv))) maskSet.set(key(iv), { mnemonic: mb.insn.mnemonic, imm: v });
    }
  }

  const out = [];

  // br -> brclr / brset.  Every spelling of every comparison whose set is a
  // mask test's: enumerate all 16-bit constants, since the spellings of one
  // interval are scattered across conditions (`lt #0`, `le #-1`).
  for (const c of conds)
    for (let k = 0; k < M; k++) {
      const iv = cmpInterval(c, k);
      const kk = key(iv);
      if (tableSet.has(kk)) continue;        // condimm5 already takes it
      const to = maskSet.get(kk);
      if (!to) continue;
      out.push({ from: { mnemonic: cmp.mnemonic, cond: c, imm: k },
                 to:   { mnemonic: to.mnemonic, cond: null, imm: to.imm } });
    }

  // brclr / brset -> br.  One mask per predicate and sense, and a mask is
  // determined by its set, so walking the table entries finds every one.
  for (const mb of masks)
    for (const [kk, e] of tableSet) {
      const [s, l] = kk.split(':').map(Number);
      // Which mask, if any, has this set in this sense?  The interval says:
      // [0, 2^n) is the clear test of ~(2^n - 1), [2^n, M) the set test.
      const lowRun = mb.set ? (s + l === M ? s : -1) : (s === 0 ? l : -1);
      if (lowRun <= 0 || lowRun >= M || (lowRun & (lowRun - 1))) continue;
      const m = ~(lowRun - 1) & 0xffff;
      if (encodable.get(mb.insn.mnemonic).has(m)) continue;
      if (key(maskInterval(m, mb.set)) !== kk) throw new Error(`brequiv: ${m} does not test ${kk}`);
      out.push({ from: { mnemonic: mb.insn.mnemonic, cond: null, imm: m },
                 to:   { mnemonic: cmp.mnemonic, cond: e.cond, imm: e.imm } });
    }
  return out;
}

// Every way of writing the comparison `cond #k`: each condition spelling and
// 16-bit constant whose truth set is the same.  The manual lists these; the
// assemblers derive the same set by trying each entry's constant and its two
// neighbours, which reaches all of them for every entry condimm5 holds.
export function spellings(spec, cond, k) {
  const t = spec.optype;
  const conds = t.cond3.names.concat(Object.keys(t.cond3.swapped ?? {}))
    .filter((c) => cmpInterval(c, 0) !== null);
  const want = key(cmpInterval(cond, k));
  const out = [];
  for (const c of conds)
    for (let kk = 0; kk < M; kk++)
      if (key(cmpInterval(c, kk)) === want)
        out.push({ cond: c, imm: c === 'lo' || c === 'ls' || c === 'hi' || c === 'hs' || kk < H ? kk : kk - M });
  return out;
}
