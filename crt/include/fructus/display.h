/* fructus/display.h - the display's registers and frame buffers.

   docs/vga.md is the reference; tools/fpga-system.sv is the hardware and
   tools/gpu.js the simulator's model of it, which tools/fcc-run.mjs shows
   with --x11 or writes out with --frames.

   TWO FRAME BUFFERS, A and B, of 32 KB.  The display shows one; the mode says
   what the processor's data above 0x8000 is:

     DISPLAY_CPU        its own memory, as ever
     DISPLAY_COPY       its own; and A, which must be the one shown, is copied
                        into B in the next frame
     DISPLAY_BLIT       the buffer not shown, for loads and stores
     DISPLAY_WRITETHRU  its own for loads, the buffer not shown for stores

   OR'd with DISPLAY_SHOW_A, or not, for the buffer shown.  The processor's
   code and the exception vectors are never redirected: only data.

   A C PROGRAM'S GLOBALS ARE ABOVE 0x8000 in ld/fructus-sim.ld, with its code.
   In BLIT mode it can see none of them, and in WRITETHRU it can read them but
   its stores to them land in the buffer.  So draw with locals - the stack is
   below 0x8000 - and set DISPLAY_CPU again before touching globals.

   A CHANGE OF THE BUFFER SHOWN, or of COPY, takes effect at the next vertical
   sync, and until then the processor's stores to the buffer shown, or the one
   being copied into, are dropped.  display_sync() waits for it.

   The frame buffer's own addresses, 0x0000 - 0x7fff, are seen by the
   processor at 0x8000 - 0xffff, and every pointer in the line tables and the
   font register ignores bit 15, so either form may be written there.  */
#ifndef _FRUCTUS_DISPLAY_H
#define _FRUCTUS_DISPLAY_H

#include <stdint.h>

#define DISPLAY_REG(off)    (*(volatile uint16_t *)(0x0400 + (off)))
#define DISPLAY_MODE        DISPLAY_REG(0x80)   /* write */
#define DISPLAY_FONT        DISPLAY_REG(0x82)   /* write: the font's address */
#define DISPLAY_STATUS      DISPLAY_REG(0x84)   /* read */
#define DISPLAY_TIMING_H(i) DISPLAY_REG(0x90 + 2 * (i))  /* front porch, sync, back porch, visible */
#define DISPLAY_TIMING_V(i) DISPLAY_REG(0x98 + 2 * (i))
#define DISPLAY_PAL_ADDR    DISPLAY_REG(0xa0)   /* then each write to ... */
#define DISPLAY_PAL_DATA    DISPLAY_REG(0xa2)   /* ... sets one entry and steps */
#define DISPLAY_PAT_ADDR    DISPLAY_REG(0xa4)
#define DISPLAY_PAT_DATA    DISPLAY_REG(0xa6)
#define DISPLAY_ATTR_ADDR   DISPLAY_REG(0xa8)
#define DISPLAY_ATTR_DATA   DISPLAY_REG(0xaa)

/* The mode register.  */
#define DISPLAY_CPU        0
#define DISPLAY_COPY       1
#define DISPLAY_BLIT       2
#define DISPLAY_WRITETHRU  3
#define DISPLAY_SHOW_A     4

/* The status register.  */
#define DISPLAY_VBLANK     0x8000              /* the line is not visible */
#define DISPLAY_LINE(s)    ((s) & 0x3ff)       /* from the first visible line */

/* The buffer, as the processor sees it in BLIT or WRITETHRU.  */
#define DISPLAY_FB         ((uint8_t *)0x8000)

/* The line tables, one 16-bit entry per scan line.  */
#define DISPLAY_CHARS      ((uint16_t *)0xf000)  /* the line's character codes */
#define DISPLAY_COLOURS    ((uint16_t *)0xf400)  /* its foreground colours */
#define DISPLAY_BACKGROUND ((uint16_t *)0xf800)  /* its background pixels; even */
#define DISPLAY_LINEMODE   ((uint16_t *)0xfc00)  /* its mode word */

/* A mode word: OR one depth, one width and the font line together.  */
#define DISPLAY_FONT_LINE(n) ((n) & 0xff)
#define DISPLAY_1BPP_28    (0 << 8)    /* 1 bit per pixel, palette 28-29 */
#define DISPLAY_1BPP_30    (1 << 8)    /*                  palette 30-31 */
#define DISPLAY_2BPP_24    (2 << 8)    /* 2 bits, palette 24-27 */
#define DISPLAY_2BPP_8     (3 << 8)    /*         palette 8-11 */
#define DISPLAY_3BPP       (4 << 8)    /* 3 bits, palette 16-23; even widths only */
#define DISPLAY_4BPP       (5 << 8)    /* 4 bits, palette 0-15 */
#define DISPLAY_8BPP       (6 << 8)    /* the byte itself, see DISPLAY_RGB */
#define DISPLAY_WIDTH(w)   (((w) - 1) << 11)   /* each pixel 1-8 columns wide */
#define DISPLAY_WIDE_FONT  0x4000      /* 40 cells of 16 pixels, a word a glyph row */
#define DISPLAY_NO_TEXT    0x8000      /* background only */

/* A colour in the 8-bit pixel format: red 0-5, green 0-6, blue 0-4.  A byte
   0-31 is a palette entry instead.  */
#define DISPLAY_RGB(r, g, b) \
  ((uint8_t)(((g) + 1) << 5 | ((r) / 3) << 4 | ((r) % 3) * 5 + (b)))

/* Wait for the start of the next vertical blank: the time to change the
   palette or a sprite without tearing.  */
static inline void display_vblank (void)
{
  while (DISPLAY_STATUS & DISPLAY_VBLANK) ;
  while (!(DISPLAY_STATUS & DISPLAY_VBLANK)) ;
}

/* Wait until a whole vertical blank, and so a vertical sync, has passed:
   after it, a change of the buffer shown or of COPY has taken effect.  Up to
   two frames.  */
static inline void display_sync (void)
{
  display_vblank ();
  while (DISPLAY_STATUS & DISPLAY_VBLANK) ;
}

/* Palette entries from `first' on.  */
static inline void display_palette (unsigned first, const uint8_t *bytes, unsigned n)
{
  DISPLAY_PAL_ADDR = first;
  while (n--) DISPLAY_PAL_DATA = *bytes++;
}

/* Sprite s: screen position x, y (either may be negative, to slide off the
   edge), its pattern 0-15, double height or not, and its three colours,
   palette entries 1-15, or 0 for transparent.  */
static inline void display_sprite (unsigned s, int x, int y, unsigned pattern,
                                   unsigned tall, unsigned c1, unsigned c2, unsigned c3)
{
  DISPLAY_ATTR_ADDR = 4 * s;
  DISPLAY_ATTR_DATA = ((x + 48) & 0x3ff) | tall << 10 | pattern << 11;
  DISPLAY_ATTR_DATA = (y + 42) & 0x3ff;
  DISPLAY_ATTR_DATA = c1 | c2 << 4 | c3 << 8;
}

/* Pattern p's 63 words: row r is words 3r to 3r + 2, 8 pixels each, pixel 0
   in the low two bits.  */
static inline void display_pattern (unsigned p, const uint16_t *words)
{
  DISPLAY_PAT_ADDR = 64 * p;
  for (unsigned i = 0; i < 63; i++) DISPLAY_PAT_DATA = words[i];
}

#endif
