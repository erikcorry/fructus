#!/usr/bin/env node
// =============================================================================
// libgcc-check.mjs - the multiply helpers GCC calls, executed
// =============================================================================
//
// The reference is plain JavaScript arithmetic, which is exact here: a 32-bit
// product is well inside a double, and Math.imul gives the wrapping 32-bit one.
// Nothing below is a second implementation of shift-and-add.
//
// THE REGISTER CONVENTION IS THE THING MOST LIKELY TO BE WRONG, so it is what
// most of these checks are about.  isa/abi.s says a 32-bit value lives in a
// register pair as LOW:HIGH - the low half in the lower-numbered register, the
// same order as memory - and these are called by compiler-generated code, so
// they have to match.  A routine that returned the pair the other way round
// would pass every "is the product right" test written in terms of its own
// convention, so the halves are checked separately.
// =============================================================================

import { assemble, machine } from './harness.mjs';

let fails = 0, checks = 0;
const check = (name, ok, detail) => {
  checks++;
  if (!ok && fails++ < 10) console.log(`  FAIL ${name}: ${detail}`);
};

const m = machine();
const { code, syms } = assemble('libgcc/lib1funcs.s');
const RET = 0x8000, SP0 = 0xfffe, R4 = 0xe4e4;
// [cpu.vectors] divide_by_zero, where a recip of a divisor of 0 traps.
const DIV0 = m.spec.cpu.vectors.divide_by_zero;
const RTI = parseInt(m.spec.insn.find((i) => i.mnemonic === 'rti').form[0].encoding.replace(/[\s_]/g, ''), 2);

// With `handler', an rti at divide_by_zero, so a trap there carries on after
// the recip, and `traps' counts them.
function run(entry, regs, { handler = false } = {}) {
  m.mem.fill(0);
  m.load(code);
  if (handler) m.mem[DIV0] = RTI;
  let traps = 0;
  const trace = handler ? (at) => { if (at === DIV0) traps++; } : null;
  m.R.fill(0);
  m.R[m.named.sp] = SP0;
  m.R[m.named.lr] = RET;
  m.R[4] = R4;                       // r4 is callee saved at every arity
  for (const [i, v] of Object.entries(regs)) m.R[i] = v & 0xffff;
  m.pc = syms.get(entry); m.halted = false; m.count = 0;
  m.reset();
  let why;
  try { why = m.run({ max: 8000, stopAt: RET, trace }); }
  catch (e) { why = `ran off the rails: ${e.message}`; }
  return { why, R: [...m.R], sp: m.R[m.named.sp], cycles: m.cycles(), traps };
}

// A signed 16-bit reading of a bit pattern.
const s16 = (v) => (v & 0x8000) ? v - 0x10000 : v;

let x = 0x2545f491;
const r32 = () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x; };
const r16 = () => (r32() >>> 16) & 0xffff;

const edge = [0, 1, 2, 3, 255, 256, 257, 4095, 32767, 32768, 32769, 65534, 65535];
const pairs = [];
for (const a of edge) for (const b of edge) pairs.push([a, b]);
for (let i = 0; i < 2500; i++) pairs.push([r16(), r16()]);

// --- __mulhi3 ----------------------------------------------------------------
// The narrow helper, and the one every int multiply goes through.  It leaves
// rubbish in r1 and is entitled to: a 16-bit return says nothing about r1, and
// __umulhisi3 writes the high half itself.
{
  let wrong = 0, eg = '';
  for (const [a, b] of pairs) {
    const q = run('__mulhi3', { 0: a, 1: b });
    if (q.why !== 'stopped' || q.R[0] !== ((a * b) & 0xffff) || q.sp !== SP0 || q.R[4] !== R4) {
      if (!wrong++) eg = `${a} * ${b} -> ${q.why !== 'stopped' ? q.why : q.R[0]}`;
    }
  }
  check('__mulhi3', wrong === 0, `${wrong} of ${pairs.length} wrong, e.g. ${eg}`);
  console.log(`ok    __mulhi3: ${pairs.length} products`);
}

// --- __umulhisi3 and __mulhisi3 ----------------------------------------------
{
  let wrongU = 0, wrongS = 0, egU = '', egS = '';
  for (const [a, b] of pairs) {
    const u = run('__umulhisi3', { 0: a, 1: b });
    const gotU = u.R[1] * 65536 + u.R[0];          // LOW:HIGH, per isa/abi.s
    if (u.why !== 'stopped' || gotU !== a * b || u.sp !== SP0 || u.R[4] !== R4) {
      if (!wrongU++) egU = `${a} * ${b} = ${a * b}, got ${gotU}`;
    }
    const s = run('__mulhisi3', { 0: a, 1: b });
    const gotS = (s.R[1] * 65536 + s.R[0]) | 0;
    const wantS = (s16(a) * s16(b)) | 0;
    if (s.why !== 'stopped' || gotS !== wantS || s.sp !== SP0 || s.R[4] !== R4) {
      if (!wrongS++) egS = `${s16(a)} * ${s16(b)} = ${wantS}, got ${gotS}`;
    }
  }
  check('__umulhisi3', wrongU === 0, `${wrongU} wrong, e.g. ${egU}`);
  check('__mulhisi3', wrongS === 0, `${wrongS} wrong, e.g. ${egS}`);

  // THE HALVES, NOT JUST THE PRODUCT.  A routine that returned low:high would
  // agree with a reference written the same way round, so pin one product
  // whose halves differ and say which register holds which.
  const q = run('__umulhisi3', { 0: 0xffff, 1: 0xffff });   // 0xfffe0001
  check('__umulhisi3 is low:high', q.R[0] === 0x0001 && q.R[1] === 0xfffe,
        `0xffff squared put 0x${q.R[0].toString(16)} in r0 and ` +
        `0x${q.R[1].toString(16)} in r1; abi.s says r0 is the low half`);
  console.log(`ok    __umulhisi3 and __mulhisi3: ${pairs.length} products each, halves in the right registers`);
}

