/* Shifts by a masked count.  Returns 0, or the number of the check that
   failed.  Run by tests/run.sh through tools/fcc.

   fructus.h says SHIFT_COUNT_TRUNCATED, which lets GCC delete the `& 15',
   `& 31' or `& 63' below and hand the raw count to the shift.  That is only
   right if every way a shift is done reads just those bits: the machine's
   16-bit shifts, the 32- and 64-bit helpers in lib1funcs.S, and the 32-bit
   shifts GCC expands inline at -O2.  Each is tried with every count from 0
   to 127, so the counts past the width - the ones the mask exists for - are
   all there.

   The reference moves one bit at a time with a CONSTANT shift, which shares
   no code with a shift by a variable count.  */

volatile unsigned vn;

#define CHECK(T, W, NUM)						\
  {									\
    T v = (T) 0x9bd5c3a1e7f24867ULL;					\
    for (unsigned n = 0; n < 128; n++)					\
      {									\
	vn = n;								\
	unsigned k = vn & (W - 1);					\
	T l = v, r = v;							\
	unsigned T ur = (unsigned T) v;					\
	for (unsigned i = 0; i < k; i++)				\
	  {								\
	    l <<= 1;							\
	    r >>= 1;							\
	    ur >>= 1;							\
	  }								\
	if ((T) (v << (vn & (W - 1))) != l)				\
	  return NUM;							\
	if ((T) (v >> (vn & (W - 1))) != r)				\
	  return NUM + 1;						\
	if ((unsigned T) ((unsigned T) v >> (vn & (W - 1))) != ur)	\
	  return NUM + 2;						\
      }									\
  }

int
main (void)
{
  CHECK (int, 16, 1)
  CHECK (long, 32, 4)
  CHECK (long long, 64, 7)
  return 0;
}
