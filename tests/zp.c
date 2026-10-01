/* The zero page from C: variables with the zp attribute, in both halves,
   reached however -mzp-base decides, and shared with tests/zp.s, which
   reaches them through R_FRUCTUS_ZP10 by hand.  Exit status 0 is a pass;
   anything else names the check that failed.  */

struct point { int x, y; };

int a __attribute__ ((zp)) = 5;
int b __attribute__ ((zp));
int h __attribute__ ((zp ("hi"))) = 7;
unsigned char bytes[8] __attribute__ ((zp));
int words[4] __attribute__ ((zp ("hi"))) = { 10, 20, 30, 40 };
long big __attribute__ ((zp)) = 0x12345678;
struct point pt __attribute__ ((zp ("hi"))) = { 3, 4 };

/* Defined in tests/zp.s, in .zphi.  */
extern int asm_count __attribute__ ((zp));

/* tests/zp.s: a + b + h + asm_count, read through the base.  */
extern int asm_sum (void);

__attribute__ ((noinline)) int sum3 (void) { return a + b + h; }
__attribute__ ((noinline)) void bump (int i) { bytes[i]++; b += i; }
__attribute__ ((noinline)) int word (int i) { return words[i] + words[i + 1]; }
__attribute__ ((noinline)) long getbig (void) { return big + a; }
__attribute__ ((noinline)) int dist (void) { return pt.x * pt.x + pt.y * pt.y; }
__attribute__ ((noinline)) int *addr (void) { return &h; }

__attribute__ ((noinline)) int counter (void)
{
  static int n __attribute__ ((zp));
  return ++n;
}

__attribute__ ((noinline)) int loop (void)
{
  int s = 0;
  for (int i = 0; i < 4; i++)
    s += words[i] + bytes[i] + a;
  return s;
}

int
main (void)
{
  unsigned pa = (unsigned) &a, ph = (unsigned) &h, pp = (unsigned) &pt;

  if (pa == 0 || pa >= 0x200 || ph < 0x200 || ph >= 0x400 || pp < 0x200 || pp >= 0x400)
    return 1;
  b = 3;
  bump (2); bump (2); bump (5);
  if (sum3 () != 5 + 12 + 7)
    return 2;
  if (bytes[2] != 2 || bytes[5] != 1 || bytes[0] != 0)
    return 3;
  if (word (1) != 50 || word (2) != 70)
    return 4;
  if (getbig () != 0x12345678 + 5)
    return 5;
  if (dist () != 25)
    return 6;
  if (*addr () != 7)
    return 7;
  if (counter () != 1 || counter () != 2)
    return 8;
  if (loop () != 100 + 2 + 4 * 5)
    return 9;
  asm_count = 100;
  if (asm_sum () != 5 + 12 + 7 + 100)
    return 10;
  return 0;
}
