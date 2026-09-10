#!/usr/bin/env node
// =============================================================================
// sim-check.mjs - run the snippets on the simulator, against real arithmetic
// =============================================================================
//
// fpadd-check.mjs and fpsub-check.mjs test JS functions that MIRROR the
// snippets line by line.  That was the only option before there was a machine
// to run them on, and it has the failure mode you would expect: the mirror is
// maintained by hand, so it can drift from the code it claims to model, and a
// drift that happens to preserve the result is invisible.
//
// This runs the actual assembled bytes instead.  The reference is exact 32-bit
// arithmetic in BigInt - not another transcription of the algorithm - so the
// only way to pass is to compute the right answer.
// =============================================================================

import { assemble, callRoutine, machine, spec } from './harness.mjs';
import { BUILTIN } from '../tools/sim.js';
import { writeFileSync, rmSync } from 'node:fs';

const M32 = (1n << 32n) - 1n, B31 = 1n << 31n, B32 = 1n << 32n;
let fails = 0, checks = 0;
const check = (name, ok, detail) => { checks++; if (!ok) { if (fails++ < 8) console.log(`  FAIL ${name}: ${detail}`); } };

const m = machine();
const hex32 = (v) => v.toString(16).padStart(8, '0');

// --- fpadd ------------------------------------------------------------------
// X normalised, Y already aligned.  The sum is in [2^31, 2^33); if it reaches
// 2^32 it is shifted down one and the exponent goes up.  Bit 31 of the result
// is the implicit one and is always returned clear.
{
  const { code, syms } = assemble('snippets/fpadd.s');
  const ref = (X, Y) => {
    const S = X + Y;
    const [full, exp] = S >= B32 ? [S >> 1n, 1] : [S, 0];
    return { v: full & (B31 - 1n), exp };
  };

  const cases = [];
  for (const xh of [0x8000, 0x8001, 0xffff, 0xfffe, 0xc000])
    for (const xl of [0, 1, 0xffff, 0x8000])
      for (const yh of [0, 1, 0x7fff, 0x8000, 0xffff, 0xfffe])
        for (const yl of [0, 1, 0xffff, 0x8000]) cases.push([xh, xl, yh, yl]);
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
  for (let i = 0; i < 4000; i++)
    cases.push([0x8000 | (rnd() & 0x7fff), rnd() & 0xffff, rnd() & 0xffff, rnd() & 0xffff]);

  for (const [xh, xl, yh, yl] of cases) {
    const r = callRoutine(m, code, syms.get('fpadd_mantissa'), syms.get('done'),
                          { 0: xh, 1: xl, 2: yh, 3: yl });
    const X = (BigInt(xh) << 16n) | BigInt(xl), Y = (BigInt(yh) << 16n) | BigInt(yl);
    const e = ref(X, Y);
    const got = (BigInt(r[0]) << 16n) | BigInt(r[1]);
    check('fpadd', got === e.v && r[2] === e.exp,
          `${hex32(X)} + ${hex32(Y)} -> ${hex32(got)} exp ${r[2]}, want ${hex32(e.v)} exp ${e.exp}`);
  }
  console.log(`ok    snippets/fpadd.s on the simulator: ${cases.length} cases`);
}

