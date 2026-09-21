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
// WHAT IT RUNS: every instruction in the ISA.  The ALU groups, mov, the
// unary operations, iseq and isset, in their one-, two- and three-byte forms;
// the transfers of control; the loads and stores, at both widths and in every
// addressing form; the block moves - push, pop, and the post-updating stm and
// ldm; and halt and nop.
//
// EVERY FREE OPCODE GOES TO A TRAP WORD, so a program cannot run an
// unimplemented instruction silently.  Which opcodes are which is worked out
// from the spec, through tools/control.js - whose ALU_LATER, the list of
// instructions deliberately left unimplemented, is empty now.
// =============================================================================

import { loadSpec } from './isa.js';
import { buildDecoder, decode } from './decode.js';
import { ALU_RULES, ALU_ELSEWHERE, ALU_LATER, LHS_FIELD, LHS_PORTB } from './control.js';

// THE STEP NAMES A PORT-A SOURCE BY ITS CODE, not by a two-bit selector that
// rtl/cpu.sv has to expand.  A 4:1 mux over codes cost a LUT level in series
// ahead of rtl/lhs.sv's own decode and the register file's read, and that chain
// ends at the memory's data pins; a wider ROM word costs nothing measurable.
// See rtl/cpu.sv's header for both measurements.
const LHS_CODE = { 1: LHS_FIELD.rd.code, 2: LHS_FIELD.ra.code, 3: LHS_PORTB };
const reads = (which) => ({ luse: 1, lalt: LHS_CODE[which] });

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
  ['pcload',   2,    'load the pc: 1 always, 2 if the branch is taken'],
  ['amem',     1,    'the address unit drives the address bus: a data cycle, not a fetch'],
  ['abase',    1,    "the address unit's left input: 0 the left operand flop, 1 its own last address"],
  ['akon',     2,    'and its right: 0 the right operand flop, 1 #0, 2 #1, 3 #-1'],
  ['we',       1,    'write the byte on mem_wdata at that address'],
  ['wsel',     2,    "which byte: 0/1 port A's low/high, 2 the left operand flop's high"],
  ['dcap',     2,    'capture the bus byte: 1 shift it into the right operand flop, 2 zero extend it there'],
  ['luse',     1,    "lhs alternate: port A reads this step's own code rather than rtl/predecode.sv's"],
  ['lalt',     4,    'and that code, in rtl/lhs.sv\'s numbering - 8 the rd field, 9 the ra field, 10 port B\'s'],
  ['dalt',     3,    'dest alternate - 0 the pointer predecode names, 1 rd, 2 ra, 3 port B, 4 sp, 5 lr'],
  // --- the exception lines -------------------------------------------------
  // Four fields and seven bits, and none of them is near the register file.
  // WIDTH IS THE CHEAP THING TO SPEND: padding this word from 29 bits to 37
  // and taking a fifth block RAM moved the clock by 0.01 MHz, so a field that
  // buys a mux arm somewhere shallow is always the better trade than a mux in
  // front of the eight registers.  See rtl/cpu.sv's header.
  ['shwe',     2,    'latch port A into a shadow: 1 shadow_sp, 2 shadow_lr, 3 shadow_isp'],
  ['shsel',    2,    'which shadow the right operand flop takes under dcap 3: 0 shadow_isp, 1 pc, 2 shadow_sp, 3 shadow_lr'],
  ['iesel',    2,    'the interrupt-enable flag: 1 set it, 2 clear it'],
  ['vec',      1,    'load the pc from the exception vector'],
];
const W = FIELDS.reduce((n, [, w]) => n + w, 0);

// --- the shared steps, above the 256 entry points ------------------------------
const STEP = { EXEC: 256, FETCH2: 257, HALT: 258, TRAP: 259, BOOT: 260, SLOW: 261,
               BRF2: 262, BRDO: 263, JF2: 264, JCF2: 265, JRDO: 266, PCDISP: 267,
               PCREG: 268, CALLREG: 269,
               LDA: 270, LDLO: 271, LDHI: 272, LDA8: 273, LD8: 274,
               STA: 275, STHI: 276, STA8: 277, STEND: 278,
               LDF2: 279, LD8F2: 280, STF2: 281, ST8F2: 282,
               STLO: 283, ST8: 284 };
