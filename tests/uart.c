/* uart.c - fructus/uart.h on tools/fcc-run.mjs, which has the UART's
   receiving side: --input is what arrives.  Echoes the input in upper case
   through putchar, which waits on `busy' as the hardware needs, and counts
   it; tests/run.sh compares what comes out.  Exits 0 if the status said
   nothing was waiting once the input ran out, and no byte was lost.  */

#include <stdio.h>
#include <fructus/uart.h>

int
main (void)
{
  int n = 0;
  while (fructus_uart_ready ())
    {
      uint16_t status = __uart_status;
      uint8_t c = fructus_uart_getc ();
      if (status & FRUCTUS_UART_OVERRUN)
        return 2;
      putchar (c >= 'a' && c <= 'z' ? c - 'a' + 'A' : c);
      n++;
    }
  printf ("%d\n", n);
  return __uart_status & (FRUCTUS_UART_RECEIVED | FRUCTUS_UART_BUSY);
}
