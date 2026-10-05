/* tests/mul.c - products and constant divisions, against shift and add.

   tests/run.sh compiles this four ways - -O2 and -Os, with -mmul and
   without - and every one must exit 0, the number of wrong answers.  What
   is under test is different each way: with -mmul a 16-bit `*' is the mul
   instruction, a wider product mul's byte products inline or the `_mul'
   routines in libgcc, and a division by a constant at -O2 a multiply by its
   reciprocal; without, libgcc's shift-and-add and division routines.

   The references never multiply or divide, so they share nothing with what
   they check.  The 16-bit constants cover the three forms gas can pick for
   mul: imm5 tied, imm10 untied, and a register loaded first.  The divisors
   cover the reciprocals that need the add-back fixup (7), that are even
   (10, 1000), a power of two, negative ones, and the largest.  */

typedef unsigned short u16;
typedef short s16;
typedef unsigned long u32;
typedef long s32;
typedef unsigned long long u64;
typedef long long s64;

__attribute__((noinline)) static u64
ref (u64 a, u64 b)
{
  u64 r = 0;
  for (; b; b >>= 1, a <<= 1)
    if (b & 1)
      r += a;
  return r;
}

/* Restoring division, a bit at a time.  */
__attribute__((noinline)) static u16
ref_udiv (u16 a, u16 d, u16 *rem)
{
  u32 r = 0;
  u16 q = 0;
  for (int i = 15; i >= 0; i--)
    {
      r = (r << 1) | ((a >> i) & 1);
      q <<= 1;
      if (r >= d)
	r -= d, q |= 1;
    }
  *rem = r;
  return q;
}

/* C's signed division truncates toward zero, and the remainder has the
   dividend's sign.  */
static s16
ref_sdiv (s16 a, s16 d, s16 *rem)
{
  u16 ua = a < 0 ? -(u16) a : a, ud = d < 0 ? -(u16) d : d, ur;
  u16 q = ref_udiv (ua, ud, &ur);
  *rem = a < 0 ? -ur : ur;
  return (a < 0) != (d < 0) ? -q : q;
}

/* --- 16 x 16 -> 16 -------------------------------------------------------- */
__attribute__((noinline)) static u16 var (u16 a, u16 b) { return a * b; }
__attribute__((noinline)) static u16 k11 (u16 a) { u16 t = a; t *= 11; return t; }
__attribute__((noinline)) static u16 k300 (u16 a, u16 b) { return b * 300; }
__attribute__((noinline)) static u16 kbig (u16 a) { return a * 12345; }

/* --- wider products ------------------------------------------------------- */
__attribute__((noinline)) static u32 wu (u16 a, u16 b) { return (u32) a * b; }
__attribute__((noinline)) static s32 ws (s16 a, s16 b) { return (s32) a * b; }
__attribute__((noinline)) static u16 hu (u16 a, u16 b) { return ((u32) a * b) >> 16; }
__attribute__((noinline)) static s16 hs (s16 a, s16 b) { return ((s32) a * b) >> 16; }
__attribute__((noinline)) static u32 m32 (u32 a, u32 b) { return a * b; }
__attribute__((noinline)) static u32 m32k (u32 a) { return a * 100000; }
__attribute__((noinline)) static u64 w64 (u32 a, u32 b) { return (u64) a * b; }
__attribute__((noinline)) static u64 m64 (u64 a, u64 b) { return a * b; }

/* --- division by constants ----------------------------------------------- */
#define UDIVS(X) X(3) X(5) X(7) X(10) X(60) X(100) X(256) X(641) X(1000) \
		 X(10007) X(40000) X(65535)
#define UDIV(d)								\
  __attribute__((noinline)) static u16 ud##d (u16 a) { return a / d##u; } \
  __attribute__((noinline)) static u16 um##d (u16 a) { return a % d##u; }
UDIVS (UDIV)

#define SDIVS(X) X(3, 3) X(7, 7) X(10, 10) X(100, 100) X(1000, 1000)	\
		 X(m7, -7) X(m10, -10) X(16, 16) X(32767, 32767)
#define SDIV(n, d)							\
  __attribute__((noinline)) static s16 sd##n (s16 a) { return a / (d); } \
  __attribute__((noinline)) static s16 sm##n (s16 a) { return a % (d); }
SDIVS (SDIV)

static int bad;

static void
check16 (u16 x, u16 y)
{
  bad += var (x, y) != (u16) ref (x, y);
  bad += k11 (x) != (u16) ref (x, 11);
  bad += k300 (0, y) != (u16) ref (y, 300);
  bad += kbig (x) != (u16) ref (x, 12345);

  u32 pu = ref (x, y);
  s32 ps = (s32) ref ((u64) (s64) (s16) x, (u64) (s64) (s16) y);
  bad += wu (x, y) != pu;
  bad += ws (x, y) != ps;
  bad += hu (x, y) != (u16) (pu >> 16);
  bad += hs (x, y) != (s16) (ps >> 16);

  u16 r;
#define UCHECK(d)							\
  bad += ud##d (x) != ref_udiv (x, d, &r);				\
  bad += um##d (x) != r;
  UDIVS (UCHECK)

  s16 sr;
#define SCHECK(n, d)							\
  bad += sd##n (x) != ref_sdiv (x, d, &sr);				\
  bad += sm##n (x) != sr;
  SDIVS (SCHECK)
}

static void
check32 (u32 a, u32 b)
{
  bad += m32 (a, b) != (u32) ref (a, b);
  bad += m32k (a) != (u32) ref (a, 100000);
  bad += w64 (a, b) != ref (a, b);
  u64 c = (u64) a << 32 | b, d = (u64) b << 32 | (a ^ 0x5a5a5a5a);
  bad += m64 (c, d) != ref (c, d);
}

static const u16 edge[] = { 0, 1, 2, 3, 7, 255, 256, 257, 0x7fff, 0x8000,
			    0x8001, 0xfeff, 0xff00, 0xfffe, 0xffff };

int
main (void)
{
  const unsigned n = sizeof edge / sizeof edge[0];
  for (unsigned i = 0; i < n; i++)
    for (unsigned j = 0; j < n; j++)
      {
	check16 (edge[i], edge[j]);
	check32 ((u32) edge[i] << 16 | edge[j], (u32) edge[j] << 16 | edge[i]);
      }
  u16 x = 1;
  for (int i = 0; i < 100; i++)
    {
      x = x * 25173 + 13849;			/* and one more product per trip */
      u16 y = x ^ (x >> 7);
      check16 (x, y);
      check32 ((u32) x << 16 | y, (u32) y * 40503 + x);
    }
  return bad;
}