const word = (w) => ({ next: 0, fetch: 0, dispatch: 0, wen: 0, halt: 0, trap: 0, pcload: 0,
                       amem: 0, abase: 0, akon: 0, we: 0, wsel: 0, dcap: 0,
                       luse: 0, lalt: 0, dalt: 0, ...w });
const rom = new Array(1 << ADDR).fill(null);
const why = new Map();
rom[STEP.EXEC]   = word({ wen: 1, dispatch: 1 });        why.set(STEP.EXEC, 'write the result; the next opcode is on the bus');
rom[STEP.FETCH2] = word({ fetch: 1, next: STEP.EXEC });  why.set(STEP.FETCH2, 'fetch byte 2');
rom[STEP.HALT]   = word({ halt: 1, next: STEP.HALT });   why.set(STEP.HALT, 'stay here');
rom[STEP.TRAP]   = word({ trap: 1, next: STEP.TRAP });   why.set(STEP.TRAP, 'stay here, flagged');
rom[STEP.BOOT]   = word({ dispatch: 1 });                why.set(STEP.BOOT, 'after reset: the first opcode is on the bus');
rom[STEP.SLOW]   = word({ next: STEP.EXEC });               why.set(STEP.SLOW, 'wait: rtl/unary.sv registers the slow pair');
rom[STEP.BRF2]   = word({ fetch: 1, next: STEP.BRDO });     why.set(STEP.BRF2, "a branch's displacement");
rom[STEP.BRDO]   = word({ pcload: 2, dispatch: 1, next: STEP.PCDISP });
                                                            why.set(STEP.BRDO, 'take it, or dispatch what is already on the bus');
rom[STEP.JF2]    = word({ fetch: 1, pcload: 1, next: STEP.PCDISP });
                                                            why.set(STEP.JF2, "a wide target's second byte, and load it at once");
rom[STEP.JCF2]   = word({ fetch: 1, pcload: 1, wen: 1, next: STEP.PCDISP });
                                                            why.set(STEP.JCF2, 'the same, and the write lands in lr: the ALU is carrying pc + 2');
rom[STEP.JRDO]   = word({ pcload: 1, dispatch: 1, next: STEP.PCDISP });
                                                            why.set(STEP.JRDO, 'load a relative target; it is always taken');
rom[STEP.PCDISP] = word({ dispatch: 1 });                   why.set(STEP.PCDISP, 'the target is on the bus now');
rom[STEP.PCREG]  = word({ pcload: 1, dispatch: 1, next: STEP.PCDISP });
                                                            why.set(STEP.PCREG, 'the register was read last cycle: present it');
rom[STEP.CALLREG] = word({ pcload: 1, dispatch: 1, wen: 1, next: STEP.PCDISP });
                                                            why.set(STEP.CALLREG, 'the same, and the write lands in lr: the ALU is carrying pc + 2');
