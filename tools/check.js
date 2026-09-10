#!/usr/bin/env node
// =============================================================================
// check.js - validate isa/fructus.toml against the invariants in its header
// =============================================================================
//
//   npm run check
//
// Checks the six encoding invariants the spec documents, plus the internal
// consistency of the operand types and aliases, then prints the
// opcode map.  Exits non-zero on any failure.
//
// This is the tool that keeps an evolving opcode map honest: invariants 5 and 6
// are the ones that catch a new instruction quietly colliding with an old one.
// =============================================================================

import { parse } from 'smol-toml';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const specPath = process.argv[2] ?? join(root, 'isa/fructus.toml');

const spec = parse(readFileSync(specPath, 'utf8'));
const errors = [];
const err = (m) => errors.push(m);

// --- operand types -----------------------------------------------------------
const types = spec.optype;
for (const [name, t] of Object.entries(types)) {
  const dup = (xs, what) => {
    if (new Set(xs).size !== xs.length)
      err(`optype ${name}: duplicate ${what}, reverse lookup is ambiguous`);
  };
  if (t.kind === 'table') {
    // Invariant 4a: a table is a complete, distinct value set.
    if (t.values.length !== 2 ** t.bits)
      err(`optype ${name}: ${t.values.length} values for ${t.bits} bits`);
    dup(t.values, 'values');
  } else if (t.kind === 'reg' || t.kind === 'enum') {
    if (t.names.length !== 2 ** t.bits)
      err(`optype ${name}: ${t.names.length} names for ${t.bits} bits`);
    dup(t.names, 'names');
    for (const [spelling, target] of Object.entries(t.aliases ?? {})) {
      if (!t.names.includes(target)) err(`optype ${name}: alias ${spelling} -> unknown ${target}`);
      if (t.names.includes(spelling)) err(`optype ${name}: alias ${spelling} shadows a real name`);
    }
    for (const [spelling, target] of Object.entries(t.swapped ?? {})) {
      if (!t.names.includes(target)) err(`optype ${name}: swapped ${spelling} -> unknown ${target}`);
      if (t.names.includes(spelling)) err(`optype ${name}: swapped ${spelling} shadows a real name`);
    }
  } else if (t.kind === 'combo') {
    // A combo may be shorter than 2^bits while the table is being designed.
    if (t.values.length > 2 ** t.bits)
      err(`optype ${name}: ${t.values.length} entries exceeds ${2 ** t.bits}`);
    for (const v of t.values)
      if (v.length !== t.parts.length)
        err(`optype ${name}: entry [${v}] has ${v.length} values for ${t.parts.length} parts`);
    dup(t.values.map((v) => v.join(' ')), 'entries');
  }
}