// --- the `_mul' routines, which use the multiplier ---------------------------
// What gcc -mmul calls.  The sim has mul and mulhu, so they run here like
// the rest.  __mulsi3_mul has no branch, so besides the products, the timing
// is checked to be the same for every operand - a branch slipped in would
// show.
{
  const R2 = 0x2222, R3 = 0x3333;
  const wide = [];
  for (const [a, b] of pairs) wide.push([a, b, r16(), r16()]);
  for (const a of edge) for (const b of edge) wide.push([a, b, b, a], [a, a, b, b]);
  for (const [name, args, want, keeps] of [
    ['__mulsi3_mul', 4, ([a, b, c, d]) =>
       ((BigInt(a) | BigInt(b) << 16n) * (BigInt(c) | BigInt(d) << 16n)) & 0xffffffffn, false],
  ]) {
    let wrong = 0, eg = '';
    const cycles = new Set();
    for (const v of args === 2 ? pairs : wide) {
      const regs = { 0: v[0], 1: v[1] };
      if (args === 2) Object.assign(regs, { 2: R2, 3: R3 });
      else Object.assign(regs, { 2: v[2], 3: v[3] });
      const q = run(name, regs);
      const got = BigInt(q.R[1]) << 16n | BigInt(q.R[0]);     // LOW:HIGH
      const kept = q.sp === SP0 && q.R[4] === R4 && (!keeps || (q.R[2] === R2 && q.R[3] === R3));
      cycles.add(q.cycles);
      if (q.why !== 'stopped' || got !== want(v) || !kept) {
        if (!wrong++) eg = `${v.slice(0, args).map((x) => '0x' + x.toString(16)).join(' ')} -> ` +
                           (q.why !== 'stopped' ? q.why : `0x${got.toString(16)}, want ` +
                            `0x${want(v).toString(16)}` + (kept ? '' : ', and a kept register changed'));
      }
    }
    check(name, wrong === 0, `${wrong} wrong, e.g. ${eg}`);
    check(`${name} never branches`, cycles.size === 1,
          `${[...cycles].join(', ')} cycles: it should take the same for every operand`);
    console.log(`ok    ${name}: ${(args === 2 ? pairs : wide).length} products, ${[...cycles][0]} cycles every time`);
  }
}

// --- the shortcut ------------------------------------------------------------
// Both operands under 256 means the product is under 65536, so the whole thing
// is one narrow multiply.  It is worth roughly four times the general case.
{
  const small = () => run('__umulhisi3', { 0: r16() & 0xff, 1: r16() & 0xff }).cycles;
  const big = () => run('__umulhisi3', { 0: 0x8000 | r16(), 1: 0x8000 | r16() }).cycles;
  let s = 0, b = 0;
  for (let i = 0; i < 200; i++) { s += small(); b += big(); }
  check('__umulhisi3 shortcut', s / 200 < b / 200 / 3,
        `small operands cost ${(s / 200).toFixed(0)} against ${(b / 200).toFixed(0)}, ` +
        `so the under-256 path is not being taken`);
  console.log(`ok    the under-256 shortcut: ${(s / 200).toFixed(0)} cycles against ${(b / 200).toFixed(0)}`);
}

// --- __mulsi3 ----------------------------------------------------------------
// 32 x 32 -> 32, with both arguments as low:high pairs.  Math.imul is exactly
// this operation, which is what makes the reference a one-liner.
{
  let wrong = 0, eg = '';
  const cases = [];
  for (const A of [0, 1, 0xffff, 0x10000, 0xffffffff, 0x80000000, 0x12345678])
    for (const B of [0, 1, 0xffff, 0x10000, 0xffffffff, 0x80000000, 0x12345678])
      cases.push([A >>> 0, B >>> 0]);
  for (let i = 0; i < 2500; i++)
    cases.push([((r16() * 65536) + r16()) >>> 0, ((r16() * 65536) + r16()) >>> 0]);
  // Both high words zero is the shortcut path and needs its own coverage: a
  // random 32-bit pair almost never lands on it.
  for (let i = 0; i < 1000; i++) cases.push([r16(), r16()]);
  for (let i = 0; i < 500; i++) cases.push([r16() & 0xff, r16() & 0xff]);
  // And exactly one of them zero, which is NOT shortcut and takes the long way.
  for (let i = 0; i < 500; i++) cases.push([((r16() * 65536) + r16()) >>> 0, r16()]);

  for (const [A, B] of cases) {
    const q = run('__mulsi3', { 0: A & 0xffff, 1: A >>> 16, 2: B & 0xffff, 3: B >>> 16 });
    const got = ((q.R[1] * 65536 + q.R[0]) >>> 0);
    const want = Math.imul(A, B) >>> 0;
    if (q.why !== 'stopped' || got !== want || q.sp !== SP0 || q.R[4] !== R4) {
      if (!wrong++) eg = `0x${A.toString(16)} * 0x${B.toString(16)} = 0x${want.toString(16)}, ` +
                         `got 0x${got.toString(16)}`;
    }
  }
  check('__mulsi3', wrong === 0, `${wrong} of ${cases.length} wrong, e.g. ${eg}`);

  // THE SHORTCUT.  Both high words zero means both cross terms vanish and the
  // answer is the widening product of the low halves - which __umulhisi3
  // already returns as low:high, so it is a tail call with nothing to fix up.
  const cost = (regs) => run('__mulsi3', regs).cycles;
  let wide = 0, narrow = 0, tiny = 0;
  for (let i = 0; i < 200; i++) {
    const p = [r16(), r16(), r16(), r16()];
    wide   += cost({ 0: p[0], 1: p[1] | 0x8000, 2: p[2], 3: p[3] | 0x8000 });
    narrow += cost({ 0: p[0], 1: 0, 2: p[2], 3: 0 });
    tiny   += cost({ 0: p[0] & 0xff, 1: 0, 2: p[2] & 0xff, 3: 0 });
  }
  check('__mulsi3 shortcut', narrow / 200 < wide / 200 * 0.6,
        `16-bit longs cost ${(narrow / 200).toFixed(0)} against ${(wide / 200).toFixed(0)} ` +
        `for full ones, so the both-high-words-zero path is not being taken`);
  check('__mulsi3 shortcut reaches through', tiny / 200 < narrow / 200 * 0.5,
        `8-bit longs cost ${(tiny / 200).toFixed(0)} against ${(narrow / 200).toFixed(0)}, ` +
        `so __umulhisi3's own under-256 shortcut is not being reached`);
  console.log(`ok    __mulsi3: ${cases.length} products; ` +
              `${(wide / 200).toFixed(0)} / ${(narrow / 200).toFixed(0)} / ` +
              `${(tiny / 200).toFixed(0)} cycles for 32 / 16 / 8-bit values`);
}

