/* fructus/cycles.h - the cycle counter.

   32 bits at 0x0424 - 0x0427, low word first: `__cycles' in
   the linker scripts, a symbol for the reason fructus/display.h gives.  It is
   [cpu.io]'s, in rtl/cpu.sv and tools/sim.js alike: every clock since reset,
   and tests/cpu-check.mjs holds the two to the same value at every load, so
   a difference of two readings on the simulator is what the hardware takes.

   NO HOLD REGISTER.  The count runs on between the load of one word and the
   load of the other, and a carry out of the low word in between tears the
   pair.  So read the high word, the low word and the high word again, and go
   round once more if the high word moved: a low word read between two equal
   high words belongs to them.  */
#ifndef _FRUCTUS_CYCLES_H
#define _FRUCTUS_CYCLES_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

extern volatile uint16_t __cycles[2];

static inline uint32_t
fructus_cycles (void)
{
  uint16_t hi, lo;
  do
    {
      hi = __cycles[1];
      lo = __cycles[0];
    }
  while (hi != __cycles[1]);
  return (uint32_t) hi << 16 | lo;
}

#ifdef __cplusplus
}
#endif

#endif
