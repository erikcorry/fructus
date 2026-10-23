/* uart.c - fructus/uart.h on tools/fcc-run.mjs, which has the UART's
   receiving side: --input is what arrives.  Echoes the input in upper case
   through putchar, which waits on `busy' as the hardware needs, and counts
   it; tests/run.sh compares what comes out.  Exits 0 if the status said
   nothing was waiting once the input ran out, and no byte was lost; 3 if a
   load outside the late bit's window, or one instruction too soon inside it,
   saw the byte waiting - fructus/io.h says why it must not.  */

#include <stdio.h>
#include <fructus/uart.h>

/* The divisors fructus/uart.h names, at the system's 25.125 MHz.  */
_Static_assert (FRUCTUS_UART_DIV_9600 == 2616, "9600");
_Static_assert (FRUCTUS_UART_DIV_19200 == 1308, "19200");
_Static_assert (FRUCTUS_UART_DIV_38400 == 653, "38400");
_Static_assert (FRUCTUS_UART_DIV_57600 == 435, "57600");
_Static_assert (FRUCTUS_UART_DIV_115200 == 217, "115200: the reset value");
_Static_assert (FRUCTUS_UART_DIV_230400 == 108, "230400");
_Static_assert (FRUCTUS_UART_DIV_460800 == 54, "460800");
_Static_assert (FRUCTUS_UART_DIV_921600 == 26, "921600");

/* fructus_io_load with one nop where it needs two: the load is the second
   instruction after the mode's write, and runs in the old mode.  */
static uint16_t
too_soon (const volatile void *p)
{
  uint16_t v, m, a;
  __asm__ volatile ("mov\t%2, #0x480\n\t"
                    "ld\t%1, [%2]\n\t"
                    "or\t%0, %1, #8\n\t"
                    "st\t%0, [%2]\n\t"
                    "nop\n\t"
                    "ld\t%0, [%3]\n\t"
                    "st\t%1, [%2]"
                    : "=&r" (v), "=&r" (m), "=&r" (a) : "r" (p) : "memory");
  return v;
}

int
main (void)
{
  int n = 0;
  /* A byte is waiting, but a plain load is the memory beneath, and so is a
     load the window has not yet reached.  First, before any window: the
     mode a window puts back takes as long to be seen as the bit did.  */
  if (__uart_status & FRUCTUS_UART_RECEIVED)
    return 3;
  if (too_soon (&__uart_status) & FRUCTUS_UART_RECEIVED)
    return 3;
  if (!fructus_uart_ready ())
    return 3;
  while (fructus_uart_ready ())
    {
      uint16_t status = fructus_io_load (&__uart_status);
      uint8_t c = fructus_uart_getc ();
      if (status & FRUCTUS_UART_OVERRUN)
        return 2;
      putchar (c >= 'a' && c <= 'z' ? c - 'a' + 'A' : c);
      n++;
    }
  printf ("%d\n", n);
  return fructus_io_load (&__uart_status) & (FRUCTUS_UART_RECEIVED | FRUCTUS_UART_BUSY);
}