// --- fpsub ------------------------------------------------------------------
// X and Y both have their implicit bit restored, Y already shifted down to
// match.  Either may be larger.  The result is the normalised magnitude with
// bit 31 holding the SIGN, and the exponent adjustment is 0 or negative.
{
  const { code, syms } = assemble('snippets/fpsub.s');
  const ref = (X, Y) => {
    const D = X - Y;
    if (D === 0n) return { v: 0n, exp: 0 };
    const mag = D < 0n ? -D : D;
    let n = 0n, s = mag;
    while ((s & B31) === 0n) { s <<= 1n; n++; }
    s &= M32;
    return { v: D < 0n ? s : s & (B31 - 1n), exp: -Number(n) };
  };

  const cases = [];
  for (const xh of [0x8000, 0x8001, 0xffff, 0xc000])
    for (const xl of [0, 1, 0xffff, 0x8000])
      for (const yh of [0, 1, 0x7fff, 0x8000, 0x8001, 0xffff, 0xc000])
        for (const yl of [0, 1, 0xffff, 0x8000]) cases.push([xh, xl, yh, yl]);
  // exact and near-exact cancellation, the case with the deepest normalise
  for (const d of [0, 1, 2, 3, 0xffff, 0x10000, 0x10001])
    for (const xh of [0x8000, 0xffff, 0xabcd]) {
      const X = (xh << 16) | 0x1234;
      const Y = (X - d) >>> 0;
      cases.push([xh, 0x1234, (Y >>> 16) & 0xffff, Y & 0xffff]);
    }
  let seed = 99;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
  for (let i = 0; i < 4000; i++)
    cases.push([0x8000 | (rnd() & 0x7fff), rnd() & 0xffff, rnd() & 0xffff, rnd() & 0xffff]);

  for (const [xh, xl, yh, yl] of cases) {
    const r = callRoutine(m, code, syms.get('fpsub_mantissa'), syms.get('done'),
                          { 0: xh, 1: xl, 2: yh, 3: yl });
    const X = (BigInt(xh) << 16n) | BigInt(xl), Y = (BigInt(yh) << 16n) | BigInt(yl);
    const e = ref(X, Y);
    const got = (BigInt(r[0]) << 16n) | BigInt(r[1]);
    const exp = r[2] >= 0x8000 ? r[2] - 0x10000 : r[2];
    check('fpsub', got === e.v && exp === e.exp,
          `${hex32(X)} - ${hex32(Y)} -> ${hex32(got)} exp ${exp}, want ${hex32(e.v)} exp ${e.exp}`);
  }
  console.log(`ok    snippets/fpsub.s on the simulator: ${cases.length} cases`);
}

// --- add32 ------------------------------------------------------------------
// Three fragments, no carry flag anywhere.  The whole point of the snippet is
// that the carry out of a 16-bit add is recoverable from the result, so what is
// being tested is a claim about arithmetic and not just about encoding.
{
  const { code, syms } = assemble('snippets/add32.s');
  const pairs = [];
  for (const h of [0, 1, 0x7fff, 0x8000, 0xfffe, 0xffff])
    for (const l of [0, 1, 2, 3, 0x7fff, 0x8000, 0xfffd, 0xfffe, 0xffff]) pairs.push([h, l]);
  let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);

  // in place, X in r0:r1 and Y in r2:r3
  let n = 0;
  for (const [xh, xl] of pairs) for (const [yh, yl] of pairs) {
    const r = callRoutine(m, code, syms.get('add32'), syms.get('no_carry'), { 0: xh, 1: xl, 2: yh, 3: yl });
    const want = (((BigInt(xh) << 16n) | BigInt(xl)) + ((BigInt(yh) << 16n) | BigInt(yl))) & M32;
    const got = (BigInt(r[0]) << 16n) | BigInt(r[1]);
    check('add32', got === want, `${hex32((BigInt(xh)<<16n)|BigInt(xl))} + ${hex32((BigInt(yh)<<16n)|BigInt(yl))} -> ${hex32(got)}, want ${hex32(want)}`);
    n++;
  }

  // the same shape in r4:r5 and r6:r7 - note r6 IS sp, which the routine uses
  // as ordinary data, so this also checks the harness is not quietly reserving it
  for (let i = 0; i < 3000; i++) {
    const [xh, xl, yh, yl] = [rnd() & 0xffff, rnd() & 0xffff, rnd() & 0xffff, rnd() & 0xffff];
    const r = callRoutine(m, code, syms.get('add32_r4r5'), syms.get('no_carry2'), { 4: xh, 5: xl, 6: yh, 7: yl });
    const want = (((BigInt(xh) << 16n) | BigInt(xl)) + ((BigInt(yh) << 16n) | BigInt(yl))) & M32;
    const got = (BigInt(r[4]) << 16n) | BigInt(r[5]);
    check('add32_r4r5', got === want, `${hex32(got)} want ${hex32(want)}`);
    n++;
  }

  // += 3, where the carry test compares against the constant itself
  for (const [xh, xl] of pairs) {
    const r = callRoutine(m, code, syms.get('add32_plus3'), syms.get('no_carry3'), { 0: xh, 1: xl });
    const want = (((BigInt(xh) << 16n) | BigInt(xl)) + 3n) & M32;
    const got = (BigInt(r[0]) << 16n) | BigInt(r[1]);
    check('add32_plus3', got === want, `${hex32((BigInt(xh)<<16n)|BigInt(xl))} + 3 -> ${hex32(got)}, want ${hex32(want)}`);
    n++;
  }
  console.log(`ok    snippets/add32.s on the simulator: ${n} cases`);
}

