#!/usr/bin/env node
// =============================================================================
// cpu-check.mjs - rtl/cpu.sv, the processor, against the simulator
// =============================================================================
//
//   node tests/cpu-check.mjs
//
// Random programs of every form the instruction set has - the ALU
// instructions, the conditional branches, the jumps and calls, the memory
// instructions and the exception ones - ending in halt, run from random registers on
// rtl/cpu.sv and tools/sim.js.  The random branches all go FORWARD, to
// an instruction boundary, so every program ends; loops come from a few
// programs written as source and assembled.
//
// WHAT IS COMPARED.  Every instruction that leaves the ALU stage is printed
// with its pc and the registers after its write, and must match the simulator
// instruction for instruction - branches included, which write nothing.  And
// the dispatches must come exactly as rtl/cpu.sv's header says: one a
// cycle, except that an instruction of three bytes starting at an odd address
// is followed by a cycle with none, a taken branch by three, and one
// predicted taken by one.  The
// dispatches a taken branch squashes are dropped before that is checked.
// The forms are drawn so that every length lands at both alignments.
//
// AND EVERY DATA ACCESS, in order: each cycle mem_we writes, and each cycle
// mem_rld says a load's word arrived, with mem_rmar its address, must be one
// the simulator's semantics made, in the order they made them - a byte, or a
// word at an even address, an access.  That is the contract with the system,
// whose I/O registers act on those two and on nothing else: a fetch may read
// anything, a mispredicted path's included, but a load or store squashed
// behind a wrong guess must never reach the bus as one.  Registers and the
// memory at the halt would miss a squashed store whose word is written again
// later, and any load at all, since reading is harmless to memory and not to
// a port.
//
// Needs iverilog; skips without it.  CPU_KEEP=1 leaves the programs in
// build/cpu-prog-N.hex, their registers in build/cpu-reg-N.hex and the last
// bench's memory at each halt in build/cpu-mem-N.hex, for looking at one
// that fails.  FRUCTUS_RTL=dir reads the RTL from dir instead
// of rtl/, which is how tests/dontcare-check.mjs runs it with its don't-cares
// filled.
// =============================================================================

import { loadSpec } from '../tools/isa.js';
import { Machine } from '../tools/sim.js';
import { buildDecoder, decode } from '../tools/decode.js';
import { execFileSync } from 'node:child_process';
import { assemble } from './harness.mjs';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';

const have = (cmd) => {
  try { execFileSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }); return true; }
  catch { return false; }
};
if (!have('iverilog')) {
  console.log('skip  tests/cpu-check.mjs: iverilog not installed');
  process.exit(0);
}

const spec = loadSpec();
const dec = buildDecoder(spec);
const hex4 = (v) => ((v >>> 0) & 0xffff).toString(16).padStart(4, '0');
const rnd = (() => { let s = 2654435761;
  return () => (s ^= s << 13, s ^= s >>> 17, s ^= s << 5, s >>> 0); })();
const EDGE = [0, 1, 2, 0x7fff, 0x8000, 0xffff, 0x00ff, 0x0100];
const val = () => (rnd() % 4 === 0 ? EDGE[rnd() % EDGE.length] : rnd() & 0xffff);

