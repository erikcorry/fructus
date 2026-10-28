// main.cc - the terminal on the display: bytes from the serial line, drawn.
//
//   tools/fcc -Os -T ld/fructus-writethru.ld -Iterminal terminal/main.cc
//     terminal/terminal.cc terminal/decompose.cc terminal/font.cc
//     terminal/row.cc terminal/bidi.cc terminal/vectors.s -o build/terminal
//   node tools/fcc-run.mjs build/terminal.bin --input bytes --paced --x11 --scale 2
//
// THE BUFFER, as the processor addresses it in WRITETHRU (docs/vga.md):
//
//     0x8000   the font, font.cc's FONT: .font is linked there, so setup
//              copies it with p[i] = p[i]; 17 font rows of 256
//     0x9100   the codes, 80 a text row: EDGE's 28 rows, RISER's, X_TOP's,
//              X_MIDDLE's, X_BOTTOM's
//     0xbcc0   the foreground colours, 28 rows of 80
//     0xc580   the background, a byte a cell: 8 bits a pixel, 8 wide
//     0xce40   80 bytes of black, for the lines off the text
//     0xf000   the line tables
//
// THE ROWS IN THE BUFFER ARE THE TERMINAL'S ROWS[], not the lines of the
// screen: screen line y shows rows[line[y]], and the line tables say which.
// So a scroll changes the line tables' pointers and draws only the row that
// came in.  The text is lines 2-477 of 480.
//
// TWO BUFFERS, AND COPY (docs/vga.md, "Double buffering").  B is shown, and
// each pass draws into A the rows changed since the last, then shows A for
// a frame in COPY, which copies it into B, and shows B again.  So a change
// is drawn once, and A always has the latest.  The record of where A has
// the cursor drawn, the cell's colours swapped, is the only one.
//
// THE DENSE TERMINAL, -DTERMINAL_DENSE (terminal.h), is 128x60 cells of 5x8,
// all 480 lines, in the display's 5-pixel cells:
//
//   tools/fcc -Os -DTERMINAL_DENSE -T ld/fructus-writethru.ld -Iterminal
//     terminal/main.cc terminal/terminal.cc terminal/font5.cc
//     terminal/vectors.s -o build/terminal-dense
//
//     0x8000   the font, font5.cc's FONT, 8 font rows of 128
//     0x8400   the codes, 128 a text row, 60 rows: a cell's base is its code
//     0xa200   the foreground colours
//     0xc000   the background, a byte a cell: 8 bits a pixel, 5 wide
//     0xde00   128 bytes of black, for lines 480-511
//     0xf000   the line tables
//
// Its one screen is 23K of the 28K below 0x8000, so the primary screen,
// while the alternate one is shown, is kept above the code, in .upper: the
// processor's own RAM there, which it stores to only in DISPLAY_CPU.
//
// THE SERIAL LINE FILLS A RING, from the UART's receive interrupt
// (vectors.s's shim calls rx_interrupt), and drain() empties it into the
// screen: before each row a pass draws, and all through the waits for the
// vertical syncs.  The line runs at 230400 baud.  The UART holds one byte,
// and the next comes 1,090 cycles later; a row is some 30,000 cycles, or
// 38,000 right to left through bidi.cc, so the ring holds what comes during
// one row and a drain.  put() is some 550 cycles a byte, and at 460800 baud
// it would be all of them.
// The handler alone moves the head and drain() alone the tail, each a word
// stored at once, so neither stops the other.
#ifdef TERMINAL_DENSE
#include "font5.h"
#include "terminal.h"
#else
#include "row.h"
#endif

#include <fructus/cycles.h>
#include <fructus/display.h>
#include <fructus/uart.h>

using namespace terminal;

