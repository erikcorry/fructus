// rules-check.cc - font.h's glyphs() for gen-font.mjs --rules's pairs.
//
// Reads "base mark" a line and prints "base mark", the code of each zone and
// EDGE's underlined, as the generator's --rules does; terminal/check.mjs
// compares the two.
#include <stdio.h>

#include "font.h"
#include "terminal.h"

using namespace terminal;

int main() {
  unsigned base, mark;
  while (scanf("%u %u%*[^\n]", &base, &mark) == 2) {
    uint8_t codes[ZONES];
    glyphs(base, mark, MARK_BELOW[mark >> 3] >> (mark & 7) & 1, codes);
    printf("%u %u", base, mark);
    for (uint8_t c : codes) printf(" %u", c);
    printf(" %u\n", UNDERLINED[codes[0]]);
  }
}
