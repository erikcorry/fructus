#!/usr/bin/env node
// =============================================================================
// gen-immgen.js - the immediate unit, generated from isa/fructus.toml
// =============================================================================
//
//   node tools/gen-immgen.js > rtl/immgen.sv
//
// One combinational block that produces the 16-bit immediate right-hand side
// for every instruction that has one: the ALU and shift groups, mov, the load
// and store displacements, and the two mask branches.  58 opcodes.
//
// Its inputs are the instruction register - rtl/insn.sv, every byte at a fixed
// position - plus ONE control line.  Every distinction but one is already
// in those five bits; the exception is the packed branch, whose five-bit field
// is a condimm5 index rather than a signed imm5 and sits in the same column.
// See rtl/immgen.sv's own header for why that line is worth a microcode bit.
//
// THE VALUE TABLES ARE READ FROM THE SPEC, not transcribed.  tests/immgen-
// check.mjs generates its vectors from the same TOML and runs them against the
// generated Verilog under iverilog, so a table edit that the circuit cannot
// express fails the suite rather than shipping.
// =============================================================================

import { loadSpec } from './isa.js';

const spec = loadSpec();
const t = spec.optype;
const hex16 = (v) => `16'h${(((v) >>> 0) & 0xffff).toString(16).padStart(4, '0')}`;

// --- the properties this circuit depends on, asserted here as well as in
// --- check.js, because a generator that silently emits wrong logic is worse
// --- than one that refuses to run.
for (let n = 0; n < 16; n++) {
  for (const name of ['immbit5', 'immask5'])
    if (((t[name].values[n] ^ t[name].values[n + 16]) & 0xffff) !== 0xffff)
      throw new Error(`${name}: entry ${n + 16} is not the complement of ${n}`);
}
for (let n = 0; n < 8; n++)
  if ((t.imm3.values[n] & 15) !== (t.shift3.values[n] & 15))
    throw new Error(`shift3[${n}] is not imm3[${n}] & 15`);

// The two mask tables are one shifter, which is a property of their ORDER:
// index bits 3:2 are a row, bits 1:0 a column, and an entry is its column's
// nibble shifted left four places per row.  immbit5's nibble is 1 << column;
// immask5's is whatever row 0 holds, except in OVERRIDE, whose four entries
// replace the shifter's output outright.
const OVERRIDE = 2;
const low16 = (name) => t[name].values.slice(0, 16).map((v) => (v >>> 0) & 0xffff);
low16('immbit5').forEach((v, n) => {
  if (v !== 1 << n) throw new Error(`immbit5: entry ${n} is not 1 << ${n}, so it is not the shifter's`);
});
const maskLow = low16('immask5');
const nibble = [0, 1, 2, 3].map((c) => (c === OVERRIDE ? null : maskLow[c]));
const special = [0, 1, 2, 3].map((row) => maskLow[4 * row + OVERRIDE]);
for (let row = 0; row < 4; row++)
  for (let c = 0; c < 4; c++) {
    if (c === OVERRIDE) continue;
    if (nibble[c] > 15 || maskLow[4 * row + c] !== (nibble[c] << (4 * row)))
      throw new Error(`immask5: entry ${4 * row + c} is not column ${c}'s nibble shifted ${4 * row} places`);
  }

