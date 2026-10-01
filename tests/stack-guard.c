/* stack-guard.c - a recursion with no bottom runs into the I/O page's guard.

   The stack grows down from __stack_top towards the I/O page, whose top 16
   bytes, 0x04f0-0x04ff, trap to [cpu.vectors] io_guard (isa/fructus.toml,
   [cpu.io]).  tools/fcc-run.mjs stops there and exits 124, so this program
   passes by never returning.  Each frame is a few bytes of saved registers
   and a word of its own, well under the guard's 16, so a push lands in it
   rather than stepping over it.

   It prints first, which is the check that the console moved with the page:
   run.sh looks for the line on stdout.  */

#include <stdio.h>

static int
deeper (volatile int n)
{
  volatile int here = n;
  return deeper (here + 1) + here;   /* not a tail call: the add is after it */
}

int
main (void)
{
  puts ("descending");
  return deeper (0);
}
