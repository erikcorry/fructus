// bidi.h - a row's cells in the order the display shows them.
//
// terminal.h says which properties a row has and how it gets them.  A row
// in explicit mode shows its cells as they are, or right to left from the
// right edge if BIDI_RTL, every mirrored character mirrored.  One in
// implicit mode is the Unicode bidirectional algorithm's (UAX #9) paragraph,
// at level 1: no embeddings, overrides or isolates, which the terminal drops
// as zero width, and no Arabic.  Its direction is BIDI_RTL's, or with
// BIDI_AUTO its first strong letter's, and then
//
//   W4-W7   a separator between numbers joins them, + - , . / :, and an
//           ET - # $ % ° and the like - beside one is part of it; the rest
//           are neutral, and a number after a left-to-right letter is one
//   N1-N2   neutrals between two of a direction take it, numbers counting
//           as right to left, and otherwise the paragraph's
//   I1-I2   levels: 0 or 1 for the paragraph, a level up for the other
//           direction, and numbers two up from left-to-right paragraphs'
//   L1      the spaces at the end at the paragraph's level, so erased cells
//           are at its end, left of a right-to-left row's text
//   L2      each run from the highest level down to 1 reversed
//   L4      MIRRORS in right-to-left runs, odd levels, as their pairs, and
//           BOX_MIRRORS with BIDI_BOX
//
// A row with no right-to-left letter in a left-to-right paragraph is as it
// is, and bidi_order says so without the rest: by the marks alone, when no
// cell is from the third set, the only one with right-to-left letters.
#ifndef TERMINAL_BIDI_H
#define TERMINAL_BIDI_H

#include "font.h"
#include "terminal.h"

namespace terminal {

constexpr uint8_t MIRROR = 0x80;

// order[v] is the column of the cell shown at column v, | MIRROR if it
// shows as its pair.  False, and order untouched, if the row shows as it is.
bool bidi_order(const Row &r, uint8_t order[COLUMNS]);

// A cell's base shown mirrored: its pair's, in the same set.
uint8_t mirrored(uint8_t base, uint8_t mark);

}  // namespace terminal

#endif
