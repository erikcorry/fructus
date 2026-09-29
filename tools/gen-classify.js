#!/usr/bin/env node
// =============================================================================
// gen-classify.js - the processor's predecode table
// =============================================================================
//
//   node tools/gen-classify.js > rtl/classify.sv
//
// rtl/cpu.sv is a three-stage pipeline - dispatch/predecode, decode, ALU -
// over a 16-bit memory port.  Its dispatch stage looks the opcode up here, and
// decides from the kind and the length alone whether the next dispatch can
// follow at once.
//
// ONE ROW PER OPCODE, from tools/predecode-rows.js, with two things added:
// the category, and the instruction's length.  The category is
//
//     kind   0 ALU     one result into one register, every stage single-cycle
//            1 UCODE   anything else, and every opcode the spec leaves empty
//            2 CBR     a conditional branch
//            3 JUMP    an unconditional transfer: jmp, jmpr, call, ret
//
// and with the length it names the seven classes: ONE_BYTE_ALU is kind 0 and
// length 1, THREE_BYTE_CONDITIONAL_BRANCH kind 2 and length 3, and so on.
//
// THE KIND IS READ OFF THE SEMANTICS, so a new instruction lands in the right
// one without being named here.  ALU is one register written from registers
// and constants - one `R[x] =` statement, reading no memory - or nothing at
// all, nop; less what the spec gives an extra cycle, clz, popcount and mul,
// which run a microcode routine instead.  JUMP is a pc written outright,
// perhaps with lr taking the return address first, and nothing else.  A
// conditional branch is whatever predecode found a condition for.  A new
// instruction that fits none of them is microcoded, and without a routine it
// traps - which tests/cpu-check.mjs, running every form against the
// simulator, reports.
// =============================================================================

import { loadSpec } from './isa.js';
import { rows, X } from './predecode-rows.js';
import { entryOf, entryNamed, ENTRY_BITS } from './ucode.js';

const spec = loadSpec();

