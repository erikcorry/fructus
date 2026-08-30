// Verify the arithmetic of snippets/fpadd.s.
//
// These MIRROR the instruction sequences in that file one line at a time; if the
// snippet changes, change this too.  Assembling proves it encodes, which is a
// different claim from computing the right sum.
const M = 0xffff, B32 = 1n << 32n;
let fails = 0;
const check = (name, ok, detail = '') => {
  if (!ok) { fails++; console.log(`FAIL ${name} ${detail}`); }
};

// ============================================================================
// fpadd_mantissa - caller has unpacked and aligned.  34 bytes.
// ============================================================================
function aligned(xh, xl, yh, yl) {
  let r0 = xh, r1 = xl, r2 = yh, r3 = yl;
  const yl0 = r3, yh0 = r2;
  r1 = (r1 + r3) & M;                      // add  r1, r1, r3
  r0 = (r0 + r2) & M;                      // add  r0, r0, r2
  let ovf;
  if (r1 >= yl0) {                         // br16 hs, r1, r3, no_lo
    ovf = r0 < yh0;                        //   br16 lo, r0, r2, shift_down
  } else {
    r0 = (r0 + 1) & M;                     //   add  r0, r0, #1
    ovf = r0 <= yh0;                       //   br16 ls, r0, r2, shift_down
  }
  if (!ovf) {
    r0 = ((r0 << 1) & M) >>> 1;            // shl r0,r0,#1 / lsr r0,r0,#1
    return { hi: r0, lo: r1, exp: 0 };     // mov  r2, #0
  }
  r1 = r1 >>> 1;                           // lsr  r1, r1, #1
  r3 = (r0 << 15) & M;                     // shl  r3, r0, #15
  r1 = (r1 | r3) & M;                      // or   r1, r1, r3
  r0 = r0 >>> 1;                           // lsr  r0, r0, #1
  return { hi: r0, lo: r1, exp: 1 };       // mov  r2, #1
}

function refAligned(X, Y) {
  if (!((X >> 31n) & 1n)) throw new Error('X must be normalised');
  const S = X + Y;
  const over = S >= B32;
  const R = over ? S >> 1n : S;
  if (!((R >> 31n) & 1n)) throw new Error('result not normalised');
  if (R >= B32) throw new Error('result overflowed 32 bits');
  return { hi: Number((R >> 16n) & 0x7fffn), lo: Number(R & 0xffffn), exp: over ? 1 : 0 };
}

const split = (V) => [Number((V >> 16n) & 0xffffn), Number(V & 0xffffn)];
const rnd31 = () => BigInt(Math.floor(Math.random() * 2 ** 31));

{
  let n = 0, over = 0;
  const corners = [0n, 1n, 2n, 0x7fffffffn, 0x80000000n, 0xfffe0000n, 0xffff0000n,
                   0xffffffffn, 0xffff8000n, 0xfffffffen];
  const cases = [];
  // X normalised; Y as the caller would produce it - a normalised significand
  // shifted right by the exponent difference.
  for (const a of corners) for (const b of corners) for (const d of [0, 1, 2, 15, 16, 17, 31, 32])
    cases.push([(a | 0x80000000n) & 0xffffffffn, (b | 0x80000000n) >> BigInt(d)]);
  // Bias the exponent difference small: a uniform d makes Y tiny most of the
  // time and the overflow path almost never runs.  Half the cases use d <= 2.
  for (let i = 0; i < 120000; i++) {
    const X = (1n << 31n) | rnd31();
    const d = BigInt(Math.random() < 0.5 ? Math.floor(Math.random() * 3)
                                         : Math.floor(Math.random() * 33));
    cases.push([X, ((1n << 31n) | rnd31()) >> d]);
  }
  for (const [X, Y] of cases) {
    const g = aligned(...split(X), ...split(Y)), e = refAligned(X, Y);
    if (e.exp) over++;
    check('aligned', g.hi === e.hi && g.lo === e.lo && g.exp === e.exp,
          `X=${X.toString(16)} Y=${Y.toString(16)} got ${g.hi.toString(16)}:${g.lo.toString(16)}/${g.exp} ` +
          `want ${e.hi.toString(16)}:${e.lo.toString(16)}/${e.exp}`);
    n++;
  }
  console.log(`fpadd_mantissa: ${n} cases, ${over} of them overflowing`);
}

// The two carry conditions, exhaustively over the space that matters.  Using
// `lo` for both is wrong exactly when XH is 0xffff and the low half carried.
{
  let n = 0;
  for (let xh = 0x8000; xh <= 0xffff; xh += 7)
    for (let yh = 0; yh <= 0xffff; yh += 13)
      for (const c of [0, 1]) {
        const T = xh + yh + c;
        let r0 = (xh + yh) & M, got;
        if (c === 0) got = r0 < yh; else { r0 = (r0 + 1) & M; got = r0 <= yh; }
        check('carry-condition', got === (T >= 0x10000) && r0 === (T & M),
              `XH=${xh.toString(16)} YH=${yh.toString(16)} c=${c}`);
        n++;
      }
  console.log(`carry conditions: ${n} (XH, YH, c) combinations`);
}

console.log(fails ? `${fails} MISMATCHES` : 'all match');