// --- __umulsidi3 -------------------------------------------------------------
// 32 x 32 -> 64, so BigInt is the reference: the product does not fit a double.
// The four words come back low to high in r0:r1:r2:r3.
//
// THE CARRIES ARE WHAT THIS IS REALLY TESTING.  Three of the four additions can
// carry into the next word, and one of those carries can itself wrap - which
// the routine handles with a second test that most operands never reach.  So
// the cases below are not only random: they include products chosen to drive
// the partial sums to 0xffff, where the second test is the only thing between
// a right answer and a wrong one.
{
  const wide = (A, B, name = '__umulsidi3') => {
    m.mem.fill(0);
    m.load(code);
    m.R.fill(0);
    m.R[m.named.sp] = SP0;
    m.R[m.named.lr] = RET;
    m.R[4] = R4;
    m.R[0] = Number(A & 0xffffn); m.R[1] = Number((A >> 16n) & 0xffffn);
    m.R[2] = Number(B & 0xffffn); m.R[3] = Number((B >> 16n) & 0xffffn);
    m.pc = syms.get(name); m.halted = false; m.count = 0;
    m.reset();
    let why;
    try { why = m.run({ max: 20000, stopAt: RET }); }
    catch (e) { why = `ran off the rails: ${e.message}`; }
    return { why, sp: m.R[m.named.sp], r4: m.R[4], cycles: m.cycles(),
             product: (BigInt(m.R[3]) << 48n) | (BigInt(m.R[2]) << 32n) |
                      (BigInt(m.R[1]) << 16n) | BigInt(m.R[0]) };
  };
  const r32n = () => (BigInt(r16()) << 16n) | BigInt(r16());

  const cases = [];
  const edge = [0n, 1n, 2n, 0xffffn, 0x10000n, 0xfffffffen, 0xffffffffn,
                0x80000000n, 0x7fffffffn, 0xdeadbeefn];
  for (const A of edge) for (const B of edge) cases.push([A, B]);
  for (let i = 0; i < 2500; i++) cases.push([r32n(), r32n()]);
  for (let i = 0; i < 800; i++) cases.push([BigInt(r16()), BigInt(r16())]);  // the shortcut
  for (let i = 0; i < 400; i++) cases.push([r32n(), BigInt(r16())]);

  // Operands whose halves are all 0xffff or near it drive every partial sum to
  // the top of its range, which is where the carry-of-a-carry lives.
  //
  // THIS SWEEP IS THE ONLY THING THAT CATCHES IT, which was checked and not
  // assumed: deleting the routine's second carry test leaves 3700 random
  // products all correct and fails only here.  Four thousand more cases for
  // one bug that randomness does not reach.
  const near = [0xfffcn, 0xfffdn, 0xfffen, 0xffffn, 0x0000n, 0x0001n, 0x8000n, 0x8001n];
  for (const ah of near) for (const al of near) for (const bh of near) for (const bl of near)
    cases.push([(ah << 16n) | al, (bh << 16n) | bl]);

  let wrong = 0, eg = '';
  for (const [A, B] of cases) {
    const q = wide(A, B);
    if (q.why !== 'stopped' || q.product !== A * B || q.sp !== SP0 || q.r4 !== R4) {
      if (!wrong++) eg = `0x${A.toString(16)} * 0x${B.toString(16)} = ` +
                         `0x${(A * B).toString(16)}, got ` +
                         (q.why !== 'stopped' ? q.why : `0x${q.product.toString(16)}`);
    }
  }
  check('__umulsidi3', wrong === 0, `${wrong} of ${cases.length} wrong, e.g. ${eg}`);

  // __umulsidi3_mul tests its carries as __umulsidi3 does, so the same
  // sweep - which is the only thing that reaches the ones that wrap w2.
  let wrongM = 0, egM = '';
  for (const [A, B] of cases) {
    const q = wide(A, B, '__umulsidi3_mul');
    if (q.why !== 'stopped' || q.product !== A * B || q.sp !== SP0 || q.r4 !== R4) {
      if (!wrongM++) egM = `0x${A.toString(16)} * 0x${B.toString(16)} = ` +
                           `0x${(A * B).toString(16)}, got ` +
                           (q.why !== 'stopped' ? q.why : `0x${q.product.toString(16)}`);
    }
  }
  check('__umulsidi3_mul', wrongM === 0, `${wrongM} of ${cases.length} wrong, e.g. ${egM}`);

  const cost = (gen, name) => {
    let y = 0x517cc1b7;
    const g = () => { y ^= y << 13; y >>>= 0; y ^= y >>> 17; y ^= y << 5; y >>>= 0; return y; };
    const b = (n) => BigInt((g() >>> (32 - n)) & 0xffff);
    let t = 0;
    for (let i = 0; i < 200; i++) { const [A, B] = gen(b); t += wide(A, B, name).cycles; }
    return t / 200;
  };
  const full = cost((b) => [(b(16) << 16n) | b(16), (b(16) << 16n) | b(16)]);
  const half = cost((b) => [b(16), b(16)]);
  check('__umulsidi3 shortcut', half < full / 3,
        `16-bit values cost ${half.toFixed(0)} against ${full.toFixed(0)} for 32-bit ones`);
  const fullM = cost((b) => [(b(16) << 16n) | b(16), (b(16) << 16n) | b(16)], '__umulsidi3_mul');
  const halfM = cost((b) => [b(16), b(16)], '__umulsidi3_mul');
  console.log(`ok    __umulsidi3 and __umulsidi3_mul: ${cases.length} products each against BigInt; ` +
              `${full.toFixed(0)} and ${fullM.toFixed(0)} cycles full width, ${half.toFixed(0)} and ${halfM.toFixed(0)} narrow`);
}

