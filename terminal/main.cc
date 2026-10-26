// main.cc - the terminal on the display: bytes from the serial line, drawn.
//
//   tools/fcc -Os -T ld/fructus-writethru.ld -Iterminal terminal/main.cc
//     terminal/terminal.cc terminal/decompose.cc terminal/font.cc
//     terminal/row.cc terminal/vectors.s -o build/terminal
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
// TWO BUFFERS.  Each pass reads what has come, draws into the buffer not
// shown the rows changed since that buffer was last drawn, and shows it; the
// other buffer catches up on the next pass.  Each buffer has its own record
// of rows to draw, of whether its line tables are out of date, and of where
// it drew the cursor, which is the cell's colours swapped.
//
// THE SERIAL LINE FILLS A RING, from the UART's receive interrupt
// (vectors.s's shim calls rx_interrupt), and each pass empties it.  The UART
// holds one byte, and at 115200 baud the next comes 2,180 cycles later, but a
// pass - drawing every row and waiting for the flip's vertical sync - takes
// up to 830,000.  The ring holds what comes meanwhile: a frame's worth, 193
// bytes, at most in terminal/check.mjs's runs, and two frames' is 386.  The handler alone moves the head and the pass
// alone the tail, each a word stored at once, so neither stops the other.
#include "row.h"

#include <fructus/display.h>
#include <fructus/uart.h>

using namespace terminal;

namespace {

constexpr int TOP = 2, TEXT_LINES = LINES * ROWS;
constexpr uint16_t MODE = DISPLAY_8BPP | DISPLAY_WIDTH(8);

// The buffer's arrays, from the end of the font at the linker's 0x8000.
// Addresses, not pointers: a pointer computed from another is initialised
// at run time, and ld/fructus-writethru.ld runs no constructors.
constexpr uint16_t ROW_BYTES = ROWS * COLUMNS;
constexpr uint16_t CODES_AT = 0x8000 + LINES * 256, FG_AT = CODES_AT + ZONES * ROW_BYTES;
constexpr uint16_t BG_AT = FG_AT + ROW_BYTES, BLACK_AT = BG_AT + ROW_BYTES;
static_assert(FG_AT == 0xbcc0 && BLACK_AT == 0xce40, "the map above is out of date");
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

bool show_a;   // which buffer is shown; WRITETHRU writes the other

// Show the other buffer, and write to the one that was shown, once the
// change has taken effect: until then, stores above 0x8000 go nowhere.
void flip() {
  show_a = !show_a;
  DISPLAY_MODE = (show_a ? DISPLAY_SHOW_A : 0) | DISPLAY_WRITETHRU;
  display_sync();
}

// The pointers of the text's lines, for the rows the screen shows now.
void line_tables() {
  for (int y = 0; y < ROWS; y++) {
    int r = screen->line[y];
    for (int l = 0; l < LINES; l++) {
      int line = TOP + LINES * y + l;
      DISPLAY_CHARS[line] = address(CODES + (ZONE_OF_LINE[l] * ROWS + r) * COLUMNS);
      DISPLAY_COLOURS[line] = address(FG + r * COLUMNS);
      DISPLAY_BACKGROUND[line] = address(BG + r * COLUMNS);
    }
  }
}

void draw(int r) {
  RowArrays out = { {}, FG + r * COLUMNS, BG + r * COLUMNS };
  for (int z = 0; z < ZONES; z++) out.code[z] = CODES + (z * ROWS + r) * COLUMNS;
  draw_row(screen->rows[r], out);
}

// The cursor's cell with its colours swapped.
void draw_cursor(int r, int x) {
  const Row &row = screen->rows[r];
  FG[r * COLUMNS + x] = row.bg[x];
  BG[r * COLUMNS + x] = row.fg[x];
}

// The parts that never change: the font, the modes, the black outside the
// text.  Then every row.
void setup_buffer() {
  volatile uint8_t *font = (volatile uint8_t *) FONT;
  for (int i = 0; i < LINES * 256; i++) font[i] = FONT[i];
  for (int i = 0; i < COLUMNS; i++) BLACK[i] = DISPLAY_RGB(0, 0, 0);
  for (int line = 0; line < 512; line++) {
    int l = line - TOP;
    if (l < 0 || l >= TEXT_LINES) {
      DISPLAY_CHARS[line] = DISPLAY_COLOURS[line] = DISPLAY_BACKGROUND[line] = address(BLACK);
      DISPLAY_LINEMODE[line] = MODE | DISPLAY_NO_TEXT;
    } else {
      DISPLAY_LINEMODE[line] = MODE | DISPLAY_FONT_LINE(4 * (l % LINES));
    }
  }
  line_tables();
  for (int r = 0; r < ROWS; r++) draw(r);
}

// What each buffer has yet to catch up on.
struct Behind {
  uint32_t rows;
  bool tables;
  int8_t cursor_row, cursor_x;   // where it drew the cursor, -1 for nowhere
};
Behind behind[2] = { { 0, false, -1, 0 }, { 0, false, -1, 0 } };

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

int main() {
  reset();
  dirty = 0;
  moved = false;
  DISPLAY_FONT = address(FONT);
  flip();             // A shown, B written
  setup_buffer();
  flip();             // B shown, A written
  setup_buffer();

  __shadow_isp = address(interrupt_stack + sizeof interrupt_stack);
  __uart_status = FRUCTUS_UART_RX_INTERRUPT;
  __asm__ volatile("sei" ::: "memory");

  for (;;) {
    uint16_t head = ring_head;
    __asm__ volatile("" ::: "memory");
    for (; ring_tail != head; ring_tail++) put(ring[ring_tail % RING]);
    for (Behind &b : behind) {
      b.rows |= dirty;
      b.tables |= moved;
    }
    dirty = 0;
    moved = false;

    Behind &b = behind[show_a];      // A shown: B is written, behind[1]
    int cursor = cursor_shown ? screen->line[cursor_y] : -1;
    if (cursor != b.cursor_row || cursor_x != b.cursor_x) {
      if (b.cursor_row >= 0) b.rows |= (uint32_t) 1 << b.cursor_row;
      if (cursor >= 0) b.rows |= (uint32_t) 1 << cursor;
    }
    if (!b.rows && !b.tables) continue;
    if (b.tables) line_tables();
    for (int r = 0; r < ROWS; r++)
      if (b.rows >> r & 1) draw(r);
    if (cursor >= 0 && b.rows >> cursor & 1) draw_cursor(cursor, cursor_x);
    b.rows = 0;
    b.tables = false;
    b.cursor_row = cursor;
    b.cursor_x = cursor_x;
    flip();
  }
}
