// rx-check.cc - rx.cc's handler, fed by the UART's interrupt;
// teletext/rx-check.mjs runs it.
//
// tools/fcc-run.mjs --paced sends the bytes at 115200 baud and raises the
// interrupt line for each.  Whenever a page is complete, three times, and
// once more at the end, it prints what take_page gives:
//
//     page N sum S
//
// N the page's index, S the sum of its 1000 bytes; "none" when there is no
// page to take.  Then "overruns N".
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
  uint16_t sum = 0;
  for (int r = 0; r < ROWS; r++)
    for (int c = 0; c < COLUMNS; c++) sum += p->text[r][c];
  put(" sum ");
  number(sum);
  put("\n");
}

int main() {
  rx_start();
  for (int pages = 0; pages < 3;)
    if (rx_complete) {
      report();
      pages++;
    }
  report();
  put("overruns ");
  number(rx_overruns);
  put("\n");
  return 0;
}
