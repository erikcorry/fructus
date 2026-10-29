// row.cc - a text row into its arrays: see row.h.
#include "row.h"

#include "bidi.h"

namespace terminal {

namespace {

// Cell c, shown at v, as glyphs() makes it: its mark, its set, its
// underline, mirrored if it shows as its pair.
void special(const Row &r, const RowArrays &out, int v, int c, bool mirror) {
  uint8_t codes[ZONES];
  uint8_t mark = r.mark[c] & MARK, base = r.base[c];
  if (mirror) base = mirrored(base, mark);
  glyphs(base, mark, MARK_BELOW[mark >> 3] >> (mark & 7) & 1, codes);
  if (r.mark[c] & UNDERLINE) codes[EDGE] = UNDERLINED[codes[EDGE]];
  for (int z = 0; z < ZONES; z++) out.code[z][v] = codes[z];
}

}  // namespace

// Every cell is drawn as its base alone first, a zone at a time, so that each
// loop has one array to write: a store through a uint8_t * may be to
// anything, and with six arrays to write at once their pointers were loaded
// again after every store.  Then the cells that are more than their base.
// A row shown as it is has loops of its own, with no order to look up.
int draw_row(const Row &r, const RowArrays &out, int x) {
  uint8_t order[COLUMNS];
  if (!bidi_order(r, order)) {
    for (int z = 0; z < ZONES; z++) {
      const uint8_t *glyph = GLYPH[z];
      uint8_t *code = out.code[z];
      for (int v = 0; v < COLUMNS; v++) code[v] = glyph[r.base[v]];
    }
    for (int v = 0; v < COLUMNS; v++) out.fg[v] = r.fg[v];
    for (int v = 0; v < COLUMNS; v++) out.bg[v] = r.bg[v];
    for (int v = 0; v < COLUMNS; v++)
      if (r.mark[v]) special(r, out, v, v, false);
    return x;
  }

  for (int z = 0; z < ZONES; z++) {
    const uint8_t *glyph = GLYPH[z];
    uint8_t *code = out.code[z];
    for (int v = 0; v < COLUMNS; v++) code[v] = glyph[r.base[order[v] & ~MIRROR]];
  }
  for (int v = 0; v < COLUMNS; v++) out.fg[v] = r.fg[order[v] & ~MIRROR];
  for (int v = 0; v < COLUMNS; v++) out.bg[v] = r.bg[order[v] & ~MIRROR];
  int at = x;
  for (int v = 0; v < COLUMNS; v++) {
    int c = order[v] & ~MIRROR;
    if (c == x) at = v;
    if (r.mark[c] || order[v] & MIRROR) special(r, out, v, c, order[v] & MIRROR);
  }
  return at;
}

}  // namespace terminal
