// bidi.cc - a row's cells in display order: see bidi.h.
#include "bidi.h"

namespace terminal {

namespace {

// The cell's entry in its set's table: its class and mirror flags.
uint8_t bidi_of(const Row &r, int c) {
  uint8_t mark = r.mark[c] & MARK, base = r.base[c];
  if (mark == BRAILLE) return BIDI_L;
  return mark == SECOND ? SECOND_BIDI[base] : mark == THIRD ? THIRD_BIDI[base] : BIDI_CLASS[base];
}

// The pair of a base as base_of gives it, or -1.
int pair_of(const Pair *table, int count, uint16_t from) {
  for (int i = 0; i < count; i++)
    if (table[i].from == from) return table[i].to;
  return -1;
}

uint16_t full_base(uint8_t base, uint8_t mark) {
  return mark == SECOND ? SECOND_SET | base : mark == THIRD ? THIRD_SET | base : base;
}

bool mirrors(const Row &r, int c) {
  uint8_t b = bidi_of(r, c);
  return b & BIDI_MIRRORED || (r.bidi & BIDI_BOX && b & BIDI_BOX_MIRRORED);
}

bool strong(uint8_t k) { return k == BIDI_L || k == BIDI_R; }

}  // namespace

uint8_t mirrored(uint8_t base, uint8_t mark) {
  uint16_t b = full_base(base, mark);
  int p = pair_of(MIRRORS, MIRROR_COUNT, b);
  if (p < 0) p = pair_of(BOX_MIRRORS, BOX_MIRROR_COUNT, b);
  return p < 0 ? base : (uint8_t) p;
}

bool bidi_order(const Row &r, uint8_t order[COLUMNS]) {
  bool rtl = r.bidi & BIDI_RTL;
  if (r.bidi & BIDI_EXPLICIT) {
    if (!rtl) return false;
    for (int v = 0; v < COLUMNS; v++) {
      int c = COLUMNS - 1 - v;
      order[v] = c | (mirrors(r, c) ? MIRROR : 0);
    }
    return true;
  }

  // The classes, the first strong letter, whether any is right to left,
  // and where the spaces at the end start.  MIRROR in level says the cell
  // has a pair, and the bits under it are its level.
  uint8_t k[COLUMNS], level[COLUMNS];
  uint8_t pairs = BIDI_MIRRORED | (r.bidi & BIDI_BOX ? BIDI_BOX_MIRRORED : 0);
  int first = -1, end = 0;
  bool any_r = false;
  for (int c = 0; c < COLUMNS; c++) {
    uint8_t b = bidi_of(r, c);
    k[c] = b & BIDI_CLASS_BITS;
    level[c] = b & pairs ? MIRROR : 0;
    any_r |= k[c] == BIDI_R;
    if (first < 0 && strong(k[c])) first = c;
    if (k[c] != BIDI_WS) end = c + 1;
  }
  if (r.bidi & BIDI_AUTO && first >= 0) rtl = k[first] == BIDI_R;
  if (!rtl && !any_r) return false;
  uint8_t edge = rtl ? BIDI_R : BIDI_L;   // sos and eos

  // W4: one separator between two numbers, ES or CS, is a number.
  for (int c = 1; c < COLUMNS - 1; c++)
    if ((k[c] == BIDI_ES || k[c] == BIDI_CS) && k[c - 1] == BIDI_EN && k[c + 1] == BIDI_EN) k[c] = BIDI_EN;
  // W5: terminators beside a number are part of it.
  for (int c = 0, e; c < COLUMNS; c = e) {
    for (e = c + 1; k[c] == BIDI_ET && e < COLUMNS && k[e] == BIDI_ET; e++) {}
    if (k[c] == BIDI_ET && ((c > 0 && k[c - 1] == BIDI_EN) || (e < COLUMNS && k[e] == BIDI_EN)))
      for (int i = c; i < e; i++) k[i] = BIDI_EN;
  }
  // W6, W7: the other separators and terminators are neutral; a number
  // after a left-to-right letter, or at the start of a left-to-right
  // paragraph, is left to right.
  uint8_t last = edge;
  for (int c = 0; c < COLUMNS; c++) {
    if (k[c] == BIDI_ES || k[c] == BIDI_ET || k[c] == BIDI_CS) k[c] = BIDI_ON;
    if (strong(k[c])) last = k[c];
    else if (k[c] == BIDI_EN && last == BIDI_L) k[c] = BIDI_L;
  }
  // N1, N2: a run of neutrals takes the direction both sides have, numbers
  // being right to left, or the paragraph's.
  for (int c = 0, e; c < COLUMNS; c = e) {
    e = c + 1;
    if (k[c] != BIDI_ON && k[c] != BIDI_WS) continue;
    while (e < COLUMNS && (k[e] == BIDI_ON || k[e] == BIDI_WS)) e++;
    uint8_t before = c > 0 ? (k[c - 1] == BIDI_L ? BIDI_L : BIDI_R) : edge;
    uint8_t after = e < COLUMNS ? (k[e] == BIDI_L ? BIDI_L : BIDI_R) : edge;
    for (int i = c; i < e; i++) k[i] = before == after ? before : edge;
  }
  // I1, I2, and L1: the spaces at the end at the paragraph's level.
  int high = 0;
  for (int c = 0; c < COLUMNS; c++) {
    int l = rtl ? (k[c] == BIDI_R ? 1 : 2) : (k[c] == BIDI_L ? 0 : k[c] == BIDI_R ? 1 : 2);
    level[c] |= l;
    if (l > high) high = l;
  }
  for (int c = end; c < COLUMNS; c++) level[c] = rtl;

  // L2: from the highest level down to 1, each run at it or higher turned
  // round.  Then L4.
  for (int c = 0; c < COLUMNS; c++) order[c] = c;
  for (int at = high; at >= 1; at--)
    for (int v = 0, e; v < COLUMNS; v = e) {
      e = v + 1;
      if ((level[order[v]] & ~MIRROR) < at) continue;
      while (e < COLUMNS && (level[order[e]] & ~MIRROR) >= at) e++;
      for (int i = v, j = e - 1; i < j; i++, j--) {
        uint8_t t = order[i];
        order[i] = order[j];
        order[j] = t;
      }
    }
  for (int v = 0; v < COLUMNS; v++)
    if ((level[order[v]] & (MIRROR | 1)) == (MIRROR | 1)) order[v] |= MIRROR;
  return true;
}

}  // namespace terminal
