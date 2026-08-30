// Verify the arithmetic of snippets/fpsub.s.
//
// This MIRRORS the instruction sequence in that file one line at a time; if the
// snippet changes, change this too.  Assembling proves it encodes, which is a
// different claim from computing the right difference.
const M = 0xffff;
const clz16 = (v) => { let n = 0; while (n < 16 && !((v << n) & 0x8000)) n++; return n; };
const shl = (v, n) => (v << (n & 15)) & M;
const lsr = (v, n) => (v & M) >>> (n & 15);

function sub(xh, xl, yh, yl) {
  let r0 = xh, r1 = xl, r2 = yh, r3 = yl, r4, r5;
  // 1. which is larger, and |X - Y|
  let yBigger;
  if (r0 < r2) yBigger = true;
  else if (r0 > r2) yBigger = false;
  else yBigger = r1 < r3;
  if (!yBigger) {
    if (!(r1 >= r3)) r0 = (r0 - 1) & M;
    r1 = (r1 - r3) & M; r0 = (r0 - r2) & M; r4 = 0x7fff;
  } else {
    if (!(r3 >= r1)) r2 = (r2 - 1) & M;
    r1 = (r3 - r1) & M; r0 = (r2 - r0) & M; r4 = 0xffff;
  }
  // 2. distance from normalised
  r2 = 0;
  if (r0 === 0) {
    if (r1 === 0) return { hi: 0, lo: 0, exp: 0, zero: true };
    r0 = r1; r1 = 0; r2 = 16;
  }
  // 3. normalise
  r3 = clz16(r0);
  r2 = (r2 + r3) & M;
  r0 = shl(r0, r3);
  r5 = lsr(r1, 1);
  r1 = shl(r1, r3);
  r3 = (0 + 15 - r3) & M;
  r5 = lsr(r5, r3);
  r0 = (r0 | r5) & M;
  // 4. sign and adjustment
  r0 = r0 & r4;   // 0x7fff clears the implicit bit, 0xffff keeps it as a sign
  r2 = (0 - r2) & M;
  return { hi: r0, lo: r1, exp: (r2 & 0x8000) ? r2 - 0x10000 : r2, zero: false };
}

function reference(X, Y) {
  const D = X - Y;
  if (D === 0n) return { hi: 0, lo: 0, exp: 0, zero: true };
  const neg = D < 0n, Mg = neg ? -D : D;
  let n = 0n, m = Mg;
  while (!((m >> 31n) & 1n)) { m <<= 1n; n++; }
  const packed = neg ? (m | (1n << 31n)) : (m & 0x7fffffffn);
  return { hi: Number((packed >> 16n) & 0xffffn), lo: Number(packed & 0xffffn),
           exp: -Number(n), zero: false };
}

const split = (V) => [Number((V >> 16n) & 0xffffn), Number(V & 0xffffn)];
const rnd31 = () => BigInt(Math.floor(Math.random() * 2 ** 31));
const cases = [];
const C = [0n, 1n, 2n, 0x7fffffffn, 0x80000000n, 0x80000001n, 0xfffffffen, 0xffffffffn];
for (const a of C) for (const b of C) cases.push([a, b]);
for (let i = 0; i < 150000; i++) {
  const X = (1n << 31n) | rnd31();
  const d = BigInt(Math.floor(Math.random() * 33));
  const Y = Math.random() < 0.35 ? ((1n << 31n) | rnd31()) : ((1n << 31n) | rnd31()) >> d;
  cases.push([X, Y]);
  if (Math.random() < 0.05) cases.push([X, X]);            // exact cancellation
  if (Math.random() < 0.1) cases.push([X, X - 1n]);        // maximal cancellation
}
let bad = 0, zeros = 0, negs = 0, big = 0;
for (const [X, Y] of cases) {
  const g = sub(...split(X), ...split(Y)), e = reference(X, Y);
  if (e.zero) zeros++; else if (e.exp < 0) big++;
  if (e.hi & 0x8000) negs++;
  if (g.hi !== e.hi || g.lo !== e.lo || g.exp !== e.exp || g.zero !== e.zero) {
    if (bad++ < 5) console.log(`X=${X.toString(16)} Y=${Y.toString(16)}: got ${g.hi.toString(16)}:${g.lo.toString(16)}/${g.exp} want ${e.hi.toString(16)}:${e.lo.toString(16)}/${e.exp}`);
  }
}
console.log(`${cases.length} cases (${zeros} exact cancellations, ${negs} negative, ${big} needing a shift): ${bad ? bad + ' MISMATCHES' : 'all match'}`);
