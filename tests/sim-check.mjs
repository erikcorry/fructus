#!/usr/bin/env node
// =============================================================================
// sim-check.mjs - run assembled code on the simulator, against real answers
// =============================================================================
//
// The machine's own behaviour - the cost model, brk and rti, the I/O page,
// iseq/isset - and the hand-written routines the compiler does not cover.
// Each runs the actual assembled bytes, and the reference is computed
// independently - not another transcription of the algorithm - so the only
// way to pass is to compute the right answer.
// =============================================================================

import { assemble, callRoutine, machine, spec } from './harness.mjs';
import { Machine } from '../tools/sim.js';
import { writeFileSync, rmSync } from 'node:fs';

let fails = 0, checks = 0;
const check = (name, ok, detail) => { checks++; if (!ok) { if (fails++ < 8) console.log(`  FAIL ${name}: ${detail}`); } };

const m = machine();

// --- data directives and struct offsets --------------------------------------
// Both failure modes here are silent: a byte-swapped constant assembles and
// loads without complaint, and a wrong struct offset reads the neighbouring
// field.  Only executing it tells them apart.
{
  const { code, syms } = assemble('tests/data.s');
  const r = callRoutine(m, code, syms.get('data_test'), syms.get('data_done'), {});
  const want = { 0: 0x2222, 2: 0x3333, 3: 0xbeef, 4: 0x89ab, 5: 0xcdef };
  const what = { 0: 'node.value through a tagged pointer', 2: 'node.kind, offset 3',
                 3: 'dw is little endian', 4: 'dd high half, at the higher address',
                 5: 'dd low half, at the lower address' };
  for (const [i, v] of Object.entries(want))
    check('data', r[i] === v, `r${i} (${what[i]}) = ${r[i].toString(16)}, want ${v.toString(16)}`);
  console.log('ok    tests/data.s on the simulator: dw, dd and tagged struct offsets');
}

// --- the cost model: what a taken branch costs -------------------------------
// Every performance figure in this repo rests on what a taken branch and a
// jump are charged, and on the fetcher behind them.  Nothing else in the
// suite would catch the simulator drifting from the spec: the numbers would
// all move together, and each assertion would be re-tightened around the new
// wrong value by whoever ran the tests next.  So it is measured here directly,
// one instruction at a time, each from a full instruction buffer - prime() -
// so that what is left is the instruction's own cost and its target's refill.
// A redirect's target dispatches two cycles after its word is read if its
// instruction is in that word, three if it reaches into the next.
{
  const { code, syms } = assemble('tests/branch-cost.s');
  // `guess`: what every entry of the jmp ra predictor's table holds - 0, the
  // target of a jump through r0, or 0xffff, a guess that is wrong.  A new
  // machine each time: prime() keeps the fetcher where it is, so what one
  // jump's predictors had still to learn would land in the next one's run.
  const cost = (label, guess = 0xffff) => {
    const m = machine();
    m.mem.fill(0);
    m.jtm.fill(guess);
    m.load(code);
    m.R.fill(0);                       // r0 = 0: `eq #0` is taken, `ne #0` is not
    m.pc = syms.get(label);
    m.halted = false;
    m.reset();
    m.prime();
    m.step();
    return m.cycles();
  };

  const want = [
    ['b_taken', 6, 'a 3-byte branch, taken, to an odd 3-byte instruction: two words'],
    ['b_odd',   2, 'a 3-byte branch at an odd address, not taken, before an even 3-byte one: five bytes are not six'],
    ['b_even',  1, 'a 3-byte branch at an even address, not taken'],
    // An absolute jmp or call reads its target's word as it dispatches.
    ['j_abs',   3, 'a 3-byte absolute jump, to an even 3-byte instruction'],
    ['c_abs',   3, 'a 3-byte absolute call, to an odd 2-byte instruction'],
    ['c_lr',    5, '`call lr`, to the next instruction, odd and 2 bytes'],
    ['j_reg',   6, 'a 2-byte jump through a register, to an even 3-byte instruction'],
    // Guessed right, the target is read as it dispatches, as an absolute one's.
    ['j_reg',   3, 'a 2-byte jump through a register, guessed right, to an even 3-byte instruction', 0],
    ['i_ret',   6, 'ret: one byte, through a register, to an even 3-byte instruction'],
    ['c_reg',   6, 'a 2-byte call through a register, to an even 3-byte instruction'],
    // A call guessed right holds dispatch while its target's words come in.
    ['c_reg',   3, 'a 2-byte call through a register, guessed right, to an even 3-byte instruction', 0],
  ];
  for (const [label, cycles, what, guess] of want)
    check('branch cost', cost(label, guess) === cycles,
          `${what} cost ${cost(label, guess)} cycles, want ${cycles}`);

  // The pair that isolates the cause: the same branch, the same three bytes,
  // both at even addresses, taken and not.  Taken, it is the cycle any
  // instruction costs, the penalty, and its target's two words.
  check('branch cost', cost('b_taken') - cost('b_even') === spec.cpu.taken_branch_penalty + 2,
        `taken and not-taken differ by ${cost('b_taken') - cost('b_even')}, want ${spec.cpu.taken_branch_penalty} + 2`);

  // The penalty is declared in the spec, not buried in the simulator.
  check('branch cost', spec.cpu.taken_branch_penalty === 3,
        `spec says the penalty is ${spec.cpu.taken_branch_penalty}`);
  console.log('ok    cost model: a branch guessed wrong 5 or 6 cycles, a jump 2 or 3, a call 3, through a register unguessed 5 or 6, as its target needs one word or two');
}