// --- roll32 -----------------------------------------------------------------
// Each fragment rotates by a different distance and reaches for a different
// shift form to do it, so this is really three tests of the shift3 table.  The
// order of the shifts is load bearing - the file says so - and getting it wrong
// is silently wrong rather than rejected, which is exactly what execution
// catches and assembling does not.
{
  const { code, syms } = assemble('snippets/roll32.s');
  const rotl = (x, n) => ((x << BigInt(n)) | (x >> BigInt(32 - n))) & M32;

  const vals = [0n, 1n, 0x80000000n, 0xffffffffn, 0x0000ffffn, 0xffff0000n,
                0x12345678n, 0xdeadbeefn, 0xaaaaaaaan, 0x55555555n, 0x00010001n];
  let seed = 31337; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
  for (let i = 0; i < 2000; i++) vals.push((BigInt(rnd() & 0xffff) << 16n) | BigInt(rnd() & 0xffff));

  let n = 0;
  for (const X of vals) {
    const L = Number(X & 0xffffn), H = Number(X >> 16n);

    // roll left by 13, in place in r2:r3
    let r = callRoutine(m, code, syms.get('roll13'), syms.get('roll8'), { 2: L, 3: H });
    let want = rotl(X, 13);
    check('roll13', ((BigInt(r[3]) << 16n) | BigInt(r[2])) === want,
          `rotl(${hex32(X)}, 13) -> ${hex32((BigInt(r[3]) << 16n) | BigInt(r[2]))}, want ${hex32(want)}`);

    // roll left by 8, result in r0:r1, and the inputs must SURVIVE
    r = callRoutine(m, code, syms.get('roll8'), syms.get('roll7'), { 2: L, 3: H });
    want = rotl(X, 8);
    check('roll8', ((BigInt(r[1]) << 16n) | BigInt(r[0])) === want,
          `rotl(${hex32(X)}, 8) -> ${hex32((BigInt(r[1]) << 16n) | BigInt(r[0]))}, want ${hex32(want)}`);
    check('roll8 inputs survive', r[2] === L && r[3] === H,
          `r2:r3 was ${hex32(X)}, came back ${hex32((BigInt(r[3]) << 16n) | BigInt(r[2]))}`);

    // roll left by 7, in place in r2:r3
    r = callRoutine(m, code, syms.get('roll7'), syms.get('roll7_end'), { 2: L, 3: H });
    want = rotl(X, 7);
    check('roll7', ((BigInt(r[3]) << 16n) | BigInt(r[2])) === want,
          `rotl(${hex32(X)}, 7) -> ${hex32((BigInt(r[3]) << 16n) | BigInt(r[2]))}, want ${hex32(want)}`);
    n += 3;
  }
  console.log(`ok    snippets/roll32.s on the simulator: ${n} cases`);
}

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

