// rx.cc - the serial line's interrupt handler: see rx.h for the protocol.
#include "rx.h"

#include <fructus/uart.h>

extern "C" volatile uint16_t __shadow_isp;

namespace teletext {

Page pages[2];
volatile uint8_t rx_page;
volatile uint8_t rx_complete;
volatile uint16_t rx_overruns;

namespace {

// Where the next byte goes.  pos counts the page's bytes and runs on past
// 1000, so a long page is told from a whole one; row and column are pos's,
// kept as counters because there is no divide.
uint16_t pos;
uint8_t row, column;

// vectors.s's stub saves r0, r1, r5 and lr, which a void (void) function
// may clobber; the rest are callee saved.  This needs little: 64 bytes.
uint8_t interrupt_stack[64] __attribute__((aligned(2)));

}  // namespace

void rx_start() {
  __shadow_isp = (uint16_t) (uintptr_t) (interrupt_stack + sizeof interrupt_stack);
  __uart_status = FRUCTUS_UART_RX_INTERRUPT;
  interrupts_on();
}

}  // namespace teletext

using namespace teletext;

// From vectors.s on the interrupt line, and on a brk, which finds nothing
// received and returns.
extern "C" void teletext_rx_interrupt() {
  uint16_t status = fructus_io_load(&__uart_status);
  if (!(status & FRUCTUS_UART_RECEIVED)) return;
  if (status & FRUCTUS_UART_OVERRUN) rx_overruns = rx_overruns + 1;
  uint8_t byte = (uint8_t) fructus_io_load(&__console);

  if (byte == END_OF_PAGE) {
    if (pos == PAGE_BYTES) rx_complete = 1;
    pos = 0;
    row = column = 0;
    return;
  }

  if (pos == 0) rx_complete = 0;   // overwriting it from here on
  if (pos < PAGE_BYTES) {
    Page &in = pages[rx_page];
    const Page &shown = pages[rx_page ^ 1];
    byte &= 0x7f;
    if (column == 0) in.dirty[row] = 0;
    in.text[row][column] = byte;
    if (byte != shown.text[row][column]) in.dirty[row] = 1;
    if (++column == COLUMNS) {
      column = 0;
      row++;
    }
  }
  pos++;
}