// --- __udivmodhi4 and the four division helpers ------------------------------
// The reference is JavaScript's own division, and the cases are not a sample
// where they matter: b = 10 is checked for EVERY dividend, because that path
// is a fixed-point estimate with one correction and its errors would live at
// particular values rather than at random ones.
{
  let wrong = 0, eg = '';
  const divmod = (a, b) => run('__udivmodhi4', { 0: a, 1: b });
  const want = (a, b) => [Math.floor(a / b), a % b];

  let cycTen = 0;
  for (let a = 0; a <= 0xffff; a++) {
    const q = divmod(a, 10), [wq, wr] = want(a, 10);
    if (q.why !== 'stopped' || q.R[0] !== wq || q.R[1] !== wr || q.sp !== SP0 || q.R[4] !== R4) {
      if (!wrong++) eg = `${a}/10 = ${wq},${wr}, got ${q.R[0]},${q.R[1]}`;
    }
    cycTen += q.cycles;
  }
  check('__udivmodhi4 by ten', wrong === 0, `${wrong} of 65536 wrong, e.g. ${eg}`);

  let wrongP = 0, cycPow = 0, nPow = 0;
  for (let k = 0; k < 16; k++)
    for (let i = 0; i < 200; i++) {
      const a = r16(), b = 1 << k;
      const q = divmod(a, b), [wq, wr] = want(a, b);
      if (q.why !== 'stopped' || q.R[0] !== wq || q.R[1] !== wr || q.R[4] !== R4) wrongP++;
      cycPow += q.cycles; nPow++;
    }
  check('__udivmodhi4 by a power of two', wrongP === 0, `${wrongP} of ${nPow} wrong`);

  let wrongG = 0, egG = '', cycGen = 0, nGen = 0;
  const cases = [];
  for (const a of edge) for (const b of edge) if (b) cases.push([a, b]);
  for (let i = 0; i < 3000; i++) cases.push([r16(), r16() || 1]);
  for (const b of [3, 7, 100, 1000]) for (let i = 0; i < 200; i++) cases.push([r16(), b]);
  for (const [a, b] of cases) {
    const q = divmod(a, b), [wq, wr] = want(a, b);
    if (q.why !== 'stopped' || q.R[0] !== wq || q.R[1] !== wr || q.sp !== SP0 || q.R[4] !== R4) {
      if (!wrongG++) egG = `${a}/${b} = ${wq},${wr}, got ${q.R[0]},${q.R[1]}`;
    }
    cycGen += q.cycles; nGen++;
  }
  check('__udivmodhi4 general', wrongG === 0, `${wrongG} of ${nGen} wrong, e.g. ${egG}`);

  // DIVISION BY ZERO RETURNS JUNK AND MUST NOT HANG, which is the whole
  // contract: C says nothing about the value.
  const z = divmod(1234, 0);
  check('__udivmodhi4 by zero terminates', z.why === 'stopped' && z.R[4] === R4,
        `dividing by zero ${z.why}`);

  // THE THREE PATHS, pinned by cost rather than by a byte count.  Ten is the
  // worst divisor the general loop has - twelve iterations - so if its own path
  // stopped being taken it would cost several times this.
  const tenMean = cycTen / 65536, powMean = cycPow / nPow;
  let cycEleven = 0;
  for (let i = 0; i < 400; i++) cycEleven += divmod(r16(), 11).cycles;
  check('the power-of-two path', powMean < 22, `${powMean.toFixed(1)} cycles, expected a mask and a shift`);
  check('the divide-by-ten path', tenMean < 60 && tenMean < cycEleven / 400 / 2,
        `ten costs ${tenMean.toFixed(1)} cycles against ${(cycEleven / 400).toFixed(1)} for eleven, ` +
        `so the shift-and-add path is not being taken`);
  console.log(`ok    __udivmodhi4: 65536 dividends by ten, ${nPow + nGen} more; ` +
              `${powMean.toFixed(0)} / ${tenMean.toFixed(0)} / ${(cycGen / nGen).toFixed(0)} cycles ` +
              `for a power of two / ten / a random divisor`);
}

// --- the wrappers, where the signs go back on --------------------------------
// C truncates a quotient towards zero and gives the remainder the dividend's
// sign, which is what Math.trunc and JavaScript's % do.
{
  let wrong = 0, eg = '';
  const signed = [];
  for (const a of [-32768, -32767, -1000, -10, -1, 0, 1, 10, 1000, 32767])
    for (const b of [-32768, -1000, -10, -3, -1, 1, 3, 10, 1000, 32767])
      signed.push([a, b]);
  for (let i = 0; i < 2000; i++) signed.push([s16(r16()), s16(r16()) || 1]);

  for (const [a, b] of signed) {
    const d = run('__divhi3', { 0: a, 1: b }), md = run('__modhi3', { 0: a, 1: b });
    const wq = Math.trunc(a / b) & 0xffff, wr = (a % b) & 0xffff;
    if (d.why !== 'stopped' || d.R[0] !== wq || d.sp !== SP0 || d.R[4] !== R4
        || md.why !== 'stopped' || md.R[0] !== wr || md.sp !== SP0 || md.R[4] !== R4) {
      if (!wrong++) eg = `${a}/${b} = ${Math.trunc(a / b)},${a % b}, got ${s16(d.R[0])},${s16(md.R[0])}`;
    }
  }
  check('__divhi3 and __modhi3', wrong === 0, `${wrong} of ${signed.length} wrong, e.g. ${eg}`);

  let wrongU = 0, egU = '';
  for (let i = 0; i < 2000; i++) {
    const a = r16(), b = r16() || 1;
    const u = run('__udivhi3', { 0: a, 1: b }), um = run('__umodhi3', { 0: a, 1: b });
    if (u.R[0] !== Math.floor(a / b) || um.R[0] !== a % b || u.R[4] !== R4 || um.R[4] !== R4) {
      if (!wrongU++) egU = `${a}/${b}: got ${u.R[0]}, ${um.R[0]}`;
    }
  }
  check('__udivhi3 and __umodhi3', wrongU === 0, `${wrongU} wrong, e.g. ${egU}`);
  console.log(`ok    the four division helpers: ${signed.length} signed pairs, 2000 unsigned`);
}