// --- zeroed memory traps, and does not run away ------------------------------
// brk is opcode 0x00 so that erased memory, an unwritten ROM and a wild jump
// into a zeroed page all trap where the mistake happened, with the faulting
// address in lr for a monitor to print.  With nop at zero the same jump runs a
// nop sled to the top of memory, wraps, and keeps going.
//
// THE ADDRESS IS WHAT THIS BUYS over the halt that used to be here.  A halt
// stopped the machine and said nothing; the trap names the byte after the
// mistake, which is enough to find it in a listing.
{
  const blank = machine();
  blank.pc = 0x4000;
  blank.step();
  check('zeroed memory traps to the vector', blank.pc === spec.cpu.vectors.brk,
        `pc=0x${blank.pc.toString(16)}, vector=0x${spec.cpu.vectors.brk.toString(16)}`);
  check('and lr names where it happened', blank.R[blank.named.lr] === 0x4001,
        `lr=0x${blank.R[blank.named.lr].toString(16)}`);
  check('and interrupts are off inside the handler', blank.ie === false, `ie=${blank.ie}`);

  // AND IT DOES NOT RUN AWAY.  The vector is zeroed too in a blank machine, so
  // the trap re-enters itself and the pc is PINNED at the vector rather than
  // sledding through memory.  That is the property the old halt had and the
  // one worth keeping: a machine that has stopped making progress at one
  // nameable address, not one that looks alive.
  const drift = machine();
  drift.pc = 0x4000;
  drift.run({ max: 1000 });
  check('and stays put', drift.pc === spec.cpu.vectors.brk,
        `pc=0x${drift.pc.toString(16)} after ${drift.count} instructions`);

  // THE OPCODES COME FROM THE SPEC.  This test used to spell nop as a literal
  // 0x01, which is how it came to be testing `ret` the day the one-byte row was
  // rearranged - it passed no useful assertion and reported a confusing pc.
  const opcodeOf = (mnemonic) => {
    const i = spec.insn.find((x) => x.mnemonic === mnemonic && !(x.operands ?? []).length);
    return parseInt(i.form[0].encoding.replace(/_/g, ''), 2);
  };
  const NOP = opcodeOf('nop');

  const n = machine();
  n.mem[0] = NOP; n.mem[1] = NOP; n.pc = 0;
  n.step(); n.step();
  check('nop still does nothing', !n.halted && n.pc === 2 && n.regs().every((r) => r === 0),
        `pc=${n.pc} halted=${n.halted}`);

  // And the layout the argument above depends on: the instructions a wild jump
  // is likeliest to hit are the two that trap and stop, so they take the
  // LOWEST opcodes in the machine and nop sits far away.  rti was the third
  // until jmp r5 and call r5 took 0x02 and 0x03 for their low bits.
  // Stated as PROPERTIES, not addresses.  These were pinned to 0x00/0x01/0x0f
  // and the whole block moved, so the assertions failed for the right reason
  // and had to be rewritten anyway - which is the argument for writing the
  // property in the first place.  They were rewritten a second time when brk
  // took opcode zero, and the property survived the move unchanged.
  const oneByte = [];
  for (const insn of spec.insn)
    for (const form of insn.form ?? []) {
      const bits = (form.encoding ?? '').replace(/[\s_]/g, '');
      if (bits.length === 8 && /^[01]{8}$/.test(bits)) oneByte.push(parseInt(bits, 2));
    }
  oneByte.sort((a, b) => a - b);
  const exception = ['brk', 'halt'].map(opcodeOf);
  check('brk and halt are the lowest opcodes in the machine',
        exception.every((op, k) => oneByte[k] === op) && exception[0] === 0,
        `lowest are ${oneByte.slice(0, 2).map((o) => '0x' + o.toString(16)).join(' ')}`);
  check('and brk is opcode zero, so erased memory traps',
        opcodeOf('brk') === 0, `brk=0x${opcodeOf('brk').toString(16)}`);
  check('nop is nowhere near them',
        NOP > exception[1] + 8, `nop=0x${NOP.toString(16)}`);
  console.log('ok    brk is opcode zero: zeroed memory traps where the mistake happened');
}