// --- memcpy: the ladder, both correct and no slower --------------------------
// Two separate claims, and neither one implies the other.  A copy that moves
// the wrong bytes is a bug; a copy that moves the right bytes two cycles per
// byte slower than the comment says is a comment that has quietly gone stale,
// which is the failure this repo keeps finding in prose.
//
// The cycle figure is the LOOP alone, recovered by differencing two lengths so
// that prologue, epilogue and tail cancel out.  That is why the numbers come
// out exactly whole - 14.0000, not 14.02 - and why a regression shows up as a
// clean step rather than drifting with the buffer size.
{
  const { code, syms } = assemble('snippets/memcpy.s');
  const SRC = 0x1000, DST = 0x4000, RET = 0x8000, GUARD = 0xa5;

  // Run one copy and return both what it wrote and what it cost.
  const copy = (entry, n) => {
    m.mem.fill(GUARD);
    m.load(code);
    for (let i = 0; i < n; i++) m.mem[SRC + i] = (i * 7 + 13) & 0xff;
    m.R.fill(0);
    m.R[m.named.sp] = 0xfffe;
    m.R[m.named.lr] = RET;            // ret lands on the sentinel, and we stop
    m.R[0] = SRC; m.R[1] = DST; m.R[2] = n;
    m.pc = entry; m.halted = false; m.count = 0;
    m.reset();
    const why = m.run({ max: 5000000, stopAt: RET });
    let wrong = -1;
    for (let i = 0; i < n; i++)
      if (m.mem[DST + i] !== ((i * 7 + 13) & 0xff)) { wrong = i; break; }
    // and it must not touch the four bytes past the end
    const over = [0, 1, 2, 3].some((i) => m.mem[DST + n + i] !== GUARD);
    return { why, wrong, over, cycles: m.cycles(), sp: m.R[m.named.sp] };
  };

  const rungs = [
    ['memcpy',                 15.0000, 1],
    ['memcpy2',                 8.5000, 1],
    ['memcpy3',                 7.5000, 1],
    ['memcpy4',                 6.0000, 1],
    ['memcpy_divisible_by_32',  4.4063, 32],
  ];

  for (const [name, want, unit] of rungs) {
    const entry = syms.get(name);
    check(name, entry !== undefined, 'no such symbol');
    if (entry === undefined) continue;

    // Lengths that exercise the head and tail peeling: odd, even, just under
    // and just over a block.  The last rung only promises multiples of 32.
    const lengths = unit === 1
      ? [0, 1, 2, 3, 4, 5, 7, 8, 13, 16, 31, 32, 33, 63, 101, 256]
      : [32, 64, 96, 256];
    for (const n of lengths) {
      const r = copy(entry, n);
      check(name, r.why === 'stopped', `n=${n} did not return: ${r.why}`);
      if (r.why !== 'stopped') continue;
      check(name, r.wrong < 0, `n=${n} wrong byte at +${r.wrong}`);
      check(name, !r.over, `n=${n} wrote past the end`);
      check(name, r.sp === 0xfffe, `n=${n} left sp at 0x${r.sp.toString(16)}`);
    }

    // Differencing: (cost of a+k*unit) - (cost of a) over the extra bytes.
    const a = 32 * unit, b = a + 64 * unit;
    const per = (copy(entry, b).cycles - copy(entry, a).cycles) / (b - a);
    check(name, Math.abs(per - want) < 0.0001,
          `loop costs ${per.toFixed(4)} cycles/byte, the file says ${want.toFixed(4)}`);
  }
  console.log('ok    snippets/memcpy.s on the simulator: 5 rungs, bytes and cycles');
}

