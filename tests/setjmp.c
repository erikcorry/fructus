/* setjmp and longjmp, from C.  Returns 0, or the number of the check that
   failed.  Run by tests/run.sh through tools/fcc.

   WHAT IS ACTUALLY BEING TESTED is that longjmp puts the frame back: a, b and
   c are set before the setjmp and never touched afterwards, so whether they
   live in r2, r3 and r4 or in the frame, they can only still be right if
   longjmp restored the registers and sp.  deep() jumps from twenty frames
   down, which no epilogue unwinds.  */

#include <setjmp.h>

static jmp_buf env;
volatile int reached;

static void
deep (int n)
{
  if (n)
    {
      deep (n - 1);
      return;
    }
  longjmp (env, 7);
}

int
main (void)
{
  int a = 11, b = 22, c = 33;
  int v = setjmp (env);

  if (v == 0)
    {
      reached++;
      longjmp (env, 42);
    }
  if (v == 42)
    {
      if (a != 11 || b != 22 || c != 33)
	return 1;
      longjmp (env, 0);		/* C says this comes back as 1, not 0 */
    }
  if (v == 1)
    {
      if (reached != 1)
	return 2;
      deep (20);
      return 3;			/* deep() must not return */
    }
  if (v != 7)
    return 4;
  if (a != 11 || b != 22 || c != 33)
    return 5;
  return 0;
}
