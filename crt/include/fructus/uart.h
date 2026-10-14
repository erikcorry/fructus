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

/* THE DIVISOR is clocks to a bit less one, 12 bits: 3 to 4095.  These are
   the values to write for the common rates, at the clock the UART runs
   from.  That is the system's, 25.125 MHz from the PLL; a board clocked
   otherwise defines FRUCTUS_UART_CLOCK_HZ before including this.  At
   25.125 MHz:

       baud     value   error
       9600     2616    +0.01%
      19200     1308    -0.03%
      38400      653    +0.05%
      57600      435    +0.05%
     115200      217    +0.05%     the value from reset
     230400      108    +0.05%
     460800       54    -0.86%
     921600       26    +0.97%

   4800 and below need more than 4096 clocks, which 12 bits cannot hold.
   The receiver samples each bit once, in its middle, and tolerates a few
   per cent between the two ends' rates over a byte; the last two rates
   spend about a quarter of that on rounding.  */
#ifndef FRUCTUS_UART_CLOCK_HZ
#define FRUCTUS_UART_CLOCK_HZ 25125000UL
#endif

#define FRUCTUS_UART_DIVISOR(baud) \
  ((uint16_t) ((FRUCTUS_UART_CLOCK_HZ + (unsigned long) (baud) / 2) \
               / (unsigned long) (baud) - 1))

#define FRUCTUS_UART_DIV_9600   FRUCTUS_UART_DIVISOR (9600)
#define FRUCTUS_UART_DIV_19200  FRUCTUS_UART_DIVISOR (19200)
#define FRUCTUS_UART_DIV_38400  FRUCTUS_UART_DIVISOR (38400)
#define FRUCTUS_UART_DIV_57600  FRUCTUS_UART_DIVISOR (57600)
#define FRUCTUS_UART_DIV_115200 FRUCTUS_UART_DIVISOR (115200)
#define FRUCTUS_UART_DIV_230400 FRUCTUS_UART_DIVISOR (230400)
#define FRUCTUS_UART_DIV_460800 FRUCTUS_UART_DIVISOR (460800)
#define FRUCTUS_UART_DIV_921600 FRUCTUS_UART_DIVISOR (921600)

/* Set the rate: fructus_uart_divisor (FRUCTUS_UART_DIV_9600).  Wait for
   BUSY to clear first, or the byte being sent changes rate part way.  */
static inline void
fructus_uart_divisor (uint16_t value)
{
  __uart_divisor = value;
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
