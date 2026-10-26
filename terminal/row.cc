// row.cc - a text row into its arrays: see row.h.
#include "row.h"

namespace terminal {

void draw_row(const Row &r, const RowArrays &out) {
  uint8_t codes[ZONES];
  for (int c = 0; c < COLUMNS; c++) {
    uint8_t mark = r.mark[c] & MARK;
    glyphs(r.base[c], mark, MARK_BELOW[mark >> 3] >> (mark & 7) & 1, codes);
    if (r.mark[c] & UNDERLINE) codes[EDGE] = UNDERLINED[codes[EDGE]];
    for (int z = 0; z < ZONES; z++) out.code[z][c] = codes[z];
    out.fg[c] = r.fg[c];
    out.bg[c] = r.bg[c];
  }
}

}  // namespace terminal
