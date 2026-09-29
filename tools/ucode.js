// =============================================================================
// ucode.js - the processor's microcode, as data
// =============================================================================
//
// Shared by tools/gen-ucode.js, which writes the ROM, and
// tools/gen-classify.js, which gives every microcoded opcode the
// address its routine starts at.  One module, so that the two cannot
// disagree about where a routine is.
//
// A ROUTINE is up to eight steps at an ENTRY: the ROM address is
// {entry, step - 1}.  Entry 0 is the idle routine, all zeros, which the
// sequencer reads when it has nothing to do.  The entries are assigned in
// the order the routines are listed here, so one can be added anywhere.
//
// The rules for a memory instruction's steps, and why the exception routines
// are ordered as they are, are in tools/gen-ucode.js's header.
// =============================================================================

export const STEPS = 8;
export const ENTRY_BITS = 5;

// THE WORD, field by field: [name, bit, width, what it does in its step].
// rtl/cpu.sv takes the same fields at the same bits.
export const FIELDS = [
  ['A',   0, 1, 'an address step: mar, or mar + 1 for a load, and mar steps up'],
  ['C',   1, 1, "a load's byte arrives and shifts into ldq"],
  ['R',   2, 1, 'dispatch is released'],
  ['D',   3, 1, 'the last step'],
  ['W',   4, 2, 'a loaded register is written: 1, 2 or 3, through the ALU'],
  ['P',   6, 1, "a block move's pointer is written, the same way"],
  ['WE',  7, 1, 'the NEXT step writes memory'],
  ['KS',  8, 2, 'the register read this step: 0 .. 2 of the list, 3 a literal'],
  ['KH', 10, 1, "which half of it a store's next byte is - or, when KS is 3, lr and not sp"],
  ['SH', 11, 2, 'a shadow takes aq, the register read the step before: 1 shadow_sp, 2 shadow_lr, 3 shadow_isp'],
  ['LQ', 13, 3, 'ldq takes: 1 the pc, 2 shadow_sp, 3 shadow_lr, 4 shadow_isp, 5 the product, 6 clz or popcount'],
  ['WX', 16, 2, 'a register is written from ldq, through the ALU: 1 sp, 2 lr'],
  ['IE', 18, 2, 'ie: 1 cleared, 2 set'],
  ['RJ', 20, 2, 'the fetch goes to: 1 the vector, 2 aq, the register read the step before'],
  ['L',  22, 1, "C's byte is on mem_late, the word from two edges ago: blit mode"],
];
export const WORD_BITS = 32;

// A memory instruction's routine depends on how it moves bytes, not on which
// instruction it is: push and stm step alike, and so do pop and ldm.
const memKey = ({ st, blk, w2, n }) => `${st ? 'st' : 'ld'}${blk ? 'blk' : ''}${w2 ? 16 : 8}x${n}`;

// BLIT MODE'S LOADS take every byte a cycle late, on mem_late, so their
// arrivals, their writes, their release and their end each come a step later
// than the ordinary routine's; the addresses go out as before.  Only ld, ld8
// and ldm have a late copy - pop keeps its ordinary routine - and a one-byte
// load's copy releases dispatch in step 1 instead of its ALU cycle.
function memSteps({ st, blk, w2, n }, late = 0) {
  const B = w2 ? 2 : 1, N = n * B;
  const step = Array.from({ length: STEPS + 2 }, () => ({}));
  if (st) {
    for (let k = 1; k <= N; k++) step[k].A = 1;
    step[N].R = 1;
    if (blk) { step[N + 1].P = 1; step[N + 1].D = 1; } else step[N].D = 1;
    // In step k the next byte, byte k, is made ready: register k / B, half
    // k % B.  Byte 0 was made ready in the ALU cycle.
    for (let k = 1; k < N; k++) Object.assign(step[k], { WE: 1, KS: Math.floor(k / B), KH: k % B });
  } else {
    for (let k = 1; k <= N - 1; k++) step[k].A = 1;
    for (let k = 1; k <= N; k++) Object.assign(step[k + late], late ? { C: 1, L: 1 } : { C: 1 });
    for (let i = 0; i < n; i++) step[1 + late + (i + 1) * B].W = i + 1;
    if (N - 1 + late >= 1) step[N - 1 + late].R = 1;
    step[N + 1 + late].D = 1;
    if (blk) step[1].P = 1;
  }
  if (Object.keys(step[STEPS + 1]).length) throw new Error('a routine is longer than eight steps');
  return step.slice(1, STEPS + 1);
}

// The literal registers the exception routines read: KS 3, and KH picks.
const SP = { KS: 3, KH: 0 }, LR = { KS: 3, KH: 1 };

