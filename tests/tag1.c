/* Tagged pointers, for tests/tag1.s: R_FRUCTUS_16_TAG1 places the address of
   a 2-aligned object plus one, in a datum that may sit at any address.  The
   objects are here, laid out by the compiler; the tagged pointers to them are
   in the assembly, written `.short tag1(sym)', some in an aligned table and
   some in a byte stream where they land odd, and `mov rd, #tag1(sym)' in
   code.  main returns 0, or the number of the first check that failed.  */

struct obj { int a, b; };

struct obj o1 = { 1, 2 };
struct obj o2[3];

extern const unsigned short table[];
extern const unsigned char stream[];
extern unsigned tagged_o1 (void);
extern unsigned tagged_o2_1 (void);

/* A bytecode stream is read a byte at a time: its words are not aligned.  */
static unsigned
rd16 (const unsigned char *p)
{
  return p[0] | p[1] << 8;
}

int
main (void)
{
  if (table[0] != (unsigned) &o1 + 1)
    return 1;
  if (table[1] != (unsigned) &o2[2] + 1)
    return 2;
  if (table[2] != 0x1235)		/* tag1 of a constant, done by gas */
    return 3;
  if (((unsigned) stream & 1) != 0 || stream[0] != 0x42)
    return 4;
  if (rd16 (stream + 1) != (unsigned) &o1 + 1)	/* at an odd address */
    return 5;
  if (rd16 (stream + 3) != (unsigned) &o2[1] + 1)
    return 6;
  if (tagged_o1 () != (unsigned) &o1 + 1)
    return 7;
  if (tagged_o2_1 () != (unsigned) &o2[1] + 1)
    return 8;
  return 0;
}
