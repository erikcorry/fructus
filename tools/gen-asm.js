#!/usr/bin/env node
// =============================================================================
// gen-asm.js - the gas operand tables, from isa/fructus.toml
// =============================================================================
//
//   node tools/gen-asm.js --header > vendor/binutils-gdb/include/opcode/fructus-asm.h
//   node tools/gen-asm.js --table  > vendor/binutils-gdb/opcodes/fructus-asm.c
//
// gen-opcodes.js emits what a DISASSEMBLER needs: one flat table saying what
// each of the 256 opcodes is called and how long it is.  That is not enough to
// assemble, because assembling runs the other way - a mnemonic and some
// operand text arrive, and several encodings may accept them.  `and rd, rd, #4'
// fits imm5, immbit5, imm3 and imm10; `and rd, rd, #0xff00' fits only immask5
// and imm10.  Choosing between those is the whole job.
//
// So this emits the form table: one row per (instruction, form), carrying the
// syntax to parse, the constraints each operand must satisfy, and where the
// bits go.  gas walks it shortest-first and takes the first row that accepts
// what was written, which is what tools/gen-customasm.js arranges for customasm
// by a different route - two assemblers reading one spec.
//
// No mnemonic is special-cased and no operand kind is hand-coded in
// tc-fructus.c.  If this table cannot express a form, the generator says so;
// the assertions below are where that happens.
// =============================================================================

import { loadSpec, decodeEncoding, nameIndex } from './isa.js';
import { buildDecoder } from './decode.js';

const spec = loadSpec();
const t = spec.optype;
const mode = process.argv.includes('--header') ? 'header' : 'table';
const u16 = (v) => (v >>> 0) & 0xffff;

// --- which value table an encoded `table' optype refers to --------------------
const TABLES = { imm3: 'FR_T_IMM3', shift3: 'FR_T_SHIFT3',
                 immbit5: 'FR_T_IMMBIT5', immask5: 'FR_T_IMMASK5' };

// --- the relocation a symbolic value needs -----------------------------------
// Only fields wide enough to hold a whole address, or a whole branch
// displacement, can carry a relocation.  A five-bit immediate or a table index
// cannot, so a symbol simply does not fit those forms - which is the same
// "does it fit" test the constant case uses, and needs no special case.
function relocFor(et, pcrel) {
  if (et.kind !== 'int') return 'FR_R_NONE';
  if (et.bits === 8)  return pcrel ? 'FR_R_8_PCREL'  : 'FR_R_8';
  if (et.bits === 16) return pcrel ? 'FR_R_16_PCREL' : 'FR_R_16';
  return 'FR_R_NONE';
}

