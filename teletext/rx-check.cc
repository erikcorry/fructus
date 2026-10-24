// rx-check.cc - rx.cc's handler, fed by brk; teletext/rx-check.mjs runs it.
//
// The simulator models the UART but not its interrupt, so each byte waiting
// gets a brk: the same vector, stub, handler and rti the line would take.
// After every byte that leaves a page complete, and once at the end, it
// prints what take_page gives:
//
//     page N dirty R R ... sum S
//
// N the page's index, the R its dirty rows, S the sum of its 1000 bytes;
// "none" when there is no page to take.  Then "overruns N".
#include "rx.h"

#include <fructus/uart.h>

using namespace teletext;

static void put(const char *s) {
  while (*s) fructus_uart_putc(*s++);
}

static void number(unsigned v) {
  char digits[6];
  int n = 0;
  do digits[n++] = '0' + v % 10; while (v /= 10);
  while (n) fructus_uart_putc(digits[--n]);
}

static void report() {
  const Page *p = take_page();
  if (!p) {
    put("none\n");
    return;
  }
  put("page ");
  number(p - pages);
  put(" dirty");
  for (int r = 0; r < ROWS; r++)
    if (p->dirty[r]) {
      put(" ");
      number(r);
    }
  uint16_t sum = 0;
  for (int r = 0; r < ROWS; r++)
    for (int c = 0; c < COLUMNS; c++) sum += p->text[r][c];
  put(" sum ");
  number(sum);
  put("\n");
}

int main() {
  rx_start();
  interrupts_off();   // nothing raises the line here, and take_page turns them on
  while (fructus_uart_ready()) {
    __asm__ volatile ("brk" ::: "memory");
    if (rx_complete) report();
  }
  report();
  put("overruns ");
  number(rx_overruns);
  put("\n");
  return 0;
}
