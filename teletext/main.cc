// main.cc - a teletext display: pages from the serial line, drawn whole.
//
//   tools/fcc -Os -T ld/fructus-writethru.ld -Iteletext teletext/*.cc teletext/vectors.s -o build/teletext
//
// Each page that comes is drawn into the buffer not shown, which is then
// shown at the next vertical sync, and the other buffer is drawn next time.
// Every page is drawn whole: what that costs is printed with -DTELETEXT_TIMING,
// and the dirty rows rx.cc keeps are there if it is too much.
//
// -DTELETEXT_POLL feeds the handler by brk, for tools/fcc-run.mjs, which
// models the UART but not its interrupt.
#include "rx.h"
#include "screen.h"

#include <fructus/cycles.h>
#include <fructus/display.h>
#include <fructus/uart.h>

using namespace teletext;

namespace {

// Flashing: on 3/4 of a second, off 1/4, at the display's clock.
constexpr uint32_t CLOCK = 25175000, FLASH_ON = CLOCK / 4 * 3, FLASH_OFF = CLOCK / 4;

bool show_a;   // which buffer is shown; WRITETHRU writes the other

// Show the other buffer, and write to the one that was shown, once the
// change has taken effect: until then, stores above 0x8000 go to the code.
void flip() {
  show_a = !show_a;
  DISPLAY_MODE = (show_a ? DISPLAY_SHOW_A : 0) | DISPLAY_WRITETHRU;
  display_sync();
}

#ifdef TELETEXT_TIMING
void number(uint32_t v) {
  char digits[10];
  int n = 0;
  do digits[n++] = '0' + v % 10; while (v /= 10);
  while (n) fructus_uart_putc(digits[--n]);
}
#endif

}  // namespace

int main() {
  setup_display();
  flip();             // A shown, B written
  setup_buffer();
  flip();             // B shown, A written
  setup_buffer();
  rx_start();

  bool flash_on = true;
  uint32_t flash_at = fructus_cycles();
  for (;;) {
#ifdef TELETEXT_POLL
    interrupts_off();
    while (fructus_uart_ready()) __asm__ volatile ("brk" ::: "memory");
    interrupts_on();
#endif
    if (const Page *page = take_page()) {
#ifdef TELETEXT_TIMING
      uint32_t start = fructus_cycles();
#endif
      draw_page(page->text);
#ifdef TELETEXT_TIMING
      uint32_t took = fructus_cycles() - start;
#endif
      flip();
#ifdef TELETEXT_TIMING
      number(took);
      fructus_uart_putc('\n');
#endif
    }
    if (fructus_cycles() - flash_at >= (flash_on ? FLASH_ON : FLASH_OFF)) {
      flash_at += flash_on ? FLASH_ON : FLASH_OFF;
      flash_on = !flash_on;
      display_vblank();
      set_flash(flash_on);
    }
  }
}