// =============================================================================
// One (insn, form) pair -> one row
// =============================================================================
//
// A row's slots are the things the syntax asks the programmer to write, in the
// order they are written.  A combo operand - condimm5 - is written as two
// pieces, `{k.cond}` and `#{k.imm}`, so it becomes two slots: the first carries
// the encoded value and the second only constrains it.
function rowsFor(insn, form, swapped) {
  const { runs, encType, nbytes } = decodeEncoding(insn, form);
  const ops = insn.operands ?? [];
  const fix = form.fix ?? {};
  const tie = form.tie ?? {};

  // slot list, and the map from operand name to its anchor slot
  const slots = [], anchor = new Map(), ref = new Map();
  for (const op of ops) {
    const lt = t[op.type];
    if (lt.kind === 'combo') {
      if (lt.parts.length !== 2 || lt.parts[0] !== 'cond' || lt.parts[1] !== 'imm')
        throw new Error(`${insn.mnemonic}: combo ${op.type} is not (cond, imm)`);
      anchor.set(op.name, slots.length);
      ref.set(`${op.name}.cond`, slots.length);
      slots.push({ op, kind: 'FR_CC', part: 'cond' });
      ref.set(`${op.name}.imm`, slots.length);
      slots.push({ op, kind: 'FR_CK', part: 'imm' });
    } else {
      anchor.set(op.name, slots.length);
      ref.set(op.name, slots.length);
      slots.push({ op, kind: null });
    }
  }

  // The exchange, for the swapped spelling of a two-register branch.  Only the
  // PLACES move: `br gt, ra, rb, L` is `br lt, rb, ra, L`, so the bits that
  // would take ra take rb instead.  Nothing else in the row changes, which is
  // why this needs no swap logic in gas at all.
  const swap = {};
  if (swapped) {
    const [x, y] = insn.swap_operands;
    swap[x] = y; swap[y] = x;
  }

  // --- describe each slot ----------------------------------------------------
  for (const s of slots) {
    const op = s.op, lt = t[op.type];
    const et = encType.has(op.name) ? t[encType.get(op.name)] : null;
    s.tie = -1; s.fixed = 0; s.value = 0;
    s.table = 'FR_T_NONE'; s.reloc = 'FR_R_NONE';
    s.bits = 0; s.signed = 0; s.pcrel = op.pcrel ? 1 : 0;
    s.swapped = 0;

    if (op.name in fix) {
      s.fixed = 1;
      s.value = (lt.kind === 'reg' || lt.kind === 'enum')
        ? nameIndex(lt, fix[op.name]) : u16(fix[op.name]);
    } else if (op.name in tie) {
      const target = tie[op.name];
      if (!ref.has(target)) throw new Error(`${insn.mnemonic}: tie to unknown ${target}`);
      s.tie = ref.get(target);
    }

    // How it is written is the logical type; what it encodes to is et.
    if (s.kind === null)
      s.kind = lt.kind === 'reg'  ? 'FR_REG'
             : lt.kind === 'enum' ? 'FR_COND'
             : 'FR_INT';

    if (s.kind === 'FR_COND' && swapped) s.swapped = 1;

    if (et && !s.fixed && s.tie < 0) {
      if (et.kind === 'table') {
        if (!(encType.get(op.name) in TABLES))
          throw new Error(`${insn.mnemonic}: no value table for ${encType.get(op.name)}`);
        s.kind = 'FR_TABLE';
        s.table = TABLES[encType.get(op.name)];
      } else if (et.kind === 'int') {
        s.bits = et.bits; s.signed = et.signed ? 1 : 0;
        s.reloc = relocFor(et, op.pcrel);
      } else if (et.kind === 'combo') {
        // The anchor slot already says FR_CC; what it still needs is the width
        // the instruction compares at, which decides which spellings it takes.
        s.bits = Number((/\btest\s*\([^()]*,\s*(\d+)\s*\)/.exec(insn.semantics ?? '') ?? [])[1]) || 16;
      } else if (et.kind !== 'reg' && et.kind !== 'enum') {
        throw new Error(`${insn.mnemonic}: cannot describe encoded type ${et.kind}`);
      }
    }
  }

  // --- where the bits go -----------------------------------------------------
  // The instruction is one word, byte 0 in the most significant position, so a
  // run starting at character `at' of the encoding string with width w lands at
  // instruction bit (nbits - at - w).  Emitting is then a plain shift loop and
  // there is no per-form byte assembly anywhere in gas.
  const nbits = nbytes * 8;
  let base = 0n, at = 0;
  const places = [];
  for (const r of runs) {
    if (r.kind === 'lit') {
      base |= BigInt(parseInt(r.bits, 2)) << BigInt(nbits - at - r.bits.length);
      at += r.bits.length;
    } else {
      const w = r.hi - r.lo + 1;
      const from = swap[r.op] ?? r.op;
      places.push({ slot: anchor.get(from), vlo: r.lo, width: w, ilo: nbits - at - w });
      at += w;
    }
  }
  if (at !== nbits) throw new Error(`${insn.mnemonic}/${form.name}: encoding is ${at} bits`);

  // --- the syntax, with %N for each slot -------------------------------------
  const syntax = (insn.syntax ?? '').replace(/\{([A-Za-z_]\w*(?:\.\w+)?)\}/g, (m, r) => {
    if (!ref.has(r)) throw new Error(`${insn.mnemonic}: syntax names unknown '${r}'`);
    return `%${ref.get(r)}`;
  });

  return { mnemonic: insn.mnemonic, syntax, nbytes, slots, places, base,
           insn, form, swapped,
           tag: `${insn.mnemonic}/${form.name}${swapped ? ' swapped' : ''}` };
}

