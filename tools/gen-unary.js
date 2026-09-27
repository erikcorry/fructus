#!/usr/bin/env node
// =============================================================================
// gen-unary.js - the unary ALU, from isa/fructus.toml
// =============================================================================
//
//   node tools/gen-unary.js > rtl/unary.sv
//
// Two pairs of unary operations: a fast pair that is wiring - sxt8 and bitrev -
// and a slow pair - clz and popcount - whose result is registered, because the
// spec gives those two an extra cycle.  clmul may join either opcode as its
// third operation, and is built to match: wiring on the fast one, registered
// halfway on the slow one.  The OPERATIONS are hand-written below;
// where each sits, and which is fast, comes from the spec through
// tools/control.js, so an operation cannot be added or moved without this file
// either implementing it or refusing to run.
// =============================================================================

import { unaryLayout } from './control.js';

const L = unaryLayout();

const IMPL = {
  sxt8:     'sxt',
  bitrev:   'rev',
  clz:      "{11'd0, cl_q}",
  popcount: "{11'd0, pc}",
  clmul:    "{1'b0, cm}",
};
for (const o of L.ops)
  if (!(o.mnemonic in IMPL)) throw new Error(`unary ${o.mnemonic} is not implemented by rtl/unary.sv`);
if ([...L.fast, ...L.slow].some((m, i) => m && ['sxt8', 'bitrev'].includes(m) !== i < 2))
  throw new Error(`clz and popcount must be the slow pair and sxt8 and bitrev the fast one: fast ${L.fast}, slow ${L.slow}`);
for (const t of [L.fastThird, L.slowThird])
  if (t && t.mnemonic !== 'clmul') throw new Error(`only clmul can be a third unary operation, not ${t.mnemonic}`);

const impl = (m) => (m ? IMPL[m] : "16'hxxxx");
// One select bit per pair, and a second for an opcode that holds a third.
const selS = L.wide ? `sel[${L.selBit - 1}]` : 'sel';
const selO = `sel[${L.otherBit - 1}]`;
const mux = (pair, third) => {
  const two = `${selS} ? ${impl(pair[1])} : ${impl(pair[0])}`;
  return third ? `${third.level ? '' : '~'}${selO} ? ${impl(third.mnemonic)} : ${two}` : two;
};
const names = (pair, third) => [...pair, third?.mnemonic].filter(Boolean).join(' or ');

// --- clmul, one output bit at a time --------------------------------------------
// Bit k of the product is the XOR of a[i] & a[8+j] over every i + j = k: one
// term at each end, eight in the middle, sixty-four in all.
const terms = [...Array(15).keys()].map((k) => [...Array(8).keys()]
  .filter((i) => k - i >= 0 && k - i < 8).map((i) => `a[${i}] & a[${8 + k - i}]`));
const clmul = L.fastThird ? 'fast' : L.slowThird ? 'slow' : null;
let clmulRtl = '';
if (clmul === 'fast') {
  clmulRtl = `    // --- clmul: the carry-less product of a's two bytes, in the same cycle ---------
    // Two LUT4 levels: each LUT of the first takes two partial products, and one
    // more XORs up to four of those.  Sixty-four ANDs, no carries.  Measured on
    // the processor, 53 cells and no clock that the placement seeds can see -
    // the same cells the registered form costs, so it is not registered.  The
    // table is in isa/fructus.toml, at clmul.
    wire [14:0] cm;
${terms.map((t, k) => `    assign cm[${String(k).padStart(2)}] = ${t.join(' ^ ')};`).join('\n')}

`;
} else if (clmul === 'slow') {
  // Pairs of partial products, each pair one LUT4: the flop goes after them.
  const pairs = terms.map((t) => [...Array(Math.ceil(t.length / 2)).keys()].map((j) => t.slice(2 * j, 2 * j + 2).join(' ^ ')));
  const width = pairs.flat().length;
  let at = 0;
  const slices = pairs.map((p) => { const lo = at; at += p.length; return [lo, at - 1]; });
  clmulRtl = `    // --- clmul: the carry-less product of a's two bytes, over two cycles ----------
    // THE FLOP GOES AFTER ONE LUT LEVEL, for popcount's reason: each LUT4 takes
    // two partial products and XORs them in the SLOW cycle, ${width} of them, and EXEC
    // XORs up to four of those.  A LUT's flop is in the same logic cell, so the
    // register costs the cells the first level needed anyway.
    logic [${width - 1}:0] cq;
    always_ff @(posedge clk) cq <= {
${pairs.flat().map((e, i) => `        ${e}`).reverse().join(',\n')}
    };
    wire [14:0] cm;
${slices.map(([lo, hi], k) => `    assign cm[${String(k).padStart(2)}] = ${lo === hi ? `cq[${lo}]` : `^cq[${hi}:${lo}]`};`).join('\n')}

`;
}
const hex = (n) => `0x${n.toString(16).padStart(2, '0')}`;
const listed = [...L.ops].sort((a, b) => a.code - b.code).map((o) =>
  `//     ${String(o.code).padStart(2)}    ${hex(o.op)}   ${String(o.index).padStart(2)}      ${String(o.value).padStart(3)}      ${o.mnemonic.padEnd(9)} ${o.slow ? 'slow' : 'fast'}`)
  .join('\n');