// --- mul.s: four multiplies, all of them the same function -------------------
// The reference is a * b & 0xffff computed in JavaScript, which is not another
// transcription of shift-and-add - the whole point of the file is that four
// quite different algorithms have to agree with it.
//
// The cycle figures in the file's header are what the choice between them rests
// on, so they are pinned too.  They are averages over a distribution rather
// than a single call, because that is the only honest way to compare a routine
// whose cost depends on the multiplier's width against one that does not.
{
  const { code, syms } = assemble('snippets/mul.s');
  const RET = 0x8000, R2 = 0xc2c2;
  const call = (entry, a, b) => {
    m.mem.fill(0);
    m.load(code);
    m.R.fill(0);
    m.R[m.named.sp] = 0xfffe;
    m.R[m.named.lr] = RET;
    m.R[0] = a; m.R[1] = b;
    m.R[2] = R2;                      // mul_16_nib borrows it and must give it back
    m.pc = syms.get(entry); m.halted = false; m.count = 0;
    m.reset();
    let why;
    // A 16x16 multiply is at most a couple of hundred instructions, so this cap
    // is 20x headroom and turns a routine that fails to terminate into an
    // instant failure rather than a stalled suite.  The version of mul_16 that
    // shifted the multiplier ARITHMETICALLY never cleared r1 and never ended.
    try { why = m.run({ max: 4000, stopAt: RET }); }
    catch (e) { why = `ran off the rails: ${e.message}`; }
    return { why, r0: m.R[0], r1: m.R[1], r2: m.R[2], cycles: m.cycles() };
  };

  const NAMES = ['mul_16', 'mul_16_x4', 'mul_16_fast', 'mul_16_fast_erik',
                 'mul_16_nib', 'mul_16_min'];

  // Every power of two and its neighbours, both ways round, plus a sweep.  The
  // powers of two are where a shift-and-add goes wrong: they are the operands
  // that carry a single set bit, and 0x8000 is the one whose shift falls off
  // the top.  Zero is in the list for all four, because none of them tests for
  // it any more - they are merely correct about it.
  const edge = [0, 1, 2, 3, 4, 5, 7, 8, 15, 16, 17, 31, 32, 33, 63, 64, 127, 128,
                129, 255, 256, 257, 1023, 1024, 4095, 4096, 32767, 32768, 32769,
                40000, 65535];
  let x = 0x2545f491;
  const r32 = () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x; };
  const cases = [];
  for (const a of edge) for (const b of edge) cases.push([a, b]);
  for (let i = 0; i < 2000; i++) cases.push([(r32() >>> 16) & 0xffff, (r32() >>> 16) & 0xffff]);

  for (const name of NAMES) {
    let wrong = 0, eg = '';
    for (const [a, b] of cases) {
      const r = call(name, a, b);
      const want = (a * b) & 0xffff;
      if (r.why !== 'stopped' || r.r0 !== want || r.r2 !== R2) {
        if (!wrong++) eg = `${a} * ${b} -> ${r.why !== 'stopped' ? r.why : r.r0}, want ${want}`;
      }
    }
    check(`mul ${name}`, wrong === 0, `${wrong} of ${cases.length} wrong, e.g. ${eg}`);
  }

  // The header's table.  A drift of a cycle or two is a real change to one of
  // these routines and should be looked at, so the tolerance is tight.
  const mean = (entry, gen) => {
    let y = 0x9e3779b9;
    const g = () => { y ^= y << 13; y >>>= 0; y ^= y >>> 17; y ^= y << 5; y >>>= 0; return y; };
    const bits = (n) => (g() >>> (32 - n)) & 0xffff;
    let tot = 0;
    for (let i = 0; i < 600; i++) { const [a, b] = gen(bits); tot += call(entry, a, b).cycles; }
    return tot / 600;
  };
  const UNIFORM = (r) => [r(16), r(16)];
  const SMALL_A = (r) => [r(8), r(16)];
  const SMALL_B = (r) => [r(16), r(8)];      // a NARROW MULTIPLIER, which is
                                             // the axis every routine here
                                             // actually costs time along
  const want = [
    ['mul_16',      UNIFORM, 163], ['mul_16',      SMALL_A, 163],
    ['mul_16_x4',   UNIFORM, 110], ['mul_16_x4',   SMALL_A, 110],
    ['mul_16_fast', UNIFORM, 101], ['mul_16_fast', SMALL_A, 101],
    ['mul_16_fast_erik', UNIFORM, 114], ['mul_16_fast_erik', SMALL_A, 114],
    ['mul_16_nib', UNIFORM, 89], ['mul_16_nib', SMALL_A, 89],
    ['mul_16_min',  UNIFORM, 163], ['mul_16_min',  SMALL_A,  88],
  ];
  for (const [entry, gen, target] of want) {
    const got = mean(entry, gen);
    check(`mul ${entry} cost`, Math.abs(got - target) < 1.5,
          `${(gen === UNIFORM ? '16x16' : 'a<256')}: ${got.toFixed(1)} cycles, the file says ${target}`);
  }

  // AND THE ORDERING, which is the file's actual conclusion and survives a
  // change of a few cycles either way.
  check('mul: unrolling helps', mean('mul_16_x4', UNIFORM) < mean('mul_16', UNIFORM),
        'the four-bit loop is not faster than the plain one');
  check('mul: full unrolling helps more', mean('mul_16_fast', UNIFORM) < mean('mul_16_x4', UNIFORM),
        'the unrolled chain is not faster than the four-bit loop');
  check('mul: but not for a narrow multiplier',
        call('mul_16_fast', 0xbeef, 3).cycles > call('mul_16', 0xbeef, 3).cycles,
        'the unrolled chain no longer loses on a 2-bit multiplier');

  // THE TWO DISPATCHES CROSS OVER, which is the whole point of keeping both.
  // A linear scan costs 3c+4 and a computed goto a flat 23, so the scan wins
  // on a wide multiplier and loses badly on a narrow one.  If either of these
  // stopped holding, one of the two routines would have become pointless.
  check('mul: the scan wins on a wide multiplier',
        call('mul_16_fast', 0xbeef, 0xffff).cycles < call('mul_16_fast_erik', 0xbeef, 0xffff).cycles,
        'the scan no longer beats the computed goto at clz = 0');
  check('mul: the computed goto wins on a narrow one',
        call('mul_16_fast_erik', 0xbeef, 15).cycles < call('mul_16_fast', 0xbeef, 15).cycles,
        'the computed goto no longer beats the scan at clz = 12');
  check('mul: swapping beats all of it when the operands are lopsided',
        mean('mul_16_min', SMALL_A) < mean('mul_16_fast', SMALL_A),
        'the swap prologue no longer beats the unrolled chain on a small multiplicand');

  // THE NIBBLE TABLE IS THE FASTEST PER BIT, which it was not before its
  // dispatch was cut from 20 cycles a nibble to 10.  Both halves of that are
  // asserted: it beats the four-bit loop, and it costs seven times the bytes
  // to do it - so neither the speed claim nor the size caveat can go stale.
  check('mul: the nibble table pays now',
        mean('mul_16_nib', UNIFORM) < mean('mul_16_x4', UNIFORM),
        'the nibble table no longer beats the four-bit loop');
  // Its steady state is the cheapest here - 4 cycles a bit against the
  // unrolled chain's 6.5 - but it pays 33 cycles of prologue against that
  // chain's 7, so it wins where there are fewer bits to amortise over and
  // loses by a whisker on a full sixteen.  Both directions are pinned.
  // THE TABLE HAS THE BEST STEADY STATE AND THE WORST ENTRY, and both halves
  // are pinned because the routine only exists to show the trade.  It beats
  // every unrolled chain on a 16-bit multiplier, and a 37-byte loop still
  // beats IT on an 8-bit one, because 33 cycles of prologue want four nibbles
  // to amortise and two do not give it enough.
  check('mul: the table is fastest on a wide multiplier',
        mean('mul_16_nib', UNIFORM) < mean('mul_16_fast', UNIFORM),
        'the nibble table no longer beats the unrolled chain on 16 bits');
  check('mul: and its prologue costs it the narrow one',
        mean('mul_16_nib', SMALL_B) > mean('mul_16_x4', SMALL_B),
        'the nibble table now beats the four-bit loop on 8-bit multipliers too');

  // --- the widening multiply ------------------------------------------------
  // 16 x 16 -> 32, so the reference is a plain JavaScript product: both
  // operands are 16 bits, the result is at most 32, and doubles are exact to
  // 53.  Nothing here needs BigInt and nothing here is a second shift-and-add.
  {
    const wide = (a, b) => {
      const r = call('mul_16_16_32', a, b);
      return { ...r, product: r.r1 * 65536 + r.r0 };
    };
    let wrong = 0, eg = '';
    const at = [0, 1, 2, 3, 5, 255, 256, 257, 4095, 32767, 32768, 32769,
                49152, 65534, 65535];
    const pairs = [];
    for (const a of at) for (const b of at) pairs.push([a, b]);
    for (let i = 0; i < 2000; i++) pairs.push([(r32() >>> 16) & 0xffff, (r32() >>> 16) & 0xffff]);

    // THE ADDEND REACHES ZERO and the carry test has to be right about it.
    // The multiplicand is a << i, so a = 0x8000 empties its low half after one
    // step and every set bit of b above bit 0 then adds zero.  `sum < addend`
    // handles that; `sum >= -addend` would not, which is why add32.s says so.
    for (const a of [0x8000, 0xc000, 0x4000, 0xff00])
      for (let b = 0; b < 0x10000; b += 337) pairs.push([a, b]);

    for (const [a, b] of pairs) {
      const r = wide(a, b);
      if (r.why !== 'stopped' || r.product !== a * b) {
        if (!wrong++) eg = `${a} * ${b} = ${a * b}, got ` +
                           `${r.why !== 'stopped' ? r.why : r.product}`;
      }
    }
    check('mul_16_16_32', wrong === 0, `${wrong} of ${pairs.length} wrong, e.g. ${eg}`);

    const w = (gen) => {
      let y = 0x517cc1b7;
      const g = () => { y ^= y << 13; y >>>= 0; y ^= y >>> 17; y ^= y << 5; y >>>= 0; return y; };
      const bits = (n) => (g() >>> (32 - n)) & 0xffff;
      let tot = 0;
      for (let i = 0; i < 400; i++) { const [a, b] = gen(bits); tot += wide(a, b).cycles; }
      return tot / 400;
    };
    const wide16 = w((r) => [r(16), r(16)]), wide8 = w((r) => [r(16), r(8)]);
    check('mul_16_16_32 cost', Math.abs(wide16 - 311) < 2,
          `16x16 costs ${wide16.toFixed(1)} cycles, the file says 311`);
    check('mul_16_16_32 narrow', Math.abs(wide8 - 164) < 2,
          `16x8 costs ${wide8.toFixed(1)} cycles, the file says 164`);
    // The swap is load-bearing here too: a narrow multiplicand must be moved
    // into the multiplier, or the loop runs over all sixteen bits.
    check('mul_16_16_32 swaps', w((r) => [r(8), r(16)]) < wide16 * 0.75,
          'a narrow multiplicand no longer becomes the multiplier');
    console.log(`ok    mul_16_16_32: ${pairs.length} products against exact arithmetic`);
  }

  console.log('ok    snippets/mul.s on the simulator: 7 entry points, ' +
              cases.length + ' pairs each, and the cost table');
}

