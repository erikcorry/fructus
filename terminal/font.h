// font.h - the terminal's font, and what a cell's base and mark show.
//
// terminal/gen-font.mjs makes font.cc from X11's 9x15 and says how; this is
// what the C side needs.
//
// A CELL IS 8x17 in five zones, each with its own array of codes in the
// frame buffer and its own 256 codes:
//
//     EDGE    lines 0-2 and 13-16: accents over capitals, descenders and the
//             accents below, the underline, the ends of box drawing
//     RISER   lines 3-5: capitals and ascenders above the x-height, and the
//             accents over small letters
//     X_TOP   lines 6-7: the top of the x-height
//     X_MIDDLE lines 8-9
//     X_BOTTOM lines 10-12: the rest, down to the baseline
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
// see glyphs().  TONOS, past them, is a Greek capital's: an acute that
// Unicode does not tell from Á's, drawn at the letter's top left: a tick in
// the riser beside it, or above it where a stem would meet the tick - Ά Έ Ή
// Ί Ό Ύ, from decompose.cc, by OVERRIDES.  The mark SECOND, past them, says the base is from the
// second set, SECOND_GLYPH: symbols and a few letters that take no accent.
// So a base is in all 9 bits, and base_of gives them as 0x100 | the base.
//
// THE UNDERLINE is in the font, on line 14 with a line's gap under the
// baseline, in the text's colour: an underlined cell's EDGE code is
// UNDERLINED[code].  It stops a pixel short of a descender either side.
#ifndef TERMINAL_FONT_H
#define TERMINAL_FONT_H

#include <stdint.h>

namespace terminal {

constexpr int LINES = 17, ZONES = 5, UNDERLINE_LINE = 14;
enum : uint8_t { EDGE, RISER, X_TOP, X_MIDDLE, X_BOTTOM };

constexpr uint8_t BLANK = 0x20;         // the blank slice, in every zone
constexpr uint8_t SECOND = 0x7f;        // the mark of the second set's bases
constexpr uint8_t TONOS = 0x7e;         // Greek capitals' accent, at their left
constexpr uint16_t SECOND_SET = 0x100;  // base_of's flag for them
constexpr uint8_t DOTLESS_I = 0x69;
extern const uint8_t DOTTED_I, DOTLESS_J, FALLBACK;  // i for į, ȷ, and �

extern const uint8_t FONT[LINES * 256];
extern const uint8_t ZONE_OF_LINE[LINES];
extern const uint8_t GLYPH[ZONES][256];
extern const uint8_t MARK_GLYPH[2][TONOS + 1];   // EDGE and RISER, BLANK for none
extern const uint8_t UNDERLINED[256];      // an EDGE code underlined
extern const uint8_t SECOND_GLYPH[][ZONES];
extern const int SECOND_COUNT;

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
  uint16_t base;                        // SECOND_SET | base for the second set
};
extern const Unicode UNICODE[];
extern const int UNICODE_COUNT;

// Code points drawn as another's base - ʼ as ’, − as - - sorted likewise.
extern const Unicode ALIASES[];
extern const int ALIAS_COUNT;

// The base for a code point, SECOND_SET | base for the second set, FALLBACK
// if the font has none.
uint16_t base_of(uint32_t c);

// The codes a cell puts in each zone.  A mark goes in the first of its two
// zones that the base leaves blank - the riser and then over the capitals
// for one above, under the baseline and then the riser for one below, which
// only the cedilla has: ģ's turned comma - and is dropped if neither is.
// below says which the mark is: terminal.h's MARK_BELOW.
inline void glyphs(uint8_t base, uint8_t mark, bool below, uint8_t out[ZONES]) {
  if (mark == SECOND) {
    for (int z = 0; z < ZONES; z++) out[z] = SECOND_GLYPH[base][z];
    return;
  }
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