// And the columns are the mode mux's tree: every form reading one of these
// tables must sit in its column, or the circuit below reads the wrong one.
const COLUMN = { imm5: [0], condimm5: [0], imm10: [1], imm3: [2, 3], shift3: [2, 3], immbit5: [4], immask5: [5] };
for (const insn of spec.insn)
  for (const form of insn.form ?? []) {
    const op = form.encoding.replace(/_/g, '').split(/\s+/)[0];
    const types = Object.values(form.fields ?? {}).map((f) => f.split(':')[1].replace(/\[.*$/, ''));
    for (const ty of types.filter((x) => x in COLUMN)) {
      const cols = [...Array(8).keys()].filter((v) =>
        [0, 1, 2].every((k) => !/[01]/.test(op[5 + k]) || Number(op[5 + k]) === ((v >> (2 - k)) & 1)));
      if (cols.some((c) => !COLUMN[ty].includes(c)))
        throw new Error(`${insn.mnemonic}/${form.name}: ${ty} at column +${cols.join('/+')}, but rtl/immgen.sv reads it at +${COLUMN[ty].join('/+')}`);
    }
  }
const nibRows = [0, 1, 2, 3].map((c) =>
  `        3'b0_${c.toString(2).padStart(2, '0')}: nib = 4'b${(1 << c).toString(2).padStart(4, '0')};`).concat(
  [0, 1, 2, 3].map((c) =>
  `        3'b1_${c.toString(2).padStart(2, '0')}: nib = 4'b${c === OVERRIDE ? 'xxxx' : nibble[c].toString(2).padStart(4, '0')};`)).join('\n');
const specialRows = special.map((v, row) => `        2'd${row}: special = ${hex16(v)};`).join('\n');

const caseBody = (name, vals, w) =>
  vals.map((v, n) => `        ${w}'d${n}: ${name} = ${hex16(v)};`).join('\n');

const caseTable = (name, vals, w, sel) =>
  `    always_comb case (${sel})\n` +
  vals.map((v, n) => `        ${w}'d${n}: ${name} = ${hex16(v)};`).join('\n') +
  `\n    endcase`;

process.stdout.write(`// =============================================================================
// immgen.sv - the immediate right-hand side
// =============================================================================
//
// GENERATED by tools/gen-immgen.js from isa/fructus.toml.  Do not edit; edit
// the spec and regenerate with \`npm run rtl\`.
//
// One combinational block serving 58 opcodes: every ALU and shift group, mov,
// the load and store displacements, and brclear/brset.  Its inputs are the
// instruction register and one microcode line, cimm.  NOTHING ELSE - no width
// bit, no shift bit, no opcode decode.  Five properties of the encoding make
// that possible.
//
// 1. THE COLUMN IS THE MODE.  Every instruction with an immediate puts it in
//    the same column of the opcode map, so opcode[2:0] alone says which of the
//    five immediate modes to produce:
//
//      +0  imm5      signed -16..15, and the tied load displacement
//      +1  imm10     signed, spanning two bytes
//      +2  imm3      the small-constant table  (+3 is its second opcode)
//      +4  immbit5   32 single-bit masks
//      +5  immask5   32 field and stripe masks
//      +6, +7              the three-operand forms: NO IMMEDIATE
//
//    and \`cimm\` selects a sixth mode at +0, for the packed branch alone.
//
//    THE ORDER IS A TREE.  opcode[2] takes the two mask tables, which are one
//    circuit; below it opcode[1] takes imm3; below that opcode[0] chooses
//    between the two sign-extended slices.  Every level of the mux reads one
//    bit.  The generator checks that every form in the spec sits in the column
//    this reads it from.
//
// 2. +6 AND +7 ARE DELIBERATELY UNDEFINED.  Everything there takes its
//    right-hand side from a register, and rtl/rhs.sv gets that register's
//    number straight off the instruction bytes rather than from here - so this
//    block computing it too would be a second copy of the same three wires,
//    free to drift from the first.
//
//    What this block drives there is whatever the tree gives - the mask
//    shifter's output - rather than an x, because the measured circuit has no
//    mux input to spend on one.  It is meaningless all the same: reading it
//    means the microcode asked for an immediate from an instruction that has
//    none.  0x88..0x8f make that concrete - they are \`mov rd, #imm16\`,
//    where opcode[2:0] is the DESTINATION REGISTER and not a mode selector at
//    all, so this block's output there is meaningless for a third reason again.
//    rtl/rhs.sv gives that instruction its value directly, as code 4.
//
// 3. opcode[0] IS sel[0].  The imm3 index is {byte1[7:6], opcode[0]} - the spec
//    spells this \`imm3[0]\`, so the pair of opcodes at +2 and +3 ARE the low
//    index bit.  It is already an input; the index costs no logic.
//
// 4. THE TWO 5-BIT TABLES ARE ONE SHIFTER.  For both immbit5 and immask5 the
//    upper sixteen entries are exact bitwise complements of the lower sixteen,
//    and in the lower sixteen, bits 3:2 of the index are a row and bits 1:0 a
//    column: an entry is its column's nibble shifted left four places per
//    row.  immbit5's nibble is 1 << column; immask5's are row 0's entries,
//    except column ${OVERRIDE}, whose byte and swizzle masks replace the shifter's
//    output.  So four LUT4s make the nibble from the column and sel[0] (+4
//    against +5), one shift places it, the override patches one column, and
//    the complement XOR is applied once.  All asserted by the generator.
//
// 5. imm3 AND shift3 ARE ONE TABLE.  They differ at index 0 alone, -1 against
//    15, and the shifter masks its right-hand side to four bits, so -1 IS 15 to
//    a shift.  shift3 is an assembler vocabulary - it exists to reject
//    \`shl rd, ra, #-1\` - and the datapath never needs to know about it.
//
// EVERY FIELD IS AT ONE POSITION FOR THE WHOLE INSTRUCTION.  rtl/insn.sv puts
// each byte at its place - byte 0 low - so what this block reads is:
//
//     sel                                 insn[2:0]
//     imm5, immbit5, immask5, condimm5    insn[15:11]
//     imm3 index                          {insn[15:14], insn[0]}
//     imm10                               insn[23:14]
//
// all of them slices, and none of them moving when a later byte arrives.
//
// THAT USED TO BE A CONTRACT ON THE MICROCODE.  This block once read a shifting
// immreg holding the newest two bytes, where byte 1 moved up as byte 2 came in.
// Any five-bit field had to be consumed before the third byte was fetched -
// brclear's mask test ahead of its displacement - and imm10's two halves sat at
// opposite ends of the register, though they are adjacent in the stream.
// Neither is true now: a mask can be read in any cycle of its instruction, and
// imm10 is the one slice invariant 4b in tools/check.js says it is.
//
// NEITHER br FORM RIDES THIS BLOCK.  The two-register branches are at +6 and
// +7, where there is no immediate; and the packed form at +0 reads five bits
// through condimm5, which fuses a condition with a constant rather than being a
// plain immediate.  The branch unit decodes that one for itself.
//
// WHY cimm IS A MICROCODE BIT AND NOT DECODED HERE.  immgen could work it out
// for itself - the packed branch is 0xa0 and 0xa8, so \`(op & 0xf7) == 0xa0\` -
// and that was the first design.  It is a seven-input function of the opcode
// REGISTER, so it lands two LUT levels in front of the mode mux, and measured
// in one harness against the other it costs a level and a quarter of the clock:
// 115 SB_LUT4 at four levels and 71 MHz, against 109 at three levels and 91.
// A registered microcode line arrives at level zero and the mux absorbs it.
//
// THE SHARED SHIFTER AND THE COLUMN TREE, measured on an iCE40 UP5K, yosys 0.52
// + nextpnr-ice40 0.7, the median of eight placement seeds in the processor:
//
//                                         alone   with rhs   cpu   cpu MHz
//     two tables, masks at +1 and +5        112       176    947     23.7
//     one shifter, masks at +1 and +5        89       152    934     23.4
//     one shifter, masks at +4 and +5        95       158    911     23.9
//       and the opcodes moved to match       95       158    938     23.3
//
// The first three rows read the old opcode map everywhere but here; the last
// is the processor as generated, whose rtl/predecode.sv table came out 13
// LUT4 larger once its rows moved, with nothing in it changed but their order.
//
// The clock is the same in all four, inside what the seeds wander by: the
// immediate settles before the register value it meets in rtl/rhs.sv.  What
// moved is area, and the processor only kept the shifter's saving once the
// columns made its select a single bit.  Forcing the shifter's output to stay a
// net, with (* keep *), cost 29 LUT4 and no speed.
//
// EARLIER, as two tables: 111 SB_LUT4 for
// the block alone, and 87 MHz placed in a registered harness (three seeds:
// 86.9 / 86.7 / 73.0).
//
// MOVING TO THE 24-BIT REGISTER CHANGED NOTHING HERE, as a change of wiring
// should not.  One harness, -nobram, medians of five seeds: 132 SB_LUT4 and
// 85.1 MHz reading a shifting immreg, 130 and 83.4 reading insn.sv - the same
// two LUT levels, and a gap well inside what the seeds wander by.
//
// The byte 1 re-layout cost six LUT4 here, the one place it cost anything.
// Measured against the same tools, the old layout was 105 SB_LUT4 and
// 87.3 / 88.4 / 80.2 MHz: the same clock within placement noise, six fewer
// cells.
//
// The six have a specific cause.  Before, \`i5\` and \`i10\` shared their low
// five bits, so five bits of the mode mux below were free.  Now \`i5[4:0]\` is
// insn[15:11] and \`i10[4:0]\` is insn[18:14], which do not coincide, so those
// five bits need real muxing - one level wide rather than deep, which is why
// the clock holds.
//
// What it buys is in software: a decoder extracting a signed imm10 from a
// 16-bit load went from four instructions to one, and an imm5 from two to one,
// because every immediate is now a contiguous top-aligned slice of the
// instruction stream.  See invariants 4b and 4c in tools/check.js.
// =============================================================================

module immgen (
    input  logic [23:0] insn,   // the instruction, byte 0 low: rtl/insn.sv
    input  logic        cimm,   // microcode: read +0's five bits as condimm5
    output logic [15:0] imm
);

    wire [2:0] sel = insn[2:0];                     // the column

    // --- +0 / +1: the two modes that are pure wiring ------------------------
    wire [15:0] i5  = {{11{insn[15]}}, insn[15:11]};   // +0  imm5, and off5
    // imm10 is byte 1's top two bits and all of byte 2: one slice.
    wire [15:0] i10 = {{6{insn[23]}}, insn[23:14]};    // +1  imm10

    // --- +2 / +3: imm3, which is also shift3 --------------------------------
    wire [2:0] k3 = {insn[15:14], insn[0]};
    logic [3:0] lo3;
${caseTable('lo3', t.imm3.values.map((v) => v & 15), 3, 'k3').replace(/16'h([0-9a-f]{4})/g, (_, h) => `4'h${h.slice(-1)}`)}
    // Index 0 is the only entry whose top twelve bits are set: -1 for the ALU,
    // and 15 to a shifter, which masks.  One gate, not a second table.
    wire neg = (k3 == 3'd0);
    wire [15:0] i3v = {{12{neg}}, lo3};

    // --- +4 / +5: immbit5 and immask5, one nibble shifter --------------------
    wire [4:0] n5  = insn[15:11];
    wire [1:0] col = n5[1:0], row = n5[3:2];
    wire       msk = sel[0];                        // +4 immbit5, +5 immask5
    logic [3:0] nib;                                // four LUT4s
    always_comb case ({msk, col})
${nibRows}
    endcase
    wire [15:0] shv = {12'd0, nib} << {row, 2'b00};
    logic [15:0] special;                           // immask5's column ${OVERRIDE}
    always_comb case (row)
${specialRows}
    endcase
    wire        ovr  = msk & (col == 2'd${OVERRIDE});
    wire [15:0] tsel = (ovr ? special : shv) ^ {16{n5[4]}};

    // --- +0 again, for the packed branch ------------------------------------
    // \`br cond, ra, #imm5\` puts a condimm5 index in the same five bits that
    // every other +0 form reads as a signed integer, so this is a whole table
    // rather than a reinterpretation of one.  It is 32 entries indexed directly,
    // and it is two LUT levels - the same depth as the mask tables beside it -
    // so it joins the mode mux rather than sitting in front of it.
    logic [15:0] ccon;
    always_comb case (n5)
${caseBody('ccon', spec.optype.condimm5.values.map((e) => e[1]), 5)}
    endcase

    // --- the mode mux, a tree on the column bits ------------------------------
    // cimm is ignored anywhere but +0.  Asserting it elsewhere is a microcode
    // bug, and folding it into +0's leg rather than driving x keeps every level
    // of the tree a single select bit.
    wire [15:0] sext = sel[0] ? i10 : (cimm ? ccon : i5);   // +0, +1
    wire [15:0] low  = sel[1] ? i3v : sext;                 // +0 .. +3
    assign imm = sel[2] ? tsel : low;                       // +4, +5; +6, +7 too

endmodule
`);
