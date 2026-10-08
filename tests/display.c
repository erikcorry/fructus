/* display.c - the simulator's display, tools/gpu.js, as a program sees it.

   tests/display-check.mjs runs this and then looks at the buffers, the
   machine's memory and the frames it drew.  Returns 0, or the number of the
   first check made here that failed.  */
#include <fructus/display.h>

#define FB8(a)  (*(volatile uint8_t *)(a))
#define FB16(a) (*(volatile uint16_t *)(a))

/* Eight bands of 60 lines, each a direct colour, at 8 bpp and width 8: one
   80-byte line per band at 0x8000 + 0x80 k.  */
static const uint8_t band[8] = {
  DISPLAY_RGB (5, 0, 0), DISPLAY_RGB (0, 6, 0), DISPLAY_RGB (0, 0, 4), DISPLAY_RGB (5, 6, 0),
  DISPLAY_RGB (0, 6, 4), DISPLAY_RGB (5, 0, 4), DISPLAY_RGB (5, 6, 4), DISPLAY_RGB (2, 3, 2),
};
static const uint8_t colours[3] = { DISPLAY_RGB (5, 6, 4), 0, 0 };
static const uint16_t square[63] = {
  /* rows 0-20, the first 8 pixels of each in colour 1 */
  0x5555, 0, 0, 0x5555, 0, 0, 0x5555, 0, 0, 0x5555, 0, 0, 0x5555, 0, 0, 0x5555, 0, 0,
  0x5555, 0, 0, 0x5555, 0, 0, 0x5555, 0, 0, 0x5555, 0, 0, 0x5555, 0, 0, 0x5555, 0, 0,
  0x5555, 0, 0, 0x5555, 0, 0, 0x5555, 0, 0, 0x5555, 0, 0, 0x5555, 0, 0, 0x5555, 0, 0,
  0x5555, 0, 0, 0x5555, 0, 0, 0x5555, 0, 0,
};

int main (void)
{
  display_palette (1, colours, 1);
  display_pattern (2, square);
  display_sprite (0, 100, 100, 2, 0, 1, 0, 0);

  /* 1. WRITETHRU, B shown: stores go to A, loads are the processor's.  */
  DISPLAY_MODE = DISPLAY_WRITETHRU;
  uint8_t before = FB8 (0x8000);
  for (unsigned k = 0; k < 8; k++) {
    uint8_t c = band[k];
    for (unsigned i = 0; i < 80; i++) FB8 (0x8000 + 0x80 * k + i) = c;
  }
  if (FB8 (0x8000) != before) return 1;
  for (unsigned n = 0; n < 480; n++) {
    DISPLAY_BACKGROUND[n] = 0x8000 + 0x80 * (n / 60);
    DISPLAY_LINEMODE[n] = DISPLAY_8BPP | DISPLAY_WIDTH (8) | DISPLAY_NO_TEXT;
  }
  FB16 (0x8600) = 0x7e7e;          /* in A, and never read by the display */

  /* 2. Show A.  Until the vertical sync B is still shown, so this is lost.  */
  DISPLAY_MODE = DISPLAY_SHOW_A | DISPLAY_WRITETHRU;
  FB16 (0x8700) = 0x1111;
  display_sync ();
  FB16 (0x8702) = 0x2222;          /* B's now */

  /* 3. COPY A to B, for a frame or two.  */
  DISPLAY_MODE = DISPLAY_SHOW_A | DISPLAY_COPY;
  display_sync ();
  DISPLAY_MODE = DISPLAY_SHOW_A | DISPLAY_WRITETHRU;
  FB16 (0x8704) = 0x3333;          /* lost: B is copied into until the sync */
  display_sync ();

  /* 4. BLIT: loads and stores are B's.  */
  DISPLAY_MODE = DISPLAY_SHOW_A | DISPLAY_BLIT;
  FB16 (0x8706) = 0x4444;
  unsigned got = FB16 (0x8706), copied = FB16 (0x8000 + 0x80 * 3);
  unsigned old = FB16 (0x8702);
  DISPLAY_MODE = DISPLAY_SHOW_A | DISPLAY_CPU;
  if (got != 0x4444) return 2;
  if (copied != (band[3] | band[3] << 8)) return 3;
  if (old != 0x2222) return 4;

  /* 5. The status register: a visible line, then the blank.  */
  unsigned s;
  while ((s = DISPLAY_STATUS) & DISPLAY_VBLANK) ;
  if (DISPLAY_LINE (s) >= 480) return 5;
  while (!((s = DISPLAY_STATUS) & DISPLAY_VBLANK)) ;
  if (DISPLAY_LINE (s) != 0) return 6;
  return 0;
}
