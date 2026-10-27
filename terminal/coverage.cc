// coverage.cc - what the terminal makes of each grapheme cluster, for
// terminal/coverage.mjs.
//
// A cluster a line in, UTF-8, each into a terminal just reset.  Out, a line
// each:
//
//     X B MARK SET DRAWN BASE
//
// X the cursor's column after it; B 'F' if the cell is the fallback, else
// 'b'; MARK the cell's mark, 0 for the second and third sets and Braille;
// SET 0, 1, 2 or 3 for the first, second, third or Braille; DRAWN 1 if the
// mark changes the glyph;
// BASE the cell's base.
#include <stdio.h>
#include <string.h>

#include "font.h"
#include "terminal.h"

using namespace terminal;

void terminal::send(const char *) {}

int main() {
  char line[256];
  while (fgets(line, sizeof line, stdin)) {
    line[strcspn(line, "\n")] = 0;
    reset();
    for (char *p = line; *p; p++) put((uint8_t) *p);
    const Row &r = screen->rows[screen->line[0]];
    uint8_t m = r.mark[0] & MARK, b = r.base[0];
    int set = m == SECOND ? 1 : m == THIRD ? 2 : m == BRAILLE ? 3 : 0;
    int drawn = 0;
    if (!set && m) {
      uint8_t with[ZONES], without[ZONES];
      glyphs(b, m, MARK_BELOW[m >> 3] >> (m & 7) & 1, with);
      glyphs(b, 0, false, without);
      drawn = memcmp(with, without, ZONES) != 0;
    }
    printf("%d %s %d %d %d %d\n", cursor_x, !set && b == FALLBACK ? "F" : "b", set ? 0 : m, set, drawn, b);
  }
}
