#!/usr/bin/env node
// =============================================================================
// libc-check.mjs - libc/memcpy.s, executed
// =============================================================================
//
// memcpy has three properties an assembler cannot check and a reading is bad
// at.  It must move the right bytes for every length; it must not disturb
// anything else - not the bytes either side of the destination, not the source,
// not the callee-saved registers, and above all not the stack, which the bulk
// loop borrows and has to give back; and it must still cost what the file says.
//
// memmove adds a fourth: it must survive every relative position of the two
// regions.  The interesting ones are the near misses - dest one byte above src,
// regions that abut exactly, regions that overlap by all but one byte - so the
// sweep here is exhaustive over a window rather than a chosen handful.
// =============================================================================

import { assemble, machine } from './harness.mjs';

let fails = 0, checks = 0;
const check = (name, ok, detail) => {
  checks++;
  if (!ok && fails++ < 12) console.log(`  FAIL ${name}: ${detail}`);
};

const m = machine();
const { code, syms } = assemble('libc/memcpy.s');

// --- the buffers ------------------------------------------------------------
// A window of SPAN bytes, with the two regions LOW and HIGH inside it and
// MAXN <= HIGH so that a memcpy placement can never overlap.  That distinction
// is not pedantry: memcpy is entitled to assume the regions are disjoint, and a
// test that quietly hands it overlapping ones is testing nothing it promised.
const SPAN = 0x1000, LOW = 0x000, HIGH = 0x800, MAXN = 0x400;
const RET  = 0x8000;                 // the sentinel lr returns to
const SP0  = 0xfffe;
const R3   = 0xc3c3, R4 = 0xd4d4;    // sentinels in the callee-saved registers
const FILL = 0x5a;                   // everything outside the window

// Both bases are used for every case.  A pointer comparison that is signed
// instead of unsigned orders 0x9000 BELOW 0x2000, so memmove would pick the
// wrong disposition for every high address - and a sweep that only ever runs
// low in memory cannot tell the two spellings apart.
const BASES = [0x2000, 0x9000];
let BUF = BASES[0];

// THE TEST DATA MUST NOT LOOK LIKE ITSELF SHIFTED.  An overlapping copy that
// goes the wrong way smears the buffer by exactly the distance between the two
// pointers, so wherever the fill agrees with a shifted copy of itself, the
// corruption lands on identical bytes and is INVISIBLE.  This bit us twice:
// `(i * 31 + 7) & 0xff` repeats every 256 and hid a 512-byte displacement, and
// a hand-rolled 16-bit xorshift emitted runs of equal adjacent bytes and hid a
// ONE-byte displacement - which is the single most important memmove case
// there is.  xorshift32 has neither property, and the assertion below is what
// actually establishes that rather than hoping.
const DATA = new Uint8Array(SPAN);
{
  let x = 0x2545f491;
  for (let i = 0; i < SPAN; i++) {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;  x >>>= 0;
    DATA[i] = x & 0xff;
  }
  // For every shift, agreement must be near chance (1 in 256).  A fill with a
  // period, or with runs, spikes here; this is the property the whole overlap
  // sweep rests on, so it is measured, not assumed.
  const LIMIT = SPAN / 32;                       // 3%, against an expected 0.4%
  for (let d = 1; d < SPAN; d++) {
    let same = 0;
    for (let i = 0; i + d < SPAN; i++) if (DATA[i] === DATA[i + d]) same++;
    if (same > LIMIT)
      throw new Error(`fill matches itself shifted by ${d} in ${same} places - ` +
                      `a smear of ${d} bytes could hide`);
  }
}

// Run one call and report both the memory afterwards and how it behaved.
function call(entry, dest, src, n) {
  // A placement that leaves the window would be compared against bytes the
  // reference never modelled, so refuse it here rather than debug it later.
  for (const [what, p] of [['dest', dest], ['src', src]])
    if (p < BUF || p + n > BUF + SPAN)
      throw new Error(`${what} 0x${p.toString(16)}+${n} leaves the window at 0x${BUF.toString(16)}`);
  m.mem.fill(FILL);
  m.load(code);
  m.mem.set(DATA, BUF);
  const before = m.mem.slice(BUF, BUF + SPAN);

  m.R.fill(0);
  m.R[m.named.sp] = SP0;
  m.R[m.named.lr] = RET;
  m.R[0] = dest; m.R[1] = src; m.R[2] = n;
  m.R[3] = R3;   m.R[4] = R4;
  m.pc = entry; m.halted = false; m.count = 0;
  m.fetched = 0; m.bus = 0;

  let why;
  try {
    why = m.run({ max: 2000000, stopAt: RET });
  } catch (e) {
    why = `ran off the rails: ${e.message}`;   // a lost return address, usually
  }
  return {
    why, before,
    after: m.mem.slice(BUF, BUF + SPAN),
    ret: m.R[0], sp: m.R[m.named.sp], r3: m.R[3], r4: m.R[4],
    cycles: m.fetched + m.bus,
  };
}

// The reference is memmove's definition, which memcpy must also satisfy
// wherever it is legal to call it.  Reading from a SNAPSHOT is what makes this
// a reference rather than a second copy of the algorithm.
function verify(name, r, dest, src, n) {
  check(name, r.why === 'stopped', `did not return: ${r.why}`);
  if (r.why !== 'stopped') return;

  const want = r.before.slice();
  for (let i = 0; i < n; i++) want[dest - BUF + i] = r.before[src - BUF + i];

  let bad = -1;
  for (let i = 0; i < SPAN; i++) if (r.after[i] !== want[i]) { bad = i; break; }
  check(name, bad < 0, bad < 0 ? '' :
        `window byte ${bad} (dest+${bad - (dest - BUF)}) is ` +
        `${r.after[bad].toString(16)}, want ${want[bad].toString(16)}`);

  check(name, r.ret === dest, `returned 0x${r.ret.toString(16)}, want dest 0x${dest.toString(16)}`);
  check(name, r.sp  === SP0,  `left sp at 0x${r.sp.toString(16)}`);
  check(name, r.r3  === R3,   `clobbered r3: 0x${r.r3.toString(16)}`);
  check(name, r.r4  === R4,   `clobbered r4: 0x${r.r4.toString(16)}`);
}

