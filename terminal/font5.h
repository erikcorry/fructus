// font5.h - the dense terminal's font: 128 codes of 5x8, ASCII's.
//
// terminal/gen-font5.mjs makes font5.cc from Spleentt 5x8 and says how.  A
// cell's base is its code: ASCII 0x20-0x7e, box drawing 0x01-0x0f - its
// arms - or FALLBACK.  FONT is one font row a line, 128 bytes each: line L
// of a cell shows FONT[128 L + code], and the line table's font_line for
// line L is 2 L.  A row's pixels are its low five bits, bit 0 leftmost.
#ifndef TERMINAL_FONT5_H
#define TERMINAL_FONT5_H

#include <stdint.h>

namespace terminal {

constexpr int LINES = 8;
constexpr uint8_t FALLBACK = 0x7f;      // an empty box, for what the font lacks

constexpr uint8_t UP = 1, DOWN = 2, LEFT = 4, RIGHT = 8;   // box drawing's arms

extern const uint8_t FONT[LINES * 128];
extern const uint8_t BOX[128];          // U+2500-U+257F's codes, 0 for ╱ ╲ ╳

}  // namespace terminal

#endif
