#!/usr/bin/env node
// =============================================================================
// gen-pipe-classify.js - the pipelined experiment's predecode table
// =============================================================================
//
//   node tools/gen-pipe-classify.js > rtl/pipe/classify.sv
//
// THE EXPERIMENT IN rtl/pipe/ IS NOT THE PROCESSOR.  It is a three-stage
// pipeline - dispatch/predecode, decode, ALU - over a 16-bit memory port, built
// to find out what clock such a machine could run at before anything else is
// committed to it.  So far it runs the one-register ALU instructions and the
// conditional branches; everything else is classified, so the categories are
// real, but is stopped at as though it were microcoded.
//
// ONE ROW PER OPCODE, from tools/predecode-rows.js - the rows rtl/predecode.sv
// is built from - with two things added: the category, and the instruction's
// length.  The category is
//
//     kind   0 ALU     one result into one register, every stage single-cycle
//            1 UCODE   anything else, and every opcode the spec leaves empty
//            2 CBR     a conditional branch
//            3 JUMP    an unconditional transfer: jmp, jmpr, call, ret
//
// and with the length it names the seven classes: ONE_BYTE_ALU is kind 0 and
// length 1, THREE_BYTE_CONDITIONAL_BRANCH kind 2 and length 3, and so on.
//
// WHICH INSTRUCTIONS ARE ALU IS A LIST, NOT A RULE, because it is the
// experiment's scope rather than a property of the instruction set: the
// instructions whose selects already describe them completely, less the two
// that need more than one ALU cycle (clz and popcount, which the spec gives an
// extra cycle) and mul, which is left out of the first step on purpose.
// =============================================================================

import { loadSpec } from './isa.js';
import { rows, X } from './predecode-rows.js';

const spec = loadSpec();

const ALU = new Set(['mov', 'movhi', 'sxt8', 'bitrev', 'clmul', 'add', 'rsb', 'xor',
                     'and', 'or', 'shl', 'lsr', 'asr', 'iseq', 'isset', 'nop']);
const HALT = parseInt(spec.insn.find((i) => i.mnemonic === 'halt')
                          .form[0].encoding.replace(/[\s_]/g, ''), 2);

const KIND = { alu: 0, ucode: 1, cbr: 2, jump: 3 };
const JUMP = new Set(['jmp', 'jmpr', 'call', 'ret']);
const kindOf = (r) => {
  if (r.insns.every((i) => ALU.has(i.mnemonic) && !(i.extra_cycles > 0))) return KIND.alu;
  if (r.v.cond !== X) return KIND.cbr;
  if (r.insns.every((i) => JUMP.has(i.mnemonic))) return KIND.jump;
  return KIND.ucode;
};

// {kind[1:0], len[1:0], wen, alu[3:0], lhs[3:0], rhs[3:0], dest[3:0], cond[1:0], pc[1:0]}
//
// A CONDITIONAL BRANCH RUNS THROUGH THE PIPELINE TOO, so its operand selects
// and its condition source are real; its ALU operation and destination are
// not, since it writes nothing - rtl/compare.sv reads the operands instead.
//
// SO DOES A JUMP, and `pc` says where its target is: 1 the next pc plus the
// last byte, 2 the 16 bits of bytes 1 and 2, 3 the left-hand register.  A
// branch's is always 1, and it must be there and not left to the mapper,
// because decode builds every target from it.  A call is an ALU instruction
// as well - lr takes the return address through the pass-through - so its
// ALU fields are real and it writes.
//
// A MEMORY INSTRUCTION IS MICROCODED - dispatch stops behind it - BUT IT
// ENTERS THE PIPELINE, and rtl/pipe/cpu.sv's sequencer moves its bytes from
// the ALU stage.  Its fields, read off the semantics:
//
//     mem    it is one
//     st     it writes memory, not registers
//     w2     two bytes to a register (ld, st and the block moves), not one
//     n      how many registers: 1, 2 or 3
//     blk    a block move, which walks a pointer - lhs names it - and writes
//            the pointer back; ld and st do neither
//     push   the block runs downward from the pointer, so its registers lie
//            in memory in the reverse of their order in the instruction
//
// Its destination field names the FIRST DATA REGISTER - a load's rd, a store's
// rs, a block's first register - rather than anything written by the
// ordinary write port, which a memory instruction does not use.
const memOf = (r) => {
  const sem = r.insns[0].semantics ?? '';
  let m;
  if ((m = /^R\[d\] = M(8|16)\[R\[a\] \+ (off|R\[b\])\]$/.exec(sem)))
    return { st: 0, w2: m[1] === '16' ? 1 : 0, n: 1, blk: 0, push: 0, dest: r.v.dest };
  if ((m = /^M(8|16)\[R\[a\] \+ (off|R\[b\])\] = R\[s\]$/.exec(sem)))
    return { st: 1, w2: m[1] === '16' ? 1 : 0, n: 1, blk: 0, push: 0, dest: 8 };
  if (/^base = (sp|r1|r2); /.test(sem)) {
    const n = (sem.match(/M16\[/g) ?? []).length;
    return { st: /M16\[base[^\]]*\] = R/.test(sem) ? 1 : 0, w2: 1, n, blk: 1,
             push: /base - /.test(sem) ? 1 : 0, dest: 8 };
  }
  return null;
};
const bits = (v, w) => (v === X ? 'x'.repeat(w) : v.toString(2).padStart(w, '0'));
const counts = [0, 0, 0, 0];
let memRows = 0;
const cases = rows.map((r) => {
  const k = kindOf(r);
  counts[k]++;
  // The selects matter only to a row that flows; a row the experiment stops
  // at leaves them to the mapper.
  const cbr = k === KIND.cbr, jump = k === KIND.jump;
  const mem = k === KIND.ucode ? memOf(r) : null;
  if (mem) memRows++;
  const writes = (k === KIND.alu || jump) && r.v.dest !== X;
  const piped = k !== KIND.ucode || !!mem;
  const f = (v, on) => (on ? v : X);
  const wen = piped ? (writes ? 1 : 0) : X;
  const mf = (v, w) => bits(mem ? v : X, w);
  const t = [bits(k, 2), bits(r.nbytes, 2), bits(wen, 1),
             bits(f(r.v.alu, writes), 4), bits(f(r.v.lhs, piped), 4), bits(f(r.v.rhs, piped), 4),
             bits(mem ? mem.dest : f(r.v.dest, writes), 4), bits(f(r.v.cond, cbr), 2),
             bits(f(r.v.pc, jump || cbr), 2),
             bits(mem ? 1 : 0, 1), mf(mem?.st, 1), mf(mem?.w2, 1), mf(mem?.n, 2), mf(mem?.blk, 1), mf(mem?.push, 1)];
  return `        8'h${r.op.toString(16).padStart(2, '0')}: t = 32'b${t.join('_')};    // ${r.who}`;
}).join('\n');