namespace {

// The buffer's arrays, from the end of the font at the linker's 0x8000.
// Addresses, not pointers: a pointer computed from another is initialised
// at run time, and ld/fructus-writethru.ld runs no constructors.
constexpr int TEXT_LINES = LINES * ROWS;
constexpr uint16_t ROW_BYTES = ROWS * COLUMNS;
#ifdef TERMINAL_DENSE
constexpr int TOP = 0;
constexpr uint16_t MODE = DISPLAY_8BPP | DISPLAY_WIDTH(5) | DISPLAY_NARROW_FONT;
constexpr uint16_t CODES_AT = 0x8000 + LINES * 128, FG_AT = CODES_AT + ROW_BYTES;
constexpr uint16_t BG_AT = FG_AT + ROW_BYTES, BLACK_AT = BG_AT + ROW_BYTES;
static_assert(FG_AT == 0xa200 && BLACK_AT == 0xde00, "the map above is out of date");
#else
constexpr int TOP = 2;
constexpr uint16_t MODE = DISPLAY_8BPP | DISPLAY_WIDTH(8);
constexpr uint16_t CODES_AT = 0x8000 + LINES * 256, FG_AT = CODES_AT + ZONES * ROW_BYTES;
constexpr uint16_t BG_AT = FG_AT + ROW_BYTES, BLACK_AT = BG_AT + ROW_BYTES;
static_assert(FG_AT == 0xbcc0 && BLACK_AT == 0xce40, "the map above is out of date");
#endif
static_assert(BLACK_AT + COLUMNS <= 0xf000, "the arrays run into the line tables");

#define CODES ((uint8_t *) CODES_AT)
#define FG ((uint8_t *) FG_AT)
#define BG ((uint8_t *) BG_AT)
#define BLACK ((uint8_t *) BLACK_AT)

uint16_t address(const uint8_t *p) { return (uint16_t) (uintptr_t) p; }

// The ring, the interrupt's stack, and the bytes lost to a full ring.
constexpr uint16_t RING = 1024;
uint8_t ring[RING];
volatile uint16_t ring_head;    // the interrupt's
uint16_t ring_tail;             // the pass's
volatile uint16_t ring_lost;
uint8_t interrupt_stack[128];

// The mode last written.  A store sees a mode write from the third
// instruction after it, as a load does (fructus/io.h), hence the nops; the
// barrier keeps the compiler's stores on their side of the mode.
uint16_t mode;

void set_mode(uint16_t m) {
  mode = m;
  DISPLAY_MODE = m;
  __asm__ volatile("nop\n\tnop" ::: "memory");
}

// What the pass draws from.  The normal terminal draws from a copy, taken
// while nothing is drawn, so that put() can go on between its rows: in
// .upper, which WRITETHRU's loads see and its stores do not reach, so it is
// written in DISPLAY_CPU.  The dense terminal has no room for one and
// draws from the screen itself: a row put() changes after it was drawn is
// drawn again on the next pass, and until then the line tables may be a
// pass ahead of a row or behind it.
#ifdef TERMINAL_DENSE
const Screen &view() { return *screen; }
#else
__attribute__((section(".upper"))) Screen copy;
const Screen &view() { return copy; }
#endif

#ifdef TERMINAL_DENSE

// The pointers of the text's lines, for the rows the screen shows now.
void line_tables() {
  for (int y = 0; y < ROWS; y++) {
    int r = view().line[y];
    uint16_t code = address(CODES + r * COLUMNS), fg = address(FG + r * COLUMNS);
    uint16_t bg = address(BG + r * COLUMNS);
    for (int line = TOP + LINES * y; line < TOP + LINES * (y + 1); line++) {
      DISPLAY_CHARS[line] = code;
      DISPLAY_COLOURS[line] = fg;
      DISPLAY_BACKGROUND[line] = bg;
    }
  }
}

// A row, as it is: no bidi, so cell x shows at x.
int draw(int r, int x = 0) {
  const Row &row = view().rows[r];
  uint8_t *code = CODES + r * COLUMNS, *fg = FG + r * COLUMNS, *bg = BG + r * COLUMNS;
  for (int i = 0; i < COLUMNS; i++) {
    code[i] = row.base[i];
    fg[i] = row.fg[i];
    bg[i] = row.bg[i];
  }
  return x;
}

// The primary screen while the alternate is shown: above the code, where
// WRITETHRU's stores would go to the buffer, so it is written in
// DISPLAY_CPU.
__attribute__((section(".upper"))) Screen kept;

#else

// The pointers of the text's lines, for the rows the screen shows now.
void line_tables() {
  for (int y = 0; y < ROWS; y++) {
    int r = view().line[y];
    for (int l = 0; l < LINES; l++) {
      int line = TOP + LINES * y + l;
      DISPLAY_CHARS[line] = address(CODES + (ZONE_OF_LINE[l] * ROWS + r) * COLUMNS);
      DISPLAY_COLOURS[line] = address(FG + r * COLUMNS);
      DISPLAY_BACKGROUND[line] = address(BG + r * COLUMNS);
    }
  }
}

// A row, and where its cell x shows.
int draw(int r, int x = 0) {
  RowArrays out = { {}, FG + r * COLUMNS, BG + r * COLUMNS };
  for (int z = 0; z < ZONES; z++) out.code[z] = CODES + (z * ROWS + r) * COLUMNS;
  return draw_row(view().rows[r], out, x);
}

#endif

// The cursor's cell, x, with its colours swapped where it shows, at.
void draw_cursor(int r, int at, int x) {
  const Row &row = view().rows[r];
  FG[r * COLUMNS + at] = row.bg[x];
  BG[r * COLUMNS + at] = row.fg[x];
}

// The parts that never change: the font, the modes, the black outside the
// text.  Then every row.
void setup_buffer() {
  volatile uint8_t *font = (volatile uint8_t *) FONT;
  for (unsigned i = 0; i < sizeof FONT; i++) font[i] = FONT[i];
  for (int i = 0; i < COLUMNS; i++) BLACK[i] = DISPLAY_RGB(0, 0, 0);
  for (int line = 0; line < 512; line++) {
    int l = line - TOP;
    if (l < 0 || l >= TEXT_LINES) {
      DISPLAY_CHARS[line] = DISPLAY_COLOURS[line] = DISPLAY_BACKGROUND[line] = address(BLACK);
      DISPLAY_LINEMODE[line] = MODE | DISPLAY_NO_TEXT;
    } else {
      DISPLAY_LINEMODE[line] = MODE | DISPLAY_FONT_LINE(sizeof FONT / LINES / 64 * (l % LINES));
    }
  }
  line_tables();
  for (int r = 0; r < ROWS; r++) draw(r);
}

// Where A has the cursor drawn: its row, -1 for nowhere, and its cell.
int8_t cursor_row = -1, cursor_cell;

// What has come from the line, into the screen.
void drain() {
  uint16_t head = ring_head;
  __asm__ volatile("" ::: "memory");
  for (; ring_tail != head; ring_tail++) put(ring[ring_tail % RING]);
}

// Drain until a vertical sync has passed since the call, and so the mode
// written before it has taken effect.  The status says only the visible
// line, so the wait is timed from the first one seen: the sync starts 490 -
// v lines after line v begins, and lasts two (fructus/display.h).  The
// cycles are read after the line, so the time is if anything late.
void wait_sync() {
  int v;
  while ((v = display_line()) < 0) drain();
  uint32_t end = fructus_cycles() + (uint32_t) (492 - v) * 800;
  do drain(); while ((int32_t) (fructus_cycles() - end) < 0);
}

}  // namespace

