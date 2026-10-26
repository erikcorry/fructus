// row.h - a text row as the frame buffer holds it.
//
// Each text row has six arrays of 80 bytes in the frame buffer, and the line
// table points each of its 17 lines at three of them:
//
//     code[EDGE], code[RISER], code[X]   the character codes: line L's
//                                        pointer is code[ZONE_OF_LINE[L]]
//     fg                                 every line's foreground colours
//     bg                                 the background, 8 bits a pixel,
//                                        pixels 8 wide: one byte a cell
//     under                              line 13's background: an underlined
//                                        cell's foreground, so the line is
//                                        drawn whole in it
//
// draw_row fills them from a Row.  The pointers are plain stores, so in
// WRITETHRU they may be the frame buffer's addresses.
#ifndef TERMINAL_ROW_H
#define TERMINAL_ROW_H

#include "font.h"
#include "terminal.h"

namespace terminal {

constexpr int UNDERLINE_LINE = 13;

struct RowArrays {
  uint8_t *code[ZONES];
  uint8_t *fg, *bg, *under;
};

void draw_row(const Row &r, const RowArrays &out);

}  // namespace terminal

#endif