// --- build every row ---------------------------------------------------------
const rows = [];
for (const insn of spec.insn)
  for (const form of insn.form ?? []) {
    rows.push(rowsFor(insn, form, false));
    if (insn.swap_operands) rows.push(rowsFor(insn, form, true));
  }

// Shortest first, and stable within a size so the spec's own order breaks ties.
// gas takes the first row that accepts what was written, so this ordering is
// the "prefer the smaller encoding" rule; there is no size search in gas.
rows.sort((a, b) => a.nbytes - b.nbytes);

// --- which row a first byte decodes to ---------------------------------------
// The disassembler needs the same rows, reached the other way round.  It is a
// list per opcode rather than one row, because length is a function of byte 0
// - `length_from_first_byte`, which the ISA commits to - while the mnemonic is
// not: the unary block packs sxt8, clz and popcount into opcode 0x32 and tells
// them apart with two bits of byte 1.
//
// So each entry carries the byte-1 mask and match that selects it, in the same
// order tools/decode.js tries them, and the first match wins in both.
const { table: decTable } = buildDecoder(spec);
const cand = [], firstCand = [];
for (let b = 0; b < 256; b++) {
  firstCand.push(cand.length);
  for (const c of decTable[b]) {
    const w = c.nbytes * 8;
    // Byte 2 is always a whole field - a displacement or an immediate - so
    // discrimination never needs it.  Assert that rather than assume it.
    if (c.nbytes === 3 && (c.mask & 0xff) !== 0)
      throw new Error(`${c.insn.mnemonic}/${c.form.name}: byte 2 carries literal bits, `
                    + `which the opcode map cannot discriminate on`);
    const m1 = c.nbytes >= 2 ? (c.mask >>> (w - 16)) & 0xff : 0;
    const l1 = c.nbytes >= 2 ? (c.lit  >>> (w - 16)) & 0xff : 0;
    const k = rows.findIndex((r) => !r.swapped && r.insn === c.insn && r.form === c.form);
    if (k < 0) throw new Error(`opcode 0x${b.toString(16)} decodes to a form with no row`);
    cand.push({ mask: m1, match: l1, form: k });
  }
}
firstCand.push(cand.length);

// =============================================================================
// The properties gas relies on, asserted here
// =============================================================================

// Every field that can carry a relocation is a whole number of bytes, stored
// low byte first, at the end of its instruction.  All three parts earn their
// keep:
//
//   whole bytes, low byte first  makes applying a fixup `number_to_chars_
//                                littleendian' and nothing else
//   at the end                   makes md_pcrel_from uniform - fx_where +
//                                fr_address + fx_size is the address of the
//                                next instruction for all eleven pcrel forms,
//                                and tc_gen_reloc's addend bias is fx_size
for (const r of rows) {
  const wanted = r.slots.map((s, i) => [s, i]).filter(([s]) => s.reloc !== 'FR_R_NONE');
  for (const [slot, i] of wanted) {
    const ps = r.places.filter((p) => p.slot === i);
    const lo = Math.min(...ps.map((p) => p.ilo));
    const W  = ps.reduce((a, p) => a + p.width, 0);
    if (lo !== 0 || W % 8 !== 0 || W !== slot.bits)
      throw new Error(`${r.tag}: relocatable field is ${W} bits at bit ${lo}, `
                    + `wanted ${slot.bits} ending the instruction`);
    // Reading the instruction's bytes upwards must give the value's bytes from
    // least significant to most.  Both the count and the placement are
    // checked, since a field laid out the other way round comes back as one
    // contiguous run rather than W/8 byte-sized ones.
    const ok = ps.length === W / 8
            && ps.every((p) => p.width === 8 && p.ilo === lo + (W - 8) - p.vlo);
    if (!ok)
      throw new Error(`${r.tag}: relocatable field is not stored low byte first `
                    + `(${ps.length} run(s): `
                    + ps.map((p) => `value[${p.vlo + p.width - 1}:${p.vlo}] at insn bit ${p.ilo}`).join(', ')
                    + `)`);
  }
}