extern "C" volatile uint16_t __shadow_isp;

// A byte from the UART into the ring.  The store of the head comes after
// the byte's.
extern "C" void rx_interrupt() {
  if (!fructus_uart_ready()) return;
  uint8_t c = (uint8_t) fructus_io_load(&__console);
  uint16_t h = ring_head;
  if ((uint16_t) (h - ring_tail) == RING) {
    ring_lost = ring_lost + 1;
    return;
  }
  ring[h % RING] = c;
  __asm__ volatile("" ::: "memory");
  ring_head = h + 1;
}

void terminal::send(const char *s) {
  while (*s) fructus_uart_putc(*s++);
}

#ifdef TERMINAL_DENSE
// In COPY the processor's stores are its own already, and writing another
// mode then could drop the copy.
void terminal::stash(const Screen &s) {
  uint16_t m = mode;
  if ((m & 3) != DISPLAY_COPY) set_mode((m & DISPLAY_SHOW_A) | DISPLAY_CPU);
  kept = s;
  set_mode(m);
}

void terminal::unstash(Screen &s) { s = kept; }
#endif

int main() {
  reset();
  DISPLAY_FONT = address(FONT);
  set_mode(DISPLAY_CPU);
#ifndef TERMINAL_DENSE
  copy = *screen;
#endif
  set_mode(DISPLAY_SHOW_A | DISPLAY_WRITETHRU);
  display_sync();
  setup_buffer();     // B
  set_mode(DISPLAY_WRITETHRU);
  display_sync();
  setup_buffer();     // A, and B shown
  dirty = 0;
  moved = false;

  __shadow_isp = address(interrupt_stack + sizeof interrupt_stack);
  __uart_divisor = FRUCTUS_UART_DIV_230400;
  __uart_status = FRUCTUS_UART_RX_INTERRUPT;
  __asm__ volatile("sei" ::: "memory");

  // B is shown and A drawn, from view(), with a drain between rows.  Then A
  // is shown for a frame in COPY, which copies it into B, and B is shown
  // again.  Every change is drawn once, into A, and put() goes on all the
  // while but for the copy into view().
  for (;;) {
    drain();
    Rows rows = dirty;
    bool tables = moved;
    dirty = 0;
    moved = false;
#ifndef TERMINAL_DENSE
    if (rows || tables) {
      set_mode(DISPLAY_CPU);
      for (int r = 0; r < ROWS; r++)
        if (rows >> r & 1) copy.rows[r] = screen->rows[r];
      for (int y = 0; y < ROWS; y++) copy.line[y] = screen->line[y];
      set_mode(DISPLAY_WRITETHRU);
    }
#endif
    int x = cursor_x;
    int cursor = cursor_shown ? view().line[cursor_y] : -1;
    if (cursor != cursor_row || x != cursor_cell) {
      if (cursor_row >= 0) rows |= (Rows) 1 << cursor_row;
      if (cursor >= 0) rows |= (Rows) 1 << cursor;
    }
    if (!rows && !tables) continue;

    if (tables) line_tables();
    int at = x;
    for (int r = 0; r < ROWS; r++)
      if (rows >> r & 1) {
        drain();
        int v = draw(r, x);
        if (r == cursor) at = v;
      }
    if (cursor >= 0 && rows >> cursor & 1) draw_cursor(cursor, at, x);
    cursor_row = cursor;
    cursor_cell = x;

    set_mode(DISPLAY_SHOW_A | DISPLAY_COPY);
    wait_sync();                      // the copy's frame has begun
    set_mode(DISPLAY_WRITETHRU);
    wait_sync();                      // and ended, with B shown
  }
}