// --- the memory routines -------------------------------------------------------
// An access is an ADDRESS CYCLE and then one cycle per byte.  The address unit
// adds the two operand flops in the first, and walks upwards by one for as long
// as the access lasts, so one adder serves an access of any width.
//
// A LOAD ASKS THE ALU FOR NOTHING: each byte SHIFTS INTO the right-hand operand
// flop as it arrives, low byte first, so a 16-bit value assembles itself in
// place and an 8-bit one is zero extended as it lands.  Both routines therefore
// end in the ordinary EXEC, where the pass-through writes the flop to the
// register file - the same step every ALU instruction ends in.
//
// A STORE'S DATA COMES OUT OF A FLOP - see rtl/cpu.sv - so a step SELECTS the
// byte that the NEXT step writes.  The address cycle does the selecting and
// writes nothing, and each byte afterwards goes out while the one behind it is
// picked; that one cycle is all a store costs over the load beside it, however
// many bytes it moves.  The same cycle latches the source register, so the high
// half is selected out of the left operand flop rather than off port A again.
// A store writes no register, so it ends by pointing the bus back at the pc and
// dispatching.
rom[STEP.LDA]   = word({ amem: 1, next: STEP.LDLO });
why.set(STEP.LDA, 'the address: the two operand flops added, onto the bus');
rom[STEP.LDLO]  = word({ amem: 1, abase: 1, akon: 2, dcap: 1, next: STEP.LDHI });
why.set(STEP.LDLO, 'the low byte is on the bus: shift it in and ask for the next');
rom[STEP.LDHI]  = word({ dcap: 1, next: STEP.EXEC });
why.set(STEP.LDHI, 'the high byte: shift it in, and point the bus back at the pc');
rom[STEP.LDA8]  = word({ amem: 1, next: STEP.LD8 });
why.set(STEP.LDA8, 'the address, for a single byte');
rom[STEP.LD8]   = word({ dcap: 2, next: STEP.EXEC });
why.set(STEP.LD8, 'the byte: zero extend it into the flop, and back to the pc');
rom[STEP.STA]   = word({ amem: 1, wsel: 0, ...reads(1), next: STEP.STLO });
why.set(STEP.STA, "the address, and the source register's low byte into the store flop");
rom[STEP.STLO]  = word({ amem: 1, abase: 1, akon: 1, we: 1, wsel: 2, next: STEP.STHI });
why.set(STEP.STLO, 'that byte goes out, and the high half is selected behind it');
rom[STEP.STHI]  = word({ amem: 1, abase: 1, akon: 2, we: 1, next: STEP.STEND });
why.set(STEP.STHI, 'the next byte up: the high half, out of the store flop');
rom[STEP.STA8]  = word({ amem: 1, wsel: 0, ...reads(1), next: STEP.ST8 });
why.set(STEP.STA8, 'the address, and the only byte into the store flop');
rom[STEP.ST8]   = word({ amem: 1, abase: 1, akon: 1, we: 1, next: STEP.STEND });
why.set(STEP.ST8, 'and out it goes');
rom[STEP.STEND] = word({ next: STEP.PCDISP });
why.set(STEP.STEND, 'back to the pc; a store has no register write to wait for');
rom[STEP.LDF2]  = word({ fetch: 1, next: STEP.LDA });
why.set(STEP.LDF2, "a wide displacement's second byte, then the address");
rom[STEP.LD8F2] = word({ fetch: 1, next: STEP.LDA8 });
why.set(STEP.LD8F2, 'the same, for a byte load');
rom[STEP.STF2]  = word({ fetch: 1, next: STEP.STA });
why.set(STEP.STF2, 'the same, for a store');
rom[STEP.ST8F2] = word({ fetch: 1, next: STEP.STA8 });
why.set(STEP.ST8F2, 'the same, for a byte store');

// --- the block moves, whose chains are generated rather than written out ------
// push, pop, stm and ldm are the same three shapes at three lengths, so their
// steps are built by a loop: one cycle a byte, with the address unit walking
// and the microcode naming which register each cycle reads or writes.
//
// THE POINTER COMES BACK THROUGH rtl/rhs.sv's CODE 3.  The address unit's sum
// is a right-hand operand like any other, so the ALU's pass-through writes it
// to the register file with no mux on the write port - and the register
// rtl/predecode.sv names for these instructions IS that pointer, which is why
// the ordinary EXEC finishes every one of them.
//
// pop AND ldm SHARE EVERY STEP.  They differ only in the register predecode
// names - sp for one, r2 for the other - and no step here mentions it.
let free = 285;
const alloc = (w, note) => { const a = free++; rom[a] = word(w); why.set(a, note); return a; };
// --- the exceptions ------------------------------------------------------------
// brk and a hardware interrupt run the SAME four steps and rti runs their
// inverse.  NOTHING HERE IS A SWAP: there are two shadow stack pointers and
// every move is one way, which is the whole reason the register file needs no
// mux for this.  An exchange wants both old values while both new ones arrive,
// and on this machine that means a mux in front of the write port - measured at
// 3.3 MHz, paid by every instruction rather than by the two that need it.
//
// THE SHADOWS REACH THE REGISTER FILE THROUGH THE RIGHT-HAND OPERAND FLOP,
// under `dcap` 3, and the ALU's pass-through carries that flop to the write
// port exactly as it carries a loaded word.  See rtl/cpu.sv.
//
// `shsel` RUNS ONE STEP AHEAD OF `dcap`, and that is why these routines are
// laid out the way they are rather than the obvious way.  Choosing a shadow in
// the cycle the operand flop loads puts a 4:1 in front of a mux that was
// already the binding path, and it MEASURED 0.93 MHz and 102 cells - medians
// of sixteen seeds, 29.25 against 30.18 with that arm removed altogether.  So
// the selection is registered, and every step here names the shadow the NEXT
// one will consume.
//
// AND THAT COSTS NO CYCLES, which is what makes it the right answer rather
// than a trade: there was always a step in front to carry the selection.  An
// earlier version of this comment claimed a three-arm mux going to four was
// free in LUT levels.  It is not, and the ablation is what says so.
//
// FOUR CYCLES EACH, and they are affordable here in a way they would not be in
// an ALU instruction: an exception happens when a pin says so, not in a loop.
// Each step reads one register on port A while the previous one's value is
// still in the flop, so the reads and the writes pipeline against each other
// and nothing waits.
//
// BRK3 DOES NOT DISPATCH, and that is not an oversight.  rtl/cpu.sv's `defer`
// is driven from `pcload`, and this step loads the pc from the vector without
// it - so a dispatch here would not be deferred and would execute the byte
// already on the bus instead of the handler's first.  Every other pc-loading
// step goes through PCDISP for the same reason; rti's last step can say
// `dispatch` because it DOES use pcload and so defers itself.
STEP.BRK3 = alloc({ wen: 1, dalt: 5, vec: 1, next: STEP.PCDISP },
                  'brk: lr = pc, and the vector goes on the bus');