process.stdout.write(`// =============================================================================
// classify.sv - the pipelined experiment's predecode: what the opcode is
// =============================================================================
//
// GENERATED by tools/gen-pipe-classify.js from isa/fructus.toml.  Do not edit.
//
// Combinational, over the opcode byte as it arrives in the dispatch cycle.
// rtl/pipe/cpu.sv decides from kind and length alone whether the next dispatch
// can follow at once, and latches the rest for the decode stage.
//
// ${rows.length} opcodes: ${counts[0]} ALU, ${counts[1]} microcoded - ${memRows} of them memory instructions -
// ${counts[2]} conditional branches, ${counts[3]} jumps.
// AN OPCODE THE SPEC LEAVES EMPTY IS MICROCODED, AND ITS LENGTH IS LEFT TO THE
// MAPPER.  Microcoded stops dispatch, and it traps in the ALU stage whatever
// pc was worked out behind it, so the length is never used.  Pinned at one, as
// it was, it measured 32.96 MHz against 33.59, and the length's lookup was on
// the critical path in some seeds; free, it is on none.  The empty cells -
// ${256 - rows.length} of them - let synthesis carry the pattern of the rows and columns
// across them.
// Rearranging the opcodes that ARE used, with the empties still pinned, made
// it worse: 31.08.
// =============================================================================

module classify (
    input  logic [7:0] op,
    output logic [1:0] kind,      // 0 ALU, 1 microcoded, 2 conditional branch, 3 jump
    output logic [1:0] len,       // 1, 2 or 3 bytes
    output logic       wen,       // an ALU row writes its destination
    output logic       halt,      // it is halt
    output logic [3:0] alu_op,    // -> rtl/pipe/alu.sv
    output logic [3:0] lhs_src,   // -> rtl/lhs.sv
    output logic [3:0] rhs_src,   // rtl/rhs.sv's codes, read by rtl/pipe/cpu.sv's decode
    output logic [3:0] dest_src,  // -> rtl/dest.sv
    output logic [1:0] cond_src,  // -> rtl/cond.sv, for a conditional branch
    output logic [1:0] pc_src,    // a jump's target: 1 relative, 2 absolute, 3 register
    output logic       mem,       // a memory instruction: the rest describe it
    output logic       mst,       //   it stores
    output logic       mw2,       //   two bytes a register
    output logic [1:0] mn,        //   1, 2 or 3 registers
    output logic       mblk,      //   a block move, walking and writing back lhs
    output logic       mpush      //   downward, so its registers lie reversed
);

    logic [31:0] t;
    always_comb begin
        (* rom_style = "logic" *)
        case (op)
${cases}
        default: t = 32'b01_xx_x_xxxx_xxxx_xxxx_xxxx_xx_xx_0_x_x_xx_x_x;
        endcase
    end

    assign {kind, len, wen, alu_op, lhs_src, rhs_src, dest_src, cond_src, pc_src,
            mem, mst, mw2, mn, mblk, mpush} = t;
    assign halt = (op == 8'h${HALT.toString(16).padStart(2, '0')});

endmodule
`);