// A slot is determined exactly once: pinned, tied, or placed.  An operand that
// is none of those would be silently discarded.
for (const r of rows)
  r.slots.forEach((s, i) => {
    const placed = r.places.some((p) => p.slot === i);
    const ways = (s.fixed ? 1 : 0) + (s.tie >= 0 ? 1 : 0) + (placed ? 1 : 0);
    if (s.kind === 'FR_CK') return;              // constrains its anchor, encodes nothing
    if (ways !== 1) throw new Error(`${r.tag}: slot ${i} is determined ${ways} ways`);
  });

// =============================================================================
// condimm5: the spellings the assembler accepts
// =============================================================================
//
// The table holds 32 (condition, constant) pairs, and a programmer may write a
// different pair that means the same thing - `le #3` for `lt #4`, `hs #1` for
// `ne #0`.  Those are found by comparing truth sets at the instruction's own
// width, rather than by a rule about +/-1, because the interesting ones are not
// all of that shape.  Identical logic lives in gen-customasm.js; the two agree
// because tests/run.sh assembles the same source with both.
function truthBits(cond, k, w) {
  const mask = (1 << w) - 1, half = 1 << (w - 1);
  const sgn = (v) => (v & mask) >= half ? (v & mask) - (1 << w) : (v & mask);
  const kw = k & mask, ks = sgn(k);
  let out = '';
  for (let x = 0; x <= mask; x++) {
    const xs = sgn(x), d = xs - ks;
    let r;
    switch (cond) {
      case 'eq': r = x === kw; break;              case 'ne': r = x !== kw; break;
      case 'lt': r = xs <  ks; break;              case 'le': r = xs <= ks; break;
      case 'gt': r = xs >  ks; break;              case 'ge': r = xs >= ks; break;
      case 'lo': r = x  <  kw; break;              case 'ls': r = x  <= kw; break;
      case 'hi': r = x  >  kw; break;              case 'hs': r = x  >= kw; break;
      case 'vs': r = d < -half || d >= half; break;
      case 'vc': r = !(d < -half || d >= half); break;
      default:   return null;
    }
    out += r ? '1' : '0';
  }
  return out;
}

// THE COMPARISON WIDTH IS PART OF THE SPELLING.  br reads the table at 16 bits
// and br8 at 8, and an identity at one width need not hold at the other - so
// the accept list is per width, and a slot says which one it wants.
//
// Requiring both widths instead is subtly wrong, and cost `br le, r3, #0'.  At
// 16 bits `le #0' is `lt #1'; at 8 bits `lt #1' and `lt #-32767' have the same
// truth set, because -32767 & 255 is 1 - so the eight-bit table maps that set
// to the later entry and the two widths disagree about which index to use.
// The eight-bit coincidence has nothing to do with a sixteen-bit branch.
const WIDTHS = [8, 16];
const conds = Object.keys(t.cond3.swapped ?? {}).concat(t.cond3.names);
const cd = t.condimm5.values;

const accept = [];                      // { cond, imm, index, width }
const tag = (c, k) => `${c} ${u16(k)}`;

for (const w of WIDTHS) {
  const seen = new Set();
  const canon = new Map();
  cd.forEach((e, i) => {
    accept.push({ cond: e[0], imm: u16(e[1]), index: i, width: w });
    seen.add(tag(e[0], e[1]));
    const b = truthBits(e[0], e[1], w);
    if (b && !canon.has(b)) canon.set(b, i);      // the first entry, so the table's
  });                                             // own order decides collisions
  for (const [, k] of cd)
    for (const kk of [k - 1, k, k + 1])
      for (const c of conds) {
        if (seen.has(tag(c, kk))) continue;
        const idx = canon.get(truthBits(c, kk, w));
        if (idx === undefined) continue;
        seen.add(tag(c, kk));
        accept.push({ cond: c, imm: u16(kk), index: idx, width: w });
      }
}