// --- the same with recip, for -mmul ------------------------------------------
// __udivmodhi4_mul's estimate comes from the divisor's reciprocal with its
// bottom bit thrown away, and the claim is that one correction is always
// enough.  Where that could fail is at particular divisors rather than at
// random ones, so EVERY divisor is tried, against dividends spread over the
// range and the edges, and ten - its own path - against every dividend.
{
  const divmod = (a, b) => run('__udivmodhi4_mul', { 0: a, 1: b, 2: 0x2222, 3: 0x3333 });
  let wrong = 0, eg = '', n = 0, cyc = 0;
  const tally = (a, b) => {
    const q = divmod(a, b);
    n++; cyc += q.cycles;
    if (q.why !== 'stopped' || q.R[0] !== Math.floor(a / b) || q.R[1] !== a % b || q.sp !== SP0
        || q.R[2] !== 0x2222 || q.R[3] !== 0x3333 || q.R[4] !== R4) {
      if (!wrong++) eg = `${a}/${b} = ${Math.floor(a / b)},${a % b}, got ${q.R[0]},${q.R[1]}`;
    }
  };
  for (let a = 0; a <= 0xffff; a++) tally(a, 10);
  for (let b = 1; b <= 0xffff; b++)
    for (const a of [b - 1, b, 0xffff, (b * 7 + 12345) & 0xffff]) tally(a, b);
  check('__udivmodhi4_mul', wrong === 0, `${wrong} of ${n} wrong, e.g. ${eg}`);
  // BY ZERO IT TRAPS, to divide_by_zero, as recip does; and a handler that
  // returns gets junk, but a return, with r4 kept.
  const z = run('__udivmodhi4_mul', { 0: 1234, 1: 0 }, { handler: true });
  check('__udivmodhi4_mul by zero traps once, then returns', z.traps === 1 && z.why === 'stopped' && z.R[4] === R4,
        `dividing by zero trapped ${z.traps} times and ${z.why}`);

  let cycG = 0;
  for (let i = 0; i < 400; i++) cycG += divmod(r16(), r16() || 1).cycles;
  console.log(`ok    __udivmodhi4_mul: every divisor, every dividend by ten, ${n} in all; ` +
              `${(cycG / 400).toFixed(0)} cycles for a random divisor`);

  let wrongW = 0, egW = '';
  for (let i = 0; i < 3000; i++) {
    const a = s16(r16()), b = s16(r16() >>> (i % 16)) || 3;
    const ua = a & 0xffff, ub = b & 0xffff;
    for (const [name, want] of [
      ['__divhi3_mul', Math.trunc(a / b) & 0xffff], ['__modhi3_mul', (a % b) & 0xffff],
      ['__udivhi3_mul', Math.floor(ua / ub)], ['__umodhi3_mul', ua % ub]]) {
      const q = run(name, { 0: ua, 1: ub, 2: 0x2222, 3: 0x3333 });
      if (q.why !== 'stopped' || q.R[0] !== want || q.sp !== SP0
          || q.R[2] !== 0x2222 || q.R[3] !== 0x3333 || q.R[4] !== R4) {
        if (!wrongW++) egW = `${name}(${a}, ${b}) = ${want}, got ${q.R[0]}`;
      }
    }
  }
  check('the four division helpers with recip', wrongW === 0, `${wrongW} wrong, e.g. ${egW}`);
  console.log('ok    the four division helpers with recip: 3000 pairs each, r2 and r3 kept');
}

// --- 32-bit division with recip ----------------------------------------------
// __udivmodsi4_mul returns the quotient in r0:r1 and the remainder in r2:r3,
// and is the libfunc gcc -mmul calls for both of a 32-bit / and %.  The cases
// reach every divisor width - the width picks between the two-step 2/1 path
// and the one-step 3/2 one - with dividends that are exact multiples, one
// either side of them, and narrower than their divisors.
{
  let x = 0x2545f491;
  const r32 = () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x; };
  const cases = [];
  const edge = [0, 1, 2, 3, 10, 0x7fff, 0x8000, 0xffff, 0x10000, 0x10001, 0x7fffffff,
                0x80000000, 0x80000001, 0xfffffffe, 0xffffffff, 1000000000];
  for (const a of edge) for (const b of edge) if (b) cases.push([a, b]);
  for (let bits = 1; bits <= 32; bits++)
    for (let i = 0; i < 40; i++) {
      const b = ((r32() >>> (32 - bits)) | 2 ** (bits - 1)) >>> 0;
      cases.push([r32(), b], [r32() >>> (r32() % 32), b]);
      const p = Math.floor(r32() / b) * b;
      cases.push([p, b], [p + b - 1 < 2 ** 32 ? p + b - 1 : p, b], [p ? p - 1 : 0, b]);
    }
  const lo = (v) => v & 0xffff, hi = (v) => v >>> 16;
  let wrong = 0, eg = '';
  const cyc = { narrow: [0, 0], wide: [0, 0] };
  for (const [a, b] of cases) {
    const o = run('__udivmodsi4_mul', { 0: lo(a), 1: hi(a), 2: lo(b), 3: hi(b) });
    const q = o.R[1] * 65536 + o.R[0], r = o.R[3] * 65536 + o.R[2];
    const k = b < 65536 ? 'narrow' : 'wide';
    cyc[k][0] += o.cycles; cyc[k][1]++;
    if (o.why !== 'stopped' || q !== Math.floor(a / b) || r !== a % b || o.sp !== SP0 || o.R[4] !== R4) {
      if (!wrong++) eg = `${a}/${b} = ${Math.floor(a / b)},${a % b}, got ${q},${r}`;
    }
  }
  check('__udivmodsi4_mul', wrong === 0, `${wrong} of ${cases.length} wrong, e.g. ${eg}`);
  const z = run('__udivmodsi4_mul', { 0: 1234, 1: 5678 }, { handler: true });
  check('__udivmodsi4_mul by zero traps once, then returns', z.traps === 1 && z.why === 'stopped' && z.R[4] === R4,
        `dividing by zero trapped ${z.traps} times and ${z.why}`);

  let wrongW = 0, egW = '';
  for (const [a0, b0] of cases)
    for (const [sa, sb] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
      const a = (a0 * sa) | 0, b = (b0 * sb) | 0;
      for (const [name, want] of [
        ['__divsi3_mul', a === -0x80000000 && b === -1 ? a : Math.trunc(a / b) | 0],
        ['__modsi3_mul', (a % b) | 0],
        ['__udivsi3_mul', Math.floor((a >>> 0) / (b >>> 0)) | 0],
        ['__umodsi3_mul', ((a >>> 0) % (b >>> 0)) | 0]]) {
        const o = run(name, { 0: lo(a), 1: hi(a), 2: lo(b), 3: hi(b) });
        const got = o.R[0] | o.R[1] << 16;
        if (o.why !== 'stopped' || got !== want || o.sp !== SP0 || o.R[4] !== R4) {
          if (!wrongW++) egW = `${name}(${a}, ${b}) = ${want}, got ${got}`;
        }
      }
    }
  check('the four 32-bit helpers with recip', wrongW === 0, `${wrongW} wrong, e.g. ${egW}`);
  console.log(`ok    __udivmodsi4_mul and its four helpers: ${cases.length} pairs; ` +
              `${(cyc.narrow[0] / cyc.narrow[1]).toFixed(0)} / ${(cyc.wide[0] / cyc.wide[1]).toFixed(0)} ` +
              `cycles for a divisor under / over 65536`);
}

