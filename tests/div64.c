/* 64-bit division, from C.  Returns 0, or the number of the check that
   failed.  Run by tests/run.sh through tools/fcc, as tests/div32.c is.

   NO REFERENCE IMPLEMENTATION IS NEEDED: a quotient and remainder are right
   exactly when a == q * b + r and r < b, and __muldi3 shares no code with
   the division.  The cases are chosen to reach the paths of libgcc's
   __udivmoddi4: a divisor under 65536, which has a loop of its own; every
   divisor width, which decides how many of the dividend's words go into the
   remainder whole; a dividend with fewer words than its divisor; and a
   divisor of 2^63 or more, which can double the remainder past 64 bits.
   Then the signed corners, which go through __divmoddi4's wrapper.  */

typedef unsigned long long u64;
typedef long long s64;

static u64 seed = 12345;
static u64
rnd (void)
{
  seed = seed * 6364136223846793005ULL + 1442695040888963407ULL;
  return seed;
}

static int
check (u64 a, u64 b)
{
  if (b == 0)
    return 0;
  u64 q = a / b, r = a % b;
  return r >= b || q * b + r != a;
}

int
main (void)
{
  /* Every divisor width, under a full-width dividend and under narrower
     ones: the words fed bit by bit run from four down to none.  */
  for (int bits = 1; bits <= 64; bits++)
    for (int i = 0; i < 6; i++)
      {
	u64 b = (rnd () >> (64 - bits)) | (1ULL << (bits - 1));
	if (check (rnd (), b) || check (rnd () >> 20, b)
	    || check (rnd () >> 40, b) || check (b * (rnd () >> 48) + 1, b))
	  return 1;
      }

  /* A divisor under 65536, which has a loop of its own, and the zero words
     it skips.  */
  for (int i = 0; i < 40; i++)
    if (check (rnd (), (rnd () & 0xffff) | 1)
	|| check (rnd () & 0xffff0000ffffULL, 10)
	|| check (rnd () >> 48, (rnd () >> 56) | 1))
      return 2;

  /* A divisor of 2^63 or more: the quotient is 0 or 1.  */
  for (int i = 0; i < 40; i++)
    {
      u64 a = rnd () | (1ULL << 63), b = rnd () | (1ULL << 63);
      if (check (a, b) || a / b != (a >= b) || check (~0ULL, b))
	return 3;
    }

  /* Edges.  */
  static const u64 edge[] = {
    0, 1, 2, 3, 10, 0xffff, 0x10000, 0x10001, 0xffffffffULL, 0x100000000ULL,
    1000000000ULL, 0xffffffffffffULL, 0x1000000000000ULL,
    0x7fffffffffffffffULL, 0x8000000000000000ULL, 0xfffffffffffffffeULL,
    0xffffffffffffffffULL
  };
  const unsigned n = sizeof edge / sizeof edge[0];
  for (unsigned i = 0; i < n; i++)
    for (unsigned j = 0; j < n; j++)
      if (check (edge[i], edge[j]))
	return 4;

  /* Known answers, in case the identity is met by a consistently wrong
     pair.  */
  if (10000000000000000000ULL / 10 != 1000000000000000000ULL) return 5;
  if (12345678901234567890ULL % 1000000000ULL != 234567890) return 6;
  if (0xffffffffffffffffULL / 0xffffffffULL != 0x100000001ULL) return 7;
  if (0xffffffffffffffffULL / 0x8000000000000000ULL != 1) return 8;

  /* Signed: the quotient truncates towards zero, the remainder takes the
     dividend's sign.  */
  static const s64 sedge[] = {
    -9223372036854775807LL - 1, -9223372036854775807LL, -1000000000000LL,
    -65536, -10, -3, -1, 0, 1, 3, 10, 65536, 1000000000000LL,
    9223372036854775807LL
  };
  const unsigned sn = sizeof sedge / sizeof sedge[0];
  for (unsigned i = 0; i < sn; i++)
    for (unsigned j = 0; j < sn; j++)
      {
	s64 a = sedge[i], b = sedge[j];
	if (b == 0 || (b == -1 && a == sedge[0]))
	  continue;			/* undefined */
	s64 q = a / b, r = a % b;
	if (q * b + r != a)
	  return 9;
	if (r != 0 && ((r < 0) != (a < 0)))
	  return 10;
	if ((u64) (r < 0 ? -r : r) >= (b < 0 ? -(u64) b : (u64) b))
	  return 11;
      }
  if (-7LL / 2 != -3 || -7LL % 2 != -1 || 7LL / -2 != -3 || 7LL % -2 != 1)
    return 12;

  return 0;
}