// =============================================================================
// Aliases: pure text rewrites, exactly as customasm gets them
// =============================================================================
//
// An alias has no encoding.  It matches a syntax, captures each operand's text
// unexamined, and builds the line the target instruction would have been
// written as, so the rewrite knows nothing about types and form selection then
// runs normally.  `mov rd, rs' becomes `or rd, rs, #0', and shortest-first
// selection finds the one-byte encoding when the registers are r0 and r1.
const aliases = (spec.alias ?? []).map((al) => {
  const slots = [];
  const syntax = al.syntax.replace(/\{([A-Za-z_]\w*)\}/g, (m, r) => {
    const i = slots.indexOf(r);
    if (i >= 0) return `%${i}`;
    slots.push(r);
    return `%${slots.length - 1}`;
  });
  const target = spec.insn.find((i) => i.mnemonic === al.expand.mnemonic
    && (i.operands ?? []).every((o) => o.name in al.expand.args)
    && Object.keys(al.expand.args).length === (i.operands ?? []).length);
  if (!target) throw new Error(`alias ${al.mnemonic}: nothing named ${al.expand.mnemonic} takes those arguments`);
  const body = target.syntax.replace(/\{([A-Za-z_]\w*)\}/g, (m, r) => {
    const v = al.expand.args[r];
    if (typeof v === 'number') return `${v}`;
    const neg = v.startsWith('-');
    const nm = neg ? v.slice(1) : v;
    const i = slots.indexOf(nm);
    if (i < 0) throw new Error(`alias ${al.mnemonic}: argument names unknown '${v}'`);
    // `-imm' has to survive being pasted into a larger expression.
    return neg ? `-(%${i})` : `%${i}`;
  });
  return { mnemonic: al.mnemonic, syntax, nslots: slots.length,
           body: `${target.mnemonic} ${body}` };
});

// =============================================================================
// Emit
// =============================================================================

const banner = `/* Fructus assembler tables.

   GENERATED by tools/gen-asm.js from isa/fructus.toml.  Do not edit; edit the
   spec and run \`npm run binutils\`.

   This file is part of the GNU Binutils.  It is free software; you can
   redistribute it and/or modify it under the terms of the GNU General Public
   License as published by the Free Software Foundation; either version 3, or
   (at your option) any later version.  */

`;