STEP.BRK2 = alloc({ wen: 1, dalt: 4, shwe: 2, dcap: 3, next: STEP.BRK3 },
                  'brk: sp = shadow_isp, shadow_lr = lr, and the pc into the flop');
STEP.BRK1 = alloc({ luse: 1, lalt: 7, shwe: 1, dcap: 3, shsel: 1, next: STEP.BRK2 },
                  'brk: shadow_sp = sp, read lr, shadow_isp into the flop, pc selected');
STEP.BRK0 = alloc({ luse: 1, lalt: 6, iesel: 2, shsel: 0, next: STEP.BRK1 },
                  'brk: read sp on port A, interrupts off, shadow_isp selected');

// rti runs the same shape backwards.  The pc is loaded from lr in the LAST
// step, not the first, so that lr is still the interrupted address while the
// earlier steps read it - and `pcload` 1 with rtl/predecode.sv's pc_src 3
// reaches it the same way `ret` does, off port A.
STEP.RTI3 = alloc({ wen: 1, dalt: 5, pcload: 1, dispatch: 1, next: STEP.PCDISP },
                  'rti: lr = shadow_lr, and the return address goes on the bus');
STEP.RTI2 = alloc({ wen: 1, dalt: 4, shwe: 3, dcap: 3, iesel: 1, next: STEP.RTI3 },
                  'rti: sp = shadow_sp, shadow_isp = sp, shadow_lr into the flop, interrupts on');
STEP.RTI1 = alloc({ luse: 1, lalt: 6, dcap: 3, shsel: 3, next: STEP.RTI2 },
                  'rti: read sp on port A, shadow_sp into the flop, shadow_lr selected');
STEP.RTI0 = alloc({ luse: 1, lalt: 7, shsel: 2, next: STEP.RTI1 },
                  'rti: read lr on port A, and shadow_sp selected');

STEP.PUSHEND = alloc({ abase: 1, akon: 1, next: STEP.EXEC },
                     'back to the pc; the flop already holds the new sp');
STEP.STMEND  = alloc({ abase: 1, akon: 2, next: STEP.EXEC },
                     'back to the pc, and one more step for the pointer');
