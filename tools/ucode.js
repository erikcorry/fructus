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
  ['LQ', 13, 3, 'ldq takes: 1 the pc, 2 shadow_sp, 3 shadow_lr, 4 shadow_isp'],
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
//
// AN ALIGNED COPY MOVES A WORD A STEP.  A word instruction whose first
// address is even - and a block move's addresses are all the parity of its
// first - takes each register's two bytes in one access, so its routine is
// the byte routine's shape with one access a register: an aligned ld steps
// exactly as ld8 does.  Which bytes an access moves is rtl/cpu.sv's `mal`,
// a flop, and not in the word.
function memSteps({ st, blk, w2, n }, late = 0, aligned = 0) {
  const B = w2 && !aligned ? 2 : 1, N = n * B;   // accesses: a register's, and all
  const step = Array.from({ length: STEPS + 2 }, () => ({}));
  if (st) {
    for (let k = 1; k <= N; k++) step[k].A = 1;
    // Released a step before the last access: the next instruction then
    // reaches decode after the routine's last read through decode's port.
    // A routine of one access releases in its ALU cycle instead, through
    // predecode's `urs`, as a one-access load does.
    if (N >= 2) step[N - 1].R = 1;
    if (blk) { step[N + 1].P = 1; step[N + 1].D = 1; } else step[N].D = 1;
    // In step k the next access, access k, is made ready: register k / B,
    // half k % B.  Access 0 was made ready in the ALU cycle.
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
  // mul, clz and popcount ran routines here once, taking their results into
  // ldq; the ALU stage holds them a second cycle now - rtl/cpu.sv.
};
// THE BOOT LOOP IS ENTRY 0, the idle routine's.  Idle reads only its word 0,
// which stays all zeros; no opcode starts entry 0, so its words 1 .. 7 are
// read only when rtl/cpu.sv's `boot` starts the sequencer there from reset.
// No step says D, so the step count wraps and the eight steps go round for as
// long as `boot` is held, one byte stored a lap: WE in word 4, its access in
// word 5, at mar, which starts at 0 and steps up a byte.  The byte is not the
// processor's - the system puts the flash's byte on the memory's data pins
// while it boots - so the store reads no register.  A lap is eight cycles
// because a byte is eight bits of single SPI at the processor's clock;
// tools/fpga-system.sv's streamer keeps the two in step.
const BOOT = [{}, {}, {}, {}, { WE: 1 }, { A: 1 }, {}, {}];
// Which routine an instruction that is not a memory instruction runs.
const NAMED = { brk: 'brk', rti: 'rti', sei: 'sei', cli: 'cli' };

// THE VARIANTS SIT AT FIXED BITS OF THE ENTRY, so rtl/cpu.sv chooses one by
// setting a bit - LATE from flops in decode, ALIGN from the first address's
// bit 0 in the ALU cycle - and needs no column to say where it is.  A routine
// with variants therefore needs an entry with those bits clear whose
// variants' slots are free too - a store, with no late copy, may sit in the
// late half; allocate() finds them, the routines with the
// most variants first.  The five-bit entry is full: every one of its 32
// slots holds a routine.
export const LATE = 1 << (ENTRY_BITS - 1);
export const ALIGN = 1 << (ENTRY_BITS - 2);

// The shapes the instruction set has: ld, ld8, st and st8 move one register
// and are no block; the block moves are two bytes a register.  Each family is
// a routine and its variants, by the bits that choose them.
const FAMILIES = [{ variants: { 0: { name: 'idle/boot', key: 'idle', steps: BOOT } } }];
for (const st of [0, 1])
  for (const blk of [0, 1])
    for (const w2 of [0, 1])
      for (const n of [1, 2, 3]) {
        if (blk ? !w2 : n !== 1) continue;
        const m = { st, blk, w2, n };
        const name = st ? (blk ? `push/stm ${n}` : w2 ? 'st' : 'st8') : (blk ? `pop/ldm ${n}` : w2 ? 'ld' : 'ld8');
        const key = memKey(m), bytes = n * (w2 ? 2 : 1);
        const v = { 0: { name, key, bytes, steps: memSteps(m), m } };
        if (!st) v[LATE] = { name: `${name} late`, key: `late:${key}`, bytes, steps: memSteps(m, 1) };
        if (w2) v[ALIGN] = { name: `${name} al`, key: `al:${key}`, bytes, steps: memSteps(m, 0, 1) };
        if (w2 && !st) v[LATE | ALIGN] = { name: `${name} al late`, key: `late:al:${key}`, bytes, steps: memSteps(m, 1, 1) };
        FAMILIES.push({ variants: v });
      }
for (const [name, steps] of Object.entries(EXCEPTIONS)) FAMILIES.push({ variants: { 0: { name, key: name, steps } } });

function allocate(families) {
  const slots = new Array(1 << ENTRY_BITS).fill(null);
  // idle first, at 0: the sequencer reads entry 0 when it has nothing to do.
  const order = [families[0], ...families.slice(1).sort((a, b) => Object.keys(b.variants).length - Object.keys(a.variants).length)];
  for (const f of order) {
    const offs = Object.keys(f.variants).map(Number), bits = offs.reduce((a, o) => a | o, 0);
    const e = slots.findIndex((_, e) => !(e & bits) && offs.every((o) => !slots[e | o]));
    if (e < 0) throw new Error(`no room for ${f.variants[0].name} and its variants: more routines than entries`);
    for (const o of offs) slots[e | o] = f.variants[o];
  }
  return slots.map((r) => r ?? { name: 'idle', key: 'free', steps: [] });
}
export const ROUTINES = allocate(FAMILIES);
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