// =============================================================================
// The object format, against binutils itself
// =============================================================================
// e_machine is `unsigned char e_machine[2]` - sixteen bits - and NOTHING in the
// toolchain range-checks a value assigned to it.  A wider constant compiles, is
// written through bfd_put_16, and silently loses its top bits: the header says
// one thing and every object produced says another, with no error anywhere.
// That is the same shape as the byte-order trap tests/data.s exists to pin, so
// it is asserted here rather than trusted.
//
// The collision check reads the REAL include/elf/common.h out of the
// vendor/binutils-gdb submodule, so it keeps working as binutils allocates new
// official numbers.  A copy of the list here would be right on the day it was
// written and wrong afterwards.  If the submodule is not checked out the check
// says so and skips, rather than passing silently.
{
  const elf = spec.elf;
  if (!elf) err('no [elf] section: the object format is part of the spec');
  else {
    if (!Number.isInteger(elf.machine) || elf.machine < 0 || elf.machine > 0xffff)
      err(`[elf] machine 0x${(elf.machine ?? 0).toString(16)} does not fit e_machine's 16 bits, `
        + `and nothing downstream would tell you - bfd_put_16 truncates in silence`);

    const hdr = join(root, 'vendor/binutils-gdb/include/elf/common.h');
    if (!existsSync(hdr)) {
      console.log('note: vendor/binutils-gdb not checked out, so [elf] machine '
                + 'was NOT checked for collisions');
    } else {
      const text = readFileSync(hdr, 'utf8');
      const claimed = new Map();
      for (const m of text.matchAll(/#define\s+(EM_[A-Z0-9_]+)\s+(0x[0-9a-fA-F]+|\d+)/g))
        claimed.set(Number(m[2]), m[1]);
      // The number must be OURS or nobody's.  Before the port landed this was
      // a pure collision check; now that EM_FRUCTUS is in the header the same
      // test has to accept our own entry - and still reject the case that
      // matters, which is somebody else's name on our number.
      const holder = claimed.get(elf.machine);
      if (holder && holder !== elf.machine_id)
        err(`[elf] machine 0x${elf.machine.toString(16)} is ${holder} in `
          + `include/elf/common.h, not ${elf.machine_id}`);
      else if (!holder)
        console.log(`elf: machine 0x${elf.machine.toString(16)} (${elf.machine_id}) is `
                  + `unclaimed among the ${claimed.size} values in binutils`);
      else
        console.log(`elf: machine 0x${elf.machine.toString(16)} is ${elf.machine_id} in `
                  + `include/elf/common.h, as the spec says`);
    }
  }

  // The relocations only have to be internally coherent - a pc-relative field
  // that is not signed cannot reach backwards, which is never what is meant.
  for (const r of spec.reloc ?? []) {
    if (![8, 16].includes(r.bits))
      err(`reloc ${r.name}: ${r.bits} bits, but every Fructus field is 8 or 16`);
    if (r.pcrel && !r.signed)
      err(`reloc ${r.name}: pc-relative but unsigned, so it could not branch backwards`);
  }
}

// =============================================================================
// Relationships BETWEEN tables that the hardware is built on
// =============================================================================
// The checks above ask whether each table is well formed.  These ask whether
// two tables still stand in the relation that rtl/immgen.sv exploits to collapse
// them - which is a property of the VALUES, invisible to any per-table check,
// and silently destroyed by an ordinary-looking edit.
//
// Breaking one of these is allowed.  What is not allowed is breaking it without
// noticing, so the failure names the cost rather than forbidding the change.
{
  const u16 = (v) => (v >>> 0) & 0xffff;

  // immbit5 and immask5 are each sixteen values plus their complements, so the
  // two tables share ONE complement layer: choose the sixteen-entry half with
  // opcode[2], then XOR with the field's top bit.  An entry above 15 that is
  // not the complement of the one sixteen below it needs its own 32-entry
  // lookup, which is a second XOR layer - about 16 LUT4 on an iCE40.
  for (const name of ['immbit5', 'immask5']) {
    const v = types[name]?.values;
    if (!v || v.length !== 32) continue;
    for (let n = 0; n < 16; n++)
      if (u16(v[n] ^ v[n + 16]) !== 0xffff)
        err(`optype ${name}: entry ${n + 16} is not the complement of entry ${n}, `
          + `so the two mask tables can no longer share a complement layer`);
  }

  // imm3 and shift3 differ at index 0 alone - -1 against 15 - and every shift
  // masks its right-hand side to four bits, so -1 IS 15 to a shift.  That is
  // why the immediate unit has no shift3 table and no `is_shift` input: shift3
  // is an assembler vocabulary, there to reject `shl rd, ra, #-1`, and the
  // datapath never distinguishes it.  Change a value so the masks differ and
  // the hardware needs a second table and a control line to select it.
  const i3 = types.imm3?.values, s3 = types.shift3?.values;
  if (i3 && s3 && i3.length === s3.length)
    for (let n = 0; n < i3.length; n++)
      if ((i3[n] & 15) !== (s3[n] & 15))
        err(`optype shift3: entry ${n} is ${s3[n]}, but imm3[${n}] & 15 is ${i3[n] & 15}; `
          + `the shifter masks to four bits, so these must agree or the immediate `
          + `unit needs a separate shift3 table`);
}

// =============================================================================
// Combo tables: every entry must mean something no other entry means
// =============================================================================
// A combo entry is a PREDICATE on a register, and two entries that denote the
// same predicate waste a slot even when their spellings differ - because for
// integers `x <= k` is `x < k+1` and `x > k` is `x >= k+1`.  The distinctness
// check above compares (condition, constant) pairs and cannot see that, so the
// test here is semantic: evaluate each entry over every register value it could
// see and compare the truth sets.
//
// THE COMPARISON WIDTH MATTERS.  br8 compares low bytes, br16 whole words, and
// both index the SAME table - so two entries only waste a slot if they agree at
// BOTH widths.  Differing at either width means both are earning their place.
const WIDTHS = [8, 16];

// The truth set of one predicate, as a packed bitmap over all 2^w register
// values.  Returns null for a condition this evaluator does not model.
function truthSet(cond, k, w) {
  const mask = (1 << w) - 1, half = 1 << (w - 1);
  const sgn = (v) => ((v & mask) >= half ? (v & mask) - (1 << w) : (v & mask));
  const kw = k & mask, ks = sgn(kw);
  const bits = Buffer.alloc((mask + 1) / 8);
  for (let x = 0; x <= mask; x++) {
    const xs = sgn(x), d = xs - ks;
    let r;
    switch (cond) {
      case 'eq': r = x === kw;            break;
      case 'ne': r = x !== kw;            break;
      case 'lt': r = xs <  ks;            break;   // signed
      case 'le': r = xs <= ks;            break;
      case 'gt': r = xs >  ks;            break;
      case 'ge': r = xs >= ks;            break;
      case 'lo': r = x  <  kw;            break;   // unsigned
      case 'ls': r = x  <= kw;            break;
      case 'hi': r = x  >  kw;            break;
      case 'hs': r = x  >= kw;            break;
      case 'vs': r = d < -half || d >= half; break; // signed overflow of x - k
      case 'vc': r = !(d < -half || d >= half); break;
      default:   return null;
    }
    if (r) bits[x >> 3] |= 1 << (x & 7);
  }
  return bits;
}

for (const [name, t] of Object.entries(types)) {
  if (t.kind !== 'combo') continue;

  // Each part may declare the optype it draws its values from.  That is what
  // makes the LUT's output width computable, and it is worth stating: a table
  // whose entries wander outside those domains needs wider control signals than
  // the parts suggest.
  if (t.domain) {
    let outBits = 0;
    const shape = [];
    for (const part of t.parts) {
      const dn = t.domain[part];
      if (!dn) { err(`optype ${name}: part '${part}' has no domain`); continue; }
      const d = types[dn];
      if (!d) { err(`optype ${name}: part '${part}' names unknown domain '${dn}'`); continue; }
      const i = t.parts.indexOf(part);

      // An enum reached through `swapped` needs one extra bit of output: the
      // operand order the swap stands for.
      const swap = d.kind === 'enum' && d.swapped ? 1 : 0;
      outBits += d.bits + swap;
      shape.push(`${dn} ${d.bits}${swap ? ' + order 1' : ''}`);

      for (const entry of t.values) {
        const v = entry[i];
        let ok;
        if (d.kind === 'enum' || d.kind === 'reg')
          ok = d.names.includes(v) || v in (d.aliases ?? {}) || v in (d.swapped ?? {});
        else if (d.kind === 'table') ok = d.values.includes(v);
        else if (d.kind === 'int')   ok = Number.isInteger(v);
        else ok = true;
        if (!ok) err(`optype ${name}: '${v}' is not in ${dn}, so part '${part}' escapes its domain`);
      }
    }
    console.log(`${name}: ${t.values.length} entries selecting ${outBits} bits of output ` +
                `(${shape.join(', ')})`);
  }

  // The semantic check.  Only meaningful for the (condition, constant) shape.
  const ci = t.values[0]?.findIndex((v) => typeof v === 'string');
  const ki = t.values[0]?.findIndex((v) => typeof v === 'number');
  if (ci === undefined || ci < 0 || ki < 0) continue;

  const seen = new Map();
  let unmodelled = 0;
  for (const entry of t.values) {
    const cond = entry[ci], k = entry[ki];
    const sets = WIDTHS.map((w) => truthSet(cond, k, w));
    if (sets.some((s) => s === null)) { unmodelled++; continue; }
    const key = sets.map((s) => s.toString('base64')).join('|');
    const prior = seen.get(key);
    if (prior)
      err(`optype ${name}: '${cond} #${k}' means exactly what '${prior}' means, ` +
          `at both ${WIDTHS.join(' and ')} bits - one of the two is a wasted slot`);
    else seen.set(key, `${cond} #${k}`);
  }
  if (unmodelled)
    err(`optype ${name}: ${unmodelled} entries use a condition check.js cannot evaluate`);

  // Rewrites: spellings the assembler accepts and canonicalises onto an entry
  // that IS in the table.  Each must be a genuine identity - checked the same
  // way the duplicates are, by comparing truth sets - with a source that is not
  // encodable and a target that is.  Getting this wrong would silently assemble
  // the wrong branch.
  const inTable = (c, k) => t.values.some(([a, b]) => a === c && b === k);
  for (const rw of t.rewrite ?? []) {
    const [fc, fk] = rw.from, [tc, tk] = rw.to;
    if (inTable(fc, fk))
      err(`optype ${name}: rewrite source '${fc} #${fk}' is already in the table, so it rewrites nothing`);
    if (!inTable(tc, tk))
      err(`optype ${name}: rewrite target '${tc} #${tk}' is not in the table`);
    const identical = WIDTHS.every((w) => {
      const a = truthSet(fc, fk, w), b = truthSet(tc, tk, w);
      return a && b && a.equals(b);
    });
    if (!identical)
      err(`optype ${name}: rewrite '${fc} #${fk}' -> '${tc} #${tk}' is NOT an identity`);
  }
}

const FIELD_RE = /^([A-Za-z_]\w*):([A-Za-z_]\w*)(?:\[(\d+)(?::(\d+))?\])?$/;
const forms = [];

for (const insn of spec.insn) {
  const ops = insn.operands ?? [];
  const opByName = Object.fromEntries(ops.map((o) => [o.name, o]));

  for (const form of insn.form) {
    const tag = `${insn.mnemonic}/${form.name ?? form.encoding}`;
    const chars = form.encoding.replace(/[\s_]/g, '').split('');
    const n = chars.length;

    // Invariant 1: whole bytes.
    if (n % 8) { err(`${tag}: ${n} bits is not a whole number of bytes`); continue; }

    // Fixed bits -> mask/match.  Letters -> positions within the instruction.
    let mask = 0n, match = 0n;
    const letters = new Map();
    chars.forEach((c, i) => {
      const w = 1n << BigInt(n - 1 - i);
      if (c === '0') mask |= w;
      else if (c === '1') { mask |= w; match |= w; }
      else if (/[a-z]/.test(c)) {
        if (!letters.has(c)) letters.set(c, []);
        letters.get(c).push(i);
      } else err(`${tag}: bad character '${c}' in encoding`);
    });

    // Resolve each letter to (operand, encoded type, which bits of it).
    const covered = new Map(); // operand name -> Set of covered bit indices
    const encType = new Map(); // operand name -> encoded type name
    const inStream = new Map(); // operand name -> [[value bit, stream bit], ...]
    for (const [letter, positions] of letters) {
      const explicit = form.fields?.[letter];
      let opName, typeName, bitIdx;

      if (explicit) {
        const m = FIELD_RE.exec(explicit);
        if (!m) { err(`${tag}: cannot parse field spec '${explicit}'`); continue; }
        opName = m[1]; typeName = m[2];
        if (m[3] !== undefined) {
          const hi = +m[3], lo = m[4] !== undefined ? +m[4] : +m[3];
          bitIdx = [];
          if (hi >= lo) for (let b = hi; b >= lo; b--) bitIdx.push(b);
          else for (let b = hi; b <= lo; b++) bitIdx.push(b);
        }
      } else {
        const cands = ops.filter((o) => o.name.startsWith(letter));
        if (cands.length !== 1) {
          err(`${tag}: letter '${letter}' matches ${cands.length} operands; needs an explicit fields entry`);
          continue;
        }
        opName = cands[0].name;
        typeName = cands[0].type;
      }

      const op = opByName[opName];
      if (!op) { err(`${tag}: letter '${letter}' names unknown operand '${opName}'`); continue; }
      const t = types[typeName];
      if (!t) { err(`${tag}: unknown type '${typeName}'`); continue; }

      // Default bit selection: this letter carries the whole field, MSB first.
      if (!bitIdx) bitIdx = Array.from({ length: positions.length }, (_, k) => positions.length - 1 - k);
      if (bitIdx.length !== positions.length)
        err(`${tag}: letter '${letter}' occupies ${positions.length} bits but selects ${bitIdx.length}`);

      const prev = encType.get(opName);
      if (prev && prev !== typeName)
        err(`${tag}: operand '${opName}' encoded as both ${prev} and ${typeName}`);
      encType.set(opName, typeName);

      if (!covered.has(opName)) covered.set(opName, new Set());
      const set = covered.get(opName);
      bitIdx.forEach((b, k) => {
        if (set.has(b)) err(`${tag}: operand '${opName}' bit ${b} assigned twice`);
        set.add(b);
        // Where this bit lands in a LITTLE-ENDIAN STREAM REGISTER - one loaded
        // from the instruction stream, byte 0 at the bottom.  The encoding
        // string is written MSB-first WITHIN each byte and byte 0 first, so
        // getting from one to the other means finding the byte and then the
        // bit inside it.
        const pos = positions[k];
        const byte = Math.floor(pos / 8);
        const stream = byte * 8 + (7 - (pos % 8));
        if (!inStream.has(opName)) inStream.set(opName, []);
        inStream.get(opName).push([b, stream]);
      });
    }

    // Invariant 2: the encoded bits exactly cover the encoded type.
    for (const [opName, set] of covered) {
      const t = types[encType.get(opName)];
      if (!t) continue;
      for (let b = 0; b < t.bits; b++)
        if (!set.has(b)) err(`${tag}: operand '${opName}' bit ${b} is never encoded`);
      for (const b of set)
        if (b >= t.bits) err(`${tag}: operand '${opName}' bit ${b} is outside ${encType.get(opName)}`);
    }

    // Invariant 3: every operand is determined - by a field, by fix, or by a
    // tie to something itself determined.
    const fix = form.fix ?? {}, tie = form.tie ?? {};
    for (const op of ops) {
      const determined = covered.has(op.name) || op.name in fix ||
        (op.name in tie && (covered.has(tie[op.name]) || tie[op.name] in fix));
      if (!determined) err(`${tag}: operand '${op.name}' is not determined by this form`);
    }

    // Invariant 4: fix and tie name real operands.
    for (const opName of Object.keys(fix))
      if (!opByName[opName]) err(`${tag}: fix names unknown operand '${opName}'`);
    for (const [a, b] of Object.entries(tie))
      if (!opByName[a] || !opByName[b]) err(`${tag}: tie ${a}=${b} names an unknown operand`);

    // --- Invariant 4b: EVERY FIELD IS ONE CONTIGUOUS SLICE OF THE STREAM ----
    //
    // Load the instruction stream into a register, little endian, byte 0 at the
    // bottom.  Every operand field must then be a single contiguous run of
    // bits, in order - so extracting it is a shift and a mask, and extracting a
    // SIGNED one that reaches the top of the register is a lone `asr'.
    //
    // This is why byte 1 puts the first operand in the LOW bits and gives a
    // split immediate its LOW bits: it is what makes the field come out
    // contiguous once the bytes are in memory order.  Before that change the
    // ten-bit displacement of `ld rd, [ra, #imm10]' arrived in two pieces six
    // bits apart, and reassembling it cost four instructions against one.
    //
    // Who cares: a self-hosted disassembler or monitor, and any implementation
    // that buffers more than two bytes of the stream - an icache-line decoder
    // sees exactly this register.  The current two-byte immreg does NOT, because
    // it holds {byte1, byte2} with byte 1 in the high half, which is the reverse
    // of how those bytes sit in memory.  That narrow buffer is the special case.
    //
    // THE ONE ALLOWED EXCEPTION is a field that borrows its LOW bit from the
    // opcode byte - the third-register selector, and the imm3 index.  Those are
    // deliberate: the bit is in byte 0 because that is what keeps the opcode map
    // dense.  So byte 0's share is checked separately and must be the field's
    // low bits.  Any OTHER split is a mistake, and this is what says so.
    for (const [opName, bits] of inStream) {
      if (bits.length < 2) continue;
      const inOpcode = bits.filter(([, sb]) => sb < 8).sort((a, b) => a[0] - b[0]);
      const rest     = bits.filter(([, sb]) => sb >= 8).sort((a, b) => a[0] - b[0]);
      const run = (xs) => xs.every(([vb, sb], k) =>
        k === 0 || (vb === xs[k - 1][0] + 1 && sb === xs[k - 1][1] + 1));

      if (!run(rest))
        err(`${tag}: operand '${opName}' is not one contiguous slice of a `
          + `little-endian stream register (bits ${rest.map(([v, s]) => `${v}@${s}`).join(' ')}), `
          + `so extracting it costs more than a shift and a mask`);
      if (inOpcode.length) {
        if (!run(inOpcode))
          err(`${tag}: operand '${opName}' has a scattered share of byte 0`);
        if (inOpcode[0][0] !== 0 || inOpcode[inOpcode.length - 1][0] !== inOpcode.length - 1)
          err(`${tag}: operand '${opName}' borrows bits ${inOpcode.map((x) => x[0]).join(',')} `
            + `from the opcode byte, but only its LOW bits may live there`);
      }
    }

    // --- Invariant 4c: EVERY SIGNED IMMEDIATE IS TOP-ALIGNED ----------------
    //
    // Contiguity makes a field a shift and a mask.  This makes a SIGNED one a
    // single `asr': if the field's high bit is the top bit of the instruction,
    // then in a register loaded from the stream it is already at the top, and
    // one arithmetic shift right both positions it and sign extends it.
    //
    //   iiii_iddd            imm5[4] at stream bit 15   asr r0, r0, #11
    //   iiaa_addd jjjj_jjjj  imm10[9] at stream bit 23  asr r0, r0, #6
    //
    // With byte 1 the other way round - dddi_iiii - imm5 lands at stream[12:8]
    // and costs a shift first: two instructions instead of one, measured.  So
    // this is the invariant that pays for byte 1 putting the first operand in
    // the low bits, and it is exactly what an edit back to the old layout
    // breaks.
    for (const [opName, bits] of inStream) {
      const t = types[encType.get(opName)];
      if (!t || t.kind !== 'int' || !t.signed) continue;
      const top = bits.reduce((a, b) => (b[0] > a[0] ? b : a));
      if (top[1] !== n - 1)
        err(`${tag}: signed immediate '${opName}' has its high bit at stream `
          + `bit ${top[1]}, not ${n - 1} - so sign extending it needs a shift `
          + `before the asr, not just the asr`);
    }

    forms.push({ tag, insn, form, n, nbytes: n / 8, mask, match,
                 mask0: Number((mask >> BigInt(n - 8)) & 0xffn),
                 match0: Number((match >> BigInt(n - 8)) & 0xffn) });
  }
}

// --- invariant 5: length is determined by byte 0 -----------------------------
const table = Array.from({ length: 256 }, () => []);
for (const f of forms)
  for (let b = 0; b < 256; b++)
    if ((b & f.mask0) === f.match0) table[b].push(f);

for (let b = 0; b < 256; b++) {
  const lens = new Set(table[b].map((f) => f.nbytes));
  if (lens.size > 1)
    err(`byte 0x${b.toString(16).padStart(2, '0')}: ambiguous length ${[...lens]} ` +
        `(${table[b].map((f) => f.tag).join(', ')})`);
}

// --- invariant 6: no two forms overlap ---------------------------------------
for (let i = 0; i < forms.length; i++)
  for (let j = i + 1; j < forms.length; j++) {
    const A = forms[i], B = forms[j];
    if (A.n !== B.n) continue;
    if (((A.match ^ B.match) & (A.mask & B.mask)) === 0n)
      err(`forms overlap: ${A.tag} and ${B.tag}`);
  }

// --- aliases: no encodings, but the rewrite must land on something real ------
const byMnemonic = {};
for (const i of spec.insn) (byMnemonic[i.mnemonic] ??= []).push(i);

for (const al of spec.alias ?? []) {
  const tag = `alias ${al.mnemonic}`;
  const targets = byMnemonic[al.expand.mnemonic];
  if (!targets) { err(`${tag}: expands to unknown mnemonic '${al.expand.mnemonic}'`); continue; }
  const args = al.expand.args;
  const mine = new Set(al.operands.map((o) => o.name));
  // An argument is a reference when it names one of the alias's own operands,
  // and a literal otherwise - a number, or an enum/reg spelling.
  const isRef = (v) => typeof v === 'string' && mine.has(v.replace(/^-/, ''));
  // Exactly one target entry must have precisely the operands the rewrite fills.
  const keys = new Set(Object.keys(args));
  const fits = targets.filter((t) => {
    const names = new Set(t.operands.map((o) => o.name));
    return names.size === keys.size && [...keys].every((k) => names.has(k));
  });
  if (fits.length !== 1)
    err(`${tag}: rewrite matches ${fits.length} '${al.expand.mnemonic}' entries, need exactly 1`);

  // A preferred alias is run BACKWARDS by the disassembler, so the rewrite has
  // to be invertible: each of its own operands used exactly once, no repeats.
  if (al.prefer) {
    const refs = Object.values(args).filter(isRef).map((v) => v.replace(/^-/, ''));
    if (new Set(refs).size !== refs.length)
      err(`${tag}: prefer requires distinct operand references, got ${refs.join(', ')}`);
    for (const o of al.operands)
      if (!refs.includes(o.name))
        err(`${tag}: prefer requires every operand used; '${o.name}' is not`);
  }
}

// --- the hand-written opcode map in the header comment ------------------------
// That block is prose, and prose drifts.  It has already been wrong once: nop
// and halt swapped encodings and the comment kept the old order, which nothing
// would have caught.  So every line of it that names one opcode is checked
// against the encodings below it.
//
// An alias may stand in for what it expands to - the block says `br` where the
// encoding says `br8`, and that is the point of the alias.
{
  const aliasOf = new Map();
  for (const a of spec.alias ?? []) {
    if (!aliasOf.has(a.expand?.mnemonic)) aliasOf.set(a.expand?.mnemonic, new Set());
    aliasOf.get(a.expand?.mnemonic).add(a.mnemonic);
  }
  const at = (b) => {
    const names = new Set();
    for (const f of table[b] ?? []) {
      names.add(f.insn.mnemonic);
      for (const x of aliasOf.get(f.insn.mnemonic) ?? []) names.add(x);
    }
    return names;
  };
  let n = 0;
  for (const line of readFileSync(specPath, "utf8").split('\n')) {
    const m = /^#\s+([01]{4}_[01]{4})\s{2,}(\S+)/.exec(line);
    if (!m) continue;
    n++;
    const b = parseInt(m[1].replace('_', ''), 2);
    const claim = m[2];
    const names = at(b);
    if (claim === '--') { if (names.size) err(`opcode map comment: ${m[1]} is listed free but holds ${[...names].join('/')}`); }
    else if (!names.has(claim)) err(`opcode map comment: ${m[1]} is listed as ${claim} but holds ${names.size ? [...names].join('/') : 'nothing'}`);
  }
  if (!n) err('opcode map comment: found no lines to check - has the block moved?');
}

// --- report ------------------------------------------------------------------
console.log('opcode  len  instruction');
console.log('------  ---  -----------');
const rows = [...forms].sort((a, b) => a.match0 - b.match0);
for (const f of rows) {
  const lo = [...Array(256).keys()].filter((b) => (b & f.mask0) === f.match0);
  const range = lo.length === 1
    ? `0x${lo[0].toString(16).padStart(2, '0')}     `
    : `0x${lo[0].toString(16).padStart(2, '0')}-${lo[lo.length - 1].toString(16).padStart(2, '0')}`;
  console.log(`${range}  ${f.nbytes}    ${f.tag.padEnd(18)} ${f.form.encoding}`);
}
const used = table.filter((l) => l.length).length;
console.log(`\n${forms.length} forms, ${used}/256 first-byte opcodes used, ${256 - used} free`);

if (errors.length) {
  console.log('\nFAIL:');
  for (const e of errors) console.log('  ' + e);
  process.exit(1);
}
console.log('\nAll invariants hold.');
