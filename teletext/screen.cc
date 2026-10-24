// screen.cc - a teletext page on the display: see screen.h.
#include "screen.h"

#include <fructus/display.h>

extern "C" const uint16_t teletext_font[38 * 256];

namespace teletext {

namespace {

// The buffer, as the processor stores to it.  Plain pointers: nothing here
// reads them back, which in WRITETHRU would read the code beneath.
uint8_t *const CODES = (uint8_t *) 0xcc00;
uint8_t *const COLOURS = (uint8_t *) 0xd000;
uint8_t *const BACKGROUND = (uint8_t *) 0xd400;
uint8_t *const BLANK = (uint8_t *) 0xe800;
constexpr int BANDS = 5;

constexpr uint16_t MODE = DISPLAY_4BPP | DISPLAY_WIDTH(8) | DISPLAY_WIDE_FONT;
constexpr uint8_t SPACE = 0x20, GRID = 0xe0, GRID_DOUBLE = 0xe1, DOUBLE = 0x60;

// The band each line of a row is in, cut at 6, 7, 12 and 13.
constexpr uint8_t band(int line) {
  return line < 6 ? 0 : line < 7 ? 1 : line < 12 ? 2 : line < 13 ? 3 : 4;
}

// The mosaic block row each band shows: single height, the upper row of
// double height, the lower row.
constexpr uint8_t BLOCK_ROW[3][BANDS] = {
  { 0, 1, 1, 1, 2 },
  { 0, 0, 0, 1, 1 },
  { 1, 1, 2, 2, 2 },
};

constexpr uint8_t COLOURS_RGB[8] = {
  DISPLAY_RGB(0, 0, 0), DISPLAY_RGB(5, 0, 0), DISPLAY_RGB(0, 6, 0), DISPLAY_RGB(5, 6, 0),
  DISPLAY_RGB(0, 0, 4), DISPLAY_RGB(5, 0, 4), DISPLAY_RGB(0, 6, 4), DISPLAY_RGB(5, 6, 4),
};

uint16_t *line_mode(int line) { return DISPLAY_LINEMODE + line; }

bool flashes;   // draw_row saw a flashing cell, for draw_page

}  // namespace

void setup_display() {
  DISPLAY_FONT = (uint16_t) (uintptr_t) teletext_font;
  display_set_palette(0, COLOURS_RGB, 8);
}

void setup_buffer() {
  // The font, from the processor's copy at the same address.  volatile, or
  // the compiler drops a store of what is already there.
  volatile uint16_t *font = (volatile uint16_t *) teletext_font;
  for (int i = 0; i < 38 * 256; i++) font[i] = teletext_font[i];

  for (int i = 0; i < 40; i++) BLANK[i] = 0;
  for (int line = 0; line < 512; line++) {
    int row = (line - TOP) / LINES_PER_ROW, l = (line - TOP) % LINES_PER_ROW;
    if (line < TOP || row >= 25) {
      DISPLAY_CHARS[line] = (uint16_t) (uintptr_t) BLANK;
      DISPLAY_COLOURS[line] = (uint16_t) (uintptr_t) BLANK;
      DISPLAY_BACKGROUND[line] = (uint16_t) (uintptr_t) BLANK;
      *line_mode(line) = MODE | DISPLAY_NO_TEXT;
    } else {
      DISPLAY_CHARS[line] = (uint16_t) (uintptr_t) (CODES + 40 * row);
      DISPLAY_COLOURS[line] = (uint16_t) (uintptr_t) (COLOURS + 40 * row);
      DISPLAY_BACKGROUND[line] = (uint16_t) (uintptr_t) (BACKGROUND + 40 * (BANDS * row + band(l)));
      *line_mode(line) = MODE | DISPLAY_FONT_LINE(4 * l);
    }
  }
  static const uint8_t spaces[40] = {};
  for (int row = 0; row < 25; row++) draw_row(row, spaces, false, true);
}

bool draw_row(int row, const uint8_t *text, bool bottom, bool flash_on) {
  uint8_t *codes = CODES + 40 * row, *colours = COLOURS + 40 * row;
  uint8_t *background = BACKGROUND + 40 * BANDS * row;

  // The font line of each of the row's lines: its upper or lower half.
  uint8_t *mode = (uint8_t *) line_mode(TOP + LINES_PER_ROW * row);
  for (int l = 0; l < LINES_PER_ROW; l++) mode[2 * l] = 4 * (l + (bottom ? LINES_PER_ROW : 0));

  // The SAA5050's state across the row, from its defaults.
  uint8_t fg = 7, bg = 0;
  bool mosaic = false, separated = false, flash = false, conceal = false;
  bool double_height = false, hold = false, any_double = false;
  uint8_t held = SPACE;
  bool held_separated = false;

  for (int c = 0; c < 40; c++) {
    uint8_t b = text[c] & 0x7f;

    // Set-at: these take effect in their own cell.
    switch (b) {
    case 0x09: flash = false; break;
    case 0x0c: if (double_height) { double_height = false; held = SPACE; } break;
    case 0x18: conceal = true; break;
    case 0x19: separated = false; break;
    case 0x1a: separated = true; break;
    case 0x1c: bg = 0; break;
    case 0x1d: bg = fg; break;
    case 0x1e: hold = true; break;
    }

    // What the cell shows: a control code is a space, or the held mosaic.
    uint8_t shown = b;
    bool sep = separated;
    if (b < 0x20) {
      shown = hold && mosaic ? held : SPACE;
      sep = held_separated;
    }
    bool graphic = mosaic && (shown & 0x20);       // 0x20-0x3f, 0x60-0x7f
    if (graphic) {
      held = shown;
      held_separated = sep;
    }
    if (graphic || shown != SPACE) flashes |= flash;
    if (conceal || (bottom && !double_height) || (flash && !flash_on))
      shown = SPACE, graphic = false;

    uint8_t ink = fg;
    uint8_t paper = bg | bg << 4;
    if (!graphic) {
      codes[c] = double_height && shown != SPACE ? shown + DOUBLE : shown;
      colours[c] = ink;
      for (int k = 0; k < BANDS; k++) background[40 * k + c] = paper;
    } else {
      uint8_t blocks = (shown & 0x1f) | (shown & 0x40) >> 1;
      uint8_t pair[3];
      for (int r = 0; r < 3; r++)
        pair[r] = (blocks & 1 << 2 * r ? ink : bg) | (blocks & 2 << 2 * r ? ink : bg) << 4;
      const uint8_t *rows = BLOCK_ROW[double_height ? 1 + bottom : 0];
      codes[c] = sep ? (double_height ? GRID_DOUBLE : GRID) : SPACE;
      colours[c] = bg;
      for (int k = 0; k < BANDS; k++) background[40 * k + c] = pair[rows[k]];
    }

    // Set-after: from the next cell.
    if (b >= 0x01 && b <= 0x07) {
      fg = b;
      if (mosaic) held = SPACE;
      mosaic = conceal = false;
    } else if (b >= 0x11 && b <= 0x17) {
      fg = b - 0x10;
      if (!mosaic) held = SPACE;
      mosaic = true;
      conceal = false;
    } else if (b == 0x08) {
      flash = true;
    } else if (b == 0x0d) {
      if (!double_height) held = SPACE;
      double_height = any_double = true;
    } else if (b == 0x1f) {
      hold = false;
    }
  }
  return any_double;
}

bool draw_page(const uint8_t (*text)[40], bool flash_on) {
  flashes = false;
  bool bottom = false;
  for (int row = 0; row < 25; row++) bottom = draw_row(row, text[row], bottom, flash_on) && !bottom;
  return flashes;
}

}  // namespace teletext