const CHAIN = {};
// A BLOCK MOVE'S WRITES, built from a list of [register, wsel] in WRITE ORDER.
// The store data comes out of a flop, so every step selects the byte the next
// one writes and a fill step in front selects the first - and that fill is the
// address cycle, which is why six bytes cost one cycle more than five do not.
// `step` is the akon that walks the address, `fillkon` the one that reaches the
// first address from the pointer: push starts at pointer - 1 and stm at the
// pointer itself.
const writes = (order, step, fillkon, end, what) => {
  let next = end;
  for (let k = order.length - 1; k >= 0; k--) {
    const ahead = order[k + 1];
    const sel = ahead ? { wsel: ahead[1], ...reads(ahead[0]) } : {};
    next = alloc({ amem: 1, abase: 1, akon: k === 0 ? 1 : step, we: 1, ...sel, next },
                 `${what}: byte ${k + 1} goes out` + (ahead
                   ? `, and the ${ahead[1] === 1 ? 'high' : 'low'} half of register ${ahead[0]} is selected`
                   : ''));
  }
  const [reg, sel] = order[0];
  return alloc({ amem: 1, abase: 0, akon: fillkon, wsel: sel, ...reads(reg), next },
               `${what}: the address, and the first byte into the store flop`);
};
for (const n of [1, 2, 3]) {
  // push walks DOWN and writes each register high byte first, so that the
  // addresses descend by one throughout; stm walks UP from its pointer and so
  // writes low byte first, like a store.  Both are the same chain either way.
  const down = [], up = [];
  for (let i = 1; i <= n; i++) { down.push([i, 1], [i, 0]); up.push([i, 0], [i, 1]); }
  CHAIN[`push${n}`] = writes(down, 3, 3, STEP.PUSHEND, 'push');
  CHAIN[`stm${n}`]  = writes(up,   2, 1, STEP.STMEND,  'stm');
  let next;
  // pop and ldm read upwards, shifting each byte into the right-hand flop, and
  // write each register in the cycle the NEXT one's low byte lands - the write
  // reads the flop as it stands, and the shift replaces it at the same edge.
  next = alloc({ wen: 1, dalt: n, abase: 1, akon: 2, next: STEP.EXEC },
               `pop: write register ${n}, and take the stepped pointer`);
  for (let k = 2 * n; k >= 1; k--) {
    const reg = Math.ceil(k / 2), low = k % 2 === 1;
    const also = (low && reg > 1) ? { wen: 1, dalt: reg - 1 } : {};
    next = alloc({ amem: k === 2 * n ? 0 : 1, abase: 1, akon: 2, dcap: 1, ...also, next },
                 `pop: byte ${k}${low && reg > 1 ? `, and write register ${reg - 1}` : ''}`);
  }
  CHAIN[`pop${n}`] = alloc({ amem: 1, abase: 0, akon: 1, next },
                           'pop: the address, which is the pointer itself');
}