// --- the cost model: what a taken branch costs -------------------------------
// Every performance figure in this repo rests on one cycle being charged for a
// taken RELATIVE branch and nothing for an absolute transfer.  Nothing else in
// the suite would catch the simulator dropping that: the numbers would all move
// together, and each assertion would be re-tightened around the new wrong value
// by whoever ran the tests next.  So it is measured here directly, one
// instruction at a time.
{
  const { code, syms } = assemble('tests/branch-cost.s');
  const cost = (label) => {
    m.mem.fill(0);
    m.load(code);
    m.R.fill(0);                       // r0 = 0: `eq #0` is taken, `ne #0` is not
    m.pc = syms.get(label);
    m.halted = false;
    m.reset();
    m.step();
    return m.cycles();
  };

  const want = [
    ['b_taken', 4, 'a 3-byte branch, taken'],
    ['b_fall',  3, 'a 3-byte branch, not taken'],
    ['j_rel',   3, 'a 2-byte relative jump'],
    ['j_abs',   3, 'a 3-byte absolute jump'],
    ['c_rel',   4, 'a 3-byte relative call'],
    ['c_abs',   3, 'a 3-byte absolute call'],
    ['i_ret',   1, 'ret, straight out of the register file'],
  ];
  for (const [label, cycles, what] of want)
    check('branch cost', cost(label) === cycles,
          `${what} cost ${cost(label)} cycles, want ${cycles}`);

  // The pair that isolates the cause.  callr and call are both three bytes and
  // both always transfer control; the only difference is that one has to add.
  check('branch cost', cost('c_rel') - cost('c_abs') === 1,
        `callr and call differ by ${cost('c_rel') - cost('c_abs')}, want 1`);
  // And the same instruction taken against not taken.
  check('branch cost', cost('b_taken') - cost('b_fall') === 1,
        `taken and not-taken differ by ${cost('b_taken') - cost('b_fall')}, want 1`);

  // The penalty is declared in the spec, not buried in the simulator.
  check('branch cost', spec.cpu.taken_branch_penalty === 1,
        `spec says the penalty is ${spec.cpu.taken_branch_penalty}`);
  console.log('ok    cost model: taken relative branches cost one cycle, absolute none');
}