// THE EXCEPTION ROUTINES, statement for statement as isa/fructus.toml has
// them.  A shadow and a register are never exchanged in one step.  A register
// read in step k lands in aq for step k + 1, which is where a shadow - or
// rti's redirect - takes it from, and a register is written from ldq, which
// was loaded the step before; every read is of the old value, since each
// register's write lands in the same step as the read of it or later.  The
// redirect goes out in step 2, so the handler - or the return - is dispatched
// in step 3, and every write has landed before it reaches decode in step 4.
//
// WHY aq AND NOT THE PORT ITSELF.  The port is decode's left port, borrowed,
// and a shadow loaded from it straight has decode's path in front of it -
// from the SPRAM, through the register number, into the register file's read
// - which never carries a value to a shadow but which the timing cannot know
// that about: it measured 30.25 MHz, every seed ending at a shadow.
const EXCEPTIONS = {
  //  shadow_lr = lr; lr = pc; shadow_sp = sp; sp = shadow_isp; ie = 0; pc = vector
  brk: [{ ...LR, LQ: 1, IE: 1 },
        { SH: 2, WX: 2, ...SP, LQ: 4, RJ: 1 },
        { SH: 1, WX: 1, D: 1 }],
  //  pc = lr; lr = shadow_lr; shadow_isp = sp; sp = shadow_sp; ie = 1
  rti: [{ ...LR, LQ: 3, IE: 2 },
        { RJ: 2, WX: 2, ...SP, LQ: 2 },
        { SH: 3, WX: 1, D: 1 }],
  sei: [{ IE: 2, R: 1, D: 1 }],
  cli: [{ IE: 1, R: 1, D: 1 }],
  // THE TWO-CYCLE OPERATIONS, which release dispatch in their ALU cycle, as a
  // one-byte load does.  Each has a unit that works on aq and bq every cycle
  // into a register of its own - mul's SB_MAC16 its output register, clz and
  // popcount a flop - so the result of the ALU cycle's operands is there in
  // step 1, which takes it into ldq; step 2 writes rd.  Neither result goes
  // near the ALU's result mux.
  slow: [{ LQ: 6 }, { W: 1, D: 1 }],
  mul:  [{ LQ: 5 }, { W: 1, D: 1 }],
};
// Which routine an instruction that is not a memory instruction runs.
const NAMED = { brk: 'brk', rti: 'rti', sei: 'sei', cli: 'cli', clz: 'slow', popcount: 'slow', mul: 'mul' };

// The shapes the instruction set has: ld, ld8, st and st8 move one register
// and are no block; the block moves are two bytes a register.
export const ROUTINES = [{ name: 'idle', steps: [] }];
for (const st of [0, 1])
  for (const blk of [0, 1])
    for (const w2 of [0, 1])
      for (const n of [1, 2, 3]) {
        if (blk ? !w2 : n !== 1) continue;
        const m = { st, blk, w2, n };
        ROUTINES.push({
          name: st ? (blk ? `push/stm ${n}` : w2 ? 'st' : 'st8') : (blk ? `pop/ldm ${n}` : w2 ? 'ld' : 'ld8'),
          key: memKey(m), bytes: n * (w2 ? 2 : 1), steps: memSteps(m), m,
        });
      }
for (const [name, steps] of Object.entries(EXCEPTIONS)) ROUTINES.push({ name, key: name, steps });

// A LOAD'S LATE COPY SITS AT ITS ENTRY WITH THE TOP BIT SET, so rtl/cpu.sv
// chooses it by setting that bit, from flops, and needs no second column to
// say where it is.  The slots between are left idle.
export const LATE = 1 << (ENTRY_BITS - 1);
for (const [e, r] of [...ROUTINES.entries()]) {
  if (!r.m || r.m.st) continue;
  if (e >= LATE || ROUTINES[e | LATE]) throw new Error(`no room for ${r.name}'s late copy`);
  ROUTINES[e | LATE] = { name: `${r.name} late`, key: `late:${r.key}`, bytes: r.bytes, steps: memSteps(r.m, 1) };
}
for (let e = 0; e < ROUTINES.length; e++) ROUTINES[e] ??= { name: 'idle', steps: [] };
if (ROUTINES.length > 1 << ENTRY_BITS) throw new Error('more routines than entries');
if (ROUTINES.some((r) => r.steps.length > STEPS)) throw new Error('a routine is longer than eight steps');

const find = (key) => {
  const e = ROUTINES.findIndex((r) => r.key === key);
  if (e < 0) throw new Error(`no routine for ${key}`);
  return e;
};

// Where a memory instruction's routine starts, and an exception instruction's.
export const entryOf = (m) => find(memKey(m));
export const entryNamed = (mnemonic) => (mnemonic in NAMED ? find(NAMED[mnemonic]) : null);

// The ROM, a word per address.
export function words() {
  const w = new Array(1 << (ENTRY_BITS + 3)).fill(0);
  ROUTINES.forEach((r, e) => r.steps.forEach((s, k) => {
    let v = 0;
    for (const [f, bit, width] of FIELDS) {
      const x = s[f] ?? 0;
      if (x >= 1 << width) throw new Error(`${r.name} step ${k + 1}: ${f} = ${x} does not fit`);
      v += x * 2 ** bit;
    }
    w[(e << 3) | k] = v;
  }));
  return w;
}