// --- brk and rti, the whole round trip ---------------------------------------
// NOTHING ELSE IN THIS SUITE EXERCISES rti OR THE SHADOW REGISTERS.  The check
// above reaches brk only through zeroed memory, which pins where the pc lands
// and nothing else - not the return address, not which way sp and shadow_isp
// move, and not that rti puts any of it back.
//
// THE ROUND TRIP IS THE ASSERTION.  Every register has to come back to exactly
// where it started, because that is what makes an exception invisible to the
// code it interrupted.  Checking the two halves separately would pass a pair of
// moves that are wrong in the same direction - a shadow written but never read
// looks right from one end and the value is simply lost.
//
// AND THE CYCLE COUNT IS PINNED, because the cost model charges it: seven
// cycles, dispatch to dispatch - a microcode routine in rtl/cpu.sv that moves
// sp and lr through the shadows one register a cycle, since there is no mux
// in front of the register file to swap them, a redirect of the fetch through
// taken_q, and the target's word arriving.  Both targets here are one byte,
// so their first word is enough.
{
  const opcodeOf = (mnemonic) => {
    const i = spec.insn.find((x) => x.mnemonic === mnemonic && !(x.operands ?? []).length);
    return parseInt(i.form[0].encoding.replace(/[\s_]/g, ''), 2);
  };
  const VEC = spec.cpu.vectors.brk;
  const m = machine();
  const SP = m.named.sp, LR = m.named.lr;
  m.reset();
  m.R[SP] = 0x1000; m.R[LR] = 0xbeef;
  m.shadow_isp = 0x2000; m.ie = true;
  m.mem[0]   = opcodeOf('brk');
  m.mem[VEC] = opcodeOf('rti');      // the handler is a bare return
  m.pc = 0;

  const hex = (v) => `0x${v.toString(16)}`;
  m.step();
  check('brk enters at the vector',        m.pc === VEC,            `pc=${hex(m.pc)}`);
  check('brk saves the address after it',  m.R[LR] === 1,           `lr=${hex(m.R[LR])}`);
  check('brk parks the interrupted sp',    m.shadow_sp === 0x1000,  `shadow_sp=${hex(m.shadow_sp)}`);
  check('brk loads the interrupt stack',   m.R[SP] === 0x2000,      `sp=${hex(m.R[SP])}`);
  check('brk parks the interrupted lr',    m.shadow_lr === 0xbeef,  `shadow_lr=${hex(m.shadow_lr)}`);
  check('brk disables interrupts',         m.ie === false,          `ie=${m.ie}`);
  check('brk costs seven cycles',          m.cycles() === 7,        `${m.cycles()} cycles`);

  const half = m.cycles();
  m.step();
  check('rti returns where brk came from', m.pc === 1,              `pc=${hex(m.pc)}`);
  check('rti restores lr',                 m.R[LR] === 0xbeef,      `lr=${hex(m.R[LR])}`);
  check('rti restores sp',                 m.R[SP] === 0x1000,      `sp=${hex(m.R[SP])}`);
  check('rti puts the interrupt stack back', m.shadow_isp === 0x2000, `shadow_isp=${hex(m.shadow_isp)}`);
  check('rti enables interrupts',          m.ie === true,           `ie=${m.ie}`);
  check('rti costs seven cycles',          m.cycles() - half === 7, `${m.cycles() - half} cycles`);
  console.log('ok    brk and rti: every register back where it started, seven cycles each');
}