// --- memcpy: every length through the head, and past the bulk loop ----------
// 0 to 40 covers a zero copy, every remainder the byte-loop head can be asked
// for, and the first two turns of the 16-byte loop.  The regions never overlap:
// memcpy does not promise anything if they do.
{
  const entry = syms.get('memcpy');
  const lengths = [];
  for (let n = 0; n <= 40; n++) lengths.push(n);
  lengths.push(63, 64, 65, 127, 128, 255, 256, MAXN);

  let placements = 0;
  for (const base of BASES) {
    BUF = base;
    const tag = base.toString(16);
    for (const n of lengths) {
      verify(`memcpy @${tag} n=${n}`, call(entry, BUF + HIGH, BUF + LOW, n), BUF + HIGH, BUF + LOW, n);
      // and with the source above the destination, which memcpy also allows
      verify(`memcpy @${tag} rev n=${n}`, call(entry, BUF + LOW, BUF + HIGH, n), BUF + LOW, BUF + HIGH, n);
      placements += 2;
    }
    // unaligned on both sides at once - legal here, and free
    for (const [d, s] of [[1, 0], [0, 1], [1, 1], [3, 5], [15, 1]]) {
      verify(`memcpy @${tag} odd d+${d} s+${s}`,
             call(entry, BUF + HIGH + d, BUF + LOW + s, 100), BUF + HIGH + d, BUF + LOW + s, 100);
      placements++;
    }
  }
  BUF = BASES[0];
  console.log(`ok    libc/memcpy.s memcpy: ${placements} placements over two bases`);
}

// --- memmove: every overlap in a window -------------------------------------
// dest walks past src one byte at a time, from well clear below to well clear
// above, at several lengths.  That crosses both dispositions the routine tests
// for and every partial overlap between them, including the two boundaries
// where the regions just touch.
{
  const entry = syms.get('memmove');
  let placements = 0;
  for (const base of BASES) {
    BUF = base;
    const tag = base.toString(16);
    for (const n of [1, 2, 3, 15, 16, 17, 31, 32, 33, 64]) {
      for (let d = -(n + 4); d <= n + 4; d++) {
        const src = BUF + HIGH, dest = src + d;
        verify(`memmove @${tag} n=${n} d=${d}`, call(entry, dest, src, n), dest, src, n);
        placements++;
      }
    }
    // the degenerate cases, which must do nothing at all
    verify(`memmove @${tag} n=0`,       call(entry, BUF, BUF, 0),  BUF, BUF, 0);
    verify(`memmove @${tag} same ptr`,  call(entry, BUF, BUF, 64), BUF, BUF, 64);
    placements += 2;
  }

  // Straddling 0x8000, which is the only shape that can tell `ls` from `le`:
  // both pointers in one buffer are always the same side of the sign bit, so
  // every placement above agrees under either spelling.  Here they do not.
  // 0x7f00 and 0x8100 sit either side of the sign bit, and so do 0x7f00 and
  // the source END at 0x8300 - which is what the last two placements are for:
  // the second test compares src + n against dest, and it is signed-vs-unsigned
  // in its own right even when both POINTERS are on the same side.
  BUF = 0x7c00;                       // the window covers 0x7c00 .. 0x8c00
  for (const [ds, ss, n] of [[0x500, 0x300, 0x400],       // dest high, src low
                             [0x300, 0x500, 0x400],       // dest low,  src high
                             [0x301, 0x300, 0x400],       // dest one above src
                             [0x300, 0x301, 0x400]]) {    // dest one below src
    const dest = BUF + ds, src = BUF + ss;
    verify(`memmove across 0x8000 d=0x${dest.toString(16)} s=0x${src.toString(16)}`,
           call(entry, dest, src, n), dest, src, n);
    placements++;
  }
  BUF = BASES[0];
  console.log(`ok    libc/memmove: ${placements} placements, including four across 0x8000`);
}

// --- the bulk loop still costs what the file says ---------------------------
// Differenced across two lengths so the prologue, the byte-loop head and the
// epilogue all cancel and the 16-byte loop shows on its own.
{
  const entry = syms.get('memcpy');
  const a = 64, b = MAXN;
  const cost = (n) => call(entry, BUF + HIGH, BUF + LOW, n).cycles;
  const per = (cost(b) - cost(a)) / (b - a);
  check('memcpy bulk cost', Math.abs(per - 3.8125) < 0.0001,
        `${per.toFixed(4)} cycles/byte, the file says 3.8125`);

  // The byte head is the expensive part, and its worst case is 15 bytes.
  const head = (cost(15) - cost(0)) / 15;
  check('memcpy head cost', Math.abs(head - 16) < 0.0001, `${head.toFixed(2)} cycles/byte`);
  console.log(`ok    bulk loop ${per.toFixed(4)} cycles/byte, ` +
              `byte head ${head.toFixed(2)} for up to 15 bytes`);
}

// --- sizes, so the compactness claim is checkable ---------------------------
{
  const mm = syms.get('memmove'), mc = syms.get('memcpy');
  console.log(`ok    sizes: memmove ${mc - mm} bytes, memcpy ${code.length - mc} bytes, ` +
              `${code.length} together`);
}

console.log(`${checks} checks, ${fails} failures`);
process.exit(fails ? 1 : 0);
