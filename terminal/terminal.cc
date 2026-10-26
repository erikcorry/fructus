// terminal.cc - bytes to cells: see terminal.h.
#include "terminal.h"

#include "font.h"

namespace terminal {

const Screen *screen;
uint8_t cursor_x, cursor_y;
bool cursor_shown;
uint32_t dirty;
bool moved;

namespace {

constexpr uint32_t ALL_ROWS = ((uint32_t) 1 << ROWS) - 1;
constexpr uint8_t DOT = 0x307 - 0x2ff;

// --- colours ------------------------------------------------------------------

// The display's 8-bit pixel format, as fructus/display.h's DISPLAY_RGB and
// DISPLAY_RGB888 make it: red 0-5, green 0-6, blue 0-4, or 0-255 each.
constexpr uint8_t rgb(unsigned r, unsigned g, unsigned b) {
  return (uint8_t) ((g + 1) << 5 | (((21 * r + 1) >> 2) + b));
}
constexpr uint8_t rgb888(unsigned r, unsigned g, unsigned b) {
  return rgb((r * 6) >> 8, (g * 7) >> 8, (b * 5) >> 8);
}

// The 16 colours are the Linux console's, the VGA's: 170 for the first 8,
// the brightest levels kept for the second 8, and so for bold.
constexpr uint8_t ANSI[16] = {
  rgb888(0, 0, 0), rgb888(170, 0, 0), rgb888(0, 170, 0), rgb888(170, 85, 0),
  rgb888(0, 0, 170), rgb888(170, 0, 170), rgb888(0, 170, 170), rgb888(170, 170, 170),
  rgb888(85, 85, 85), rgb888(255, 85, 85), rgb888(85, 255, 85), rgb888(255, 255, 85),
  rgb888(85, 85, 255), rgb888(255, 85, 255), rgb888(85, 255, 255), rgb888(255, 255, 255),
};

// A colour as SGR set it: 0-255 xterm's indexed colours, DEFAULT, or
// DIRECT and a pixel byte from 38;2;r;g;b.
constexpr uint16_t DEFAULT = 0x100, DIRECT = 0x200;
constexpr uint8_t BOLD = 1, UNDER = 2, REVERSE = 4, HIDDEN = 8;

struct Pen {
  uint16_t fg, bg;
  uint8_t flags;
};

// xterm's 6x6x6 cube, 16-231, and its 24 greys, 232-255.
constexpr uint8_t level(unsigned c) { return c ? 55 + 40 * c : 0; }

uint8_t colour(uint16_t c, bool bold, uint8_t otherwise) {
  if (c == DEFAULT) return otherwise;
  if (c & DIRECT) return (uint8_t) c;
  if (c < 8 && bold) c += 8;
  if (c < 16) return ANSI[c];
  if (c >= 232) {
    unsigned v = 8 + 10 * (c - 232);
    return rgb888(v, v, v);
  }
  c -= 16;
  return rgb888(level(c / 36), level(c / 6 % 6), level(c % 6));
}

// --- what is not one cell -----------------------------------------------------

struct Range {
  uint32_t first, last;
};

// East Asian Wide and Fullwidth, coarsely, and the emoji blocks.
constexpr Range WIDE[] = {
  { 0x1100, 0x115f }, { 0x2e80, 0x303e }, { 0x3041, 0x33ff }, { 0x3400, 0x4dbf },
  { 0x4e00, 0x9fff }, { 0xa000, 0xa4cf }, { 0xac00, 0xd7a3 }, { 0xf900, 0xfaff },
  { 0xfe30, 0xfe4f }, { 0xff00, 0xff60 }, { 0xffe0, 0xffe6 }, { 0x1f300, 0x1f64f },
  { 0x1f680, 0x1f6ff }, { 0x1f900, 0x1f9ff }, { 0x20000, 0x3fffd },
};

// Zero width: the joiners and marks, variation selectors and tags, and the
// combining blocks other than U+0300-U+036F, whose marks are dropped.
constexpr Range ZERO_WIDTH[] = {
  { 0x1ab0, 0x1aff }, { 0x1dc0, 0x1dff }, { 0x200b, 0x200f }, { 0x2028, 0x202e },
  { 0x2060, 0x2064 }, { 0x20d0, 0x20ff }, { 0xfe00, 0xfe0f }, { 0xfe20, 0xfe2f },
  { 0xfeff, 0xfeff }, { 0xe0000, 0xe01ef },
};

template <int N>
bool in(uint32_t c, const Range (&ranges)[N]) {
  for (const Range &r : ranges)
    if (c >= r.first && c <= r.last) return true;
  return false;
}

// The DEC special graphics set, ESC ( 0, for 0x5f-0x7e: the line drawing.
constexpr uint16_t GRAPHICS[32] = {
  0x0020, 0x25c6, 0x2592, 0x2409, 0x240c, 0x240d, 0x240a, 0x00b0,
  0x00b1, 0x2424, 0x240b, 0x2518, 0x2510, 0x250c, 0x2514, 0x253c,
  0x23ba, 0x23bb, 0x2500, 0x23bc, 0x23bd, 0x251c, 0x2524, 0x2534,
  0x252c, 0x2502, 0x2264, 0x2265, 0x03c0, 0x2260, 0x00a3, 0x00b7,
};

bool below(uint8_t mark) { return MARK_BELOW[mark >> 3] >> (mark & 7) & 1; }

// i and j under an accent above lose their dots: as code points, and as
// bases.
uint32_t dotless(uint32_t c) { return c == 'i' ? 0x131 : c == 'j' ? 0x237 : c; }
uint8_t dotless_base(uint8_t base) {
  return base == DOTTED_I ? DOTLESS_I : base == 'j' ? DOTLESS_J : base;
}

// c as a base's code point, and in mark its accent or 0.
uint32_t decompose(uint32_t c, uint8_t &mark) {
  mark = 0;
  if (c == 'i') {
    mark = DOT;
    return 0x131;
  }
  if (c < DECOMPOSITIONS[0].code || c > DECOMPOSITIONS[DECOMPOSITION_COUNT - 1].code) return c;
  int lo = 0, hi = DECOMPOSITION_COUNT - 1;
  while (lo <= hi) {
    int mid = (lo + hi) / 2;
    const Decomposition &d = DECOMPOSITIONS[mid];
    if (d.code == c) {
      mark = d.mark;
      return mark && !below(mark) ? dotless(d.base) : d.base;
    }
    if (d.code < c) lo = mid + 1;
    else hi = mid - 1;
  }
  return c;
}

// --- the state ----------------------------------------------------------------

Screen screens[2];
Screen *s = &screens[0];

Pen pen;
uint8_t ink, paper, under, erase_bg;    // the pen as cells take it

uint8_t x, y;
bool pending;                           // a character in the last column: the
                                        // next one wraps first
uint8_t top, bottom;                    // the scrolling region, inclusive
bool origin, autowrap, insert;
uint8_t charset[2], shift;              // G0 and G1: 1 for line drawing
uint8_t tabs[COLUMNS / 8];
uint32_t last;                          // the last character printed, for REP

struct Saved {
  uint8_t x, y;
  bool pending, origin;
  Pen pen;
  uint8_t charset[2], shift;
};
Saved saved[2];                         // DECSC's, one for each screen

enum : uint8_t { GROUND, ESCAPE, ESCAPE_INTER, CSI, STRING };
uint8_t state, inter, priv;
constexpr int MAX_PARAMS = 16;
uint16_t params[MAX_PARAMS];
uint8_t param;                          // the one being read
uint16_t sub;                           // bit i: params[i] came after a colon

uint32_t code;                          // UTF-8: the code point so far, and
uint8_t need;                           // the bytes still to come

// --- cells --------------------------------------------------------------------

Row &row(int line) { return s->rows[s->line[line]]; }
void touch(int line) { dirty |= (uint32_t) 1 << s->line[line]; }

void resolve() {
  bool bold = pen.flags & BOLD;
  uint8_t f = colour(pen.fg, bold, ANSI[bold ? 15 : 7]), b = colour(pen.bg, false, ANSI[0]);
  erase_bg = b;
  if (pen.flags & REVERSE) {
    uint8_t t = f;
    f = b;
    b = t;
  }
  ink = pen.flags & HIDDEN ? b : f;
  paper = b;
  under = pen.flags & UNDER ? UNDERLINE : 0;
}

// Columns from to to - 1 of a line blank, in the pen's background, as
// xterm's erasures are.
void erase(int line, int from, int to) {
  Row &r = row(line);
  for (int i = from; i < to; i++) {
    r.base[i] = ' ';
    r.mark[i] = 0;
    r.fg[i] = ANSI[7];
    r.bg[i] = erase_bg;
  }
  touch(line);
}

void erase_lines(int from, int to) {
  for (int l = from; l < to; l++) erase(l, 0, COLUMNS);
}

// Lines first to last, n times by one: up, the top line going round to the
// bottom and blanked, or down.
void scroll(int first, int last, int n, bool up) {
  uint8_t *l = s->line;
  if (n > last - first + 1) n = last - first + 1;
  while (n-- > 0) {
    if (up) {
      uint8_t r = l[first];
      for (int i = first; i < last; i++) l[i] = l[i + 1];
      l[last] = r;
      erase(last, 0, COLUMNS);
    } else {
      uint8_t r = l[last];
      for (int i = last; i > first; i--) l[i] = l[i - 1];
      l[first] = r;
      erase(first, 0, COLUMNS);
    }
  }
  moved = true;
}

// Columns from on of the cursor's line along by n, right or left, the cells
// left behind blank.
void slide(int from, int n, bool right) {
  Row &r = row(y);
  int keep = COLUMNS - from - n;
  if (keep < 0) keep = 0, n = COLUMNS - from;
  for (int k = 0; k < keep; k++) {
    int to = right ? COLUMNS - 1 - k : from + k, at = right ? to - n : to + n;
    r.base[to] = r.base[at];
    r.mark[to] = r.mark[at];
    r.fg[to] = r.fg[at];
    r.bg[to] = r.bg[at];
  }
  if (right) erase(y, from, from + n);
  else erase(y, COLUMNS - n, COLUMNS);
}

// --- the cursor ---------------------------------------------------------------

int clamp(int v, int lo, int hi) { return v < lo ? lo : v > hi ? hi : v; }

void go(int nx, int ny, int lo, int hi) {
  x = clamp(nx, 0, COLUMNS - 1);
  y = clamp(ny, lo, hi);
  pending = false;
}

// To a place counted from the region's top in origin mode.
void place(int nx, int ny) {
  if (origin) go(nx, top + ny, top, bottom);
  else go(nx, ny, 0, ROWS - 1);
}

void index() {
  pending = false;
  if (y == bottom) scroll(top, bottom, 1, true);
  else if (y < ROWS - 1) y++;
}

void reverse_index() {
  pending = false;
  if (y == top) scroll(top, bottom, 1, false);
  else if (y > 0) y--;
}

bool tab(int col) { return tabs[col >> 3] >> (col & 7) & 1; }

void tab_forward() {
  while (x < COLUMNS - 1 && !tab(++x)) {}
  pending = false;
}

void tab_back() {
  while (x > 0 && !tab(--x)) {}
  pending = false;
}

void save() {
  Saved &v = saved[s - screens];
  v.x = x, v.y = y, v.pending = pending, v.origin = origin, v.pen = pen;
  v.charset[0] = charset[0], v.charset[1] = charset[1], v.shift = shift;
}

void restore() {
  const Saved &v = saved[s - screens];
  x = v.x, y = v.y, pending = v.pending, origin = v.origin, pen = v.pen;
  charset[0] = v.charset[0], charset[1] = v.charset[1], shift = v.shift;
  resolve();
}

// --- characters ---------------------------------------------------------------

void cell(int col, uint8_t base, uint8_t mark) {
  Row &r = row(y);
  r.base[col] = base;
  r.mark[col] = mark | under;
  r.fg[col] = ink;
  r.bg[col] = paper;
  touch(y);
}

// A combining mark onto the cell before the cursor: in its place if the
// cell's only accent is ı's dot, else only if it has none.
void combine(uint32_t c) {
  if (!pending && x == 0) return;
  int col = pending ? x : x - 1;
  Row &r = row(y);
  uint8_t m = c - 0x2ff, had = r.mark[col] & MARK;
  uint8_t &base = r.base[col];
  if (base == DOTLESS_I && had == DOT) {
    if (below(m)) base = DOTTED_I;
    had = 0;
  }
  if (had) return;
  if (!below(m)) base = dotless_base(base);
  r.mark[col] = (r.mark[col] & UNDERLINE) | m;
  touch(y);
}

void print(uint32_t c) {
  if (charset[shift] && c >= 0x5f && c <= 0x7e) c = GRAPHICS[c - 0x5f];
  if (c >= 0x300 && c <= 0x36f) return combine(c);
  if (in(c, ZERO_WIDTH)) return;
  int width = in(c, WIDE) ? 2 : 1;
  uint8_t mark = 0;
  uint8_t base = width == 2 || c > 0xffff ? FALLBACK : base_of(decompose(c, mark));

  if (pending) {
    x = 0;
    index();
  }
  if (x + width > COLUMNS) {
    if (autowrap) {
      erase(y, x, COLUMNS);
      x = 0;
      index();
    } else {
      x = COLUMNS - width;
    }
  }
  if (insert) slide(x, width, true);
  cell(x, base, mark);
  if (width == 2) cell(x + 1, ' ', 0);
  x += width;
  if (x >= COLUMNS) {
    x = COLUMNS - 1;
    pending = autowrap;
  }
  last = c;
}

// --- sequences ----------------------------------------------------------------

char *decimal(char *p, unsigned v) {
  if (v >= 10) p = decimal(p, v / 10);
  *p++ = '0' + v % 10;
  return p;
}

void report_cursor() {
  char b[16] = "\033[", *p = decimal(b + 2, y + 1 - (origin ? top : 0));
  *p++ = ';';
  p = decimal(p, x + 1);
  *p++ = 'R';
  *p = 0;
  send(b);
}

void alternate(bool on, bool keep_cursor) {
  if ((s == &screens[1]) == on) return;
  if (on && keep_cursor) save();
  s = &screens[on];
  screen = s;
  if (on) erase_lines(0, ROWS);
  else if (keep_cursor) restore();
  dirty = ALL_ROWS;
  moved = true;
}

void set_mode(unsigned m, bool on) {
  switch (m) {
  case 6: origin = on; place(0, 0); break;
  case 7: autowrap = on; if (!on) pending = false; break;
  case 25: cursor_shown = on; break;
  case 47: case 1047: alternate(on, false); break;
  case 1049: alternate(on, true); break;
  }
}

// The colour in the n parameters after 38, 48 or 58 at i: 5 and an index,
// or 2 and red, green and blue - with a colour space's id between in the
// colon form, 2::r:g:b, so the last three.  NONE if neither.
constexpr uint16_t NONE = 0xffff;
uint16_t extended(int i, int n) {
  if (n >= 2 && params[i + 1] == 5) return params[i + 2] & 0xff;
  if (n < 4 || params[i + 1] != 2) return NONE;
  auto v = [&](int k) { return params[i + n - 2 + k] > 255 ? 255u : params[i + n - 2 + k]; };
  return DIRECT | rgb888(v(0), v(1), v(2));
}

// SGR.  A parameter's colon sub-parameters are its own: 4:0 to 4:5 are
// underline styles, all drawn as one but for 4:0, off, and 38:5:n and
// 38:2::r:g:b are colours.  The semicolon forms 38;5;n and 38;2;r;g;b take
// as many.  58 and 59, the underline's own colour, are read and dropped: it
// is the text's.
void sgr() {
  for (int i = 0; i <= param; i++) {
    unsigned p = params[i];
    int n = 0;
    while (i + n < param && sub >> (i + n + 1) & 1) n++;
    if (p == 38 || p == 48 || p == 58) {
      if (!n) n = i < param && params[i + 1] == 5 ? 2 : i < param && params[i + 1] == 2 ? 4 : 0;
      if (n > param - i) n = param - i;
      uint16_t c = extended(i, n);
      if (c != NONE && p != 58) (p == 38 ? pen.fg : pen.bg) = c;
      i += n;
      continue;
    }
    if (n) {
      if (p == 4) pen.flags = params[i + 1] ? pen.flags | UNDER : pen.flags & ~UNDER;
      i += n;
      continue;
    }
    if (p == 0) pen = { DEFAULT, DEFAULT, 0 };
    else if (p == 1) pen.flags |= BOLD;
    else if (p == 4) pen.flags |= UNDER;
    else if (p == 7) pen.flags |= REVERSE;
    else if (p == 8) pen.flags |= HIDDEN;
    else if (p == 22) pen.flags &= ~BOLD;
    else if (p == 24) pen.flags &= ~UNDER;
    else if (p == 27) pen.flags &= ~REVERSE;
    else if (p == 28) pen.flags &= ~HIDDEN;
    else if (p >= 30 && p <= 37) pen.fg = p - 30;
    else if (p == 39) pen.fg = DEFAULT;
    else if (p >= 40 && p <= 47) pen.bg = p - 40;
    else if (p == 49) pen.bg = DEFAULT;
    else if (p >= 90 && p <= 97) pen.fg = p - 90 + 8;
    else if (p >= 100 && p <= 107) pen.bg = p - 100 + 8;
  }
  resolve();
}

void soft_reset() {
  pen = { DEFAULT, DEFAULT, 0 };
  resolve();
  origin = insert = false;
  autowrap = cursor_shown = true;
  top = 0, bottom = ROWS - 1;
  charset[0] = charset[1] = shift = 0;
  Saved &v = saved[s - screens];
  v = Saved{};
  v.pen = pen;
}

// The parameter i, or otherwise if it is missing or 0.
int arg(int i, int otherwise = 1) { return i <= param && params[i] ? params[i] : otherwise; }

void csi(uint8_t f) {
  int a = arg(0);
  if (priv == '?') {
    if (f == 'h' || f == 'l')
      for (int i = 0; i <= param; i++) set_mode(params[i], f == 'h');
    return;
  }
  if (priv == '>') {
    if (f == 'c') send("\033[>0;0;0c");
    return;
  }
  if (priv) return;
  if (inter == '!' && f == 'p') return soft_reset();
  if (inter) return;
  int up_to = y >= top ? top : 0, down_to = y <= bottom ? bottom : ROWS - 1;
  switch (f) {
  case '@': slide(x, a, true); break;
  case 'A': go(x, y - a, up_to, ROWS - 1); break;
  case 'B': case 'e': go(x, y + a, 0, down_to); break;
  case 'C': case 'a': go(x + a, y, 0, ROWS - 1); break;
  case 'D': go(x - a, y, 0, ROWS - 1); break;
  case 'E': go(0, y + a, 0, down_to); break;
  case 'F': go(0, y - a, up_to, ROWS - 1); break;
  case 'G': case '`': go(a - 1, y, 0, ROWS - 1); break;
  case 'H': case 'f': place(arg(1) - 1, a - 1); break;
  case 'I': while (a--) tab_forward(); break;
  case 'Z': while (a--) tab_back(); break;
  case 'J':
    if (params[0] == 0) erase(y, x, COLUMNS), erase_lines(y + 1, ROWS);
    else if (params[0] == 1) erase_lines(0, y), erase(y, 0, x + 1);
    else erase_lines(0, ROWS);
    break;
  case 'K':
    if (params[0] == 0) erase(y, x, COLUMNS);
    else if (params[0] == 1) erase(y, 0, x + 1);
    else erase(y, 0, COLUMNS);
    break;
  case 'L': case 'M':
    if (y >= top && y <= bottom) {
      scroll(y, bottom, a, f == 'M');
      go(0, y, 0, ROWS - 1);
    }
    break;
  case 'P': slide(x, a, false); break;
  case 'S': scroll(top, bottom, a, true); break;
  case 'T': if (param == 0) scroll(top, bottom, a, false); break;
  case 'X': erase(y, x, x + a < COLUMNS ? x + a : COLUMNS); break;
  case 'b': if (last) while (a--) print(last); break;
  case 'c': if (params[0] == 0) send("\033[?1;2c"); break;
  case 'd': place(x, a - 1); break;
  case 'g':
    if (params[0] == 0) tabs[x >> 3] &= ~(1 << (x & 7));
    else if (params[0] == 3) for (uint8_t &t : tabs) t = 0;
    break;
  case 'h': case 'l': if (params[0] == 4) insert = f == 'h'; break;
  case 'm': sgr(); break;
  case 'n':
    if (params[0] == 5) send("\033[0n");
    else if (params[0] == 6) report_cursor();
    break;
  case 'r': {
    int t = arg(0) - 1, b = clamp(arg(1, ROWS) - 1, 0, ROWS - 1);
    if (t < b) {
      top = t, bottom = b;
      place(0, 0);
    }
    break;
  }
  case 's': save(); break;
  case 'u': restore(); break;
  }
}

// ESC # 8: the screen full of E, for lining a monitor up.
void align() {
  for (int l = 0; l < ROWS; l++) {
    y = l;
    for (int c = 0; c < COLUMNS; c++) cell(c, 'E', 0);
  }
  top = 0, bottom = ROWS - 1;
  go(0, 0, 0, ROWS - 1);
}

void escape(uint8_t c) {
  state = GROUND;
  if (c >= 0x20 && c <= 0x2f) {
    inter = c;
    state = ESCAPE_INTER;
    return;
  }
  switch (c) {
  case '[':
    param = 0;
    params[0] = 0;
    sub = 0;
    priv = inter = 0;
    state = CSI;
    break;
  case ']': case 'P': case 'X': case '^': case '_': state = STRING; break;
  case '7': save(); break;
  case '8': restore(); break;
  case 'D': index(); break;
  case 'E': x = 0; index(); break;
  case 'H': tabs[x >> 3] |= 1 << (x & 7); break;
  case 'M': reverse_index(); break;
  case 'c': reset(); break;
  }
}

void escape_final(uint32_t c) {
  if (c >= 0x20 && c <= 0x2f) return;
  state = GROUND;
  if (inter == '(' || inter == ')') charset[inter - '('] = c == '0';
  else if (inter == '#' && c == '8') align();
}

void csi_byte(uint32_t c) {
  if (c >= '0' && c <= '9') {
    if (params[param] < 1000) params[param] = params[param] * 10 + (c - '0');
  } else if (c == ';' || c == ':') {
    if (param < MAX_PARAMS - 1) {
      params[++param] = 0;
      if (c == ':') sub |= 1 << param;
    }
  } else if (c >= '<' && c <= '?') {
    priv = c;
  } else if (c >= 0x20 && c <= 0x2f) {
    inter = c;
  } else {
    state = GROUND;
    if (c >= 0x40 && c <= 0x7e) csi(c);
  }
}

// C0: executed inside a sequence too, as a VT does, but for a string's.
void control(uint8_t c) {
  if (c == 0x18 || c == 0x1a) state = GROUND;
  else if (c == 0x1b) state = ESCAPE;
  else if (state == STRING) {
    if (c == 0x07) state = GROUND;
  } else switch (c) {
  case 0x08: if (x > 0) x--; pending = false; break;
  case 0x09: tab_forward(); break;
  case 0x0a: case 0x0b: case 0x0c: index(); break;
  case 0x0d: x = 0; pending = false; break;
  case 0x0e: shift = 1; break;
  case 0x0f: shift = 0; break;
  }
}

void codepoint(uint32_t c) {
  if (c < 0x20) return control(c);
  if (c == 0x7f) return;
  switch (state) {
  case GROUND: print(c); break;
  case ESCAPE: if (c < 0x80) escape(c); else state = GROUND; break;
  case ESCAPE_INTER: escape_final(c); break;
  case CSI: csi_byte(c); break;
  }
}

}  // namespace

namespace {

// The base for c in a sorted table, or -1.
int find(const Unicode *table, int count, uint32_t c) {
  int lo = 0, hi = count - 1;
  while (lo <= hi) {
    int mid = (lo + hi) / 2;
    if (table[mid].code == c) return table[mid].base;
    if (table[mid].code < c) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

}  // namespace

uint8_t base_of(uint32_t c) {
  if (c >= 0x20 && c < 0x7f && c != 'i') return c;
  int b = find(UNICODE, UNICODE_COUNT, c);
  if (b < 0) b = find(ALIASES, ALIAS_COUNT, c);
  return b < 0 ? FALLBACK : b;
}

void reset() {
  pen = { DEFAULT, DEFAULT, 0 };
  resolve();
  origin = insert = pending = false;
  autowrap = cursor_shown = true;
  top = 0, bottom = ROWS - 1;
  charset[0] = charset[1] = shift = 0;
  for (uint8_t &t : tabs) t = 0x01;
  for (Screen &k : screens) {
    s = &k;
    for (int l = 0; l < ROWS; l++) s->line[l] = l;
    erase_lines(0, ROWS);
  }
  s = &screens[0];
  screen = s;
  x = y = 0;
  saved[0] = saved[1] = Saved{};
  saved[0].pen = saved[1].pen = pen;
  state = GROUND;
  need = 0;
  last = 0;
  dirty = ALL_ROWS;
  moved = true;
}

void put(uint8_t byte) {
  if (byte < 0x80) {
    if (need) need = 0, codepoint(0xfffd);
    codepoint(byte);
  } else if (byte < 0xc0) {
    if (!need) codepoint(0xfffd);
    else if (code = code << 6 | (byte & 0x3f), !--need) codepoint(code);
  } else {
    if (need) codepoint(0xfffd);
    if (byte < 0xc2 || byte > 0xf4) {
      need = 0;
      codepoint(0xfffd);
    } else {
      need = byte >= 0xf0 ? 3 : byte >= 0xe0 ? 2 : 1;
      code = byte & (0x3f >> need);
    }
  }
  cursor_x = x;
  cursor_y = y;
}

}  // namespace terminal