// --- the I/O page: [cpu.io] -------------------------------------------------
// A machine made with `io` has it.  Every access that touches a guard byte
// traps to io_guard - after the instruction, which runs out, its store landing
// - with lr the address of the instruction the trap took the place of, as an
// interrupt saves it; the bytes just inside the guards do not trap; the
// shadows read and write through their words, a byte at a time as well; and a
// machine without `io' is plain memory there.
//
// THE TRAP CAN BE AN INSTRUCTION LATE, as rtl/cpu.sv's is: a memory
// instruction releases dispatch a step before its last access, and a hit on
// that access is known only after the next instruction has dispatched.  So
// a hit on the only access, or the second of an odd word's two, lets the
// `nop` after it run first; a hit on the first of two does not.
{
  const io = spec.cpu.io, VEC = spec.cpu.vectors.io_guard;
  const hex = (v) => `0x${v.toString(16)}`;
  const run = (body, { mach = new Machine(spec, { io: true }), setup = () => {}, stopAt = VEC } = {}) => {
    writeFileSync('build/_io.s', `start:\n${body}\nnext:   nop\nafter:  halt\n`);
    const { code, syms } = assemble('build/_io.s');
    mach.next = syms.get('next');
    mach.after = syms.get('after');
    const SP = mach.named.sp;
    mach.load(code); mach.pc = 0; mach.R[SP] = 0x1000; mach.shadow_isp = 0x3000;
    setup(mach);
    mach.run({ max: 50, stopAt });
    return mach;
  };
  const top = io.page + 0x100 - io.guard_bytes;
  const traps = [         // ... and whether the nop after it runs first
    ['ld8 from the first guard byte', io.page, 'ld8  r0, [r1, #0]', true],
    ['st8 to the last bottom guard byte', io.page + io.guard_bytes - 1, 'st8  r0, [r1, #0]', true],
    ['ld from the first top guard word', top, 'ld   r0, [r1, #0]', true],
    ['st to the last top guard word', io.page + 0xfe, 'st   r0, [r1, #0]', true],
    ['an odd ld whose high byte is the guard', top - 1, 'ld   r0, [r1, #0]', true],
    ['an odd st whose low byte is the guard', io.page + io.guard_bytes - 1, 'st   r0, [r1, #0]', false],
  ];
  for (const [what, addr, insn, late] of traps) {
    const m = run(`        mov  r0, #0x5a5a\n        mov  r1, #${addr}\n        ${insn}`);
    const want = late ? m.after : m.next;
    check(`${what} traps`, m.pc === VEC, `pc=${hex(m.pc)}`);
    check(`${what}: lr is the instruction ${late ? 'after the nop' : 'after'}`, m.R[m.named.lr] === want,
          `lr=${hex(m.R[m.named.lr])}, want ${hex(want)}`);
    if (/^st/.test(insn))
      check(`${what}: the store landed`, m.mem[addr] === 0x5a, `mem[${hex(addr)}]=${hex(m.mem[addr])}`);
  }
  // A push off the bottom of the stack: the stack guard.
  {
    const m = run('        mov  sp, #0x0500\n        push r0, r3');
    check('a push below 0x0500 traps', m.pc === VEC, `pc=${hex(m.pc)}`);
    check('and parks the sp it pushed to', m.shadow_sp === 0x04fc, `shadow_sp=${hex(m.shadow_sp)}`);
    check('and runs on the interrupt stack', m.R[m.named.sp] === 0x3000, `sp=${hex(m.R[m.named.sp])}`);
  }
  // Just inside the guards: ordinary bytes.
  {
    const m = run(`        mov  r1, #${io.page + io.guard_bytes + 0x10}\n        mov  r0, #0x1234\n        st   r0, [r1, #0]\n` +
                  `        mov  r2, #${top - 2}\n        st   r0, [r2, #0]\n        ld   r3, [r2, #0]`);
    check('the GPU area\'s last word is memory', m.halted && m.R[3] === 0x1234, `halted=${m.halted} r3=${hex(m.R[3])}`);
  }
  // The shadows, through their words.
  {
    const m = run(`        mov  r1, #${io.shadow_lr}\n        ld   r0, [r1, #0]\n` +
                  `        mov  r1, #${io.shadow_isp}\n        mov  r2, #0x2468\n        st   r2, [r1, #0]\n` +
                  `        mov  r1, #${io.shadow_sp + 1}\n        mov  r2, #0xab\n        st8  r2, [r1, #0]\n` +
                  `        mov  r1, #${io.shadow_sp}\n        ld8  r3, [r1, #0]\n` +
                  `        brk`,
                  { setup: (mm) => { mm.shadow_lr = 0xbeef; mm.shadow_sp = 0x1111; },
                    stopAt: spec.cpu.vectors.brk });
    check('ld of shadow_lr', m.R[0] === 0xbeef, `r0=${hex(m.R[0])}`);
    check('ld8 of shadow_sp\'s low byte', m.R[3] === 0x11, `r3=${hex(m.R[3])}`);
    check('brk enters on the shadow_isp a store set', m.R[m.named.sp] === 0x2468, `sp=${hex(m.R[m.named.sp])}`);
    check('st8 to shadow_sp\'s high byte, then brk parks sp over it', m.shadow_sp === 0x1000, `shadow_sp=${hex(m.shadow_sp)}`);
    const n = run(`        mov  r1, #${io.shadow_sp + 1}\n        mov  r2, #0xab\n        st8  r2, [r1, #0]`,
                  { setup: (mm) => { mm.shadow_sp = 0x1111; } });
    check('st8 to shadow_sp\'s high byte', n.shadow_sp === 0xab11, `shadow_sp=${hex(n.shadow_sp)}`);
    check('and the memory beneath, as the hardware writes it', n.mem[io.shadow_sp + 1] === 0xab,
          `mem=${hex(n.mem[io.shadow_sp + 1])}`);
  }
  // Without `io': memory, and nothing traps.
  {
    const m = run(`        mov  r1, #${io.page}\n        mov  r0, #0x77\n        st8  r0, [r1, #0]`, { mach: machine() });
    check('a machine without the I/O page does not trap', m.halted && m.mem[io.page] === 0x77, `pc=${hex(m.pc)}`);
  }
  rmSync('build/_io.s', { force: true });
  console.log(`ok    the I/O page: ${traps.length + 1} guard traps, its edges, the shadows by word and byte`);
}

