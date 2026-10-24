// screen.h - a teletext page on the display: the fixed layout, and a row drawn.
//
// THE BUFFER, as the processor addresses it in WRITETHRU (docs/vga.md):
//
//     0x8000 - 0xcbff   the font, teletext/font.cc: .font is linked here, so
//                       setup copies it with p[i] = p[i]
//     0xcc00            the character codes, 25 rows of 40
//     0xd000            the foreground colours, 25 rows of 40
//     0xd400            the background: 5 lines of 40 bytes a row
//     0xe800            40 bytes of zeros, the background of the lines
//                       outside the page
//     0xf000 - 0xffff   the line tables
//
// THE ROWS ARE 19 LINES, from line TOP: 475 of the 480.  Each line's
// pointers are fixed - its row's codes and colours, and one of the row's 5
// background lines - and so is its mode word but for the font line, which
// draw_row writes: font rows 0-18 for an upper row, 19-37 for the lower row
// of double height.
//
// THE BACKGROUND IS THE MOSAICS.  4 bits a pixel, 8 columns wide: two pixels
// a cell, low nibble left, palette entries 0-15.  A mosaic's block rows are
// lines 0-5, 6-12 and 13-18 of a row; double height's are 0-11 and 12-18 of
// the upper row and 0-6 and 7-18 of the lower.  So each row's lines fall in
// five bands, cut at 6, 7, 12 and 13, and a band has a background line of
// its own.  A mosaic cell's glyph is a space, or with separated graphics the
// grid, 0xe0 or 0xe1, in the background colour over the blocks.
//
// THE PALETTE: 0-7 black, red, green, yellow, blue, magenta, cyan, white;
// 8-15 the same, flashing.  A flashing colour is entry 8 + c, and
// set_flash(false) shows those black for the off phase.
#ifndef TELETEXT_SCREEN_H
#define TELETEXT_SCREEN_H

#include <stdint.h>

namespace teletext {

constexpr int TOP = 2;                  // the page's first line
constexpr int LINES_PER_ROW = 19;

// The palette, and the font register.  The registers are not in a buffer,
// so once.
void setup_display();

// The fixed part of the buffer not shown: font, line tables, blank page.
// Call in WRITETHRU, after display_sync: until the mode has taken effect, a
// store above 0x8000 is to the processor's own code.
void setup_buffer();

// Row 0-24 from its 40 bytes, into the buffer not shown.  bottom: this is the
// lower row of double height, showing the bottom halves of its own double
// height characters and nothing of its single height ones.  Returns whether
// the row has double height, so the next row is its lower one.
bool draw_row(int row, const uint8_t *text, bool bottom);

// Every row, the lower rows of double height worked out on the way.
void draw_page(const uint8_t (*text)[40]);

// Flashing colours on or off.  Palette writes show at once: call it in the
// vertical blank.
void set_flash(bool on);

}  // namespace teletext

#endif
