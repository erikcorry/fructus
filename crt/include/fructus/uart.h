/* fructus/uart.h - the serial line.

   An option of the system's, rtl/uart.sv, built with FRUCTUS_UART; [cpu.io]
   in isa/fructus.toml has the register map.  Its data register is the
   console, `__console' at 0x0420, so putchar already sends through it; this
   is for reading, for the status and for the baud rate.  The words are
   symbols in the linker scripts, for the reason fructus/display.h gives.

   A STATUS OF ZERO IS IDLE.  On a machine without the UART the words are
   plain memory, so fructus_uart_putc never waits there, and
   fructus_uart_ready says nothing has arrived - unless the program wrote the
   status word itself.

   tools/fcc-run.mjs has the UART too: what it sends is printed, and
   `--input FILE' is what it receives, a byte as soon as the last is taken.  */
#ifndef _FRUCTUS_UART_H
#define _FRUCTUS_UART_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

extern volatile uint8_t __console;
extern volatile uint16_t __uart_status;
extern volatile uint16_t __uart_divisor;

#define FRUCTUS_UART_BUSY      0x01   /* a byte is being sent */
#define FRUCTUS_UART_RECEIVED  0x02   /* a byte is waiting at __console */
#define FRUCTUS_UART_OVERRUN   0x04   /* another arrived while it waited */
#define FRUCTUS_UART_RX_INTERRUPT 0x10  /* raise the interrupt line on RECEIVED */
#define FRUCTUS_UART_TX_INTERRUPT 0x20  /* and while not BUSY */

/* Clocks to a bit: the clock rate over the baud rate, rounded, from 4 to
   4096.  The register holds it less one: 217 from reset, 115200 baud at the
   system's 25.125 MHz; 9600 is 2617 clocks.  */
static inline void
fructus_uart_divisor (uint16_t clocks)
{
  __uart_divisor = clocks - 1;
}

static inline void
fructus_uart_putc (uint8_t c)
{
  while (__uart_status & FRUCTUS_UART_BUSY)
    ;
  __console = c;
}

static inline int
fructus_uart_ready (void)
{
  return (__uart_status & FRUCTUS_UART_RECEIVED) != 0;
}

/* The byte received, once fructus_uart_ready says there is one.  Reading it
   clears RECEIVED and OVERRUN.  */
static inline uint8_t
fructus_uart_getc (void)
{
  while (!fructus_uart_ready ())
    ;
  return __console;
}

#ifdef __cplusplus
}
#endif

#endif