// --- iseq / isset: the row that is two instructions --------------------------
// Which comparator a column gets is hard-wired to the low three bits, so the
// thing that can go wrong is a column wired to the wrong one - and that is
// invisible to the assembler, which is happy to encode either.  So each form is
// run for values that AGREE and values that DIFFER: a column stuck on `eq` when
// it should be `set`, or the reverse, gets one of the two wrong.
//
// The result must be exactly 1 or 0 and never anything else, because the
// one-byte `xor r0, r0, #1` negates it by flipping bit 0 alone.
{
  const asm = `start:
        iseq    r0, r0, #7
        isset   r1, r1, #0x0100
        iseq    r2, r3, #4
        iseq    r4, r5, #500
        isset   r5, r5, #0xf0f0
        iseq    r6, r7, r1
        xor     r0, r0, #1
        halt
`;
  writeFileSync('build/_isq.s', asm);
  const { code } = assemble('build/_isq.s');

  // The reference walks the same sequence rather than naming its answers,
  // because the order matters: `isset r1, r1` overwrites r1 before
  // `iseq r6, r7, r1` reads it, and a hand-written expectation gets that wrong.
  const model = (R) => {
    const r = R.slice();
    r[0] = r[0] === 7 ? 1 : 0;
    r[1] = (r[1] & 0x0100) !== 0 ? 1 : 0;
    r[2] = r[3] === 4 ? 1 : 0;
    r[4] = r[5] === 500 ? 1 : 0;
    r[5] = (r[5] & 0xf0f0) !== 0 ? 1 : 0;
    r[6] = r[7] === r[1] ? 1 : 0;
    r[0] ^= 1;                                    // the one-byte negation
    return r;
  };

  const inputs = [
    [7, 0x0100, 0, 4,   0, 500, 0, 1],
    [6, 0x0200, 0, 5,   0, 499, 0, 0],
    [7, 0x0000, 0, 4,   0, 500, 0, 0xf0f0],
    [0, 0xffff, 0, 0,   0, 0,   0, 0],
    [7, 0x0100, 0, 4,   0, 0,   0, 1],
  ];
  let bad = -1, why = '';
  inputs.forEach((R, i) => {
    m.mem.fill(0); m.load(code); m.R.fill(0);
    for (let k = 0; k < 8; k++) m.R[k] = R[k];
    m.pc = 0; m.halted = false; m.count = 0;
    m.run({ max: 200 });
    const want = model(R), got = [...m.regs()];
    for (const k of [0, 1, 2, 4, 5, 6])
      if (bad < 0 && got[k] !== want[k]) { bad = i; why = `r${k} = ${got[k]}, want ${want[k]}`; }
    // every answer must be exactly 1 or 0, since xor #1 negates by bit 0 alone
    for (const k of [1, 2, 4, 5, 6])
      if (bad < 0 && got[k] !== 0 && got[k] !== 1) { bad = i; why = `r${k} = ${got[k]}, not a 0 or 1`; }
  });
  check('iseq/isset answer 1 or 0 per column', bad < 0, `case ${bad}: ${why}`);

  // and the one-byte negation really is one byte - the opcode comes from the
  // spec, because pinning it to a literal is what broke when the row moved
  const notOp = (() => {
    for (const insn of spec.insn)
      for (const form of insn.form ?? [])
        if (form.name === 'r0_not') return parseInt(form.encoding.replace(/_/g, ''), 2);
  })();
  check('xor r0, r0, #1 is one byte', code[code.length - 2] === notOp,
        `byte before halt is 0x${code[code.length - 2].toString(16)}, want 0x${notOp.toString(16)}`);
  rmSync('build/_isq.s', { force: true });
  console.log('ok    iseq/isset: every column, agreeing and differing operands');
}

