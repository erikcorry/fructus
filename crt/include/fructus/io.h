/* fructus/io.h - loading the registers the hardware changes.

   tools/fpga-system.sv writes every register of the I/O page through into
   the memory beneath it, and a load reads that memory: what was last
   written.  The words the hardware changes - the display's status and its
   arrays' three addresses, the UART's data and status, the USB port's data
   and status - reach a load only while the mode's LATE BIT, 0x0480's bit 3,
   is set, as it is in DISPLAY_BLIT: every load then takes a cycle more.
   Outside it, a load of one of them is the word last stored there, and a
   load of a data register takes no byte.

   A LOAD SEES A MODE WRITE FROM THE THIRD INSTRUCTION AFTER IT; nearer, it
   runs in the old mode.  So fructus_io_load sets the bit, waits two nops,
   loads, and puts the mode back as it found it - in assembly, so that the
   compiler moves nothing into the gap.  Twelve cycles or so.

   AN INTERRUPT HANDLER MUST LEAVE THE MODE AS IT FOUND IT.  One that loads
   these registers does so through this, which puts the mode back; one that
   changes the mode for good - shows the other buffer at a vertical blank -
   would have that undone by a fructus_io_load it interrupted, which puts
   back the mode it read before the interrupt.

   PUTTING THE MODE BACK TAKES AS LONG: a load in the two instructions after
   still runs late, and so reads the hardware's word.

   The simulator, tools/gpu.js and tools/fcc-run.mjs, is as strict: a load
   outside the window, or too soon inside it, reads the memory beneath.  */
#ifndef _FRUCTUS_IO_H
#define _FRUCTUS_IO_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define FRUCTUS_IO_LATE  8    /* the mode's late bit */

/* The word at p, an even address in the I/O page, as the hardware has it.  */
static inline uint16_t
fructus_io_load (const volatile void *p)
{
  uint16_t v, m, a;
  __asm__ volatile ("mov\t%2, #0x480\n\t"
                    "ld\t%1, [%2]\n\t"      /* the mode, from its copy */
                    "or\t%0, %1, #8\n\t"
                    "st\t%0, [%2]\n\t"
                    "nop\n\t"
                    "nop\n\t"
                    "ld\t%0, [%3]\n\t"      /* the third instruction on */
                    "st\t%1, [%2]"
                    : "=&r" (v), "=&r" (m), "=&r" (a)
                    : "r" (p)
                    : "memory");
  return v;
}

#ifdef __cplusplus
}
#endif

#endif
