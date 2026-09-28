// =============================================================================
// pipe-ucode.js - the pipelined experiment's microcode, as data
// =============================================================================
//
// Shared by tools/gen-pipe-ucode.js, which writes the ROM, and
// tools/gen-pipe-classify.js, which gives every microcoded opcode the
// address its routine starts at.  One module, so that the two cannot
// disagree about where a routine is.
//
// A ROUTINE is up to eight steps at an ENTRY: the ROM address is
// {entry, step - 1}.  Entry 0 is the idle routine, all zeros, which the
// sequencer reads when it has nothing to do.  The entries are assigned in
// the order the routines are listed here, so one can be added anywhere.
//
// The word's fields and the rules for a memory instruction's steps are in
// tools/gen-pipe-ucode.js's header.
// =============================================================================

export const STEPS = 8;
export const ENTRY_BITS = 5;

// A memory instruction's routine depends on how it moves bytes, not on which
// instruction it is: push and stm step alike, and so do pop and ldm.
const memKey = ({ st, blk, w2, n }) => `${st ? 'st' : 'ld'}${blk ? 'blk' : ''}${w2 ? 16 : 8}x${n}`;

function memSteps({ st, blk, w2, n }) {
  const B = w2 ? 2 : 1, N = n * B;
  const step = Array.from({ length: STEPS + 1 }, () => ({}));
  if (st) {
    for (let k = 1; k <= N; k++) step[k].A = 1;
    step[N].R = 1;
    if (blk) { step[N + 1].P = 1; step[N + 1].D = 1; } else step[N].D = 1;
    // In step k the next byte, byte k, is made ready: register k / B, half
    // k % B.  Byte 0 was made ready in the ALU cycle.
    for (let k = 1; k < N; k++) Object.assign(step[k], { WE: 1, KS: Math.floor(k / B), KH: k % B });
  } else {
    for (let k = 1; k <= N - 1; k++) step[k].A = 1;
    for (let k = 1; k <= N; k++) step[k].C = 1;
    for (let i = 0; i < n; i++) step[1 + (i + 1) * B].W = i + 1;
    if (N >= 2) step[N - 1].R = 1;
    step[N + 1].D = 1;
    if (blk) step[1].P = 1;
  }
  return step.slice(1);
}

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
          key: memKey(m), bytes: n * (w2 ? 2 : 1), steps: memSteps(m),
        });
      }
if (ROUTINES.length > 1 << ENTRY_BITS) throw new Error('more routines than entries');

// Where a memory instruction's routine starts.
export function entryOf(m) {
  const e = ROUTINES.findIndex((r) => r.key === memKey(m));
  if (e < 0) throw new Error(`no routine for ${memKey(m)}`);
  return e;
}

// The ROM, a word per address.
export function words() {
  const w = new Array(1 << (ENTRY_BITS + 3)).fill(0);
  ROUTINES.forEach((r, e) => r.steps.forEach((s, k) => {
    w[(e << 3) | k] = (s.A ?? 0) | ((s.C ?? 0) << 1) | ((s.R ?? 0) << 2) | ((s.D ?? 0) << 3)
                    | ((s.W ?? 0) << 4) | ((s.P ?? 0) << 6) | ((s.WE ?? 0) << 7)
                    | ((s.KS ?? 0) << 8) | ((s.KH ?? 0) << 10);
  }));
  return w;
}