const pcRows = [...Array(16).keys()]
  .map((n) => `        4'h${n.toString(16)}: cnt4 = 3'd${n.toString(2).split('').filter((c) => c === '1').length};`)
  .join('\n');
const clzRows = [...Array(16).keys()].map((i) => {
  const pat = '0'.repeat(i) + '1' + '?'.repeat(15 - i);
  return `        16'b${pat}: cl = 5'd${i};`;
}).join('\n');

process.stdout.write(`// =============================================================================
// unary.sv - the unary ALU
// =============================================================================
//
// GENERATED by tools/gen-unary.js from isa/fructus.toml.  Do not edit; edit the
// spec, tools/control.js or the generator and run \`npm run rtl\`.
//
// ${L.wide ? `${L.ops.length} operations on two opcodes, a pair on each and ${L.fastThird ? 'clmul on the fast one' : 'clmul on the slow one'}` : 'Four operations in two pairs, one opcode each'}:
//
//   code  opcode  imm3 index  rhs value  operation
${listed}
//
// \`code\` is rhs[2:1]: the unary forms sit in the imm3 columns, rtl/immgen.sv
// turns {byte1[7:6], opcode[0]} into a value, and rtl/rhs.sv puts it on the bus
// the ALU already reads.  Within each pair the two codes differ in rhs[${L.selBit}]
// alone, so ONE bit of that value picks the operation, and which pair is
// rtl/alu.sv's operation code - 12 fast, 13 slow - from rtl/predecode.sv.${L.wide ? `
// A third operation on an opcode is the one code there whose rhs[${L.otherBit}] differs
// from the pair's, so that bit comes in too and that opcode's mux is three-way.` : ''}
//
// THE SLOW PAIR IS REGISTERED.  clz and popcount are the deep operations:
// measured in the processor, taking both out of the single cycle was worth a
// tenth of the clock, and taking either alone was not, because they are
// equally deep.  So their result goes into a register at the end of every
// cycle, and the instructions that use it declare an extra cycle in the spec -
// rtl/ucode.sv waits one step before the write.  lhs and the selector do not
// change between the two cycles, so the registered value is the right one.
// The fast pair, sxt8 and bitrev, is wiring and stays combinational.
//
// THAT SPLIT FALLS ON THE OPCODE BECAUSE THE MICROCODE'S ENTRY POINTS DO.  The
// wait is a different routine, and an entry point is chosen by the first byte;
// byte 1 cannot pick it.  tools/control.js refuses a layout in which a pair
// straddles two opcodes.
//
// NOTHING HERE FORCES A CARRY CHAIN.  popcount's adds are written as gates, not
// with \`+\`, so synthesis infers no carry cells: the adds become LUT logic placed
// alongside the rest of the block, not in the fabric's fixed carry columns.
// Measured, popcount's carry chains had cost more clock in routing than its
// eleven LUTs suggested.
//
// clz IS THE PRIORITY ENCODER, not the nibble-and-NOR version, and clz(0) = 16
// is kept deliberately: an instruction whose result depends on how it was
// reached is a bad thing to have in an ISA, even though leaving it undefined
// would drop the answer to four bits.
//
// MEASURED - see rtl/cpu.sv.
// =============================================================================

module unary (
    input  logic        clk,
    input  logic [15:0] a,
    input  logic ${L.wide ? '[1:0]  sel,     // rhs[2:1]: which operation' : `       sel,     // rhs[${L.selBit}]: which operation of the pair`}
    output logic [15:0] fast,    // ${names(L.fast, L.fastThird)}, this cycle
    output logic [15:0] slow     // ${names(L.slow, L.slowThird)}, of the previous cycle's a
);

    // --- the fast pair: wiring ------------------------------------------------
    wire [15:0] sxt = {{8{a[7]}}, a[7:0]};
    wire [15:0] rev = { a[0],  a[1],  a[2],  a[3],  a[4],  a[5],  a[6],  a[7],
                        a[8],  a[9],  a[10], a[11], a[12], a[13], a[14], a[15] };

${clmulRtl}    assign fast = ${mux(L.fast, L.fastThird)};

    // --- clz: one flat priority encoder -----------------------------------------
    logic [4:0] cl;
    always_comb casez (a)
${clzRows}
        default:  cl = 5'd16;                   // a == 0
    endcase

    // --- popcount: the counts before the flop, the adds after it -----------------
    function automatic [2:0] cnt4(input [3:0] n);
        case (n)
${pcRows}
        endcase
    endfunction
    function automatic [3:0] add3(input [2:0] x, input [2:0] y);
        logic [2:0] c;
        c[0] = x[0] & y[0];
        c[1] = (x[1] & y[1]) | (c[0] & (x[1] ^ y[1]));
        c[2] = (x[2] & y[2]) | (c[1] & (x[2] ^ y[2]));
        add3 = {c[2], x[2] ^ y[2] ^ c[1], x[1] ^ y[1] ^ c[0], x[0] ^ y[0]};
    endfunction
    function automatic [4:0] add4(input [3:0] x, input [3:0] y);
        logic [3:0] c;
        c[0] = x[0] & y[0];
        c[1] = (x[1] & y[1]) | (c[0] & (x[1] ^ y[1]));
        c[2] = (x[2] & y[2]) | (c[1] & (x[2] ^ y[2]));
        c[3] = (x[3] & y[3]) | (c[2] & (x[3] ^ y[3]));
        add4 = {c[3], x[3] ^ y[3] ^ c[2], x[2] ^ y[2] ^ c[1], x[1] ^ y[1] ^ c[0], x[0] ^ y[0]};
    endfunction
    wire [2:0] p0 = cnt4(a[3:0]),   p1 = cnt4(a[7:4]);
    wire [2:0] p2 = cnt4(a[11:8]),  p3 = cnt4(a[15:12]);

    // --- the slow pair spans BOTH of the cycles it always had --------------------
    // ITS CONTRACT IS TO DELIVER LATE, NOT TO START EARLY.  clz and popcount are
    // given the SLOW step and then EXEC, so the register belongs in the MIDDLE of
    // the work and not at the end of it: the nibble counts and the priority
    // encoder run in the SLOW cycle and land in these flops, and the adds run in
    // EXEC and reach rtl/alu.sv's output mux as wiring.  Both stages read a - the
    // operand flop - exactly as add and rsb do, so nothing in the ALU takes its
    // left operand from anywhere else.
    //
    // THE WRONG VALUE SITS ON slow THROUGH THE SLOW CYCLE, and that is allowed:
    // rtl/ucode.sv's SLOW step asserts no write, so nothing can see it, and EXEC
    // is the cycle the answer is promised in.  extra_cycles stays 1.
    //
    // WHY THE SPLIT IS AFTER THE COUNTS AND NOT AFTER THE 3-BIT ADDS.  Medians of
    // sixteen placement seeds, on the whole processor:
    //
    //   the tree whole, one cycle, registered out    27.96 MHz
    //   counts and both 3-bit adds before the flop   28.57   the SLOW cycle binds
    //   the counts alone before the flop             30.19
    //
    // A count is one LUT4 level - each of its three bits is a function of the
    // nibble's four - and an add written out is two or three.  At the third row
    // the unary unit leaves the critical path entirely: no endpoint of any seed
    // lands in it any more.
    //
    // AND THE ADDS STAY WRITTEN AS GATES.  Written with a plus they take the
    // carry chain, which saves LUTs and spends clock, because carry cells must
    // sit in one column and the placer can no longer shorten what feeds them:
    // 75 carry cells and 1199 LUT4 at 30.30 MHz as they are, against 85 and 1166
    // at 26.05 with every add written as a plus.
    logic [11:0] q;
    logic [4:0]  cl_q;
    always_ff @(posedge clk) begin q <= {p3, p2, p1, p0}; cl_q <= cl; end
    wire [4:0] pc = add4(add3(q[2:0], q[5:3]), add3(q[8:6], q[11:9]));
    assign slow = ${mux(L.slow, L.slowThird)};

endmodule
`);