if (mode === 'header') {
  process.stdout.write(`${banner}#ifndef _FRUCTUS_ASM_H_
#define _FRUCTUS_ASM_H_

/* The form table: one row per (instruction, encoding form), sorted shortest
   first, and gas takes the first row that accepts what the programmer wrote.
   That ordering is the "prefer the smaller encoding" rule; there is no size
   search in the assembler.  */

/* How an operand is written.  FR_CC and FR_CK are the two halves of a
   condimm5, which is written as a condition and a constant in different places
   on the line - \`br lt, r0, #4, target' - but encodes as one five-bit index.
   FR_CC carries that index; FR_CK only constrains which entry is chosen.  */
enum fructus_opnd_kind
{
  FR_REG,	/* r0..r7, and the spellings sp and lr */
  FR_INT,	/* an expression, which may be a symbol */
  FR_TABLE,	/* an expression that must APPEAR in a value table */
  FR_COND,	/* a cond3 name */
  FR_CC,	/* the condition half of a condimm5 */
  FR_CK		/* the constant half of a condimm5 */
};

/* Which value table an FR_TABLE operand must appear in.  "Fits" for a table
   type means "is one of these values", which drops into the same test that a
   range check provides for an ordinary integer.  */
enum fructus_valtab
{
  FR_T_NONE, FR_T_IMM3, FR_T_SHIFT3, FR_T_IMMBIT5, FR_T_IMMASK5
};

/* What a SYMBOLIC value needs.  A field too narrow to hold a whole address or
   displacement has FR_R_NONE, and a symbol therefore does not fit that form -
   the same "does it fit" test again, with no special case.  */
enum fructus_reloc
{
  FR_R_NONE, FR_R_8, FR_R_16, FR_R_8_PCREL, FR_R_16_PCREL
};

typedef struct fructus_opnd
{
  unsigned char kind;		/* enum fructus_opnd_kind */
  unsigned char table;		/* enum fructus_valtab, for FR_TABLE */
  unsigned char reloc;		/* enum fructus_reloc */
  unsigned char bits;		/* encoded width, for FR_INT */
  unsigned char is_signed;
  unsigned char pcrel;
  unsigned char swapped;	/* FR_COND: read the mirrored name set */
  signed char   tie;		/* must equal this slot, or -1 */
  signed char   fixed;		/* 1 if the form pins this operand */
  long          value;		/* the pinned value, when fixed */
} fructus_opnd;

/* Value bits -> instruction bits.  The instruction is one word with byte 0 in
   the most significant position, so emitting is a shift loop and no form
   assembles its own bytes.  */
typedef struct fructus_place
{
  unsigned char slot;
  unsigned char vlo;		/* low bit of the slice taken from the value */
  unsigned char width;
  unsigned char ilo;		/* low bit it occupies in the instruction word */
} fructus_place;

typedef struct fructus_form
{
  const char *          mnemonic;
  const char *          syntax;	/* literal text, %0..%9 for slots */
  unsigned char         nbytes;
  unsigned char         nslots;
  unsigned char         nplaces;
  unsigned long         base;	/* the fixed bits */
  const fructus_opnd *  slots;
  const fructus_place * places;
} fructus_form;

extern const fructus_form fructus_forms[];
extern const unsigned int fructus_nforms;

/* Which rows a first byte can decode to.  A list, because the mnemonic is not a
   function of byte 0: length is - the ISA commits to that - while the unary
   block packs sxt8, clz and popcount into opcode 0x32 and separates them with
   two bits of byte 1.  Each entry carries the byte-1 mask and match that
   selects it, and the first match wins.

   Printing through the row's syntax is what makes a listing reassemblable: an
   itype is a bit layout, and \`ld rd, [ra, #imm3]' and \`add rd, ra, #imm3'
   share one.  */
typedef struct fructus_cand
{
  unsigned char mask;		/* which bits of byte 1 select this row */
  unsigned char match;
  short         form;		/* index into fructus_forms */
} fructus_cand;

extern const fructus_cand fructus_opcode_cand[];
extern const short fructus_opcode_first[257];	/* [b] .. [b+1] is b's range */

/* The condimm5 spellings the assembler accepts: the 32 table entries, plus
   every other way of writing the same predicate.  \`le #3' and \`lt #4' are one
   entry; so are \`hs #1' and \`ne #0'.  Derived by comparing truth sets at both
   8 and 16 bits, not by a rule about +/-1.  */
typedef struct fructus_condimm
{
  const char *   cond;
  unsigned short imm;		/* as written, masked to 16 bits */
  unsigned char  index;		/* the five-bit field it encodes to */
  unsigned char  width;		/* the comparison width it holds at: 8 or 16 */
} fructus_condimm;

extern const fructus_condimm fructus_condimm_accept[];
extern const unsigned int fructus_ncondimm_accept;

/* An alias is a text rewrite: it captures each operand's text unexamined and
   builds the line the target would have been written as, then ordinary form
   selection runs on that.  No types are involved.  */
typedef struct fructus_alias
{
  const char *  mnemonic;
  const char *  syntax;		/* literal text, %0..%9 */
  unsigned char nslots;
  const char *  body;		/* the rewritten line, same %N references */
} fructus_alias;

extern const fructus_alias fructus_aliases[];
extern const unsigned int fructus_naliases;

/* Every spelling of a register and of a condition the assembler accepts, flat
   rather than indexed by encoding because the map is not one-to-one: \`cs' and
   \`hs' both encode as \`ls'.

   A condition's \`swapped' flag marks a mirrored spelling: \`br gt, ra, rb, L'
   is \`br lt, rb, ra, L'.  cond3 carries an operand-order bit, which is how
   twelve spellings fit into eight encodings; a form marked swapped reads only
   these and has its register places already exchanged.  */
typedef struct fructus_name
{
  const char *  name;
  unsigned char index;
  unsigned char swapped;
} fructus_name;

extern const fructus_name fructus_reg_accept[];
extern const unsigned int fructus_nreg_accept;
extern const fructus_name fructus_cond_accept[];
extern const unsigned int fructus_ncond_accept;

#endif /* _FRUCTUS_ASM_H_ */
`);
} else {
  const opnd = (s) => `{ ${s.kind}, ${s.table}, ${s.reloc}, ${s.bits}, ${s.signed}, `
                    + `${s.pcrel}, ${s.swapped}, ${s.tie}, ${s.fixed}, ${s.value} }`;
  const place = (p) => `{ ${p.slot}, ${p.vlo}, ${p.width}, ${p.ilo} }`;

  const decls = rows.map((r, i) => {
    const so = `static const fructus_opnd sl${i}[] =\n  { ${r.slots.map(opnd).join(',\n    ')} };`;
    const pl = r.places.length
      ? `static const fructus_place pl${i}[] =\n  { ${r.places.map(place).join(', ')} };`
      : `#define pl${i} NULL`;
    return `/* ${r.tag} */\n${so}\n${pl}`;
  }).join('\n\n');

  const table = rows.map((r, i) =>
    `    { "${r.mnemonic}", "${r.syntax}", ${r.nbytes}, ${r.slots.length}, `
    + `${r.places.length}, 0x${r.base.toString(16).padStart(r.nbytes * 2, '0')}, `
    + `sl${i}, pl${i} },${' '.repeat(Math.max(1, 2))}/* ${r.tag} */`).join('\n');

  // Every accepted spelling, flat.  Direct names first so a listing reads in
  // encoding order, then the extra spellings, then the mirrored ones.
  const nameRows = (names, aliases, swapped) => {
    const out = names.map((n, i) => ({ name: n, index: i, swapped: 0 }));
    for (const [from, to] of Object.entries(aliases ?? {})) {
      const i = names.indexOf(to);
      if (i < 0) throw new Error(`alias ${from}: ${to} is not a name`);
      out.push({ name: from, index: i, swapped: 0 });
    }
    for (const [from, to] of Object.entries(swapped ?? {})) {
      const i = names.indexOf(to);
      if (i < 0) throw new Error(`swapped ${from}: ${to} is not a name`);
      out.push({ name: from, index: i, swapped: 1 });
    }
    return out;
  };
  const regAccept  = nameRows(t.reg.names, t.reg.aliases, null);
  const condAccept = nameRows(t.cond3.names, t.cond3.aliases, t.cond3.swapped);
  const nameArr = (cname, rows) =>
    `const fructus_name ${cname}[] =\n  {\n`
    + rows.map((r) => `    { "${r.name}", ${r.index}, ${r.swapped} }`).join(',\n')
    + `\n  };\n\nconst unsigned int ${cname.replace('fructus_', 'fructus_n')} = ${rows.length};\n`;

  process.stdout.write(`${banner}#include "sysdep.h"
#include "opcode/fructus-asm.h"

${decls}

const fructus_form fructus_forms[] =
  {
${table}
  };

const unsigned int fructus_nforms = ${rows.length};

const fructus_cand fructus_opcode_cand[] =
  {
${cand.map((c) => `    { 0x${c.mask.toString(16).padStart(2, '0')}, `
                + `0x${c.match.toString(16).padStart(2, '0')}, ${String(c.form).padStart(3)} }`).join(',\n')}
  };

const short fructus_opcode_first[257] =
  {
${(() => { const out = []; for (let i = 0; i < 257; i += 8)
    out.push('    ' + firstCand.slice(i, i + 8).map((v) => String(v).padStart(3)).join(', ')
             + (i + 8 < 257 ? ',' : '') + `   /* 0x${i.toString(16).padStart(2, '0')} */`);
  return out.join('\n'); })()}
  };

const fructus_condimm fructus_condimm_accept[] =
  {
${accept.map((a) => `    { "${a.cond}", 0x${a.imm.toString(16).padStart(4, '0')}, ${a.index}, ${a.width} }`).join(',\n')}
  };

const unsigned int fructus_ncondimm_accept = ${accept.length};

const fructus_alias fructus_aliases[] =
  {
${aliases.map((a) => `    { "${a.mnemonic}", "${a.syntax}", ${a.nslots}, "${a.body}" }`).join(',\n')}
  };

const unsigned int fructus_naliases = ${aliases.length};

${nameArr('fructus_reg_accept', regAccept)}
${nameArr('fructus_cond_accept', condAccept)}`);
}

process.stderr.write(`gen-asm: ${rows.length} forms, ${accept.length} condimm5 spellings, `
                   + `${aliases.length} aliases\n`);
