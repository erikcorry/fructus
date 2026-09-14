#!/usr/bin/env node
// =============================================================================
// gen-ucode.js - the microcode ROM, from isa/fructus.toml
// =============================================================================
//
//   node tools/gen-ucode.js > rtl/ucode.sv
//
// The sequencer: a synchronous ROM whose address is either the opcode on the
// bus, in a dispatch step, or the current word's `next`.  Its words carry only
// what changes from step to step; everything an instruction wants throughout
// comes from rtl/predecode.sv.
//
// WHAT IT RUNS SO FAR: every instruction whose whole effect is one register
// written with an ALU result - the ALU groups, mov, the unary operations, iseq
// and isset, in their two- and three-byte forms - plus halt and nop.  The
// one-byte abbreviations are not here yet, and every other opcode goes to a
// trap word, so a program cannot run an unimplemented instruction silently.
// Which opcodes are which is worked out from the spec, through tools/control.js.
// =============================================================================

import { loadSpec } from './isa.js';
import { buildDecoder, decode } from './decode.js';
import { ALU_RULES, ALU_ELSEWHERE, ALU_LATER } from './control.js';

const spec = loadSpec();
const dec = buildDecoder(spec);

// --- the word ------------------------------------------------------------------
// next comes first so that it is the top of the word; the flags follow in the
// order the module unpacks them.
const ADDR = 9;
const FIELDS = [
  ['next',     ADDR, 'the address of the following step, unless this one dispatches'],
  ['fetch',    1,    'the byte on the bus is the next byte of this instruction'],
  ['dispatch', 1,    'the byte on the bus is the next opcode: it addresses the ROM'],
  ['wen',      1,    'write the ALU result to the register rtl/dest.sv names'],
  ['halt',     1,    'stopped: the step repeats and consumes nothing'],
  ['trap',     1,    'an opcode this ROM does not implement yet'],
];
const W = FIELDS.reduce((n, [, w]) => n + w, 0);

// --- the shared steps, above the 256 entry points ------------------------------
const STEP = { EXEC: 256, FETCH2: 257, HALT: 258, TRAP: 259, BOOT: 260 };
const word = (w) => ({ next: 0, fetch: 0, dispatch: 0, wen: 0, halt: 0, trap: 0, ...w });
const rom = new Array(1 << ADDR).fill(null);
const why = new Map();
rom[STEP.EXEC]   = word({ wen: 1, dispatch: 1 });        why.set(STEP.EXEC, 'write the result; the next opcode is on the bus');
rom[STEP.FETCH2] = word({ fetch: 1, next: STEP.EXEC });  why.set(STEP.FETCH2, 'fetch byte 2');
rom[STEP.HALT]   = word({ halt: 1, next: STEP.HALT });   why.set(STEP.HALT, 'stay here');
rom[STEP.TRAP]   = word({ trap: 1, next: STEP.TRAP });   why.set(STEP.TRAP, 'stay here, flagged');
rom[STEP.BOOT]   = word({ dispatch: 1 });                why.set(STEP.BOOT, 'after reset: the first opcode is on the bus');