// --- zeroed memory stops the machine ----------------------------------------
// halt is opcode 0x00 so that erased memory, an unwritten ROM and a wild jump
// into a zeroed page all stop where the mistake happened.  With nop at zero the
// same jump runs a nop sled to the top of memory, wraps, and keeps going.
{
  const blank = machine();
  blank.pc = 0x4000;
  blank.step();
  check('zeroed memory halts', blank.halted && blank.pc === 0x4001,
        `halted=${blank.halted} pc=0x${blank.pc.toString(16)}`);

  // and the pc is left on the instruction after the mistake, not miles away
  const drift = machine();
  drift.pc = 0x4000;
  drift.run({ max: 1000 });
  check('and stays put', drift.count === 1, `${drift.count} instructions`);

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

  // And the layout the argument above depends on: the two instructions a wild
  // jump is likeliest to hit are the two that stop or unwind, and nop is as far
  // from them as the one-byte row reaches.
  check('halt and ret hold the bottom of the one-byte row',
        opcodeOf('halt') === 0x00 && opcodeOf('ret') === 0x01,
        `halt=0x${opcodeOf('halt').toString(16)} ret=0x${opcodeOf('ret').toString(16)}`);
  check('nop bookends the far end', NOP === 0x0f, `nop=0x${NOP.toString(16)}`);
  console.log('ok    halt is opcode zero: zeroed memory stops the machine');
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

  // and the one-byte negation really is one byte and really is xor #1
  const one = assemble('build/_isq.s').code;
  check('xor r0, r0, #1 is one byte', one[code.length - 2] === 0x0c,
        `byte before halt is 0x${one[code.length - 2].toString(16)}`);
  rmSync('build/_isq.s', { force: true });
  console.log('ok    iseq/isset: every column, agreeing and differing operands');
}

