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

  // nop still nops, at its new opcode
  const n = machine();
  n.mem[0] = 0x01; n.mem[1] = 0x01; n.pc = 0;
  n.step(); n.step();
  check('nop still does nothing', !n.halted && n.pc === 2 && n.regs().every((r) => r === 0),
        `pc=${n.pc} halted=${n.halted}`);
  console.log('ok    halt is opcode zero: zeroed memory stops the machine');
}

console.log(`${checks} checks, ${fails} failures`);
process.exit(fails ? 1 : 0);