// --- the entry points ------------------------------------------------------------
const classify = (d) => {
  const sem = d.insn.semantics ?? '';
  if (sem === 'halted = 1') return 'halt';
  if (sem === '') return 'nop';
  if (d.nbytes < 2 || ALU_LATER.has(d.insn.mnemonic)) return 'trap';
  if (sem.includes(';') || /M(8|16)\[/.test(sem) || !/^R\[[a-z]\] = /.test(sem)) return 'trap';
  if (ALU_ELSEWHERE.some(([re]) => re.test(sem)) || !ALU_RULES.some(([re]) => re.test(sem))) return 'trap';
  return d.nbytes === 2 ? 'alu2' : 'alu3';
};
const ENTRY = {
  alu2: () => word({ fetch: 1, next: STEP.EXEC }),
  alu3: () => word({ fetch: 1, next: STEP.FETCH2 }),
  halt: () => word({ halt: 1, next: STEP.HALT }),
  nop:  () => word({ dispatch: 1 }),
  trap: () => word({ trap: 1, next: STEP.TRAP }),
};
const byClass = { alu2: [], alu3: [], halt: [], nop: [], trap: [] };
const opcodesIn = { alu2: 0, alu3: 0, halt: 0, nop: 0, trap: 0 };
for (let op = 0; op < 256; op++) {
  const classes = new Map();   // class -> the mnemonics this opcode carries in it
  for (let b1 = 0; b1 < 256; b1++) {
    const d = decode(dec, [op, b1, 0], 0);
    if (!d) continue;
    const c = classify(d);
    classes.set(c, new Set([...(classes.get(c) ?? []), d.insn.mnemonic]));
  }
  if (classes.size > 1)
    throw new Error(`0x${op.toString(16)}: byte 1 decides between ${[...classes].map(([c, m]) => `${[...m].join('/')} (${c})`).join(' and ')}`);
  const cls = classes.size ? [...classes.keys()][0] : 'trap';
  rom[op] = ENTRY[cls]();
  opcodesIn[cls]++;
  byClass[cls].push(...(classes.size ? [...classes.values()][0] : [`0x${op.toString(16).padStart(2, '0')}`]));
}

// --- emitting ---------------------------------------------------------------------
const pack = (w) => FIELDS.map(([n, width]) => (w[n] ?? 0).toString(2).padStart(width, '0')).join('_');
const inits = rom.map((w, a) => (w ? `        rom[${a}] = ${W}'b${pack(w)};` : null)).filter(Boolean).join('\n');
const wrap = (words, first, indent, width = 79) => {
  const lines = []; let cur = first, fresh = true;
  for (const w of words) {
    if (!fresh && cur.length + 1 + w.length > width) { lines.push(cur); cur = indent; fresh = true; }
    cur += (fresh ? '' : ' ') + w; fresh = false;
  }
  lines.push(cur); return lines.join('\n');
};
const uniq = (xs) => [...new Set(xs)];
const listed = (cls) => wrap(uniq(byClass[cls]), '//         ', '//         ');
const fieldText = FIELDS.map(([n, w, d]) => `//     ${n.padEnd(9)} ${String(w).padStart(2)}  ${d}`).join('\n');
const stepText = Object.entries(STEP).map(([n, a]) => `//     ${String(a).padStart(3)}  ${n.padEnd(7)} ${pack(rom[a])}  ${why.get(a)}`).join('\n');
const unpack = FIELDS.map(([n]) => n).join(', ');

process.stdout.write(`// =============================================================================
// ucode.sv - the microcode ROM and its sequencer
// =============================================================================
//
// GENERATED by tools/gen-ucode.js from isa/fructus.toml.  Do not edit; edit the
// spec, tools/control.js or the generator and run \`npm run rtl\`.
//
// A ${1 << ADDR}-word ROM of ${W}-bit words, read synchronously - an iCE40 block RAM,
// initialised from the bitstream.  Its address is the opcode on the bus in a
// step that dispatches, and the word's \`next\` otherwise.  The word:
//
${fieldText}
//
// The first 256 words are the entry points, one per opcode; the shared steps
// sit above them:
//
${stepText}
//
// THE ALU INSTRUCTIONS NEED ALMOST NOTHING HERE, because rtl/predecode.sv has
// already decided their operation and every source.  One cycle per byte:
//
//     cycle   bus             word                  does
//       1     opcode          the previous EXEC     address the ROM with the bus
//       2     byte 1          entry: fetch          byte 1 into rtl/insn.sv
//      (3     byte 2          FETCH2: fetch         three-byte forms only)
//       3     next opcode     EXEC: wen, dispatch   write the result, dispatch
//
// So every two-byte ALU opcode has the same entry word, and so does every
// three-byte one - the ALU operations share not only their successor but
// their whole routine.  The write and the next dispatch share a cycle, and
// nothing conflicts: the write uses the instruction already in rtl/insn.sv and
// rtl/predecode.sv, and the new opcode goes in at the edge that ends it.
//
// ENTRY POINTS, by what the spec says each opcode does:
//
//     two-byte ALU:
${listed('alu2')}
//     three-byte ALU:
${listed('alu3')}
//     halt:
${listed('halt')}
//     nop - its entry dispatches at once, since the next opcode is already on
//     the bus:
${listed('nop')}
//     trap - ${opcodesIn.trap} opcodes, every one not yet implemented and every free one.
//
// RESET forces the address to BOOT for as long as it is held, so the first
// word after it dispatches the byte at address 0.  The ROM's output register
// cannot be reset on the part; forcing the address instead needs no reset on
// the block RAM at all.
//
// MEASURED - see rtl/cpu.sv.
// =============================================================================

module ucode (
    input  logic        clk,
    input  logic        rst,
    input  logic [7:0]  bus,       // the byte on the data bus this cycle
    output logic        fetch,
    output logic        dispatch,
    output logic        wen,
    output logic        halt,
    output logic        trap
);

    (* ram_style = "block" *)
    logic [${W - 1}:0] rom [0:${(1 << ADDR) - 1}];
    initial begin
${inits}
    end

    logic [${W - 1}:0] word;
    wire  [${ADDR - 1}:0] next;
    assign {${unpack}} = word;

    wire [${ADDR - 1}:0] addr = rst ? ${ADDR}'d${STEP.BOOT} : (dispatch ? {1'b0, bus} : next);
    always_ff @(posedge clk) word <= rom[addr];

endmodule
`);
