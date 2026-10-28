// font5.h - the dense terminal's font: 128 codes of 5x8, ASCII's.
//
// terminal/gen-font5.mjs makes font5.cc from Spleentt 5x8 and says how.  A
// cell's base is its code: ASCII 0x20-0x7e, or FALLBACK.  FONT is one font
// row a line, 128 bytes each: line L of a cell shows FONT[128 L + code], and
// the line table's font_line for line L is 2 L.  A row's pixels are its top
// five bits.
#ifndef TERMINAL_FONT5_H
#define TERMINAL_FONT5_H

#include <stdint.h>

namespace terminal {

constexpr int LINES = 8;
constexpr uint8_t FALLBACK = 0x7f;      // an empty box, for all but ASCII

extern const uint8_t FONT[LINES * 128];

}  // namespace terminal

#endif
