#!/usr/bin/env node
// =============================================================================
// string-check.mjs - libc/strcmp.s: strcmp, strncmp and strlen
// =============================================================================
//
// Every routine against C's own definition, over every alignment of its
// strings: the words go whole only where a pointer is even, the routines
// peel bytes to get there, and a fault in either path shows only at some
// parities.  The comparisons are of unsigned chars, so bytes above 0x7f are
// in every set, and the result's SIGN is what is checked - C promises nothing
// more.  strncmp's limit is tried at every length around the strings' and at
// 0xffff, which is how a caller says "no limit" and which wraps any end
// address computed from it.
//
// The ABI as well: r3, r4 and sp come back as they went, and so does r2 for
// strcmp and strlen, which take fewer than three arguments - isa/abi.s.
//
// Then the cost: cycles a byte, differenced across two lengths so the call
// and the setup cancel, which is what the file's header quotes.
// =============================================================================

import { assemble, machine, near } from './harness.mjs';

let fails = 0, checks = 0;
const check = (name, ok, detail) => {
  checks++;
  if (!ok && fails++ < 12) console.log(`  FAIL ${name}: ${detail}`);
};

const m = machine();
const { code, syms } = assemble('libc/strcmp.s');
const RET = 0x8000, SP0 = 0xfffe;
const R2 = 0xc2c2, R3 = 0xc3c3, R4 = 0xd4d4;
const A = 0x2000, B = 0x4000;          // where the two strings go, plus 0..3

// Run one routine.  Memory outside the strings is 0x5a: no terminator, so a
// routine that overruns its string by more than it may reads garbage, and
// one that never stops runs out of instructions.
function call(name, regs, place) {
  m.mem.fill(0x5a);
  m.load(code);
  for (const [at, bytes] of place) m.mem.set(bytes, at);
  m.R.fill(0);
  m.R[m.named.sp] = SP0;
  m.R[m.named.lr] = RET;
  m.R[2] = R2; m.R[3] = R3; m.R[4] = R4;
  regs.forEach((v, i) => { m.R[i] = v & 0xffff; });
  m.pc = syms.get(name); m.halted = false; m.count = 0;
  m.reset();
  const why = m.run({ max: 200000, stopAt: RET });
  return { why, r0: m.R[0], r2: m.R[2], r3: m.R[3], r4: m.R[4], sp: m.R[m.named.sp], cycles: m.cycles() };
}

const sign = (v) => (v === 0 ? 0 : v > 0 ? 1 : -1);
const s16 = (v) => (v & 0x8000 ? v - 0x10000 : v);
const cmp = (a, b, n = Infinity) => {
  for (let i = 0; i < n; i++) {
    const x = a[i], y = b[i];
    if (x !== y) return sign(x - y);
    if (x === 0) return 0;
  }
  return 0;
};

// A string of `len` bytes from a seeded generator, none zero, plus its
// terminator; half of them above 0x7f.
let seed = 0x1234567;
const rnd = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed; };
const str = (len) => [...Array.from({ length: len }, () => 1 + (rnd() % 255)), 0];

const abi = (what, r, keepR2) => {
  check(`${what} returns`, r.why === 'stopped', `did not return: ${r.why}`);
  check(`${what} keeps r3, r4, sp`, r.r3 === R3 && r.r4 === R4 && r.sp === SP0,
        `r3=${r.r3.toString(16)} r4=${r.r4.toString(16)} sp=${r.sp.toString(16)}`);
  if (keepR2) check(`${what} keeps r2`, r.r2 === R2, `r2 came back 0x${r.r2.toString(16)}: it is callee saved here`);
};

let cases = 0;
const LENGTHS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 15, 16, 17, 33];
for (const len of LENGTHS)
  for (let oa = 0; oa < 4; oa++)
    for (let ob = 0; ob < 4; ob++) {
      const a = str(len);
      // Equal; and differing at every position, both ways round - and a
      // prefix, where one string ends inside the other.
      const variants = [[a, a.slice()]];
      for (let k = 0; k <= len; k++) {
        const b = a.slice();
        b[k] = k === len ? 1 + (rnd() % 255) : (a[k] + 1 + (rnd() % 254)) % 256 || 1;
        if (k === len) b.push(0);
        variants.push([a, b], [b, a]);
      }
      for (const [x, y] of variants) {
        const place = [[A + oa, x], [B + ob, y]];
        const want = cmp(x, y);
        const r = call('strcmp', [A + oa, B + ob], place);
        abi(`strcmp len ${len} at +${oa}, +${ob}`, r, true);
        check('strcmp', sign(s16(r.r0)) === want,
              `${JSON.stringify(x)} vs ${JSON.stringify(y)} at +${oa}, +${ob}: got ${s16(r.r0)}, want sign ${want}`);
        for (const n of [0, 1, 2, 3, 4, 5, len - 1, len, len + 1, len + 2, 0xffff]) {
          if (n < 0) continue;
          const rn = call('strncmp', [A + oa, B + ob, n], place);
          abi(`strncmp len ${len} n ${n} at +${oa}, +${ob}`, rn, false);
          const wn = cmp(x, y, n);
          check('strncmp', sign(s16(rn.r0)) === wn,
                `${JSON.stringify(x)} vs ${JSON.stringify(y)} n=${n} at +${oa}, +${ob}: got ${s16(rn.r0)}, want sign ${wn}`);
          cases++;
        }
        cases++;
      }
      const rl = call('strlen', [A + oa], [[A + oa, a]]);
      abi(`strlen len ${len} at +${oa}`, rl, true);
      check('strlen', rl.r0 === len, `"${a}" at +${oa}: got ${rl.r0}, want ${len}`);
      cases++;
    }
if (fails === 0) console.log(`ok    libc/strcmp.s: ${cases} calls of strcmp, strncmp and strlen at every alignment, and the ABI`);

// --- the cost --------------------------------------------------------------
// Two equal strings, so the whole of each is compared, differenced across two
// lengths: what the header quotes.  Both even, and s2 one byte up from s1's
// parity, where its words go a byte at a time.
const per = (name, oa, ob) => {
  const run = (len) => {
    const a = Array.from({ length: len }, (_, i) => 0x41 + (i % 26)).concat(0);
    const regs = name === 'strlen' ? [A + oa] : name === 'strncmp' ? [A + oa, B + ob, 0xffff] : [A + oa, B + ob];
    return call(name, regs, [[A + oa, a], [B + ob, a]]).cycles;
  };
  return (run(400) - run(80)) / 320;
};
const COSTS = {
  // name        even    s2 odd
  strcmp:  [5.25, 5.75],
  strncmp: [6.25, 6.75],
  strlen:  [2.65, 2.65],
};
for (const [name, [even, odd]] of Object.entries(COSTS)) {
  const e = per(name, 0, 0), o = per(name, 0, 1);
  check(`${name} cost`, near(e, even), `${e.toFixed(4)} cycles/byte with both even, the file says about ${even.toFixed(2)}`);
  check(`${name} cost, s2 odd`, near(o, odd), `${o.toFixed(4)} cycles/byte with s2 odd, the file says about ${odd.toFixed(2)}`);
  if (process.env.COSTS) console.log(name, e.toFixed(4), o.toFixed(4));
}
console.log(`${checks} checks, ${fails} failures`);
process.exit(fails ? 1 : 0);
