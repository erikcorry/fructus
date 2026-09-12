/* 32-bit division, from C.  Returns 0, or the number of the check that
   failed.  Run by tests/run.sh through tools/fcc at -O2 and -O0.

   NO REFERENCE IMPLEMENTATION IS NEEDED, which is what makes this worth
   running on the machine itself: a quotient and remainder are right exactly
   when a == q * b + r and r < b, and the multiply that checks it shares no
   code with the division that produced them.  The cases are then chosen to
   reach the paths: a 16-bit dividend, a divisor larger than the dividend,
   full-width values, powers of two, and the corners of the signed range.  */

static unsigned long seed = 12345;
static unsigned long rnd (void)
{
  seed = seed * 1103515245UL + 12345UL;
  return seed;
}

static int
check (unsigned long a, unsigned long b)
{
  if (b == 0)
    return 0;
  unsigned long q = a / b, r = a % b;
  if (r >= b)
    return 1;
  if (q * b + r != a)
    return 1;
  return 0;
}

int
main (void)
{
  /* Full width, both operands random.  */
  for (int i = 0; i < 300; i++)
    if (check (rnd (), rnd ()))
      return 1;

  /* A 16-bit dividend, which is the hand-written routine's case.  */
  for (int i = 0; i < 300; i++)
    if (check (rnd () & 0xffff, (rnd () & 0xffff) | 1))
      return 2;

  /* A 16-bit divisor under a full-width dividend: the general loop, and its
     longest run.  */
  for (int i = 0; i < 300; i++)
    if (check (rnd (), (rnd () & 0x7fff) | 1))
      return 3;

  /* A divisor larger than the dividend: quotient zero, nothing to do.  */
  for (int i = 0; i < 100; i++)
    {
      unsigned long a = rnd () >> 16, b = (rnd () | 0x80000000UL);
      if (check (a, b) || a / b != 0 || a % b != a)
	return 4;
    }

  /* Powers of two, and the values either side of them.  */
  for (int k = 0; k < 32; k++)
    {
      unsigned long b = 1UL << k;
      if (check (0xdeadbeefUL, b) || check (b, b) || check (b - 1, b)
	  || check (b + 1, b))
	return 5;
    }

  /* Edges, including the ones that are one word or one bit wide.  */
  static const unsigned long edge[] = {
    0, 1, 2, 3, 9, 10, 999, 1000, 0xffffUL, 0x10000UL, 0x10001UL,
    0x7fffffffUL, 0x80000000UL, 0xfffffffeUL, 0xffffffffUL
  };
  for (unsigned i = 0; i < sizeof edge / sizeof edge[0]; i++)
    for (unsigned j = 0; j < sizeof edge / sizeof edge[0]; j++)
      if (check (edge[i], edge[j]))
	return 6;

  /* Known answers, in case the identity above is satisfied by some
     consistently wrong pair.  */
  if (4000000000UL / 1000UL != 4000000UL) return 7;
  if (4000000000UL % 7UL != 4000000000UL - (4000000000UL / 7UL) * 7UL) return 8;
  if (0xffffffffUL / 0xffffUL != 0x10001UL) return 9;
  if (1000000UL / 1000UL != 1000UL || 1000000UL % 1000UL != 0) return 10;
  if (65535UL / 65535UL != 1 || 65536UL / 65535UL != 1) return 11;
  if (65536UL % 65535UL != 1) return 12;

  /* Signed: the quotient truncates towards zero, the remainder takes the
     dividend's sign.  */
  static const long sedge[] = { -2147483647L - 1, -2147483647L, -1000000L,
				-1000L, -3L, -1L, 0L, 1L, 3L, 1000L,
				1000000L, 2147483647L };
  for (unsigned i = 0; i < sizeof sedge / sizeof sedge[0]; i++)
    for (unsigned j = 0; j < sizeof sedge / sizeof sedge[0]; j++)
      {
	long a = sedge[i], b = sedge[j];
	if (b == 0)
	  continue;
	long q = a / b, r = a % b;
	if (q * b + r != a)
	  return 13;
	if (r != 0 && ((r < 0) != (a < 0)))
	  return 14;
	/* The magnitudes are compared UNSIGNED: |LONG_MIN| does not fit in a
	   long, so -b would come back negative and this check would fail on
	   a correct answer.  */
	if ((unsigned long) (r < 0 ? -r : r)
	    >= (unsigned long) (b < 0 ? -(unsigned long) b : (unsigned long) b))
	  return 15;
      }

  return 0;
}