// --- the entry points ------------------------------------------------------------
const classify = (d) => {
  const sem = d.insn.semantics ?? '';
  if (sem === 'halted = 1') return 'halt';
  if (sem === '') return 'nop';
  if (ALU_LATER.has(d.insn.mnemonic)) return 'trap';
  // The pc families.  A target from a REGISTER is not here: reading it costs a
  // cycle this machine's cost model does not charge, so ret, `jmp r5' and
  // `call ra' still trap - see rtl/cpu.sv.
  if (/^if \(.*\) pc = pc \+ off$/.test(sem)) return d.nbytes === 3 ? 'brcond' : 'trap';
  if (sem === 'pc = pc + target')   return d.nbytes === 2 ? 'jmprel8' : 'trap';
  if (sem === 'pc = target')        return d.nbytes === 3 ? 'jmpabs'  : 'trap';
  if (sem === 'lr = pc; pc = target')      return d.nbytes === 3 ? 'callabs' : 'trap';
  // A target read from a register: one cycle to read it, one to present it,
  // and the target's own dispatch.  ret spends the first on its entry word,
  // since a one-byte form has no byte to fetch.
  if (/^pc = (lr|R\[[a-z]\])$/.test(sem))  return d.nbytes === 1 ? 'pcreg1' : d.nbytes === 2 ? 'pcreg2' : 'trap';
  if (/^lr = pc; pc = R\[[a-z]\]$/.test(sem)) return d.nbytes === 2 ? 'callreg' : 'trap';
  // The exceptions.  These are tested HERE, above the catch-all below that
  // sends anything containing a `;' to the trap word - brk and rti both do.
  if (/^shadow_lr = lr;/.test(sem))          return d.nbytes === 1 ? 'brk' : 'trap';
  if (/^pc = lr; lr = shadow_lr;/.test(sem)) return d.nbytes === 1 ? 'rti' : 'trap';
  if (sem === 'ie = 1')                      return 'sei';
  if (sem === 'ie = 0')                      return 'cli';
  // The memory families.  Width and direction pick the routine; the entry word
  // differs only in how many bytes it fetches before joining it, and a form
  // whose length has no routine is refused rather than quietly trapped.
  const mem = /^R\[d\] = M16\[/.test(sem) ? 'ld'  : /^R\[d\] = M8\[/.test(sem) ? 'ld8'
            : /^M16\[/.test(sem)          ? 'st'  : /^M8\[/.test(sem)          ? 'st8' : null;
  if (mem && !sem.includes(';')) {
    const cls = `${mem}${d.nbytes}`;
    if (!(cls in ENTRY))
      throw new Error(`${d.insn.mnemonic}/${d.form.name}: ${d.nbytes} bytes, and there is no ${mem} routine that length`);
    return cls;
  }
  // The block moves.  Three shapes - push down, stm up, pop/ldm up and loading
  // - at one, two or three registers, and the arity is the operand count.
  {
    const n = (d.insn.operands ?? []).length;
    // A store that walks DOWN is push and one that walks up is stm; a load is
    // pop or ldm, which share every step of the routine.
    if (/M16\[base[^\]]*\] = R\[a\]/.test(sem))
      return /= base - \d/.test(sem) ? `push${n}` : `stm${n}`;
    if (/R\[a\] = M16\[base/.test(sem))                return `pop${n}`;
  }
  if (sem.includes(';') || /M(8|16)\[/.test(sem) || !/^R\[[a-z]\] = /.test(sem)) return 'trap';
  if (ALU_ELSEWHERE.some(([re]) => re.test(sem))) return 'trap';
  const rule = ALU_RULES.find(([re]) => re.test(sem));
  if (!rule) return 'trap';
  // An instruction that declares an extra cycle must be one whose ALU result is
  // registered, and the other way round - or the wait and the register disagree.
  const name = typeof rule[1] === 'function' ? rule[1](sem.match(rule[0]), d.insn) : rule[1];
  const extra = d.insn.extra_cycles ?? 0;
  if ((name === 'slow') !== (extra > 0))
    throw new Error(`${d.insn.mnemonic}: extra_cycles ${extra} but ALU operation ${name}`);
  if (extra > 1 || (extra && d.nbytes !== 2))
    throw new Error(`${d.insn.mnemonic}: only one extra cycle on a two-byte form is implemented`);
  return extra ? 'alu2slow' : d.nbytes === 1 ? 'alu1' : d.nbytes === 2 ? 'alu2' : 'alu3';
};
const ENTRY = {
  brcond:   () => word({ fetch: 1, next: STEP.BRF2 }),
  jmprel8:  () => word({ fetch: 1, next: STEP.JRDO }),
  jmpabs:   () => word({ fetch: 1, next: STEP.JF2 }),
  callabs:  () => word({ fetch: 1, next: STEP.JCF2 }),
  pcreg1:   () => word({ next: STEP.PCREG }),
  pcreg2:   () => word({ fetch: 1, next: STEP.PCREG }),
  callreg:  () => word({ fetch: 1, next: STEP.CALLREG }),
  push1: () => word({ fetch: 1, next: CHAIN.push1 }),
  push2: () => word({ fetch: 1, next: CHAIN.push2 }),
  push3: () => word({ fetch: 1, next: CHAIN.push3 }),
  stm1:  () => word({ fetch: 1, next: CHAIN.stm1 }),
  stm2:  () => word({ fetch: 1, next: CHAIN.stm2 }),
  stm3:  () => word({ fetch: 1, next: CHAIN.stm3 }),
  pop1:  () => word({ fetch: 1, next: CHAIN.pop1 }),
  pop2:  () => word({ fetch: 1, next: CHAIN.pop2 }),
  pop3:  () => word({ fetch: 1, next: CHAIN.pop3 }),
  ld1:  () => word({ next: STEP.LDA }),
  ld2:  () => word({ fetch: 1, next: STEP.LDA }),
  ld3:  () => word({ fetch: 1, next: STEP.LDF2 }),
  ld81: () => word({ next: STEP.LDA8 }),
  ld82: () => word({ fetch: 1, next: STEP.LDA8 }),
  ld83: () => word({ fetch: 1, next: STEP.LD8F2 }),
  st2:  () => word({ fetch: 1, next: STEP.STA }),
  st3:  () => word({ fetch: 1, next: STEP.STF2 }),
  st82: () => word({ fetch: 1, next: STEP.STA8 }),
  st83: () => word({ fetch: 1, next: STEP.ST8F2 }),
  alu1: () => word({ next: STEP.EXEC }),
  alu2: () => word({ fetch: 1, next: STEP.EXEC }),
  alu2slow: () => word({ fetch: 1, next: STEP.SLOW }),
  alu3: () => word({ fetch: 1, next: STEP.FETCH2 }),
  halt: () => word({ halt: 1, next: STEP.HALT }),
  nop:  () => word({ dispatch: 1 }),
  // brk enters the same routine a hardware interrupt does, which is the point
  // of it: one path, tested by every trap whether or not a pin ever fires.
  brk:  () => word({ next: STEP.BRK0 }),
  rti:  () => word({ next: STEP.RTI0 }),
  // sei and cli have no operand, no result and nothing to fetch, so like nop
  // they dispatch in their entry cycle; the flag moves at that same edge.
  sei:  () => word({ iesel: 1, dispatch: 1 }),
  cli:  () => word({ iesel: 2, dispatch: 1 }),
  trap: () => word({ trap: 1, next: STEP.TRAP }),
};
const byClass   = Object.fromEntries(Object.keys(ENTRY).map((c) => [c, []]));
const opcodesIn = Object.fromEntries(Object.keys(ENTRY).map((c) => [c, 0]));
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
// An instruction that declares \`extra_cycles\` in the spec - clz and popcount,
// whose result rtl/unary.sv registers - enters through SLOW instead of going
// straight to EXEC: a step that consumes nothing, so the next opcode waits on
// the bus while the register fills.
//
// A ONE-BYTE FORM'S ENTRY WORD FETCHES NOTHING, and that is what makes
// rtl/cpu.sv's early operand read possible.  Every other instruction's entry
// word fetches byte 1, and rtl/cpu.sv reads the operands in that same cycle; a
// one-byte form has no byte to fetch, but its operands are all pinned - a
// register the microcode names, or one of rtl/rhs.sv's constants - so the cycle
// is spent reading them and nothing else.  Two cycles rather than one, and in
// exchange no instruction executes in the cycle it was dispatched in, so
// nothing anywhere needs a forwarding path.
//
// So every two-byte ALU opcode has the same entry word, and so does every
// three-byte one - the ALU operations share not only their successor but
// their whole routine.  The write and the next dispatch share a cycle, and
// nothing conflicts: the write uses the instruction already in rtl/insn.sv and
// rtl/predecode.sv, and the new opcode goes in at the edge that ends it.
//
// ENTRY POINTS, by what the spec says each opcode does:
//
//     one-byte ALU - its entry word fetches nothing, and that cycle is the one
//     the operands are read in:
${listed('alu1')}
//     two-byte ALU:
${listed('alu2')}
//     two-byte ALU with a registered result, one extra cycle through SLOW:
${listed('alu2slow')}
//     three-byte ALU:
${listed('alu3')}
//     conditional branches - fetch both bytes, then take or dispatch:
${listed('brcond')}
//     the short relative jump, a byte of displacement:
${listed('jmprel8')}
//     wide targets, absolute, with and without a link:
${listed('jmpabs')}
${listed('callabs')}
//     a target out of a register - three cycles whatever the length, because
//     the register has to be read before it can be an address:
${listed('pcreg1')}
${listed('pcreg2')}
${listed('callreg')}
//     loads - an address cycle, then a cycle a byte, then the ordinary EXEC:
//     the bytes shifted themselves into the operand flop, so the pass-through
//     writes them and no step of this needs an ALU operation of its own:
${listed('ld1')}
${listed('ld2')}
${listed('ld3')}
${listed('ld81')}
${listed('ld82')}
${listed('ld83')}
//     stores - the address cycle carries the first byte out with it, and a
//     cycle at the end points the bus back at the pc:
${listed('st2')}
${listed('st3')}
${listed('st82')}
${listed('st83')}
//     the block moves - one cycle a byte, with the address unit walking and the
//     microcode naming which register each cycle reads; the pointer comes back
//     through rtl/rhs.sv's code 3, so the ordinary EXEC writes it:
${listed('push1')}
${listed('push2')}
${listed('push3')}
${listed('stm1')}
${listed('stm2')}
${listed('stm3')}
//     pop and ldm share every step of their routine, differing only in which
//     register rtl/predecode.sv names as the pointer:
${listed('pop1')}
${listed('pop2')}
${listed('pop3')}
//     the exceptions - brk enters the routine a hardware interrupt enters, and
//     rti runs it backwards; sei and cli move a flag and dispatch at once:
${listed('brk')}
${listed('rti')}
${listed('sei')}
${listed('cli')}
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
    output logic        trap,
    output logic [1:0]  pcload,    // -> rtl/cpu.sv: load the pc, and on what terms
    output logic        amem,      // -> rtl/cpu.sv's address unit: a data cycle, so it
                                   //    drives the address bus and the pc stands still
    output logic        abase,     //    its left input: the operand flop, or its own last
    output logic [1:0]  akon,      //    its right: the operand flop, or #0, #1, #-1
    output logic        we,        // -> memory: write the byte on mem_wdata
    output logic [1:0]  wsel,      //    which byte of which register that is
    output logic [1:0]  dcap,      // -> rtl/cpu.sv: take the bus byte into the right
                                   //    operand flop, shifted in or zero extended
    output logic        luse,      // -> rtl/cpu.sv: port A takes this step's code
    output logic [3:0]  lalt,      // -> rtl/lhs.sv: and that code, ready to use
    output logic [2:0]  dalt,      // -> rtl/dest.sv: and which the write port reads
    output logic [1:0]  shwe,      // -> rtl/cpu.sv: latch port A into a shadow register
    output logic [1:0]  shsel,     //    and which shadow the operand flop takes
    output logic        vec,       //    load the pc from the exception vector
    input  logic        irq,       // <- the chip: an interrupt is pending
    input  logic        defer      // rtl/cpu.sv: the pc is being loaded, so the
                                   // byte on the bus is not the next opcode
);

    (* ram_style = "block" *)
    logic [${W - 1}:0] rom [0:${(1 << ADDR) - 1}];
    initial begin
${inits}
    end

    logic [${W - 1}:0] word;
    wire  [${ADDR - 1}:0] next;
    wire  taking;                  // this step's dispatch, before the deferral
    wire  [1:0] iesel;             // the flag's own line; it never leaves this module
    assign {${unpack.replace('dispatch', 'taking')}} = word;

    // --- the interrupt-enable flag ---------------------------------------------
    // IT LIVES HERE AND NOT IN rtl/cpu.sv, and that is what keeps the interrupt
    // decision out of a combinational loop.  \`dispatch\` is this module's
    // OUTPUT; a take computed outside from \`dispatch\` and fed back would close
    // a ring through the ROM's address.  Computed inside from \`taking\` - the
    // ROM bit before the deferral - it cannot.
    //
    // A TAKEN INTERRUPT CLEARS IT, so the handler runs with interrupts off and
    // the shadow registers cannot be overwritten by a second exception before
    // the first has saved them.  \`rti\` sets it again on its way out.
    logic ie;
    always_ff @(posedge clk)
        if (rst)                ie <= 1'b0;
        else if (iesel == 2'd1) ie <= 1'b1;
        else if (iesel == 2'd2) ie <= 1'b0;
        else if (take)          ie <= 1'b0;

    // --- where an interrupt is taken -------------------------------------------
    // WHERE AN INSTRUCTION WOULD HAVE BEEN DISPATCHED, AND NOWHERE ELSE.  That
    // cycle is the only one in which no instruction is in flight: the previous
    // one's write is landing at this same edge, the next has not begun, and the
    // pc still names an instruction whose first byte has not been consumed.  So
    // the interrupted instruction is RESTARTED rather than resumed, and nothing
    // anywhere has to be unwound.
    //
    // A HALT STEP IS THE OTHER PLACE, because a halted machine never dispatches
    // and would otherwise be unreachable.  The pc stands still there, so \`lr\`
    // gets the halt's own address and an \`rti\` returns to it and waits again -
    // which is what an idle loop wants.  A handler that means to go on adds one
    // to lr before returning.
    wire take = irq & ie & (halt | (taking & ~defer));

    // A step that loads the pc says \`dispatch\` because the NEXT cycle's byte
    // is an opcode; it is this cycle's that is not, when the load actually
    // happens.  So the deferral suppresses both the line and the ROM's use of
    // the bus, and the word's own \`next\` carries the wait.  A taken interrupt
    // suppresses it for the same reason: the byte on the bus is an opcode that
    // is not going to be executed yet.
    assign dispatch = taking & ~defer & ~take;

    wire [${ADDR - 1}:0] addr = rst  ? ${ADDR}'d${STEP.BOOT}
                              : take ? ${ADDR}'d${STEP.BRK0}
                              : (dispatch ? {1'b0, bus} : next);
    always_ff @(posedge clk) word <= rom[addr];

endmodule
`);
