// font.h - the terminal's font, and what a cell's base and mark show.
//
// terminal/gen-font.mjs makes font.cc from X11's 9x15 and says how; this is
// what the C side needs.
//
// A CELL IS 8x17 in three zones, each with its own array of codes in the
// frame buffer and its own 256 codes:
//
//     EDGE    lines 0-2 and 13-16: accents over capitals, descenders and the
//             accents below, the ends of box drawing
//     RISER   lines 3-5: capitals and ascenders above the x-height, and the
//             accents over small letters
//     X       lines 6-12: the x-height
//
// FONT is one font row a line, 256 bytes each: line L of a cell shows
// FONT[256 L + code], code from the zone ZONE_OF_LINE[L]'s array.  So the
// line table's font_line for line L is 4 L.
//
// A BASE is a byte: ASCII for 0x20-0x7e, but 0x69 is a dotless ı - i is ı
// and a dot above - and the rest as gen-font.mjs's REPERTOIRE assigns them,
// which base_of finds from Unicode.  GLYPH[zone][base] is its code in each
// zone.
//
// A MARK, U+0300-U+036F less 0x2ff as the cell keeps it, changes one zone,
// see glyphs().
#ifndef TERMINAL_FONT_H
#define TERMINAL_FONT_H

#include <stdint.h>

namespace terminal {

constexpr int LINES = 17, ZONES = 3;
enum : uint8_t { EDGE, RISER, X };

constexpr uint8_t BLANK = 0x20;         // the blank slice, in every zone
constexpr uint8_t DOTLESS_I = 0x69;
extern const uint8_t DOTTED_I, DOTLESS_J, FALLBACK;  // i for į, ȷ, and �

extern const uint8_t FONT[LINES * 256];
extern const uint8_t ZONE_OF_LINE[LINES];
extern const uint8_t GLYPH[ZONES][256];
extern const uint8_t MARK_GLYPH[2][113];   // EDGE and RISER, BLANK for none

// The pairs whose letter has ink where the mark goes: a code of their own
// in each zone that differs.  Sorted by base and mark.
struct Override {
  uint8_t base, mark, zone, code;
};
extern const Override OVERRIDES[];
extern const int OVERRIDE_COUNT;

// The bases that are not their own ASCII code, sorted by code point.
struct Unicode {
  uint16_t code;
  uint8_t base;
};
extern const Unicode UNICODE[];
extern const int UNICODE_COUNT;

// The base for a code point, FALLBACK if the font has none.
uint8_t base_of(uint32_t c);

// The codes a cell puts in each zone.  A mark goes in the first of its two
// zones that the base leaves blank - the riser and then over the capitals
// for one above, under the baseline and then the riser for one below, which
// only the cedilla has: ģ's turned comma - and is dropped if neither is.
// below says which the mark is: terminal.h's MARK_BELOW.
inline void glyphs(uint8_t base, uint8_t mark, bool below, uint8_t out[ZONES]) {
  for (int z = 0; z < ZONES; z++) out[z] = GLYPH[z][base];
  if (!mark) return;
  bool overridden = false;
  for (int i = 0; i < OVERRIDE_COUNT; i++)
    if (OVERRIDES[i].base == base && OVERRIDES[i].mark == mark) {
      out[OVERRIDES[i].zone] = OVERRIDES[i].code;
      overridden = true;
    }
  if (overridden) return;
  uint8_t first = below ? EDGE : RISER, second = below ? RISER : EDGE;
  if (out[first] == BLANK && MARK_GLYPH[first][mark] != BLANK) out[first] = MARK_GLYPH[first][mark];
  else if (out[second] == BLANK) out[second] = MARK_GLYPH[second][mark];
}

}  // namespace terminal

#endif
