// row.h - a text row as the frame buffer holds it.
//
// Each text row has six arrays of 80 bytes in the frame buffer, and the
// line table points each of its 17 lines at three of them:
//
//     code[EDGE] ... code[X_BOTTOM]   the character codes, one array a zone:
//                                     line L's pointer is code[ZONE_OF_LINE[L]]
//     fg                              every line's foreground colours
//     bg                              the background, 8 bits a pixel,
//                                     pixels 8 wide: one byte a cell
//
// The underline is in the font (font.h), so it needs no array of its own.
//
// draw_row fills them from a Row, its cells in bidi_order's order, and says
// where cell x shows, for the cursor.  The pointers are plain stores, so in
// WRITETHRU they may be the frame buffer's addresses.
#ifndef TERMINAL_ROW_H
#define TERMINAL_ROW_H

#include "font.h"
#include "terminal.h"

namespace terminal {

struct RowArrays {
  uint8_t *code[ZONES];
  uint8_t *fg, *bg;
};

int draw_row(const Row &r, const RowArrays &out, int x);

}  // namespace terminal

#endif
