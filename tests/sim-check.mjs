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

import { assemble, callRoutine, machine } from './harness.mjs';

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

console.log(`${checks} checks, ${fails} failures`);
process.exit(fails ? 1 : 0);
