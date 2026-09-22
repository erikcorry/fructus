/* Tail calls through a pointer.  Returns 0, or the number of the check that
   failed.  Run by tests/run.sh through tools/fcc.

   AN INDIRECT TAIL CALL STAGES ITS TARGET IN r5, because the epilogue runs
   between loading the target and jumping to it.  An epilogue pops the
   callee-saved registers the function used, so a target the allocator had
   put in r2, r3 or r4 would be replaced by the caller's value just before
   the `jmp'.  That happened: pr34456 at -Os compiled to `pop r2, r3, lr'
   and `jmp r2'.

   tail() below is that shape: the pointer and a value are both live across
   a call, so they have to be in callee-saved registers, and the function
   ends by calling through the pointer.  main() puts sentinels in the
   registers the pops restore, so a wrong target is a wild jump rather than a
   lucky one.

   big() is the other way to lose r5: a frame over 511 bytes is too large
   for one `add sp', and the constant normally goes through r5 - which the
   epilogue of an indirect tail call must not touch.  */

typedef int (*fn) (int);

static int __attribute__ ((noinline)) negate (int x) { return -x; }
static int __attribute__ ((noinline)) twice (int x) { return 2 * x; }
volatile int one = 1;
static int __attribute__ ((noinline)) other (void) { return one; }

fn volatile pick[2] = { negate, twice };

int __attribute__ ((noinline))
tail (int which, int x)
{
  fn f = pick[which];
  int y = x + 3;
  if (other ())		/* a call, so f and y must survive one */
    y += x;
  return f (y);
}

int __attribute__ ((noinline))
big (int which, int x)
{
  volatile char buf[600];
  fn f = pick[which];
  buf[0] = x;
  buf[599] = x;
  return f (buf[0] + buf[599]);
}

int
main (void)
{
  /* Sentinels in the registers an epilogue restores: if the jump reads one
     of them, it goes somewhere that is not a function.  */
  register int r2 __asm__ ("r2") = 0x7777;
  register int r3 __asm__ ("r3") = 0x7777;
  register int r4 __asm__ ("r4") = 0x7777;
  __asm__ volatile ("" : : "r" (r2), "r" (r3), "r" (r4));

  if (tail (0, 5) != -13)
    return 1;
  if (tail (1, 5) != 26)
    return 2;
  if (big (0, 7) != -14)
    return 3;
  if (big (1, 7) != 28)
    return 4;
  return 0;
}
