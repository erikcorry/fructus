// dump.cc - terminal.cc's screen as text, after all of its input.
//
//   g++ -O2 -Iterminal terminal/dump.cc terminal/terminal.cc terminal/decompose.cc terminal/font.cc
//       terminal/bidi.cc -o build/terminal-dump
//   build/terminal-dump < bytes
//
//   tools/fcc -Os -Iterminal terminal/dump.cc terminal/terminal.cc terminal/decompose.cc terminal/font.cc
//       terminal/bidi.cc -o build/terminal-dump
//   node tools/fcc-run.mjs build/terminal-dump.bin --input bytes
//
// On the host the bytes come from stdin; on Fructus from the UART, until no
// more come.  Out, on stdout or the UART:
//
//     cursor X Y [hidden]
//     ' ' and the 80 cells of each of the 28 lines, as UTF-8, base and mark,
//         the spaces at the end dropped
//     the lines with a cell not white on black or underlined, as runs:
//         NN: FROM-TO fg FF bg BB [u] ...
//     the lines bidi.cc reorders, as shown, mirrored characters mirrored:
//         >NN: and the 80 cells, the spaces at the end dropped
//
// and the terminal's answers to the host first, each as "send" and its
// bytes with ESC as \e.
#include "bidi.h"
#include "font.h"
#include "terminal.h"

#ifdef __fructus__
#include <fructus/uart.h>
// Its two screens are 18K, and the program has no heap: 36K for it.
asm(".globl __heap_end\n.set __heap_end, 0x7000");
static void out(char c) { fructus_uart_putc(c); }
static int in() { return fructus_uart_ready() ? fructus_uart_getc() : -1; }
#else
#include <stdio.h>
static void out(char c) { putchar(c); }
static int in() { return getchar(); }
#endif

using namespace terminal;

static void text(const char *s) {
  while (*s) out(*s++);
}

static void number(unsigned v, int base = 10, int digits = 1) {
  char d[8];
  int n = 0;
  do d[n++] = "0123456789abcdef"[v % base]; while ((v /= base) || n < digits);
  while (n) out(d[--n]);
}

// A base's code point: the font's code, unless the font moved it.  base is
// 10 bits, SECOND_SET and THIRD_SET for the second and third sets.
static unsigned unicode(uint16_t base) {
  if (base >= 0x20 && base < 0x7f && base != DOTLESS_I) return base;
  for (int i = 0; i < UNICODE_COUNT; i++)
    if (UNICODE[i].base == base) return UNICODE[i].code;
  return base;
}

static void utf8(unsigned c) {
  if (c < 0x80) {
    out(c);
  } else if (c < 0x800) {
    out(0xc0 | c >> 6), out(0x80 | (c & 0x3f));
  } else {
    out(0xe0 | c >> 12), out(0x80 | (c >> 6 & 0x3f)), out(0x80 | (c & 0x3f));
  }
}

void terminal::send(const char *s) {
  text("send ");
  for (; *s; s++)
    if (*s == 0x1b) text("\\e");
    else out(*s);
  out('\n');
}

// Cell i of a row as UTF-8, its base as base.
static void cell(const Row &r, int i, uint8_t base) {
  unsigned mark = (r.mark[i] & MARK) == TONOS ? 0x301 : r.mark[i] & MARK ? 0x2ff + (r.mark[i] & MARK) : 0;
  if ((r.mark[i] & MARK) == SECOND || (r.mark[i] & MARK) == THIRD) {
    utf8(unicode(((r.mark[i] & MARK) == SECOND ? SECOND_SET : THIRD_SET) | base));
    return;
  }
  // ı and its dot are i again, to read.
  bool i_dot = base == DOTLESS_I && mark == 0x307;
  utf8(i_dot ? 'i' : unicode(base));
  if (mark && !i_dot) utf8(mark);
}

int main() {
  reset();
  const uint8_t WHITE = screen->rows[0].fg[0], BLACK = screen->rows[0].bg[0];
  for (int c; (c = in()) >= 0;) put(c);

  text("cursor ");
  number(cursor_x);
  out(' ');
  number(cursor_y);
  text(cursor_shown ? "\n" : " hidden\n");
  for (int l = 0; l < ROWS; l++) {
    const Row &r = screen->rows[screen->line[l]];
    int end = COLUMNS;
    while (end > 0 && r.base[end - 1] == ' ' && !(r.mark[end - 1] & MARK)) end--;
    out(' ');
    for (int i = 0; i < end; i++) cell(r, i, r.base[i]);
    out('\n');
  }
  for (int l = 0; l < ROWS; l++) {
    const Row &r = screen->rows[screen->line[l]];
    auto look = [&](int i) { return (uint32_t) r.fg[i] << 9 | r.bg[i] << 1 | r.mark[i] >> 7; };
    bool any = false;
    for (int i = 0; i < COLUMNS; i++)
      any |= look(i) != ((uint32_t) WHITE << 9 | BLACK << 1);
    if (!any) continue;
    number(l, 10, 2);
    out(':');
    for (int i = 0, j; i < COLUMNS; i = j) {
      for (j = i + 1; j < COLUMNS && look(j) == look(i); j++) {}
      out(' ');
      number(i);
      out('-');
      number(j - 1);
      text(" fg ");
      number(r.fg[i], 16, 2);
      text(" bg ");
      number(r.bg[i], 16, 2);
      if (r.mark[i] & UNDERLINE) text(" u");
    }
    out('\n');
  }
  for (int l = 0; l < ROWS; l++) {
    const Row &r = screen->rows[screen->line[l]];
    uint8_t order[COLUMNS];
    if (!bidi_order(r, order)) continue;
    int end = COLUMNS;
    while (end > 0 && r.base[order[end - 1] & ~MIRROR] == ' ' && !(r.mark[order[end - 1] & ~MIRROR] & MARK)) end--;
    out('>');
    number(l, 10, 2);
    text(": ");
    for (int v = 0; v < end; v++) {
      int i = order[v] & ~MIRROR;
      cell(r, i, order[v] & MIRROR ? mirrored(r.base[i], r.mark[i] & MARK) : r.base[i]);
    }
    out('\n');
  }
}
