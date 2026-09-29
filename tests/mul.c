/* tests/mul.c - 16-bit products, compiled with -mmul, against shift and add.

   With -mmul every `*' below is the mul instruction; the reference is a loop
   that never multiplies, so the two share nothing.  The constants cover the
   three forms gas can pick: imm5 tied, imm10 untied, and a register loaded
   first.  Exits with the number of wrong products.  */

typedef unsigned short u16;

__attribute__((noinline)) static u16
ref (u16 a, u16 b)
{
  u16 r = 0;
  for (; b; b >>= 1, a <<= 1)
    if (b & 1)
      r += a;
  return r;
}

__attribute__((noinline)) static u16 var (u16 a, u16 b) { return a * b; }
__attribute__((noinline)) static u16 k11 (u16 a) { u16 t = a; t *= 11; return t; }
__attribute__((noinline)) static u16 k300 (u16 a, u16 b) { return b * 300; }
__attribute__((noinline)) static u16 kbig (u16 a) { return a * 12345; }

static const u16 edge[] = { 0, 1, 2, 3, 7, 255, 256, 257, 0x7fff, 0x8000,
			    0x8001, 0xfffe, 0xffff };

int
main (void)
{
  int bad = 0;
  for (unsigned i = 0; i < sizeof edge / sizeof edge[0]; i++)
    for (unsigned j = 0; j < sizeof edge / sizeof edge[0]; j++)
      bad += var (edge[i], edge[j]) != ref (edge[i], edge[j]);
  u16 x = 1;
  for (int i = 0; i < 300; i++)
    {
      x = x * 25173 + 13849;                    /* and one more mul per trip */
      u16 y = x ^ (x >> 7);
      bad += var (x, y) != ref (x, y);
      bad += k11 (x) != ref (x, 11);
      bad += k300 (0, y) != ref (y, 300);
      bad += kbig (x) != ref (x, 12345);
    }
  return bad;
}
