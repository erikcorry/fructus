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
// register pair as HIGH:LOW, which is the opposite of what the study routines
// in snippets/ use - and these are called by compiler-generated code, so they
// have to match the ABI and not the study.  A routine that returned the pair
// the other way round would pass every "is the product right" test written in
// terms of its own convention, so the halves are checked separately.
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

function run(entry, regs) {
  m.mem.fill(0);
  m.load(code);
  m.R.fill(0);
  m.R[m.named.sp] = SP0;
  m.R[m.named.lr] = RET;
  m.R[4] = R4;                       // r4 is callee saved at every arity
  for (const [i, v] of Object.entries(regs)) m.R[i] = v & 0xffff;
  m.pc = syms.get(entry); m.halted = false; m.count = 0;
  m.reset();
  let why;
  try { why = m.run({ max: 8000, stopAt: RET }); }
  catch (e) { why = `ran off the rails: ${e.message}`; }
  return { why, R: [...m.R], sp: m.R[m.named.sp], cycles: m.cycles() };
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
// rubbish in r1 and is entitled to: an earlier draft zeroed it so the pair
// r0:r1 would be a 32-bit value, but abi.s puts the high half in r0, so that
// was backwards and __umulhisi3 writes both halves itself.
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
    const gotU = u.R[0] * 65536 + u.R[1];          // HIGH:LOW, per isa/abi.s
    if (u.why !== 'stopped' || gotU !== a * b || u.sp !== SP0 || u.R[4] !== R4) {
      if (!wrongU++) egU = `${a} * ${b} = ${a * b}, got ${gotU}`;
    }
    const s = run('__mulhisi3', { 0: a, 1: b });
    const gotS = (s.R[0] * 65536 + s.R[1]) | 0;
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
  check('__umulhisi3 is high:low', q.R[0] === 0xfffe && q.R[1] === 0x0001,
        `0xffff squared put 0x${q.R[0].toString(16)} in r0 and ` +
        `0x${q.R[1].toString(16)} in r1; abi.s says r0 is the high half`);
  console.log(`ok    __umulhisi3 and __mulhisi3: ${pairs.length} products each, halves in the right registers`);
}

// --- the shortcut ------------------------------------------------------------
// Both operands under 256 means the product is under 65536, so the whole thing
// is one narrow multiply.  It is worth roughly four times the general case, and
// it is the reason __mulhi3 promises a zero.
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
// 32 x 32 -> 32, with both arguments as high:low pairs.  Math.imul is exactly
// this operation, which is what makes the reference a one-liner.
{
  let wrong = 0, eg = '';
  const cases = [];
  for (const A of [0, 1, 0xffff, 0x10000, 0xffffffff, 0x80000000, 0x12345678])
    for (const B of [0, 1, 0xffff, 0x10000, 0xffffffff, 0x80000000, 0x12345678])
      cases.push([A >>> 0, B >>> 0]);
  for (let i = 0; i < 2500; i++)
    cases.push([((r16() * 65536) + r16()) >>> 0, ((r16() * 65536) + r16()) >>> 0]);

  for (const [A, B] of cases) {
    const q = run('__mulsi3', { 0: A >>> 16, 1: A & 0xffff, 2: B >>> 16, 3: B & 0xffff });
    const got = ((q.R[0] * 65536 + q.R[1]) >>> 0);
    const want = Math.imul(A, B) >>> 0;
    if (q.why !== 'stopped' || got !== want || q.sp !== SP0 || q.R[4] !== R4) {
      if (!wrong++) eg = `0x${A.toString(16)} * 0x${B.toString(16)} = 0x${want.toString(16)}, ` +
                         `got 0x${got.toString(16)}`;
    }
  }
  check('__mulsi3', wrong === 0, `${wrong} of ${cases.length} wrong, e.g. ${eg}`);
  console.log(`ok    __mulsi3: ${cases.length} products against Math.imul`);
}

console.log(`${checks} checks, ${fails} failures`);
process.exit(fails ? 1 : 0);