// --- the 3/2 reciprocal, made from recip's 2/1 one ----------------------------
// A divisor of 65536 or more wants the 3/2 reciprocal of both its words, and
// recip makes the 2/1 reciprocal of the high word alone: __udivmodsi4_mul's
// .wide and __udivmoddi4_mul's m = 2 and m = 3, 4 fold the low word in with
// Moller and Granlund's Algorithm 6, three copies of it.  The arithmetic is
// checked over all 2^31 normalised divisors, as the copies do it; then each
// copy is run from its recip to the fold's end on divisors from every path
// through it - all of the rarest, where p == d1 and t0 decides, about two in
// a million - against the exact reciprocal.  The paths' shares are printed,
// since the copies are laid out for the common ones to fall through.
{
  const B = 0x10000;
  const exact = (d1, d0) => {
    const d = d1 * B + d0, x = 2 ** 48 - 1;
    let q = Math.floor(x / d);
    while (q * d > x) q--;
    while ((q + 1) * d <= x) q++;
    return q - B;
  };
  // Algorithm 6 as each copy does it, and the path it takes: bits 0-1 for
  // d0's carry, 1, and p >= d1 after it, 2; bits 2-3 for t1's carry with p
  // below d1, 4, above, 8, or equal, 12.  Written out inline: the loop runs
  // 2^31 times.
  const fold = (d1, d0) => {
    let v = Math.floor(0xffffffff / d1) - B, p = ((d1 * v) % B + d0) % B, k = 0;
    if (p < d0) { k = 1; v--; if (p >= d1) { k = 2; v--; p -= d1; } p = (p - d1 + B) % B; }
    const t = v * d0, t1 = Math.floor(t / B), t0 = t % B;
    p = (p + t1) % B;
    if (p < t1) { k |= p < d1 ? 4 : p > d1 ? 8 : 12; v--; if (p > d1 || (p === d1 && t0 >= d0)) v--; }
    return [v, k];
  };
  const NAME = (k) => ['nc', 'c', 'cge'][k & 3] + ['', '/lo', '/hi', '/eq'][k >> 2];
  const count = new Float64Array(16), pick = Array.from({ length: 16 }, () => []);
  let wrongA = 0, egA = '';
  for (let d1 = 0x8000; d1 < B; d1++) {
    const v1 = Math.floor(0xffffffff / d1) - B;
    for (let d0 = 0; d0 < B; d0++) {
      let v = v1, p = ((d1 * v) % B + d0) % B, k = 0;
      if (p < d0) { k = 1; v--; if (p >= d1) { k = 2; v--; p -= d1; } p = (p - d1 + B) % B; }
      const t = v * d0, t1 = Math.floor(t / B), t0 = t % B;
      p = (p + t1) % B;
      if (p < t1) { k |= p < d1 ? 4 : p > d1 ? 8 : 12; v--; if (p > d1 || (p === d1 && t0 >= d0)) v--; }
      count[k]++;
      if (k >= 12) pick[k].push([d1, d0]);         // every divisor of the rarest
      if (v !== exact(d1, d0) && !wrongA++) egA = `d = ${d1.toString(16)}:${d0.toString(16)}`;
    }
  }
  // and 300 at random of each other path
  let seed = 0x1d872b41;
  const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 8;
  while (pick.some((a, k) => count[k] && k < 12 && a.length < 300)) {
    const d1 = 0x8000 | (rnd() & 0x7fff), d0 = rnd() & 0xffff, k = fold(d1, d0)[1];
    if (pick[k].length < 300) pick[k].push([d1, d0]);
  }
  check('Algorithm 6 against the exact reciprocal', wrongA === 0, `${wrongA} wrong, e.g. ${egA}`);

  // Each copy: from its recip, the first one after its entry, to its fold's
  // last label, with d's high word in r3 and its low word in r2.
  const enc = m.spec.insn.find((i) => i.mnemonic === 'recip').form[0].encoding.replace(/[\s_]/g, '');
  const RECIP = parseInt(enc.slice(0, 8), 2);
  const copies = [['__udivmodsi4_mul', 'vc', 'lr'], ['__udivmoddi4_mul', 'ic', 5], ['__udivmoddi4_mul', 'jc', 5]];
  let wrongC = 0, egC = '', runs = 0;
  for (const [fn, end, vreg] of copies) {
    const stop = syms.get(`${fn}.${end}`);
    // the last recip before the fold's end: the copy's own
    let at = stop;
    while (at > syms.get(fn) && !(code[at] === RECIP && code[at + 1] === ((3 << 3) | (vreg === 'lr' ? m.named.lr : vreg)))) at--;
    const vr = vreg === 'lr' ? m.named.lr : vreg;
    // The fold neither loads nor stores, so the memory is loaded once.
    m.mem.fill(0); m.load(code);
    for (const k of pick)
      for (const [d1, d0] of k) {
        m.R.fill(0);
        m.R[m.named.sp] = SP0; m.R[3] = d1; m.R[2] = d0;
        m.pc = at; m.halted = false; m.count = 0; m.reset();
        const why = m.run({ max: 200, stopAt: stop });
        runs++;
        if (why !== 'stopped' || m.R[vr] !== exact(d1, d0))
          if (!wrongC++) egC = `${fn}.${end}, d = ${d1.toString(16)}:${d0.toString(16)}: ${m.R[vr]}, not ${exact(d1, d0)}`;
      }
  }
  check('the three copies of Algorithm 6', wrongC === 0, `${wrongC} wrong, e.g. ${egC}`);
  const share = [...count].map((n, k) => n && `${NAME(k)} ${(100 * n / 2 ** 31).toFixed(n < 1e5 ? 4 : 1)}%`).filter(Boolean).join(', ');
  console.log(`ok    the 3/2 reciprocal from recip's 2/1: Algorithm 6 over 2^31 divisors, ${runs} runs of its three copies; paths ${share}`);
}