// --- digits3: every input, the bytes either side, and the cost ---------------
// The exactness argument in the file is about an error bound, and a bound is
// the kind of claim that is right for 999 inputs and wrong for one - so all
// 1000 are run.  The reference is String(), not arithmetic that could share a
// mistake with the routine.
//
// Also checked: nothing is written outside buf[0..2], and r2, r3 and r4 - callee
// saved for a two-argument function - come back untouched.  The cost is pinned
// because the file claims it is flat.
{
  const { code, syms } = assemble('libc/digits3.s');
  const EXIT = 0xfffc, BUF = 0x4001;    // odd, so a word store would show
  let bad = -1, why = '', best = Infinity, worst = 0;
  for (let n = 0; n < 1000; n++) {
    m.reset();
    const r = callRoutine(m, code, syms.get('digits3'), EXIT,
                          { 0: n, 1: BUF, 2: 0x2222, 3: 0x3333, 4: 0x4444, 7: EXIT });
    const got = String.fromCharCode(...m.mem.slice(BUF, BUF + 3));
    const c = m.cycles();
    if (c < best) best = c;
    if (c > worst) worst = c;
    if (bad >= 0) continue;
    if (got !== String(n).padStart(3, '0')) { bad = n; why = `wrote ${JSON.stringify(got)}`; }
    else if (m.mem[BUF - 1] || m.mem[BUF + 3]) { bad = n; why = 'wrote outside buf[0..2]'; }
    else if (r[2] !== 0x2222 || r[3] !== 0x3333 || r[4] !== 0x4444) { bad = n; why = 'clobbered a callee saved register'; }
  }
  check('digits3 is right', bad < 0, `n = ${bad}: ${why}`);
  check('digits3 costs 34', best === 34 && worst === 34, `measured ${best}..${worst}`);
  console.log('ok    libc/digits3.s: 1000 inputs, and its cycle count');
}

console.log(`${checks} checks, ${fails} failures`);
process.exit(fails ? 1 : 0);
