// row.cc - a text row into its arrays: see row.h.
#include "row.h"

#include "bidi.h"

namespace terminal {

int draw_row(const Row &r, const RowArrays &out, int x) {
  uint8_t order[COLUMNS], codes[ZONES];
  bool reordered = bidi_order(r, order);
  int at = x;
  for (int v = 0; v < COLUMNS; v++) {
    int c = reordered ? order[v] & ~MIRROR : v;
    if (c == x) at = v;
    uint8_t mark = r.mark[c] & MARK, base = r.base[c];
    if (reordered && order[v] & MIRROR) base = mirrored(base, mark);
    glyphs(base, mark, MARK_BELOW[mark >> 3] >> (mark & 7) & 1, codes);
    if (r.mark[c] & UNDERLINE) codes[EDGE] = UNDERLINED[codes[EDGE]];
    for (int z = 0; z < ZONES; z++) out.code[z][v] = codes[z];
    out.fg[v] = r.fg[c];
    out.bg[v] = r.bg[c];
  }
  return at;
}

}  // namespace terminal