// --- the forms: decided from the semantics, not from the classifier ----------
// One register written, no memory, no second statement.  nop comes too.  The
// two-cycle ones - mul, clz, popcount, which the spec gives an extra cycle -
// are held in the ALU stage and cost two cycles, dispatch to dispatch.
const forms = new Map();
for (let op = 0; op < 256; op++)
  for (let b1 = 0; b1 < 256; b1++) {
    const d = decode(dec, [op, b1, 0], 0);
    if (!d) continue;
    const sem = d.insn.semantics ?? '';
    const ok = d.insn.mnemonic === 'nop'
            || (/^R\[[a-z]\] = /.test(sem) && !/M(8|16)\[|;/.test(sem));
    if (!ok) continue;
    const key = `${d.insn.mnemonic}/${d.form.name}@${op}`;
    if (!forms.has(key)) forms.set(key, { op, nbytes: d.nbytes, b1s: [] });
    forms.get(key).b1s.push(b1);
  }
const all = [...forms.values()];

// THE MEMORY INSTRUCTIONS, from their semantics, in two pools.  A load is safe beside anything: it reads, and
// whatever it reads the simulator reads too.  A store is not - it could write
// over the program - so stores and the block moves that store go in programs
// of their own, whose registers all start in a window far above the program,
// and in which nothing but a walking pointer writes a register.  pop and ldm
// write registers from memory, so they go with the loads.
//
// `bytes` is what the sequencer moves, and what rtl/cpu.sv charges: a
// memory instruction's next dispatch comes bytes + 4 cycles after its own if
// it stores, and bytes + 3 if it loads, since a load's first address is the
// ALU's result, put out in its ALU cycle.
const memBytes = (sem) => {
  const blk = /^base = (sp|r[0-7]); /.test(sem);
  if (blk) return 2 * (sem.match(/M16\[/g) ?? []).length;
  const m = /M(8|16)\[R\[a\] \+ (off|R\[b\])\]/.exec(sem);
  return m ? (m[1] === '8' ? 1 : 2) : 0;
};
const memPools = { ld: new Map(), st: new Map() };
for (let op = 0; op < 256; op++)
  for (let b1 = 0; b1 < 256; b1++) {
    const d = decode(dec, [op, b1, 0], 0);
    const sem = d?.insn.semantics ?? '';
    if (!d || !memBytes(sem)) continue;
    const kind = /^(M(8|16)\[R|base = [a-z0-9]+; M16)/.test(sem) ? 'st' : 'ld';
    const key = `${d.insn.mnemonic}/${d.form.name}@${op}`;
    if (!memPools[kind].has(key)) memPools[kind].set(key, { op, nbytes: d.nbytes, b1s: [] });
    memPools[kind].get(key).b1s.push(b1);
  }
const loads = [...memPools.ld.values()], stores = [...memPools.st.values()];

// The conditional branches, by what they are: a pc-relative transfer taken
// on a test.  The offset byte is filled in once the program is laid out.
const branches = new Map();
for (let op = 0; op < 256; op++)
  for (let b1 = 0; b1 < 256; b1++) {
    const d = decode(dec, [op, b1, 0], 0);
    if (!d || !/^if \(.*\) pc = pc \+ off$/.test(d.insn.semantics ?? '')) continue;
    const key = `${d.insn.mnemonic}/${d.form.name}@${op}`;
    if (!branches.has(key)) branches.set(key, { op, nbytes: d.nbytes, b1s: [], branch: true });
    branches.get(key).b1s.push(b1);
  }
const brs = [...branches.values()];

// THE EXCEPTION INSTRUCTIONS.  brk, sei and cli go in the random programs;
// rti is reached only through brk, since the vector holds nothing but rti in
// both machines - so a brk is a round trip that leaves every register as it
// was, through the shadows.  brk and rti cost rtl/cpu.sv six cycles,
// dispatch to dispatch, since they redirect the fetch through taken_q; sei
// and cli five.
const oneByte = (mnemonic) => parseInt(spec.insn.find((i) => i.mnemonic === mnemonic)
                                           .form[0].encoding.replace(/[\s_]/g, ''), 2);
const RTI = oneByte('rti'), VECTOR = spec.cpu.vectors.brk;
// io_guard's vector holds a halt, so a guard trap ends the program there.
const GVECTOR = spec.cpu.vectors.io_guard;
// divide_by_zero's holds rti, so a recip of a divisor with bit 15 clear -
// half of the random ones - is a round trip, and the program carries on
// after it.
const DVECTOR = spec.cpu.vectors.divide_by_zero;
const excs = ['brk', 'sei', 'cli'].map((mn) => ({ op: oneByte(mn), nbytes: 1, b1s: [0] }));
const EXC = /^(brk|rti|sei|cli)$/;
// The least each takes: brk and rti redirect the fetch, and the target's
// word arrives a cycle later.
const EXC_CYCLES = { brk: 7, rti: 7, sei: 4, cli: 4 };

// THE JUMPS, found by their semantics.  An immediate target is patched in
// after layout like a branch's offset.  A register target is a pair: a
// `mov rX, #target` and then the jump through rX - so the jump always reads
// the register the instruction just ahead of it wrote, through the bypass.
// X is drawn at random - but not lr for a call, since `call lr` is
// undefined: its target would be the lr it writes.  ret is a mov into lr
// and then ret, and a one-byte jump or call through a pinned register -
// `jmp r5' - is a mov into that one.
const JUMP_SEM = /^(lr = pc; )?pc = (target|pc \+ target|R\[a\]|lr)$/;
const find = (want) => {
  for (let op = 0; op < 256; op++)
    for (let b1 = 0; b1 < 256; b1++) {
      const d = decode(dec, [op, b1, 0], 0);
      if (d && want(d)) return { op, b1, d };
    }
  throw new Error('no such form');
};
const MOV_TO = Array.from({ length: 8 }, (_, x) =>
  find((d) => d.nbytes === 3 && d.insn.semantics === 'R[d] = imm' && d.ops.d === x).op);
const jumps = [];
for (let op = 0; op < 256; op++) {
  const d = decode(dec, [op, 0, 0], 0);
  const m = d && JUMP_SEM.exec(d.insn.semantics ?? '');
  if (!m) continue;
  const how = m[2] === 'target' ? 'abs' : m[2] === 'pc + target' ? 'rel' : m[2] === 'lr' ? 'ret' : 'reg';
  jumps.push({ op, jump: how, call: !!m[1], pinned: d.nbytes === 1 && how === 'reg' ? d.ops.a : undefined });
}

// Lay a list of forms out as bytes, pointing each branch forward at a random
// instruction boundary no more than a dozen instructions on - the halt at the
// end is a boundary too - so every program ends.
const layout = (picks) => {
  const ins = picks.map((f) => ({ f, bytes: draw(f) }));
  const at = [];
  let a = 0;
  for (const i of ins) { at.push(a); a += i.bytes.length; }
  at.push(a);                                          // the halt
  ins.forEach((i, k) => {
    if (!i.f.branch && !i.f.jump) return;
    const j = k + 1 + (rnd() % Math.min(12, ins.length - k));
    const t = at[j];
    switch (i.f.jump ?? 'branch') {
      case 'branch': i.bytes[2] = (t - (at[k] + 3)) & 0xff; break;
      case 'rel':    i.bytes[1] = (t - (at[k] + 2)) & 0xff; break;
      default:       i.bytes[1] = t & 0xff; i.bytes[2] = t >> 8;   // abs, or the mov of a pair
    }
  });
  return ins.flatMap((i) => i.bytes);
};
const draw = (f) => {
  switch (f.jump) {
    case 'abs': return [f.op, 0, 0];
    case 'rel': return [f.op, 0];
    case 'ret': return [MOV_TO[7], 0, 0, f.op];
    case 'reg': {
      if (f.pinned !== undefined) return [MOV_TO[f.pinned], 0, 0, f.op];
      const xs = f.regs ?? (f.call ? [0, 1, 2, 3, 4, 5, 6] : [0, 1, 2, 3, 4, 5, 6, 7]);
      const x = xs[rnd() % xs.length]; return [MOV_TO[x], 0, 0, f.op, x];
    }
  }
  if (f.nbytes === 1) return [f.op];
  const bytes = [f.op, f.b1s[rnd() % f.b1s.length]];
  if (f.nbytes === 3) bytes.push(rnd() & 0xff);
  return bytes;
};
const HALT = parseInt(spec.insn.find((i) => i.mnemonic === 'halt')
                          .form[0].encoding.replace(/[\s_]/g, ''), 2);

// Every form twice over, once from each alignment - a one-byte nop shifts the
// second pass by one - and then random mixtures.
const NOP = forms.get([...forms.keys()].find((k) => k.startsWith('nop/')));
const shuffle = (xs) => xs.map((x) => [rnd(), x]).sort((a, b) => a[0] - b[0]).map((e) => e[1]);

// MIXED PROGRAMS: loads, stores, ALU instructions, branches, jumps and the
// exception instructions together, so that a load or a store lands in every
// slot behind a branch guessed wrong, a jump guessed wrong and a trap, a
// load straight after a store to the same word, and a load or store just
// after the instruction that wrote its base, its index or its data.  Stores
// must not reach the program, so three registers are POINTERS into a window
// far above it, and nothing writes them but the instructions that walk
// them: r1, ldm's; r5, stm's; and sp, push's and pop's.  Every store takes
// its address from them, and most loads; the rest read anywhere.  The three
// start a few bytes apart, so that what one writes another reads.
const NAMED = new Machine(spec).named;
const PTR = new Set([1, 5, NAMED.sp]);
const writesOf = (d) => [...(d.insn.semantics ?? '').matchAll(/R\[([a-z])\] = /g)].map((m) => d.ops[m[1]]);
const addrOf = (d) => {
  const m = /M(8|16)\[R\[a\] \+ (off|R\[b\])\]/.exec(d.insn.semantics ?? '');
  return m ? [d.ops.a, ...(m[2] === 'R[b]' ? [d.ops.b] : [])] : [];
};
const keepIf = (pool, ok) => pool.map((f) => ({ ...f, b1s: f.b1s.filter((b1) => ok(decode(dec, [f.op, b1, 0], 0))) }))
                                 .filter((f) => f.b1s.length);
const noPtrWrite = (d) => !writesOf(d).some((r) => PTR.has(r));
const mix = {
  alu:    keepIf(all, noPtrWrite),
  ldPtr:  keepIf(loads, (d) => noPtrWrite(d) && addrOf(d).every((r) => PTR.has(r))),
  ldAny:  keepIf(loads, noPtrWrite),
  st:     keepIf(stores, (d) => addrOf(d).every((r) => PTR.has(r))),
  jumps:  jumps.filter((j) => !PTR.has(j.pinned)).map((j) =>
            j.jump === 'reg' && j.pinned === undefined
              ? { ...j, regs: [0, 2, 3, 4, ...(j.call ? [] : [7])] } : j),
};

// Loops, and the register-register branch both ways round, assembled.  Each
// is run twice: as written, and a byte later behind a nop, so that every
// branch in it lands at the other alignment too.
const SOURCES = [
  // THE GUARDS, [cpu.io]: each program runs into one and halts at io_guard's
  // vector, having entered it at the instruction after.  A stack overflow,
  // the case they are for: the second push reaches 0x04fc.
  `       mov  r1, #0x414
          mov  r0, #0x3000
          st   r0, [r1, #0]
          mov  sp, #0x504
          push r0, r1
          push r0, r1
          add  r0, r0, #1
          halt`,
  // An odd word whose first byte is the bottom guard's last.
  `       mov  r1, #0x40f
          ld   r0, [r1, #0]
          add  r0, r0, #1
          halt`,
  // A block load into the top guard, its pointer moved as usual.
  `       mov  r1, #0x4fa
          ldm  r0, r3
          add  r0, r0, #1
          halt`,
  // A byte stored to the page's first byte.  A store of one register lets
  // the next instruction dispatch before its access, so the trap may be two
  // instructions late: two before the halt, or it would come after it.
  `       mov  r1, #0x400
          mov  r0, #0x77
          st8  r0, [r1, #0]
          add  r0, r0, #1
          add  r0, r0, #1
          halt`,
  // THE SHADOWS' WORDS, [cpu.io]: stored and loaded by word, by byte, at odd
  // addresses a byte at a time, by ldm and stm, and moved by brk and rti in
  // between.  cli first, since an interrupt rewrites them, and again after
  // brk, whose rti sets ie: one taken between the two parks the sp and lr
  // brk parked and leaves shadow_isp, so it changes nothing.  The simulator
  // runs it with the I/O page.
  `       cli
          mov  r5, #0x410
          mov  r0, #0x1234
          st   r0, [r5, #0]
          mov  r0, #0x5678
          st   r0, [r5, #2]
          mov  r0, #0x3000
          st   r0, [r5, #4]
          mov  r1, #0xab
          st8  r1, [r5, #1]
          ld   r3, [r5, #0]
          ld8  r4, [r5, #3]
          ld   r2, [r5, #3]
          add  r3, r3, r4
          add  r3, r3, r2
          brk
          cli
          mov  r1, #0x410
          ldm  r0, r4, r2
          add  r3, r3, r0
          add  r3, r3, r4
          add  r3, r3, r2
          mov  r5, #0x411
          stm  r3, r4
          ld   r0, [r5, #-5]
          ld   r2, [r5, #-1]
          halt`,
  // THE CYCLE COUNTER, [cpu.io] cycles: by word, by byte, by an odd word a
  // byte at a time, by ldm a word a cycle, and after a loop with taken
  // branches in it - each load takes the count as rtl/cpu.sv's capture sees
  // it, which the simulator must give exactly.  A store to it changes nothing.
  `       mov  r5, #0x424
          ld   r0, [r5, #0]
          ld   r2, [r5, #2]
          ld8  r3, [r5, #0]
          ld   r4, [r5, #1]
          st   r5, [r5, #0]
          mov  r1, #0x424
          ldm  r0, r2, r3
          mov  r4, #3
  spin:   add  r4, r4, #-1
          br   ne, r4, #0, spin
          ld   r4, [r5, #0]
          halt`,
  `       mov  r0, #5
          mov  r1, #0
  loop:   add  r1, r1, r0
          add  r0, r0, #-1
          br   ne, r0, #0, loop
          brset r1, #1, odd
          mov  r2, #0x1234
  odd:    brclr r1, #0xf0f0, clear
          mov  r3, #0x5678
  clear:  add  r1, r1, #1
          halt`,
  `       mov  r2, #0
          mov  r3, #7
  up:     add  r2, r2, #1
          br   lt, r2, r3, up
          br   ge, r2, r3, past
          mov  r4, #0xbad
  past:   mov  r5, #3
  down:   add  r5, r5, #-1
          iseq r6, r5, #0
          br   eq, r6, #0, down
          halt`,
  `       mov  r0, #3
          mov  r1, #0
  again:  call bump
          add  r0, r0, #-1
          br   ne, r0, #0, again
          br   eq, r0, r0, over
          mov  r2, #0xbad
  over:   mov  r2, #there
          jmp  r2
          mov  r3, #0xbad
  there:  call outer
          jmp  done
          mov  r4, #0xbad
  done:   halt
  outer:  mov  r5, lr
          mov  r4, #bump
          call r4
          mov  lr, r5
          ret
  bump:   add  r1, r1, #1
          ret`,
  // Stores read back: both widths, an odd address, every block move, the
  // pointer in a block's own list both ways, and a register named twice in
  // a pop and an ldm, where the later word wins - which libgcc's 64-bit
  // division uses to step over a dead word of its frame.
  `       mov  sp, #0x4000
          mov  r5, #0x3000
          mov  r0, #0x1234
          st   r0, [r5, #0]
          st8  r0, [r5, #3]
          ld   r1, [r5, #0]
          ld8  r3, [r5, #3]
          ld   r4, [r5, #1]
          mov  r2, #2
          ld   r4, [r5, r2]
          st   r4, [r5, #5]
          push r0, r1, r3
          push r4
          pop  r2
          pop  r0, r1, r3
          mov  r1, #0x3000
          ldm  r3, r4
          mov  r5, #0x3101
          stm  r0, r2, r5
          add  r1, r1, #-4
          ldm  r2, r0
          mov  r1, #0x3101
          ldm  r3, r1, r4
          push sp
          pop  sp
          push r6, r0
          pop  r0, r6
          push r0, r1, r3
          pop  r4, r4, r2
          mov  r1, #0x3000
          ldm  r3, r3
          halt`,
  // A DIVIDE BY ZERO, [cpu.vectors] divide_by_zero: a recip whose ra has
  // bit 15 clear traps after writing its answer, and the rti at the vector
  // comes back to the add after each.  Then one with the bit set, which does
  // not.  The shifts' two-register imm10 forms come along.
  `       mov  r1, #0x1234
          recip r0, r1
          add  r0, r0, #1
          mov  r2, #0
          mov  r3, #5
          recip r4, r2
          add  r4, r4, r0
          mov  r1, #0x9234
          recip r2, r1
          lsr  r3, r2, #13
          shl  r5, r2, #11
          asr  r1, r1, #5
          halt`,
  // A copy loop, word by word, as memcpy would do it.
  `       mov  r1, #0x3000
          mov  r5, #0x3000
          mov  r0, #0x0102
          mov  r3, #2
  fill:   add  r2, r0, #0x0202
          stm  r0, r2
          add  r0, r0, #0x0404
          add  r3, r3, #-1
          br   ne, r3, #0, fill
          mov  r5, #0x3401
          mov  r3, #2
  copy:   ldm  r4, r2
          stm  r4, r2
          add  r3, r3, #-1
          br   ne, r3, #0, copy
          mov  r5, #0x3401
          ld   r4, [r5, #0]
          ld   r2, [r5, #6]
          halt`,
];

// THE POINTER AFTER A BLOCK MOVE: each push, pop, ldm and stm, of one (push
// and pop only), two and three registers, from an even and an odd pointer, followed AT ONCE by
// an ALU instruction or a branch that reads the pointer - as its left
// operand, its right, both, through a one-byte form, and as a compare.  A
// load writes its pointer first and a store last, and nothing forwards
// either: rtl/cpu.sv says each lands before the next instruction is in
// decode.  Delaying the pointer's write showed the margin, a cycle for
// every store and for one aligned word loaded: two cycles late, and the
// instruction after reads the old pointer.  One program, since the test
// benches' cost is mostly per program, with the pointer set afresh before
// each move so that the cases do not interact.
{
  const follow = (P) => [
    `add  r0, ${P}, #1`, `mov  r0, ${P}`, `rsb  r0, ${P}, r3`, `rsb  r0, r3, ${P}`,
    `iseq r0, ${P}, ${P}`, `xor  r0, r0, ${P}`, `shl  r0, ${P}, #3`, `lsr  r0, ${P}, #13`,
    ...(P === 'r1' ? ['add  r0, r0, r1'] : []),
    `br   eq, ${P}, r3, @`, `br   ne, ${P}, #0, @`, `add  ${P}, ${P}, #0`,
  ];
  const lines = [];
  let n = 0;
  for (const [op, P] of [['push', 'sp'], ['pop', 'sp'], ['ldm', 'r1'], ['stm', 'r5']])
    for (const regs of [['r2'], ['r2', 'r3'], ['r2', 'r3', 'r4']].slice(P === 'sp' ? 0 : 1))
      for (const base of [0x3100, 0x3101]) {
        lines.push(`mov  r3, #${base}`);
        for (const f of follow(P)) {
          const lab = `bp${n++}`;
          lines.push(`mov  ${P}, #${base}`, `${op}  ${regs.join(', ')}`, f.replace('@', lab), `${lab}:`);
        }
      }
  SOURCES.push([...lines, 'halt'].map((l) => '          ' + l).join('\n'));
}
// BACKWARD BRANCHES, which the table learns to guess taken: a loop on each
// of the seven, so each is taken and then not; one never taken; one with a branch
// two ahead of it, whose verdict owns tgt_q, so it is not predicted; a push
// just before one; a call in a loop; loops nested, so that the inner
// one's wrong guess at its exit is followed by the outer one's branch; and
// a call whose target is a branch back, which dispatches the cycle after
// the call's ALU cycle moves the pc there; and a forward branch always taken
// straight behind one never taken, whose look is latched before the first
// one's bit reaches the history, and is right only once the table has
// learned in the word it read.
SOURCES.push([
  'mov  sp, #0x3100', 'mov  r3, #0', 'mov  r2, #0',
  'mov  r1, #3', 'l1: add  r2, r2, #1', 'add  r1, r1, #-1', 'br   ne, r1, #0, l1',
  'mov  r1, #3', 'l2: add  r2, r2, #3', 'add  r1, r1, #-1', 'br   ne, r1, r3, l2',
  'mov  r4, #3', 'l3: add  r2, r2, r4', 'add  r4, r4, #-1', 'br   ne, r4, r3, l3',
  'mov  r1, #0', 'l4: add  r1, r1, #1', 'brclr r1, #4, l4',
  'mov  r1, #0', 'l5: add  r1, r1, #1', 'add  r2, r2, r1', 'brclr r1, #0xfff0, l5',
  'mov  r1, #4', 'l6: add  r1, r1, #1', 'brset r1, #4, l6',
  'mov  r1, #0xfff0', 'l7: add  r1, r1, #1', 'brset r1, #0xfff0, l7',
  'l8: add  r2, r2, #1', 'br   ne, r3, r3, l8',
  'mov  r1, #3', 'l9: br   ne, r3, #0, l9x', 'add  r1, r1, #-1', 'br   ne, r1, #0, l9', 'l9x: add  r2, r2, r1',
  'mov  r1, #3', 'l10: push r2', 'add  r1, r1, #-1', 'br   ne, r1, #0, l10',
  'mov  r1, #3', 'l11: call f11', 'add  r1, r1, #-1', 'br   ne, r1, #0, l11',
  'mov  r4, #2', 'l12: mov  r1, #2', 'l13: add  r2, r2, r1', 'add  r1, r1, #-1', 'br   ne, r1, #0, l13',
  'add  r4, r4, #-1', 'br   ne, r4, #0, l12',
  'mov  r1, #3', 'l14: call f14', 'add  r1, r1, #-1', 'br   ne, r1, #0, l14',
  'mov  r1, #10', 'l15: br   ne, r3, r3, l15x', 'br   eq, r3, r3, l15y', 'l15x: add  r2, r2, #7',
  'l15y: add  r1, r1, #-1', 'br   ne, r1, #0, l15',
  'halt',
  'f11: add  r2, r2, #2', 'ret',
  'f14r: add  r2, r2, #5', 'ret', 'f14: br   eq, r3, #0, f14r',
].map((l) => '          ' + l).join('\n'));

// AN INTERPRETER'S DISPATCH: handlers that end in a jmp through a register,
// 0xb2's and jmp r5's, in an order that repeats, with forward branches
// between, and calls through a register, call ra's and call r5's - so the
// jmp ra predictor learns them, guesses right, and once in a while wrong,
// where the branch inside h3 changes its mind.
SOURCES.push([
  'jmp  go',
  'f1:  add  r3, r3, #7', 'ret',
  'f2:  brclr r1, #2, f2x', 'add  r3, r3, #9', 'f2x: ret',
  'go:  mov  r3, #0', 'mov  r1, #24',
  'top: mov  r2, #h1', 'jmp  r2',
  'h1:  add  r3, r3, #1', 'mov  r5, #h2', 'jmp  r5',
  'h2:  brset r1, #1, h2x', 'add  r3, r3, #2', 'h2x: mov  r2, #h3', 'jmp  r2',
  'h3:  brclr r1, #8, h3x', 'mov  r5, #h1b', 'jmp  r5', 'h3x: mov  r2, #h4', 'jmp  r2',
  'h1b: add  r3, r3, #5', 'mov  r2, #h4', 'jmp  r2',
  'h4:  mov  r2, #f1', 'call r2', 'mov  r5, #f2', 'call r5',
  'add  r1, r1, #-1', 'br   ne, r1, #0, top',
  'halt',
].map((l) => '          ' + l).join('\n'));

// A GUESSED JUMP IN A STORE'S WRITE CYCLE: ret, jmp ra and call ra each a
// cycle after the instruction after a store - aligned, odd and a block - so
// the guess is read late, through pjq or pjw, and the jmp ra's target
// changes every other lap, so a late guess is sometimes wrong.
SOURCES.push([
  'mov  sp, #0x3100', 'mov  r4, #0x2001', 'mov  r3, #0', 'mov  r1, #12',
  'top: call g1', 'call g2', 'call g3',
  'mov  r2, #h1', 'brset r1, #2, tx', 'mov  r2, #h2',
  'tx:  st   r3, [r4, #-1]', 'add  r3, r3, #1', 'jmp  r2',
  'h1:  add  r3, r3, #2', 'jmp  back',
  'h2:  add  r3, r3, #3',
  'back: mov  r5, #g1', 'st   r3, [r4, #0]', 'add  r3, r3, #1', 'call r5',
  'add  r1, r1, #-1', 'br   ne, r1, #0, top',
  'halt',
  'g1:  st   r3, [r4, #-1]', 'mov  r0, #0', 'ret',
  'g2:  st   r3, [r4, #0]', 'mov  r0, #1', 'ret',
  'g3:  push r2, r3', 'ret',
].map((l) => '          ' + l).join('\n'));

// LOADS AND STORES WHERE A GUESS PUTS THEM, which the access check above
// holds to the ones the program makes: behind a branch the table guesses
// wrong, both ways - the laps alternate, then go in fours - behind a loop's
// exit, at a jmp ra target guessed wrong, after a ret guessed wrong because
// the function moved lr, and a call's target the same.  r1 points at
// stand-ins for ports, which the bench cannot tell from memory; the check
// is that nothing but these instructions reads or writes them, and only
// when they run.
SOURCES.push([
  'mov  sp, #0x3100', 'mov  r1, #0x2800', 'mov  r5, #0x2810', 'mov  r4, #16', 'mov  r3, #0',
  'top: brset r4, #1, odd',
  'ld   r0, [r1, #0]', 'st   r4, [r1, #2]', 'ld8  r2, [r1, #4]',
  'odd: brclr r4, #4, sk', 'push r4', 'pop  r2', 'stm  r3, r4',
  'sk:  brset r4, #8, rare', 'ld   r0, [r1, #6]', 'st8  r4, [r1, #7]',
  'rare: add  r3, r3, r0',
  'mov  r2, #j1', 'brset r4, #2, jx', 'mov  r2, #j2',
  'jx:  jmp  r2',
  'j1:  ld   r0, [r1, #8]', 'st   r0, [r1, #10]', 'jmp  jn',
  'j2:  st   r4, [r1, #12]', 'ld   r2, [r1, #12]',
  'jn:  call f', 'ld   r0, [r1, #14]', 'st   r0, [r1, #16]',
  'jr:  mov  r2, #g', 'call r2', 'ld8  r0, [r1, #18]',
  'add  r4, r4, #-1', 'br   ne, r4, #0, top',
  'ldm  r0, r2', 'halt',
  'f:   brclr r4, #8, fr', 'mov  lr, #jr', 'fr: ret',
  'g:   ld   r2, [r1, #20]', 'ret',
].map((l) => '          ' + l).join('\n'));

// A LOAD STRAIGHT AFTER A STORE, AND A LOAD WHOSE BASE WAS JUST WRITTEN:
// the same word at once and a cycle later, aligned, odd and a byte, through
// a zero offset and not; a push read back by pop and by ld; stm read by
// ldm over the same words; pointers chased, ld r1, [r1] after ld r1, [r1]
// and the one-byte ld r0, [r0]; a base an ALU instruction or a load wrote
// the cycle before, for a load and a store; and a store's data written the
// cycle before.  What an early address, or a load ahead of a store, would
// get wrong.
SOURCES.push([
  'mov  sp, #0x3100', 'mov  r5, #0x3000', 'mov  r1, #0x3000', 'mov  r0, #0x1234',
  'st   r0, [r5, #0]', 'ld   r2, [r5, #0]',
  'add  r0, r0, #1', 'st   r0, [r5, #0]', 'add  r3, r2, #1', 'ld   r3, [r5, #0]',
  'st8  r2, [r5, #1]', 'ld   r4, [r5, #0]',
  'mov  r4, #0x3003', 'st   r0, [r4, #0]', 'ld   r2, [r4, #0]', 'ld8  r3, [r4, #0]', 'ld8  r3, [r4, #1]',
  'st   r0, [r5, #0]', 'add  r2, r2, #1', 'ld   r3, [r5, #0]',
  'push r0, r2', 'pop  r3', 'pop  r4',
  'push r2', 'ld   r0, [sp]', 'st   r3, [sp]', 'pop  r4',
  'mov  r0, #0x3010', 'st   r0, [r5, #0]', 'mov  r0, #0x3020', 'st   r0, [r5, #16]',
  'mov  r0, #0x3000', 'st   r0, [r5, #32]',
  'mov  r1, #0x3000', 'ld   r1, [r1, #0]', 'ld   r1, [r1, #0]', 'ld   r2, [r1, #0]',
  'mov  r0, #0x3000', 'ld   r0, [r0]', 'ld   r0, [r0]', 'ld   r0, [r0]',
  'mov  r1, #0x3000', 'stm  r0, r2, r3', 'ldm  r4, r2', 'ldm  r3, r0',
  'mov  r4, #0x3000', 'add  r4, r4, #2', 'ld   r2, [r4, #0]', 'add  r4, r4, #-1', 'st   r2, [r4, #0]',
  'add  r4, r4, #1', 'st8  r0, [r4, #0]', 'ld8  r3, [r4, #0]',
  'ld   r4, [r5, #16]', 'st   r0, [r4, #0]', 'ld   r4, [r5, #16]', 'ld   r3, [r4, #0]',
  'add  r0, r0, #5', 'st   r0, [r5, #0]', 'ld   r2, [r5, #0]',
  'mov  r3, #0x3002', 'mov  r2, #0', 'st   r0, [r3, r2]', 'ld   r4, [r3, r2]',
  'halt',
].map((l) => '          ' + l).join('\n'));

// The second copy has its nop IN THE SOURCE, not put in front of the bytes:
// a call or a jmp to a label is an absolute address, which the assembler
// has to see move.
const assembled = SOURCES.flatMap((src, i) => [src, `nop\n${src}`].map((text, j) => {
  const f = `build/cpu-src-${i}-${j}.s`;
  writeFileSync(f, text.split('\n').map((l) => l.trim()).join('\n') + '\n');
  const { code } = assemble(f);
  rmSync(f, { force: true });
  return [...code];
}));

// The programs that read the cycle counter.  In blit mode the count is the
// slower machine's, which the simulator does not model, and under interrupts
// it includes theirs, so there only their pcs and memory are compared.
const CLOCKED = new Set(SOURCES.flatMap((src, i) => (src.includes(`#0x${spec.cpu.io.cycles.toString(16)}`)
  ? [2 * i, 2 * i + 1] : [])));

const N_ALU = 60, N_LD = 20, N_ST = 20, N_MIX = 40;
const N_RANDOM = N_ALU + N_LD + N_ST + N_MIX;
// Even, and far above any program these make: the widest displacement is ten
// signed bits and an index is another register from the same window.
const safe = () => 0x2000 + ((rnd() % 0x1000) & ~1);
const PROGRAMS = N_RANDOM + assembled.length;
// THE SIMULATOR'S DATA ACCESSES, in the order its semantics made them: what
// the system should see on mem_rld and mem_we.  A read is its byte address,
// as mem_rmar gives it; a write its word, the lanes written and their bytes.
// A word at an odd address is two, a byte at a time, the low first; and
// run() puts each instruction's own in address order, as the sequencer
// makes them.
const logAccesses = (m) => {
  const log = [];
  const { rd8, rd16, wr8, wr16 } = Machine.prototype;
  const rd = (a) => log.push({ w: 0, a: a & 0xffff, b: a & 0xffff, lanes: 0, data: 0 });
  const wr = (a, v) => log.push({ w: 1, a: a & 0xfffe, b: a & 0xffff, lanes: 1 << (a & 1), data: (v & 0xff) << 8 * (a & 1) });
  m.rd8 = (a) => { rd(a); return rd8.call(m, a); };
  m.rd16 = (a) => { rd(a); if (a & 1) rd(a + 1); return rd16.call(m, a); };
  m.wr8 = (a, v) => { wr(a, v); wr8.call(m, a, v); };
  m.wr16 = (a, v) => {
    if (a & 1) { wr(a, v); wr(a + 1, v >> 8); } else log.push({ w: 1, a: a & 0xfffe, b: a & 0xffff, lanes: 3, data: v & 0xffff });
    wr16.call(m, a, v);
  };
  return log;
};
// Upward from the lowest byte, which memory's wrap can make 0xffff.
const upward = (xs) => {
  const lo = xs.find((x) => xs.every((y) => ((y.b - x.b) & 0xffff) < 16));
  return lo ? xs.sort((x, y) => ((x.b - lo.b) & 0xffff) - ((y.b - lo.b) & 0xffff)) : xs;
};
const showAcc = (e) => e ? (e.w ? `write ${hex4(e.a)} lanes ${e.lanes} ${hex4(e.data)}` : `read ${hex4(e.a)}`) : 'nothing';
// And folded, for the interrupt bench, which folds its own the same way.
const foldAcc = (log) => {
  let h = 0;
  for (const e of log) {
    h = (Math.imul(h, 31) + ((e.w << 18) | (e.lanes << 16) | e.a)) & 0x7fffffff;
    h = (Math.imul(h, 31) + e.data) & 0x7fffffff;
  }
  return h;
};
const programs = [];
// WHAT A STORE DID IS NOT IN ANY REGISTER, so both machines fold their whole
// memory into one number at the halt.
const fold = (mem) => {
  let hash = 0;
  for (let k = 0; k < 65536; k++) hash = (Math.imul(hash, 31) + mem[k]) & 0x7fffffff;
  return hash;
};
// THE TEST BENCHES DUMP IT, and this folds the dump.  64K iterations of a
// Verilog loop cost vvp 24 ms, and every program on every bench paid that
// twice, to clear memory and to fold it - most of this test's time.
// $readmemh and $writememh do the same in C.  So each bench reads its
// memory clear from build/cpu-zero.hex, and writes it at the end to
// build/cpu-mem-N.hex, whose fold goes into field 5 of the program's END or
// IRQ line - where the bench's own used to be, so that its output can still
// be compared whole against another run's.
const foldDump = (p) => {
  const text = readFileSync(`build/cpu-mem-${p}.hex`, 'latin1');
  let hash = 0, k = 0;
  for (const line of text.split('\n')) {
    if (line === '' || line[0] === '/') continue;
    const b = parseInt(line, 16);
    hash = (Math.imul(hash, 31) + (Number.isNaN(b) ? 0x100 : b)) & 0x7fffffff;    // x is never a byte
    k++;
  }
  return k === 65536 ? hash : -1;
};
const vvp = (file) => execFileSync('vvp', [file], { encoding: 'utf8', maxBuffer: 1 << 26 })
  .split('\n').map((line) => {
    const f = line.trim().split(/\s+/);
    if (f[0] !== 'END' && f[0] !== 'IRQ') return line;
    f[5] = String(foldDump(+f[1]));
    return f.join(' ');
  }).join('\n');
// Built with FRUCTUS_BLIT, the test bench hands the processor each word again
// a cycle later, as tools/fpga-system.sv does: \`late\` is the word at the
// address sampled two edges ago.
//
// AND BOTH LOAD PORTS ARE POISONED outside a load's word: mem_data and
// mem_late carry the word inverted except in the cycle mem_rld says a load's
// word arrived, and the cycle after for mem_late.  The system's mem_data is
// an I/O register's whenever mar points at one, whatever the cycle, so a
// fetch, a store or a shadow that took a byte from either port would read
// a register - and here reads garbage the simulator does not.  Only the
// captures may: what keeps a fetch from ever reading an I/O register is that
// instruction bytes come from mem_rdata alone.
const BLIT_WIRING = `\`ifdef FRUCTUS_BLIT
    logic [15:0] late;
    always @(posedge clk) late <= rld ? rdata : ~rdata;
    wire  [15:0] ldata = rld ? rdata : ~rdata;
\`endif`;
mkdirSync('build', { recursive: true });
writeFileSync('build/cpu-zero.hex', '00\n'.repeat(65536));
let dtraps = 0;                        // divide-by-zero traps the simulator took
for (let p = 0; p < PROGRAMS; p++) {
  let bytes, draws = val;
  if (p < N_ALU) {
    // The first program has every form twice, once from each alignment;
    // after that, one instruction in five is a branch.
    const picks = p === 0 ? shuffle([...all, ...brs, ...jumps, ...excs, NOP, ...all, ...brs, ...jumps, ...excs])
                          : Array.from({ length: 40 }, () => {
                              const r = rnd() % 20;
                              return r < 4 ? brs[rnd() % brs.length]
                                   : r < 6 ? jumps[rnd() % jumps.length]
                                   : r < 7 ? excs[rnd() % excs.length]
                                   : all[rnd() % all.length];
                            });
    bytes = layout(picks).concat([HALT]);
  } else if (p < N_ALU + N_LD) {
    // Loads among everything else; the first has every load twice.
    const picks = p === N_ALU ? shuffle([...loads, NOP, ...loads])
                              : Array.from({ length: 40 }, () => {
                                  const r = rnd() % 10;
                                  return r < 3 ? loads[rnd() % loads.length]
                                       : r < 4 ? brs[rnd() % brs.length]
                                       : all[rnd() % all.length];
                                });
    bytes = layout(picks).concat([HALT]);
  } else if (p < N_ALU + N_LD + N_ST) {
    // Stores alone, from the safe window; the first has every one twice.
    const picks = p === N_ALU + N_LD ? shuffle([...stores, NOP, ...stores])
                                     : Array.from({ length: 30 }, () => stores[rnd() % stores.length]);
    bytes = layout(picks).concat([HALT]);
    draws = safe;
  } else if (p < N_RANDOM) {
    // Mixed, the pointers in the safe window and the rest anything.
    const pick = (xs) => xs[rnd() % xs.length];
    const picks = Array.from({ length: 40 }, () => {
      const r = rnd() % 20;
      return r < 5 ? pick(mix.ldPtr) : r < 6 ? pick(mix.ldAny) : r < 10 ? pick(mix.st)
           : r < 13 ? pick(brs) : r < 15 ? pick(mix.jumps) : r < 16 ? pick(excs) : pick(mix.alu);
    });
    bytes = layout(picks).concat([HALT]);
    const w = safe(), near = () => w + (rnd() % 8);
    draws = (_, k) => (PTR.has(k) ? near() : val());
  } else {
    bytes = assembled[p - N_RANDOM];
  }
  const reg = Array.from({ length: 8 }, draws);
  // WITH THE I/O PAGE, as rtl/cpu.sv always has it: its shadows, and its
  // guards, which a random load or store can touch as well as a program
  // written to.
  const io = true;
  const m = new Machine(spec, { io }).load(bytes, 0);
  m.mem[VECTOR] = RTI;
  m.mem[GVECTOR] = HALT;
  m.mem[DVECTOR] = RTI;
  reg.forEach((v, k) => { m.R[k] = v; });
  // AND ITS TWIN IN BLIT MODE, traced on its own: the same machine but for
  // its loads' timing, which changes what the fetcher has when - and so,
  // now and then, which instruction a guard trap replaces, since a trap is
  // taken at a cycle, not at an instruction.  So blit mode is held to its
  // twin's pcs and registers, not the plain machine's.
  const mb = new Machine(spec, { io, blit: true }).load(m.mem, 0);
  mb.R.set(m.R);
  // WHETHER A BRANCH IS TAKEN IS NOT WHERE THE pc LANDS: a branch to the
  // very next instruction lands there either way, and the processor still
  // pays for taking it.  So a branch is stepped a second time, on a copy
  // whose offset byte is 1, and it was taken if that copy's pc moved by one
  // more than the branch's length.
  const run = (m) => {
    const takes = (pc, len) => {
      const c = new Machine(spec, { io }).load(m.mem, 0);
      c.R.set(m.R);
      c.pc = pc;
      c.mem[(pc + 2) & 0xffff] = 1;
      c.step();
      return c.pc === ((pc + len + 1) & 0xffff);
    };
    const trace = [], alog = logAccesses(m);
    for (let guard = 0; !m.halted && guard < 5000; guard++) {
      const pc = m.pc;
      // A guard trap is a brk dispatched where the next instruction would be,
      // and so is a divide by zero.
      const trap = m.divPending || (m.guardPending && m.fe.t >= m.guardAt);
      if (m.divPending && !m.blit) dtraps++;
      const d = decode(dec, trap ? [0, 0, 0]
                                           : [m.mem[pc], m.mem[(pc + 1) & 0xffff], m.mem[(pc + 2) & 0xffff]], 0);
      const taken = branches.has(`${d.insn.mnemonic}/${d.form.name}@${m.mem[pc]}`) && takes(pc, d.nbytes);
      // A jump costs four cycles through a register - jmp ra, call ra, ret -
      // which goes through taken_q.  An absolute target is read as the
      // jump dispatches, so jmp's target dispatches two cycles after it, and
      // call's three, when its ALU cycle has moved the pc.  jmp ra's and call
      // ra's targets, guessed right, are read as they dispatch too: two, three;
      // and ret's, from the return stack: two.
      const jm = JUMP_SEM.exec(d.insn.semantics ?? '');
      const jump = !jm ? 0 : jm[2] === 'target' ? (jm[1] ? 3 : 2)
                 : jm[1] ? 3 : 2;
      const exc = EXC.test(d.insn.mnemonic) ? EXC_CYCLES[d.insn.mnemonic]
                : d.insn.extra_cycles > 0 ? 1 + d.insn.extra_cycles : 0;
      const mem = memBytes(d.insn.semantics ?? '');
      const memst = mem && /^(M(8|16)\[R|base = [a-z0-9]+; M16)/.test(d.insn.semantics);
      // Blit mode makes every load but pop a cycle slower.
      const late = mem && !memst && !/^base = sp; /.test(d.insn.semantics);
      const before = m.cycles(), xfer0 = m.xfer, a0 = alog.length;
      m.step();
      // WITHIN AN INSTRUCTION, ADDRESS ORDER: a block move goes up memory
      // whichever way its semantics list it - push's, top first - and an
      // odd word its low byte first.
      alog.push(...upward(alog.splice(a0)));
      const cyc = m.cycles() - before;   // what the simulator charged it
      // A memory instruction's accesses: an aligned word is one, a byte one.
      const acc = mem ? m.xfer - xfer0 : 0;
      const back = !!(m.mem[(pc + 2) & 0xffff] & 0x80);
      if (!m.halted) trace.push({ pc, len: d.nbytes, taken, back, jump, mem, acc, memst, late, exc, cyc, R: Array.from(m.R) });
    }
    return { trace, acc: alog, hash: fold(m.mem), gtrap: m.pc === ((GVECTOR + 1) & 0xffff) };
  };
  const plain = run(m), blit = run(mb);
  programs.push({ bytes, reg, ...plain, io, blit });
  writeFileSync(`build/cpu-prog-${p}.hex`, bytes.map((b) => b.toString(16).padStart(2, '0')).join('\n') + '\n');
  writeFileSync(`build/cpu-reg-${p}.hex`, reg.map(hex4).join('\n') + '\n');
}

writeFileSync('build/cpu-tb.sv', `module tb;
    logic clk = 0, rst = 1;
    logic [7:0] mem [0:65535];
    logic [15:0] rdata;
    logic [15:0] regs [0:7];
    wire [15:0] addr, rpc;
    wire [15:0] wdata;
    wire [1:0] we;
    wire halted, trapped, ret;
    wire [15:0] rmar;
    wire rld, whi;
${BLIT_WIRING}
    cpu u (.clk(clk), .rst(rst), .boot(1'b0), .mem_addr(addr), .mem_rdata(rdata),
                .mem_wdata(wdata), .mem_we(we), .mem_whi(whi), .mem_rmar(rmar), .mem_rld(rld), .irq(1'b0),
\`ifdef FRUCTUS_BLIT
                .blit(\`BLIT_ON), .mem_late(late), .mem_data(ldata),
\`endif
                .halted(halted), .trapped(trapped), .result(), .retire(ret), .retire_pc(rpc));
    // A word a cycle, the even byte low, as the SPRAM delivers it; a write goes
    // to the lanes mem_we names, at the same edge, and a read in that cycle
    // sees what was there before.
    always @(posedge clk) begin
        rdata <= {mem[{addr[15:1], 1'b1}], mem[{addr[15:1], 1'b0}]};
        if (we[0]) mem[{addr[15:1], 1'b0}] <= wdata[7:0];
        if (we[1]) mem[{addr[15:1], 1'b1}] <= wdata[15:8];
    end
    integer p, k, cyc, ev, epc, go, dpc, sq, h, rl, rm, wv, wa, wd, wh;
    reg [8*64:1] name;
    task step;
        begin
            ev = ret; epc = rpc; go = u.go; dpc = u.pc; sq = u.taken_q;
            rl = rld; rm = rmar; wv = we; wa = addr; wd = wdata; wh = whi;
            #1 clk = 1; #1 clk = 0;
            // A load's word arrived, its address put out the cycle before;
            // a write at this edge.
            if (rl) $display("RD %0d %0d %h", p, cyc, rm[15:0]);
            if (wv != 0) $display("WR %0d %0d %h %0d %h %0d", p, cyc, wa[15:0], wv, wd[15:0], wh);
            if (sq) $display("SQUASH %0d %0d", p, cyc);
            if (go) $display("DISP %0d %0d %h", p, cyc, dpc[15:0]);
            if (ev) $display("RET %0d %h %h %h %h %h %h %h %h %h", p, epc[15:0],
                             u.R[0], u.R[1], u.R[2], u.R[3], u.R[4], u.R[5], u.R[6], u.R[7]);
            cyc = cyc + 1;
        end
    endtask
    initial begin
        for (p = 0; p < ${PROGRAMS}; p = p + 1) begin
            $readmemh("build/cpu-zero.hex", mem);
            $sformat(name, "build/cpu-prog-%0d.hex", p); $readmemh(name, mem);
            $sformat(name, "build/cpu-reg-%0d.hex", p);  $readmemh(name, regs);
            rst = 1;
            repeat (3) begin #1 clk = 1; #1 clk = 0; end
            for (k = 0; k < 8; k = k + 1) u.R[k] = regs[k];
            // The shadows are not reset; tools/sim.js starts them at zero.
            u.shadow_sp = 0; u.shadow_lr = 0; u.shadow_isp = 0;
            // Nor is the predictor's table, which a new Machine starts empty.
            for (h = 0; h < 256; h = h + 1) u.bpm[h] = 0;
            for (h = 0; h < 1024; h = h + 1) begin u.jtm[h] = 0; u.jcm[h] = 0; end
            mem[${VECTOR}] = 8'h${RTI.toString(16).padStart(2, '0')};
            mem[${GVECTOR}] = 8'h${HALT.toString(16).padStart(2, '0')};
            mem[${DVECTOR}] = 8'h${RTI.toString(16).padStart(2, '0')};
            rst = 0; cyc = 0;
            while (!halted && !trapped && cyc < 20000) step;
            // AND ON A LITTLE: whatever stopped the machine must have stopped
            // everything, so nothing more may dispatch, retire or be written.
            k = cyc;
            repeat (12) step;
            cyc = k;
            $sformat(name, "build/cpu-mem-%0d.hex", p); $writememh(name, mem);
            $display("END %0d %0d %0d %0d 0", p, halted, trapped, cyc);
        end
        $finish;
    end
endmodule
`);
const RTL = ['cpu', 'classify', 'alu', 'ucode', 'lhs', 'dest', 'immgen', 'cond', 'compare', 'recip']
  .map((m) => `${process.env.FRUCTUS_RTL ?? 'rtl'}/${m}.sv`);
execFileSync('iverilog', ['-g2012', '-o', 'build/cpu-tb.vvp', ...RTL, 'build/cpu-tb.sv'], { stdio: 'inherit' });
const out = vvp('build/cpu-tb.vvp');

// AND AGAIN WITH THE SB_MAC16 THAT SYNTHESIS GETS: yosys's own model of the
// DSP, which checks the instance's parameters.  Every line must be the same, less the $finish, whose time unit
// the cells' `timescale changes.
const CELLS = '/usr/share/yosys/ice40/cells_sim.v';
execFileSync('iverilog', ['-g2012', '-DCPU_CELLS', '-o', 'build/cpu-tb.vvp', CELLS, ...RTL, 'build/cpu-tb.sv'],
             { stdio: ['ignore', 'ignore', 'inherit'] });
const trace = (text) => text.split('\n').filter((l) => !/\$finish/.test(l)).join('\n');
const outCells = vvp('build/cpu-tb.vvp');
if (trace(outCells) !== trace(out)) {
  console.log('FAIL  rtl/cpu.sv: with yosys\'s SB_MAC16 it runs differently from the plain multiply');
  process.exit(1);
}

let bad = 0, instructions = 0, cycles = 0, accesses = 0, squashedMem = 0;
const complain = (msg) => { if (bad++ < 8) console.log(`  MISMATCH ${msg}`); };

// One run's output against the simulator: in blit mode, its blit-mode twin,
// whose ld, ld8 and ldm cost a cycle more.
function check(out, blit, what) {
  const rets = programs.map(() => []), disps = programs.map(() => []), squashes = programs.map(() => []), ends = [];
  const accs = programs.map(() => []);
  for (const line of out.split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f[0] === 'RET')  rets[+f[1]].push({ pc: parseInt(f[2], 16), R: f.slice(3, 11).map((h) => parseInt(h, 16)) });
    if (f[0] === 'DISP') disps[+f[1]].push({ cyc: +f[2], pc: parseInt(f[3], 16) });
    if (f[0] === 'SQUASH') squashes[+f[1]].push(+f[2]);
    // In the order they used the bus: a read in the cycle before its word
    // arrived, a write in its own, and a write first should the two ever
    // claim one cycle, as the interrupt bench folds them.
    if (f[0] === 'RD') accs[+f[1]].push({ t: 2 * (+f[2] - 1) + 1, w: 0, a: parseInt(f[3], 16), lanes: 0, data: 0 });
    if (f[0] === 'WR') {
      const a = parseInt(f[3], 16), lanes = +f[4], d = parseInt(f[5], 16);
      accs[+f[1]].push({ t: 2 * +f[2], w: 1, a: a & 0xfffe, lanes, whi: +f[6], hi: a >> 15,
                         data: (lanes & 1 ? d & 0xff : 0) | (lanes & 2 ? d & 0xff00 : 0) });
    }
    if (f[0] === 'END')  ends[+f[1]] = { halted: f[2] === '1', trapped: f[3] === '1', cyc: +f[4], hash: +f[5] };
  }
  programs.forEach((q, p) => {
    const { trace, hash } = blit ? q.blit : q;
    const say = (msg) => complain(`${what}program ${p}${msg}`);
    if (ends[p] && ends[p].hash !== hash)
      say(`: memory folds to ${ends[p].hash} on the RTL and ${hash} on the simulator`);
    // A squash in cycle T undoes the dispatches of T - 2, T - 1 and T: the
    // three instructions behind the branch.
    const got = rets[p];
    const ds = disps[p].filter((d) => !squashes[p].some((t) => d.cyc >= t - 2 && d.cyc <= t));
    // How many of those undone were loads or stores: what the access check
    // is for, so it should not be few.
    if (!blit) for (const d of disps[p]) {
      if (!squashes[p].some((t) => d.cyc >= t - 2 && d.cyc <= t)) continue;
      const b = q.bytes, at = d.pc;
      const di = at < b.length ? decode(dec, [b[at], b[at + 1] ?? 0, b[at + 2] ?? 0], 0) : null;
      if (di && memBytes(di.insn.semantics ?? '')) squashedMem++;
    }
    if (!ends[p]?.halted || ends[p]?.trapped)
      say(`: ended ${ends[p]?.trapped ? 'trapped' : 'without halting'}`);
    if (got.length !== trace.length) say(`: ${got.length} retired, the simulator ran ${trace.length}`);
    for (let i = 0; i < Math.min(got.length, trace.length); i++) {
      const g = got[i], t = trace[i];
      const clocked = blit && CLOCKED.has(p - N_RANDOM);
      if (g.pc !== t.pc || !clocked && g.R.some((v, k) => v !== t.R[k]))
        say(` instruction ${i} at 0x${t.pc.toString(16)}: rtl pc ${g.pc.toString(16)} r=${g.R.map(hex4).join(' ')}, sim r=${t.R.map(hex4).join(' ')}`);
      if (!blit) instructions++;
    }
    // The dispatch cadence: the halt is dispatched too, so there is one more
    // dispatch than retirement.
    // tools/sim.js's cost model, which every cycle count in the repo comes
    // from, must charge what the processor takes - and that depends on what
    // the fetcher has, so it is the simulator's own model of the fetcher
    // that is held to the processor here.  What the checker knows without
    // it is a floor: what each instruction takes at least, the next one's
    // bytes there as soon as the back end lets it go.
    for (let i = 1; i < Math.min(ds.length, trace.length + 1); i++) {
      const prev = trace[i - 1];
      const want = prev.cyc;
      const floor = prev.exc ? prev.exc
                  : prev.memst ? Math.max(2, prev.acc)
                  : prev.mem ? prev.acc + 2 + (blit && prev.late ? 1 : 0)
                  : prev.jump ? prev.jump : prev.taken ? 2 : 1;
      if (ds[i].pc !== (trace[i]?.pc ?? ds[i].pc)) say(` dispatch ${i}: pc ${ds[i].pc.toString(16)}`);
      if (ds[i].cyc - ds[i - 1].cyc !== want)
        say(` dispatch ${i}: ${ds[i].cyc - ds[i - 1].cyc} cycles after the one at 0x${prev.pc.toString(16)}, tools/sim.js charges ${want}`);
      if (want < floor)
        say(` instruction at 0x${prev.pc.toString(16)}: tools/sim.js charges ${want} cycles, less than the ${floor} it takes at least`);
    }
    // The data accesses, one for one.
    const acc = blit ? q.blit.acc : q.acc;
    const ga = accs[p].sort((x, y) => x.t - y.t);
    for (let i = 0; i < Math.max(ga.length, acc.length); i++) {
      const g = ga[i], t = acc[i];
      if (g && g.w && g.whi !== g.hi) say(` access ${i}: mem_whi ${g.whi} with the address's bit 15 ${g.hi}`);
      if (!g || !t || g.w !== t.w || g.a !== t.a || g.lanes !== t.lanes || g.data !== t.data) {
        say(` access ${i}: the rtl's ${showAcc(g)} in cycle ${g ? g.t >> 1 : '-'}, the simulator's ${showAcc(t)}; `
          + `${ga.length} on the bus, ${acc.length} in the semantics`);
        break;
      }
      if (!blit) accesses++;
    }
    if (!blit) cycles += ends[p]?.cyc ?? 0;
  });
}
check(out, false, '');
// A machine that is wrong already is not tried in blit mode or under
// interrupts: a program that never halts runs the interrupt bench's 50000
// cycles, and when they all do that is minutes saying nothing new.
if (bad) {
  console.log(`FAIL  rtl/cpu.sv: ${bad} disagreements with tools/sim.js`);
  process.exit(1);
}

// AND BUILT WITH FRUCTUS_BLIT: with the mode off it must be the same machine,
// line for line; with it on, the memory hands every word back a second time,
// a cycle later, on mem_late, as tools/fpga-system.sv does from its own
// memory - so a late load finds the same bytes, a cycle later.
execFileSync('iverilog', ['-g2012', '-DFRUCTUS_BLIT', '-DBLIT_ON=1\'b0', '-o', 'build/cpu-tb.vvp', ...RTL, 'build/cpu-tb.sv'],
             { stdio: 'inherit' });
const outOff = vvp('build/cpu-tb.vvp');
if (trace(outOff) !== trace(out)) {
  console.log('FAIL  rtl/cpu.sv: built for blit mode with the mode off, it runs differently');
  process.exit(1);
}
execFileSync('iverilog', ['-g2012', '-DFRUCTUS_BLIT', '-DBLIT_ON=1\'b1', '-o', 'build/cpu-tb.vvp', ...RTL, 'build/cpu-tb.sv'],
             { stdio: 'inherit' });
check(vvp('build/cpu-tb.vvp'), true, 'in blit mode, ');
for (const f of ['build/cpu-tb.vvp', 'build/cpu-tb.sv']) rmSync(f, { force: true });

// --- the interrupt line -----------------------------------------------------------
// THE SAME PROGRAMS, INTERRUPTED EVERY FEW CYCLES.  The vector holds nothing
// but rti, so an interrupt entered
// and left must leave a program exactly as if it had never come: the same
// registers and memory at the halt as the simulator's run without one.  The
// line goes up 17 to 39 cycles after each take, at random, and down at the
// next, so interrupts land after every kind of instruction.  Not on a fixed
// period: a level-sensitive line that comes back just as the preempted
// instruction is dispatched again starves it forever.
//
// AND ONCE AT THE HALT.  The machine must go on AFTER the halt, so a second
// one is put there, and the pc must end a byte further on than it waited at.
//
// A PROGRAM THAT RAN cli may rightly take none, and one whose ie is clear at
// the halt is not woken; the simulator, started with ie set as the test bench
// sets the RTL's, says which those are.
// A GUARD TRAP MAY COME A CYCLE EARLIER under interrupts: an interrupt
// taken in the cycle the hit sets gq becomes the guard's brk, at the
// dispatch the trap would otherwise have let one more instruction take.
// So a program ends as the simulator's run does, or as one whose guard traps
// are all taken a cycle before the simulator's.
const finalOf = ({ bytes, reg, io }, exact) => {
  const m = new Machine(spec, { io }).load(bytes, 0);
  m.mem[VECTOR] = RTI;
  m.mem[GVECTOR] = HALT;
  m.mem[DVECTOR] = RTI;
  m.ie = 1;
  reg.forEach((v, k) => { m.R[k] = v; });
  let cli = false;
  const alog = logAccesses(m);
  for (let guard = 0; !m.halted && guard < 5000; guard++) {
    if (m.mem[m.pc] === excs[2].op) cli = true;
    const at = m.guardAt, a0 = alog.length;
    m.step();
    alog.push(...upward(alog.splice(a0)));
    if (exact && m.guardPending && m.guardAt !== at) m.guardAt -= 1;
  }
  m.mem[m.pc] = HALT;                            // as the test bench puts after the halt
  let hash = 0;
  for (let k = 0; k < 65536; k++) hash = (Math.imul(hash, 31) + m.mem[k]) & 0x7fffffff;
  return { R: Array.from(m.R), hash, cli, ie: m.ie, acc: foldAcc(alog) };
};
const finals = programs.map((q) => finalOf(q, false));
const exacts = programs.map((q) => finalOf(q, true));
writeFileSync('build/cpu-irq-tb.sv', `module tb;
    logic clk = 0, rst = 1, irq = 0, drop;
    integer next, lfsr;
    logic [7:0] mem [0:65535];
    logic [15:0] rdata;
    logic [15:0] regs [0:7];
    wire [15:0] addr;
    wire [15:0] wdata;
    wire [1:0] we;
    wire halted, trapped;
    wire [15:0] rmar;
    wire rld;
${BLIT_WIRING}
    cpu u (.clk(clk), .rst(rst), .boot(1'b0), .mem_addr(addr), .mem_rdata(rdata),
                .mem_wdata(wdata), .mem_we(we), .mem_rmar(rmar), .mem_rld(rld), .irq(irq),
\`ifdef FRUCTUS_BLIT
                .blit(\`BLIT_ON), .mem_late(late), .mem_data(ldata),
\`endif
                .halted(halted), .trapped(trapped), .result(), .retire(), .retire_pc());
    always @(posedge clk) begin
        rdata <= {mem[{addr[15:1], 1'b1}], mem[{addr[15:1], 1'b0}]};
        if (we[0]) mem[{addr[15:1], 1'b0}] <= wdata[7:0];
        if (we[1]) mem[{addr[15:1], 1'b1}] <= wdata[15:8];
    end
    integer p, k, cyc, takes, h, pc1, acch, wv, wa, wd, rl, rm;
    reg [8*64:1] name;
    // The data accesses folded as tests/cpu-check.mjs folds the simulator's,
    // in the order they had the bus: at each edge the read whose word
    // arrives, its address put out the cycle before, and then the write.
    task fold(input integer code, input integer data);
        begin
            acch = (acch * 31 + code) & 32'h7fffffff;
            acch = (acch * 31 + data) & 32'h7fffffff;
        end
    endtask
    // One cycle.  With \`raise\`, the line goes up at \`next\`; it drops after
    // a take, and \`next\` is then 17 to 39 cycles on.
    task tick(input integer raise);
        begin
            if (raise && cyc == next) irq = 1;
            drop = u.take;
            if (drop) takes = takes + 1;
            rl = rld; rm = rmar; wv = we; wa = addr; wd = wdata;
            #1 clk = 1; #1 clk = 0;
            if (rl) fold(rm & 16'hffff, 0);
            if (wv != 0) fold((1 << 18) | (wv << 16) | (wa & 16'hfffe),
                              ((wv & 1) ? (wd & 16'h00ff) : 0) | ((wv & 2) ? (wd & 16'hff00) : 0));
            if (drop) begin
                irq = 0;
                lfsr = (lfsr * 1103515245 + 12345) & 32'h7fffffff;
                next = cyc + 17 + (lfsr >> 8) % 23;
            end
            cyc = cyc + 1;
        end
    endtask
    initial begin
        for (p = 0; p < ${PROGRAMS}; p = p + 1) begin
            $readmemh("build/cpu-zero.hex", mem);
            $sformat(name, "build/cpu-prog-%0d.hex", p); $readmemh(name, mem);
            $sformat(name, "build/cpu-reg-%0d.hex", p);  $readmemh(name, regs);
            mem[${VECTOR}] = 8'h${RTI.toString(16).padStart(2, '0')};
            mem[${GVECTOR}] = 8'h${HALT.toString(16).padStart(2, '0')};
            mem[${DVECTOR}] = 8'h${RTI.toString(16).padStart(2, '0')};
            irq = 0;
            rst = 1;
            repeat (3) begin #1 clk = 1; #1 clk = 0; end
            for (k = 0; k < 8; k = k + 1) u.R[k] = regs[k];
            u.shadow_sp = 0; u.shadow_lr = 0; u.shadow_isp = 0;
            u.ie = 1'b1;                       // as sei would
            rst = 0; cyc = 0; takes = 0; next = 5 + p % 7; lfsr = p + 1; acch = 0;
            while (!halted && !trapped && cyc < 50000) tick(1);
            // At the halt: a second one after it, and the line once more.
            pc1 = u.pc;
            mem[pc1] = 8'h${HALT.toString(16).padStart(2, '0')};
            irq = 1;
            k = cyc;
            while (irq && cyc < k + 50) tick(0);
            irq = 0;
            repeat (40) tick(0);
            $sformat(name, "build/cpu-mem-%0d.hex", p); $writememh(name, mem);
            $display("IRQ %0d %0d %0d %0d 0 %h %h %h %h %h %h %h %h %0d %0d %0d", p, halted, trapped, takes,
                     u.R[0], u.R[1], u.R[2], u.R[3], u.R[4], u.R[5], u.R[6], u.R[7], pc1, u.pc, acch);
        end
        $finish;
    end
endmodule
`);
// And in blit mode.
let irqTakes = 0;
for (const blit of [false, true]) {
  const what = blit ? ' in blit mode' : '';
  execFileSync('iverilog', ['-g2012', ...(blit ? ['-DFRUCTUS_BLIT', '-DBLIT_ON=1\'b1'] : []),
    '-o', 'build/cpu-irq-tb.vvp', ...RTL, 'build/cpu-irq-tb.sv'], { stdio: 'inherit' });
  const irqOut = vvp('build/cpu-irq-tb.vvp');
  const irqSeen = new Set();
  for (const line of irqOut.split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f[0] !== 'IRQ') continue;
    const p = +f[1], R = f.slice(6, 14).map((x) => parseInt(x, 16));
    const fin = +f[5] === exacts[p].hash && R.every((v, k) => v === exacts[p].R[k]) && +f[16] === exacts[p].acc
              ? exacts[p] : finals[p];
    irqSeen.add(p);
    if (!blit) irqTakes += +f[4];
    if (f[2] !== '1' || f[3] !== '0') complain(`program ${p}: ${f[3] === '1' ? 'trapped' : 'did not halt'} under interrupts${what}`);
    if (!fin.cli && +f[4] < 1) complain(`program ${p}: no interrupt taken${what}`);
    if (+f[5] !== fin.hash) complain(`program ${p}: memory folds to ${f[5]} under interrupts${what} and ${fin.hash} without`);
    if (+f[16] !== fin.acc) complain(`program ${p}: its data accesses fold to ${f[16]} under interrupts${what} and ${fin.acc} without`);
    if (fin.ie && +f[15] !== +f[14] + 1)
      complain(`program ${p}${what}: waited at 0x${(+f[14]).toString(16)} and ended at 0x${(+f[15]).toString(16)}, not a byte on, after the interrupt at the halt`);
    // The interrupts' own cycles are in a count read after them.
    if (!CLOCKED.has(p - N_RANDOM) && R.some((v, k) => v !== fin.R[k]))
      complain(`program ${p}: r=${R.map(hex4).join(' ')} under interrupts${what}, sim r=${fin.R.map(hex4).join(' ')}`);
  }
  if (irqSeen.size !== PROGRAMS) complain(`${PROGRAMS - irqSeen.size} programs printed nothing under interrupts${what}`);
}
for (const f of ['build/cpu-irq-tb.vvp', 'build/cpu-irq-tb.sv']) rmSync(f, { force: true });
if (!process.env.CPU_KEEP) for (let p = 0; p < PROGRAMS; p++) for (const f of [`build/cpu-prog-${p}.hex`, `build/cpu-reg-${p}.hex`]) rmSync(f, { force: true });
if (!process.env.CPU_KEEP) for (let p = 0; p < PROGRAMS; p++) rmSync(`build/cpu-mem-${p}.hex`, { force: true });
rmSync('build/cpu-zero.hex', { force: true });

// The four guard programs, each run twice, must have ended at io_guard's halt.
const GUARD_PROGRAMS = 8;
for (let k = 0; k < GUARD_PROGRAMS; k++)
  if (!programs[N_RANDOM + k].gtrap) complain(`program ${N_RANDOM + k} ran into a guard and did not trap`);
const gtraps = programs.filter((q) => q.gtrap).length;
if (bad === 0) {
  const taken = programs.reduce((n, { trace }) => n + trace.filter((t) => t.taken).length, 0);
  const jumped = programs.reduce((n, { trace }) => n + trace.filter((t) => t.jump).length, 0);
  const moved = programs.reduce((n, { trace }) => n + trace.filter((t) => t.mem).length, 0);
  // A word instruction took its words whole when it made fewer accesses than
  // it moved bytes: aligned.
  const whole = programs.reduce((n, { trace }) => n + trace.filter((t) => t.mem && t.acc < t.mem).length, 0);
  console.log(`ok    rtl/cpu.sv: ${PROGRAMS} programs, ${instructions} instructions over `
            + `${all.length + brs.length + jumps.length + loads.length + stores.length} forms, `
            + `${taken} branches taken, ${jumped} jumps, ${moved} memory instructions, ${whole} a word at a time; `
            + `registers, memory, ${accesses} data accesses in order, dispatch cadence and tools/sim.js's cycle counts agree, `
            + `${cycles} cycles to halt, ${squashedMem} loads and stores dispatched and squashed; `
            + `${gtraps} guard traps, ${gtraps - GUARD_PROGRAMS} of them random; `
            + `${dtraps} divide-by-zero traps`);
  console.log(`ok    rtl/cpu.sv, interrupted: ${PROGRAMS} programs under ${irqTakes} interrupts, `
            + `the last at each halt, end as tools/sim.js does without them, their data accesses too`);
  const lateLoads = programs.reduce((n, { trace }) => n + trace.filter((t) => t.late).length, 0);
  console.log(`ok    rtl/cpu.sv, built for blit mode: the same machine with it off; with it on, `
            + `${lateLoads} loads a cycle late, interrupted and not, as predicted`);
} else {
  console.log(`FAIL  rtl/cpu.sv: ${bad} disagreements with tools/sim.js`);
  process.exit(1);
}
