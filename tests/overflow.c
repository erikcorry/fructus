/* __builtin_clrsb and the overflow builtins on int.  Returns 0, or the
   number of the check that failed.  Run by tests/run.sh through tools/fcc.

   clrsbhi2 is a branch on the sign, a complement and clz; it is checked on
   every 16-bit value against a count done by shifting.  addvhi4, subvhi4
   and negvhi3 are br vs, or a comparison against a constant: they are
   checked against the same sums done in 32 bits, which go through none of
   them, on the edges of the range and on a sweep between.  */

static int
clrsb_ref (int x)
{
  unsigned u = x, sign = u >> 15;
  int n = 0;
  while (n < 15 && (u >> (14 - n) & 1) == sign)
    n++;
  return n;
}

static int
range (long s)
{
  return s < -32768 || s > 32767;
}

static unsigned seed = 1;
static int
rnd (void)
{
  seed = seed * 25173 + 13849;
  return (int) seed;
}

static const int edge[] = {
  -32768, -32767, -32766, -16384, -101, -100, -2, -1,
  0, 1, 2, 100, 101, 16383, 32765, 32766, 32767
};
#define NEDGE (sizeof edge / sizeof edge[0])

/* A constant operand is an expansion of its own: a comparison of the
   other operand.  */
#define CONST_CHECKS(X)  X (1) X (2) X (3) X (100) X (32767) X (-1) X (-2) \
			 X (-100) X (-32767) X (-32768) X (0)

__attribute__ ((noinline)) static int
check_const (int a)
{
  int r;
#define ONE(k)								\
  if (__builtin_add_overflow (a, k, &r) != range ((long) a + (k))	\
      || r != (int) ((unsigned) a + (unsigned) (k)))						\
    return 1;								\
  if (__builtin_sub_overflow (a, k, &r) != range ((long) a - (k))	\
      || r != (int) ((unsigned) a - (unsigned) (k)))						\
    return 1;
  CONST_CHECKS (ONE)
  return 0;
}

__attribute__ ((noinline)) static int
check (int a, int b)
{
  int r;
  if (__builtin_add_overflow (a, b, &r) != range ((long) a + b)
      || r != (int) ((unsigned) a + (unsigned) b))
    return 1;
  if (__builtin_sub_overflow (a, b, &r) != range ((long) a - b)
      || r != (int) ((unsigned) a - (unsigned) b))
    return 1;
  /* The result in an operand's own variable.  */
  int x = a;
  if (__builtin_add_overflow (x, b, &x) != range ((long) a + b))
    return 1;
  x = b;
  if (__builtin_sub_overflow (a, x, &x) != range ((long) a - b))
    return 1;
  return 0;
}

int
main (void)
{
  for (long v = -32768; v <= 32767; v++)
    if (__builtin_clrsb ((int) v) != clrsb_ref ((int) v))
      return 1;

  for (unsigned i = 0; i < NEDGE; i++)
    {
      int r;
      if (__builtin_sub_overflow (0, edge[i], &r) != (edge[i] == -32768)
	  || r != (int) -(unsigned) edge[i])
	return 2;
      if (check_const (edge[i]))
	return 3;
      for (unsigned j = 0; j < NEDGE; j++)
	if (check (edge[i], edge[j]))
	  return 4;
    }

  for (int i = 0; i < 2000; i++)
    {
      int a = rnd (), b = rnd ();
      if (check (a, b) || check (a, b >> 8) || check_const (a))
	return 5;
    }
  return 0;
}
