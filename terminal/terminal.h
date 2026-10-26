// terminal.h - an ANSI terminal's screen, 80x28 cells, from UTF-8 bytes.
//
// THE FIRST STAGE of the VGA terminal in ideas/vt100.md: bytes in, cells out.
// No display here; what draws the cells into the frame buffer reads them.
// Plain C++ with nothing of the board, so it builds for the host too.
//
// A CELL IS 32 BITS:
//
//     base    8 bits   the character, its accent split off - é is e and
//                      U+0301 - as its code in the font, font.h
//     mark    7 bits   that accent, U+0300-U+036F as its code point less
//                      0x2ff, so 0 is none
//     under   1 bit    underlined, the mark byte's top bit
//     fg, bg  8 bits   each a colour in the display's 8-bit pixel format,
//                      reverse video and bold already applied
//
// kept as a row's four arrays: 320 bytes a row, 8,960 a screen.
// ideas/vt100.md had a 16-bit Unicode base; the font's 256 bases are a byte.
//
// DECOMPOSITION, terminal/gen-decompose.mjs's table: a precomposed Latin
// letter is its base and one mark, so the font needs only bases and accents.
// i is always a dotless ı and the dot, so an accent over an i replaces the
// dot, and ȷ likewise for j.  A letter with two marks, or none that splits,
// is a base of its own; a combining mark after a letter goes on its cell if
// the cell has none.  A character the font lacks is its FALLBACK, �, and
// wide ones - CJK, emoji - take two cells, the second a space, so the
// program that sent them agrees with us about the columns.
//
// SCROLLING MOVES NO CELLS.  line[y] is the row of rows[] shown at line y,
// and a scroll turns line[] round inside the region and clears what came in.
// The display can do the same with its line tables' pointers.
//
// WHAT IT UNDERSTANDS is xterm's, as much as vim, less and the shells use
// with TERM=xterm-256color:
//
//   C0     BS HT LF VT FF CR SO SI, and CAN SUB to abandon a sequence
//   ESC    7 8 D E H M c = >, ( ) with 0 or B, #8
//   CSI    @ A B C D E F G H I J K L M P S T X Z ` a b c d e f g h l m n r s u,
//          and ! p
//   modes  4 insert; ?6 origin, ?7 autowrap, ?25 cursor, ?47 ?1047 ?1049
//          the alternate screen
//   SGR    0 1 4 7 8 22 24 27 28, 30-37 39 40-47 49 90-97 100-107,
//          38/48 with 5;n or 2;r;g;b or their colon forms, 4:0-4:5 as
//          underline off or on; 58 and 59, the underline's colour, ignored:
//          it is the text's
//   OSC, DCS, PM, APC  read to their end and ignored
//
// Bold is a brighter colour: ideas/vt100.md keeps the brightest levels back
// for it.  Italic, dim, blink, double width and height are not shown.
#ifndef TERMINAL_TERMINAL_H
#define TERMINAL_TERMINAL_H

#include <stdint.h>

namespace terminal {

constexpr int COLUMNS = 80, ROWS = 28;
constexpr uint8_t MARK = 0x7f, UNDERLINE = 0x80;

struct Row {
  uint8_t base[COLUMNS];        // font.h's codes
  uint8_t mark[COLUMNS];        // MARK and UNDERLINE
  uint8_t fg[COLUMNS], bg[COLUMNS];
};

struct Screen {
  Row rows[ROWS];
  uint8_t line[ROWS];           // the row shown at each line
};

// The screen shown, primary or alternate, and the cursor on it.  Read only
// but for dirty and moved, which whoever draws the screen clears.
extern const Screen *screen;
extern uint8_t cursor_x, cursor_y;
extern bool cursor_shown;
extern uint32_t dirty;          // bit r: rows[r] changed
extern bool moved;              // line[] changed, or the screen did

// Everything to how it is at power on: both screens blank, the pen white on
// black, tab stops every 8.
void reset();

// One byte of what the host sends.
void put(uint8_t byte);

// The terminal's answers - the cursor's place, what kind of terminal it is -
// for the host.  The program defines it.
void send(const char *s);

// gen-decompose.mjs's tables, in decompose.cc.
struct Decomposition {
  uint16_t code;
  uint8_t base, mark;
};
extern const Decomposition DECOMPOSITIONS[];
extern const int DECOMPOSITION_COUNT;
extern const uint8_t MARK_BELOW[14];

}  // namespace terminal

#endif