const isAlu = (i) => {
  const sem = i.semantics ?? '';
  return !(i.extra_cycles > 0) && (sem === '' || (/^R\[[a-z]\] = /.test(sem) && !/M(8|16)\[|;/.test(sem)));
};
const isJump = (i) => {
  const st = (i.semantics ?? '').split(/;\s*/).filter(Boolean);
  return st.some((x) => /^pc = /.test(x)) && st.every((x) => /^pc = /.test(x) || x === 'lr = pc');
};
const HALT = parseInt(spec.insn.find((i) => i.mnemonic === 'halt')
                          .form[0].encoding.replace(/[\s_]/g, ''), 2);

const KIND = { alu: 0, ucode: 1, cbr: 2, jump: 3 };
const kindOf = (r) => {
  if (r.insns.every(isAlu)) return KIND.alu;
  if (r.v.cond !== X) return KIND.cbr;
  if (r.insns.every(isJump)) return KIND.jump;
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
// ENTERS THE PIPELINE, and rtl/cpu.sv's sequencer moves its bytes from
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
// ITS ALU OPERATION IS ADD, whatever the row says: in the ALU cycle the ALU
// computes the first address, R[a] plus the offset for ld and st - which the
// operand selects already deliver - and the pointer plus -2n or 0 for a block
// move, whose offset decode supplies as its right-hand side.
//
// Its destination field names the FIRST DATA REGISTER - a load's rd, a store's
// rs, a block's first register - rather than anything written by the
// ordinary write port, which a memory instruction does not use.
//
// AN EXCEPTION INSTRUCTION - brk, rti, sei, cli - RUNS A ROUTINE TOO, entered
// the same way, and its ALU cycle does nothing.  So do the two-cycle
// operations, mul, clz and popcount.  `useq` marks every row with a routine;
// `uent` is where it starts; `uslow` marks clz and popcount; `urs` says
// dispatch is released in the ALU cycle, as a routine whose last write lands
// before the next instruction reaches decode can.  halt has none: it stops, and an interrupt wakes
// it.
//
// `ulate` marks the loads blit mode makes late - ld, ld8 and ldm, every load
// but pop, whose base is sp.  It is a table of its own, and exists only in a
// core built with FRUCTUS_BLIT: as a column of the main table, unread, it
// still changed how that table mapped, by 16 LUT4s, so the core without blit
// mode would not have been the core that was measured.
const ALU_ADD = 0;
const memOf = (r) => {
  const sem = r.insns[0].semantics ?? '';
  let m;
  if ((m = /^R\[d\] = M(8|16)\[R\[a\] \+ (off|R\[b\])\]$/.exec(sem)))
    return { st: 0, w2: m[1] === '16' ? 1 : 0, n: 1, blk: 0, push: 0, dest: r.v.dest, late: 1 };
  if ((m = /^M(8|16)\[R\[a\] \+ (off|R\[b\])\] = R\[s\]$/.exec(sem)))
    return { st: 1, w2: m[1] === '16' ? 1 : 0, n: 1, blk: 0, push: 0, dest: 8, late: 0 };
  if ((m = /^base = (sp|r1|r2); /.exec(sem))) {
    const n = (sem.match(/M16\[/g) ?? []).length;
    const st = /M16\[base[^\]]*\] = R/.test(sem) ? 1 : 0;
    return { st, w2: 1, n, blk: 1, push: /base - /.test(sem) ? 1 : 0, dest: 8,
             late: !st && m[1] !== 'sp' ? 1 : 0 };
  }
  return null;
};
const bits = (v, w) => (v === X ? 'x'.repeat(w) : v.toString(2).padStart(w, '0'));
const W = 35 + ENTRY_BITS;
const late1 = [], late0 = [];          // the rows with a routine, by ulate
const counts = [0, 0, 0, 0];
let memRows = 0, excRows = 0;
const cases = rows.map((r) => {
  const k = kindOf(r);
  counts[k]++;
  // The selects matter only to a row that flows; a row the processor stops
  // at leaves them to the mapper.
  const cbr = k === KIND.cbr, jump = k === KIND.jump;
  const mem = k === KIND.ucode ? memOf(r) : null;
  // A row runs a named routine if every instruction in it runs the same one:
  // 0x33 is clz and popcount, which the ALU cycle has already told apart.
  const named = r.insns.map((i) => entryNamed(i.mnemonic));
  const exc = k === KIND.ucode && named[0] !== null && named.every((e) => e === named[0]) ? named[0] : null;
  const slow = r.insns.every((i) => ['clz', 'popcount'].includes(i.mnemonic));
  // Released in the ALU cycle: whatever finishes in its first step, so that
  // the next instruction reaches decode as its write lands.
  const urs = (mem && !mem.st && !mem.w2 && mem.n === 1) || slow
           || r.insns.every((i) => i.mnemonic === 'mul');
  if (mem) memRows++;
  if (exc !== null) excRows++;
  const writes = (k === KIND.alu || jump) && r.v.dest !== X;
  const useq = !!mem || exc !== null;
  const piped = k !== KIND.ucode || useq;
  const f = (v, on) => (on ? v : X);
  const wen = piped ? (writes ? 1 : 0) : X;
  // A memory field is real on every row with a routine, not only a memory
  // instruction's: the sequencer reads mpush and mblk whatever it runs - for
  // which register a step writes, and whether that is the pointer - and left
  // to the mapper, mul could as well have written the reversed list.
  const mf = (v, w) => bits(mem ? v : useq ? 0 : X, w);
  const t = [bits(k, 2), bits(r.nbytes, 2), bits(wen, 1),
             bits(mem ? ALU_ADD : f(r.v.alu, writes), 4), bits(f(r.v.lhs, piped), 4), bits(f(r.v.rhs, piped), 4),
             bits(mem ? mem.dest : f(r.v.dest, writes || useq), 4), bits(f(r.v.cond, cbr), 2),
             bits(f(r.v.pc, jump || cbr), 2),
             bits(mem ? 1 : 0, 1), mf(mem?.st, 1), mf(mem?.w2, 1), mf(mem?.n, 2), mf(mem?.blk, 1), mf(mem?.push, 1),
             bits(useq ? 1 : 0, 1), bits(mem ? entryOf(mem) : exc ?? X, ENTRY_BITS),
             bits(useq ? (slow ? 1 : 0) : X, 1), bits(useq ? (urs ? 1 : 0) : X, 1)];
  if (useq) (mem?.late ? late1 : late0).push(r.op);
  return `        8'h${r.op.toString(16).padStart(2, '0')}: t = ${W}'b${t.join('_')};    // ${r.who}`;
}).join('\n');

process.stdout.write(`// =============================================================================
// classify.sv - the processor's predecode: what the opcode is
// =============================================================================
//
// GENERATED by tools/gen-classify.js from isa/fructus.toml.  Do not edit.
//
// Combinational, over the opcode byte as it arrives in the dispatch cycle.
// rtl/cpu.sv decides from kind and length alone whether the next dispatch
// can follow at once, and latches the rest for the decode stage.
//
// ${rows.length} opcodes: ${counts[0]} ALU, ${counts[1]} microcoded - ${memRows} of them memory instructions and
// ${excRows} exception or two-cycle ones - ${counts[2]} conditional branches, ${counts[3]} jumps.
// AN OPCODE THE SPEC LEAVES EMPTY IS MICROCODED, AND ITS LENGTH IS LEFT TO THE
// MAPPER.  Microcoded stops dispatch, and it traps in the ALU stage whatever
// pc was worked out behind it, so the length is never used.  Pinned at one, as
// it was, it measured 32.96 MHz against 33.59, and the length's lookup was on
// the critical path in some seeds; free, it is on none.  The empty cells -
// ${256 - rows.length} of them - let synthesis carry the pattern of the rows and columns
// across them.
// Rearranging the opcodes that ARE used, with the empties still pinned, made
// it worse: 31.08.
//
// THAT IS SAFE ONLY WHILE A TRAP IS WHERE THE MACHINE STOPS.  Dispatching an
// empty opcode loads the pc with its length added, so the pc behind it is
// garbage - x in simulation - and nothing may save it.  Today nothing does:
// \`trapped\` is terminal, and an interrupt cannot be taken behind the opcode
// because dispatch has stopped.  One taken AS it dispatches never sees it at
// all - the brk substituted for it is classified instead, and the take keeps
// the pc - so lr gets the opcode's own address.  But a routine for
// isa/fructus.toml's reserved illegal_insn vector that saved \`pc\` as brk's
// does would save the garbage: it must save the ALU stage's e_pc, the
// opcode's own address, or the empties' length must be pinned again.
// =============================================================================

module classify (
    input  logic [7:0] op,
    output logic [1:0] kind,      // 0 ALU, 1 microcoded, 2 conditional branch, 3 jump
    output logic [1:0] len,       // 1, 2 or 3 bytes
    output logic       wen,       // an ALU row writes its destination
    output logic       halt,      // it is halt
    output logic [3:0] alu_op,    // -> rtl/alu.sv
    output logic [3:0] lhs_src,   // -> rtl/lhs.sv
    output logic [3:0] rhs_src,   // predecode's rhs codes, read by rtl/cpu.sv's decode
    output logic [3:0] dest_src,  // -> rtl/dest.sv
    output logic [1:0] cond_src,  // -> rtl/cond.sv, for a conditional branch
    output logic [1:0] pc_src,    // a jump's target: 1 relative, 2 absolute, 3 register
    output logic       mem,       // a memory instruction: the rest describe it
    output logic       mst,       //   it stores
    output logic       mw2,       //   two bytes a register
    output logic [1:0] mn,        //   1, 2 or 3 registers
    output logic       mblk,      //   a block move, walking and writing back lhs
    output logic       mpush,     //   downward, so its registers lie reversed
    output logic       useq,      // it runs a routine: a memory or exception instruction
    output logic [${ENTRY_BITS - 1}:0] uent,      // where its routine starts in rtl/ucode.sv
    output logic       uslow,     // its ALU cycle puts clz or popcount of aq into ldq
\`ifdef FRUCTUS_BLIT
    output logic       ulate,     // blit mode makes it late: ld, ld8 and ldm
\`endif
    output logic       urs        // dispatch is released in its ALU cycle
);

    logic [${W - 1}:0] t;
    always_comb begin
        (* rom_style = "logic" *)
        case (op)
${cases}
        default: t = ${W}'b01_xx_x_xxxx_xxxx_xxxx_xxxx_xx_xx_0_x_x_xx_x_x_0_${'x'.repeat(ENTRY_BITS)}_x_x;
        endcase
    end

    assign {kind, len, wen, alu_op, lhs_src, rhs_src, dest_src, cond_src, pc_src,
            mem, mst, mw2, mn, mblk, mpush, useq, uent, uslow, urs} = t;
    assign halt = (op == 8'h${HALT.toString(16).padStart(2, '0')});
\`ifdef FRUCTUS_BLIT
    // Read only for a row with a routine, so the rest are the mapper's.
    always_comb
        case (op)
        ${late1.map((o) => `8'h${o.toString(16).padStart(2, '0')}`).join(', ')}:
            ulate = 1'b1;
        ${late0.map((o) => `8'h${o.toString(16).padStart(2, '0')}`).join(', ')}:
            ulate = 1'b0;
        default: ulate = 1'bx;
        endcase
\`endif

endmodule
`);
