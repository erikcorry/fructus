// preview.cc - the screen as the display will draw it, as a PPM picture.
//
//   g++ -O2 -Iterminal terminal/preview.cc terminal/terminal.cc
//       terminal/decompose.cc terminal/font.cc terminal/row.cc
//       -o build/terminal-preview
//   build/terminal-preview < bytes > screen.ppm
//
// For the host.  Each text row goes through draw_row into its six arrays,
// and each of the 476 lines is drawn from them as the display reads them:
// the code from the array of the line's zone, the glyph's bits from the font
// row of the line, fg for a 1 and bg for a 0.  The cursor is not drawn.
#include <stdio.h>

#include "row.h"

using namespace terminal;

void terminal::send(const char *) {}

// A pixel byte in the display's format as 8-bit red, green and blue
// (docs/vga.md, "8-bit pixel format"); a palette entry, unused here, black.
static void rgb(uint8_t b, uint8_t out[3]) {
  unsigned t = b >> 5, c = b & 0x1f;
  if (!t) {
    out[0] = out[1] = out[2] = 0;
    return;
  }
  out[0] = ((c & 15) / 5 + 3 * (c >> 4)) * 255 / 5;
  out[1] = (t - 1) * 255 / 6;
  out[2] = (c & 15) % 5 * 255 / 4;
}

int main() {
  reset();
  for (int c; (c = getchar()) != EOF;) put(c);

  static uint8_t code[ROWS][ZONES][COLUMNS], fg[ROWS][COLUMNS], bg[ROWS][COLUMNS];
  for (int y = 0; y < ROWS; y++)
    draw_row(screen->rows[screen->line[y]],
             { { code[y][0], code[y][1], code[y][2], code[y][3] }, fg[y], bg[y] });

  printf("P6\n%d %d\n255\n", 8 * COLUMNS, LINES * ROWS);
  for (int y = 0; y < LINES * ROWS; y++) {
    int row = y / LINES, line = y % LINES;
    for (int c = 0; c < COLUMNS; c++) {
      uint8_t bits = FONT[256 * line + code[row][ZONE_OF_LINE[line]][c]];
      for (int x = 0; x < 8; x++) {
        uint8_t p[3];
        rgb(bits & 0x80 >> x ? fg[row][c] : bg[row][c], p);
        fwrite(p, 1, 3, stdout);
      }
    }
  }
}