// --- the 64-bit divisions ----------------------------------------------------
// Six entry points on one core.  n in r0-r3, d on the stack at [sp], and for
// the divmod pair a remainder pointer at [sp, #8], which may be null.  BigInt
// is the reference, and its division truncates towards zero as C's does.
//
// What is checked beyond the answers: r4 and sp kept, nothing written past
// the arguments, and nothing written through a null remainder pointer.  The
// cases reach every divisor width, since the width decides how many of n's
// words go into the remainder whole; dividends narrower than their divisors;
// quotients that come out within one of exact; and divisors of 2^63 or more,
// the only ones whose remainder can double past 64 bits.
{
  const SP = 0xf000, RP = 0xe000, M64 = (1n << 64n) - 1n;
  const reached = new Set();
  const word = (v, i) => Number((v >> BigInt(16 * i)) & 0xffffn);
  const div = (name, n, d, rp) => {
    m.mem.fill(0);
    m.load(code);
    m.R.fill(0);
    for (let i = 0; i < 4; i++) {
      m.mem[SP + 2 * i] = word(d, i) & 0xff;
      m.mem[SP + 2 * i + 1] = word(d, i) >> 8;
      m.R[i] = word(n, i);
    }
    m.mem[SP + 8] = rp & 0xff; m.mem[SP + 9] = rp >> 8;
    m.mem[SP + 10] = 0xa5;
    m.R[4] = R4; m.R[m.named.sp] = SP; m.R[m.named.lr] = RET;
    m.pc = syms.get(name); m.halted = false; m.count = 0;
    m.reset();
    let why;
    try { why = m.run({ max: 100000, stopAt: RET, trace: (at) => reached.add(at) }); }
    catch (e) { why = `ran off the rails: ${e.message}`; }
    let got = 0n, rem = 0n;
    for (let i = 3; i >= 0; i--) {
      got = got << 16n | BigInt(m.R[i]);
      rem = rem << 16n | BigInt(m.mem[RP + 2 * i] | m.mem[RP + 2 * i + 1] << 8);
    }
    return { why, got, rem, cycles: m.cycles(),
             kept: m.R[4] === R4 && m.R[m.named.sp] === SP && m.mem[SP + 10] === 0xa5 };
  };
  let y = 0x9e3779b97f4a7c15n;
  const r64 = () => (y = (y * 6364136223846793005n + 1442695040888963407n) & M64);
  const s64 = (v) => BigInt.asIntN(64, v), u64 = (v) => BigInt.asUintN(64, v);

  const cases = [];
  const edge = [0n, 1n, 2n, 3n, 10n, 0xffffn, 0x10000n, 0x10001n, 0xffffffffn,
                0x100000000n, 1000000000n, 0xffffffffffffn, 0x1000000000000n,
                0x7fffffffffffffffn, 0x8000000000000000n, 0x8000000000000001n,
                0xfffffffffffffffen, 0xffffffffffffffffn];
  for (const a of edge) for (const b of edge) if (b) cases.push([a, b]);
  for (let bits = 1; bits <= 64; bits++)
    for (let i = 0; i < 12; i++) {
      const b = (r64() >> BigInt(64 - bits)) | (1n << BigInt(bits - 1));
      cases.push([r64(), b], [r64() >> BigInt(Number(r64() % 64n)), b],
                 [u64(b * (r64() >> 40n) + r64() % b), b]);
    }
  // One less than a multiple of a divisor whose low words are large: the
  // `_mul' core estimates each quotient word from d's top two words, and these
  // are where the estimate is one too big and d has to be added back - and,
  // for k = 65536 and a 33- to 48-bit d, where the remainder's top two words
  // come out equal to d's and the quotient word is 0xffff without an estimate.
  for (const b of [0x800000000001n, 0x8000ffffffffn, 0x1234ffffffffn, 0xffff0000ffffn,
                   0x10000ffffffffn, 0x8000000000000001n, 0x1234ffffffffffffn])
    for (const k of [1n, 2n, 7n, 0x1234n, 0xfffen, 0x10000n, 0x12345n])
      if (k * b - 1n <= M64) cases.push([k * b - 1n, b]);

  for (const [name, q, r] of [
    ['__udivdi3', (a, b) => a / b],
    ['__umoddi3', (a, b) => a % b],
    ['__udivmoddi4', (a, b) => a / b, (a, b) => a % b],
    ['__divdi3', (a, b) => u64(s64(a) / s64(b))],
    ['__moddi3', (a, b) => u64(s64(a) % s64(b))],
    ['__divmoddi4', (a, b) => u64(s64(a) / s64(b)), (a, b) => u64(s64(a) % s64(b))],
    ['__udivdi3_mul', (a, b) => a / b],
    ['__umoddi3_mul', (a, b) => a % b],
    ['__udivmoddi4_mul', (a, b) => a / b, (a, b) => a % b],
    ['__divdi3_mul', (a, b) => u64(s64(a) / s64(b))],
    ['__moddi3_mul', (a, b) => u64(s64(a) % s64(b))],
    ['__divmoddi4_mul', (a, b) => u64(s64(a) / s64(b)), (a, b) => u64(s64(a) % s64(b))],
  ]) {
    let wrong = 0, eg = '', n = 0;
    for (const [a, b] of cases)
      for (const rp of r ? [RP, 0] : [0]) {
        const o = div(name, a, b, rp);
        n++;
        const ok = o.why === 'stopped' && o.got === q(a, b) && o.kept
                   && (rp ? o.rem === r(a, b) : o.rem === 0n);
        if (!ok && !wrong++)
          eg = `0x${a.toString(16)}, 0x${b.toString(16)}${r ? (rp ? ' with' : ' without') + ' rp' : ''} -> ` +
               (o.why !== 'stopped' ? o.why : `0x${o.got.toString(16)}` +
                (r && rp ? ` rem 0x${o.rem.toString(16)}` : '') + (o.kept ? '' : ', and something it must keep changed'));
      }
    check(name, wrong === 0, `${wrong} of ${n} wrong, e.g. ${eg}`);
  }

  // The `_mul' core's rare paths, which the cases above exist to reach.
  for (const path of ['back', 'top', 'sg', 'ng'])
    check(`__udivmoddi4_mul.${path} is reached`, reached.has(syms.get(`__udivmoddi4_mul.${path}`)),
          'no case takes it, so nothing checks it');

  // Cycles by divisor width, under full 64-bit dividends.
  const cost = (bits, name = '__udivdi3') => {
    let t = 0;
    for (let i = 0; i < 30; i++)
      t += div(name, r64() | 1n << 63n,
               (r64() >> BigInt(64 - bits)) | (1n << BigInt(bits - 1)), 0).cycles;
    return (t / 30).toFixed(0);
  };
  console.log(`ok    the six 64-bit divisions and their six with recip: ${cases.length} pairs each against BigInt; ` +
              `${cost(10)} / ${cost(32)} / ${cost(48)} / ${cost(64)} cycles ` +
              `for a 10 / 32 / 48 / 64-bit divisor, and with recip ` +
              `${cost(10, '__udivdi3_mul')} / ${cost(32, '__udivdi3_mul')} / ` +
              `${cost(48, '__udivdi3_mul')} / ${cost(64, '__udivdi3_mul')}`);
}