// --- clz: four routines, every input, and the cost of each -------------------
// The reference is BUILTIN.clz - the same function tools/sim.js evaluates the
// spec's `semantics` against, and the same one rtl/unary.sv is checked with.
// So software, hardware and simulator are all measured against one definition
// rather than three transcriptions of it.
//
// EXHAUSTIVE, because the inputs that break a clz are the boundaries: 0, 1,
// 0x8000, and the value either side of every nibble edge.  65536 calls each is
// cheap enough that there is no reason to sample.
//
// The cycle counts are pinned because they are the whole point of the file -
// clz exists in snippets/ to price the TENTATIVE opcode against ~45 logic
// cells, and a figure nobody checks is a figure that goes stale.
{
  const { code, syms } = assemble('snippets/clz.s');
  const EXIT = 0xfffc;
  const run = (entry, x) => {
    m.reset();
    callRoutine(m, code, entry, EXIT, { 0: x, 7: EXIT });
    return { y: m.R[0], c: m.cycles() };
  };

  // name, its cycle range, and whether it must be right at zero
  const CASES = [
    ['clz',     21, 25],
    ['clz2',    16, 35],
    ['clz_nz',  19, 23],
    ['clz_big', 14, 15],
  ];
  for (const [name, lo, hi] of CASES) {
    let bad = -1, best = Infinity, worst = 0;
    for (let x = 0; x < 65536; x++) {
      const { y, c } = run(syms.get(name), x);
      if (y !== BUILTIN.clz(x) && bad < 0) bad = x;
      if (c < best) best = c;
      if (c > worst) worst = c;
    }
    check(`${name} is clz`, bad < 0,
          bad < 0 ? '' : `wrong at 0x${bad.toString(16)}: want ${BUILTIN.clz(bad)}`);
    check(`${name} costs ${lo}..${hi}`, best === lo && worst === hi,
          `measured ${best}..${worst}`);
  }
  // clz_big is the fastest and flattest, which is the reason it is there.
  console.log('ok    snippets/clz.s: 4 routines x 65536 inputs, and their cycle counts');
}

console.log(`${checks} checks, ${fails} failures`);
process.exit(fails ? 1 : 0);
