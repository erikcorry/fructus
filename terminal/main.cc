// main.cc - the terminal on the display: bytes from the serial line, drawn.
//
//   tools/fcc -Os -T ld/fructus-writethru.ld -Iterminal terminal/main.cc
//     terminal/terminal.cc terminal/decompose.cc terminal/font.cc
//     terminal/row.cc terminal/vectors.s -o build/terminal
//   node tools/fcc-run.mjs build/terminal.bin --input bytes --x11 --scale 2
//
// THE BUFFER, as the processor addresses it in WRITETHRU (docs/vga.md):
//
//     0x8000   the font, font.cc's FONT: .font is linked there, so setup
//              copies it with p[i] = p[i]; 17 font rows of 256
//     0x9100   the codes, 80 a text row: EDGE's 28 rows, RISER's, X's
//     0xa480   the foreground colours, 28 rows of 80
//     0xad40   the background, a byte a cell: 8 bits a pixel, 8 wide
//     0xb600   80 bytes of black, for the lines off the text
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
// The serial line is polled: tools/fcc-run.mjs models the UART but not its
// interrupt.
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
static_assert(BLACK_AT + COLUMNS <= 0xf000, "the arrays run into the line tables");

#define CODES ((uint8_t *) CODES_AT)
#define FG ((uint8_t *) FG_AT)
#define BG ((uint8_t *) BG_AT)
#define BLACK ((uint8_t *) BLACK_AT)

uint16_t address(const uint8_t *p) { return (uint16_t) (uintptr_t) p; }

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
  draw_row(screen->rows[r], { { CODES + r * COLUMNS, CODES + (ROWS + r) * COLUMNS,
                                CODES + (2 * ROWS + r) * COLUMNS },
                              FG + r * COLUMNS, BG + r * COLUMNS });
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

  for (;;) {
    for (int n = 0; n < 4096 && fructus_uart_ready(); n++) put(fructus_uart_getc());
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
