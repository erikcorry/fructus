// rx.h - teletext pages from the serial line, a byte an interrupt.
//
// THE PROTOCOL: a page is its 1000 bytes, row by row, and then a 0.  0 is
// free in a level 1 page - the spacing attributes are 0x01-0x1f - and 12,
// which would have been the obvious "new page", is normal height.  A byte
// is stored with bit 7 clear, so a sender may use the BBC's 0x80-0x9f for
// the attributes; only a 0 as sent ends the page.
//
// TWO PAGES.  The handler fills pages[rx_page]; the other is the main
// program's, which it renders at leisure.  When a 0 ends a page of exactly
// 1000 bytes the handler sets rx_complete; a page that came up short or
// long, a byte lost to an overrun, say, is dropped, and the next one starts
// clean at its first byte.  take_page() is the only way the two trade: with
// interrupts off it checks rx_complete and, if set, flips rx_page.
//
// ONE FLAG IS ENOUGH.  The handler clears rx_complete on the first byte of
// the page after, the moment it starts overwriting the finished one, so a
// page that is complete is never also being received, and take_page needs
// no "in progress" flag beside it.  A page that arrives before the main
// program takes the last is written over it: the main program gets the
// newest whole page, never a mix.
#ifndef TELETEXT_RX_H
#define TELETEXT_RX_H

#include <stdint.h>

namespace teletext {

constexpr int COLUMNS = 40, ROWS = 25, PAGE_BYTES = COLUMNS * ROWS;
constexpr uint8_t END_OF_PAGE = 0;

struct Page {
  uint8_t text[ROWS][COLUMNS];
};

extern Page pages[2];
extern volatile uint8_t rx_page;      // the page the handler fills
extern volatile uint8_t rx_complete;  // pages[rx_page] holds a whole page
extern volatile uint16_t rx_overruns; // bytes the UART lost, for a status line

inline void interrupts_off() { __asm__ volatile ("cli" ::: "memory"); }
inline void interrupts_on() { __asm__ volatile ("sei" ::: "memory"); }

// The interrupt stack, the UART's receive interrupt, and interrupts on.
void rx_start();

// The newest whole page, if one has come since the last call: the page to
// render, or nullptr.
inline const Page *take_page() {
  interrupts_off();
  const Page *p = nullptr;
  if (rx_complete) {
    p = &pages[rx_page];
    rx_page ^= 1;
    rx_complete = 0;
  }
  interrupts_on();
  return p;
}

}  // namespace teletext

#endif