// --- the shifts by a variable count -----------------------------------------
// Every legal count, against BigInt.  The 32-bit ones take the value in r0:r1
// and the count in r2; the 64-bit ones fill r0-r3 with the value, so the count
// is the one stack argument, at [sp] on entry.
//
// THE REGISTERS THEY MUST NOT TOUCH are checked too.  The 32-bit ones take
// three argument registers, so r3 is callee saved there as well as r4; the
// 64-bit ones borrow r4 and lr and must give both back.
{
  const M32n = 0xffffffffn, M64n = 0xffffffffffffffffn;
  const R3 = 0x3e3e;
  const sx = (v, w) => (v >> BigInt(w - 1)) & 1n ? v - (1n << BigInt(w)) : v;
  const refs = {
    __ashlsi3: (v, n) => (v << n) & M32n,
    __lshrsi3: (v, n) => v >> n,
    __ashrsi3: (v, n) => (sx(v, 32) >> n) & M32n,
    __ashldi3: (v, n) => (v << n) & M64n,
    __lshrdi3: (v, n) => v >> n,
    __ashrdi3: (v, n) => (sx(v, 64) >> n) & M64n,
  };
  const r64n = () => (BigInt(r16()) << 48n) | (BigInt(r16()) << 32n) | (BigInt(r16()) << 16n) | BigInt(r16());
  const edge32 = [0n, 1n, 0x7fffffffn, 0x80000000n, 0xffffffffn, 0x12345678n, 0x8000ffffn, 0x0000ffffn];
  const edge64 = [0n, 1n, 0x7fffffffffffffffn, 0x8000000000000000n, M64n, 0x0123456789abcdefn,
                  0xfedcba9876543210n, 0x00000000ffff0000n];

  const shift = (name, v, n) => {
    const wide = name.endsWith('di3');
    m.mem.fill(0);
    m.load(code);
    m.R.fill(0);
    m.R[m.named.sp] = SP0;
    m.R[m.named.lr] = RET;
    m.R[4] = R4;
    for (let w = 0; w < (wide ? 4 : 2); w++) m.R[w] = Number((v >> BigInt(16 * w)) & 0xffffn);
    if (wide) { m.mem[SP0] = n & 0xff; m.mem[SP0 + 1] = n >> 8; }
    else { m.R[2] = n; m.R[3] = R3; }
    m.pc = syms.get(name); m.halted = false; m.count = 0;
    m.reset();
    let why;
    try { why = m.run({ max: 2000, stopAt: RET }); }
    catch (e) { why = `ran off the rails: ${e.message}`; }
    let got = 0n;
    for (let w = (wide ? 3 : 1); w >= 0; w--) got = (got << 16n) | BigInt(m.R[w]);
    const kept = m.R[4] === R4 && m.R[m.named.sp] === SP0 && (wide || m.R[3] === R3);
    return { why, got, kept, cycles: m.cycles() };
  };

  for (const [name, ref] of Object.entries(refs)) {
    const wide = name.endsWith('di3'), bits = wide ? 64 : 32;
    const vals = [...(wide ? edge64 : edge32)];
    for (let i = 0; i < 40; i++) vals.push(wide ? r64n() : r64n() & M32n);
    let wrong = 0, eg = '', n = 0, worst = 0;
    for (const v of vals)
      for (let k = 0; k < bits; k++) {
        const q = shift(name, v, k), want = ref(v, BigInt(k));
        if (q.why !== 'stopped' || q.got !== want || !q.kept) {
          if (!wrong++) eg = `0x${v.toString(16)} by ${k} = 0x${want.toString(16)}, got ` +
                             (q.why !== 'stopped' ? q.why : `0x${q.got.toString(16)}` +
                              (q.kept ? '' : ', and a register it must keep changed'));
        }
        worst = Math.max(worst, q.cycles);
        n++;
      }
    check(name, wrong === 0, `${wrong} of ${n} wrong, e.g. ${eg}`);
    console.log(`ok    ${name}: ${n} shifts, every count 0..${bits - 1}, at most ${worst} cycles`);
  }
}

console.log(`${checks} checks, ${fails} failures`);
process.exit(fails ? 1 : 0);
