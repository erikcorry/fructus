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

#ifdef __cplusplus
extern "C" {
#endif

/* The registers, 0x0480 - 0x04ab: `__display' is 0x0480 in the linker
   scripts, as `__console' is 0x0420.  A symbol and not a constant address
   because GCC takes an access to a constant address below 4096 for a null
   pointer's, and -Warray-bounds says so at every one.  */
struct display_registers {
  uint16_t mode;                /* 0x0480 write */
  uint16_t font;                /* 0x0482 write: the font's address */
  uint16_t status;              /* 0x0484 read */
  uint16_t unused[5];
  uint16_t timing_h[4];         /* 0x0490 front porch, sync, back porch, visible */
  uint16_t timing_v[4];         /* 0x0498 */
  uint16_t pal_addr;            /* 0x04a0 then each write to ... */
  uint16_t pal_data;            /* 0x04a2 ... sets one entry and steps */
  uint16_t pat_addr;            /* 0x04a4 */
  uint16_t pat_data;            /* 0x04a6 */
  uint16_t attr_addr;           /* 0x04a8 */
  uint16_t attr_data;           /* 0x04aa */
};
extern volatile struct display_registers __display;

#define DISPLAY_MODE        __display.mode
#define DISPLAY_FONT        __display.font
#define DISPLAY_STATUS      __display.status
#define DISPLAY_TIMING_H(i) __display.timing_h[i]
#define DISPLAY_TIMING_V(i) __display.timing_v[i]
#define DISPLAY_PAL_ADDR    __display.pal_addr
#define DISPLAY_PAL_DATA    __display.pal_data
#define DISPLAY_PAT_ADDR    __display.pat_addr
#define DISPLAY_PAT_DATA    __display.pat_data
#define DISPLAY_ATTR_ADDR   __display.attr_addr
#define DISPLAY_ATTR_DATA   __display.attr_data

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
   0-31 is a palette entry instead.  A constant expression, for tables, and
   each argument is evaluated once.

   The byte is t:c, green + 1 in t.  c[3:0] is red and blue in base 5, red
   0-2; red 3-5 sets c[4] and puts red - 3 there, so c is 5 red + blue, plus 1
   from red 3 on, skipping c = 15.  (21 red + 1) >> 2 is 5 red + (red >= 3)
   for every red 0-5, 0 5 10 16 21 26, with red used once and no division or
   branch.  */
#ifdef __cplusplus
constexpr uint8_t DISPLAY_RGB (unsigned r, unsigned g, unsigned b)
{
  return (uint8_t)((g + 1) << 5 | (((21 * r + 1) >> 2) + b));
}
#else
#define DISPLAY_RGB(r, g, b) \
  ((uint8_t)(((g) + 1) << 5 | (((21 * (r) + 1) >> 2) + (b))))
#endif

/* The nearest colour to red, green and blue of 0-255 each.  A channel with
   levels 0-L takes (v (L + 1)) >> 8: L + 1 equal ranges of v, so 0 is level
   0, 255 is L, and the steps between are even.  A constant expression, each
   argument evaluated once.  */
#ifdef __cplusplus
constexpr uint8_t DISPLAY_RGB888 (unsigned r, unsigned g, unsigned b)
{
  return DISPLAY_RGB ((r * 6) >> 8, (g * 7) >> 8, (b * 5) >> 8);
}
#else
#define DISPLAY_RGB888(r, g, b) \
  DISPLAY_RGB (((r) * 6) >> 8, ((g) * 7) >> 8, ((b) * 5) >> 8)
#endif

/* The line being drawn, 0-479 from the top, or -1 in the vertical blank.

   At the standard 640x480 timing a line is 800 pixel clocks, 31.8
   microseconds, and the processor runs on the same clock, so a line is 800
   of its cycles.  The blank starts where line 480 would be and lasts 45
   lines, 1.43 ms, and the whole frame is 525 lines, 16.7 ms.  So at line n
   there are 480 - n lines, (480 - n) x 31.8 microseconds or (480 - n) x 800
   cycles, to the next vertical blank.  */
static inline int display_line (void)
{
  uint16_t s = DISPLAY_STATUS;
  return s & DISPLAY_VBLANK ? -1 : (int)DISPLAY_LINE (s);
}

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

/* Set palette entries first to first + n - 1 from bytes[0 .. n - 1].
   first is 0-31, and the entries wrap from 31 to 0, so n of 32 sets the
   whole palette.  Each byte is a colour in the 8-bit pixel format, as
   DISPLAY_RGB makes from levels or DISPLAY_RGB888 from 0-255; a byte of 0-31
   there shows black.  The entries are used by sprite colours (1-15) and by
   background pixels of fewer than 8 bits: 4 bpp 0-15, 2 bpp 8-11 or 24-27,
   3 bpp 16-23, 1 bpp 28-29 or 30-31.  A foreground or 8 bpp byte of 0-31 is
   an entry too.

   The display reads the palette as it draws, so a change made mid-frame
   shows from that point down: call display_vblank first for a clean one.  */
static inline void display_set_palette (unsigned first, const uint8_t *bytes, unsigned n)
{
  DISPLAY_PAL_ADDR = first;
  while (n--) DISPLAY_PAL_DATA = *bytes++;
}

/* Set sprite s, 0-15, where sprite 0 is in front of sprite 1 and so on.
   x and y are the screen position of its top left pixel: x -48 to 975 and
   y -42 to 981, so it can slide off any edge; the visible screen is 0-639
   by 0-479.  pattern is 0-15, see display_set_pattern.  tall, 0 or 1,
   doubles its height to 42 lines.  Pixel value 0 is always transparent;
   c1, c2 and c3 are the colours of pixel values 1, 2 and 3: palette entries
   1-15, or 0 to make that value transparent too.

   A sprite is read a line ahead, so moving it mid-frame can split it
   between its old place and its new: call display_vblank first.  */
static inline void display_set_sprite (unsigned s, int x, int y, unsigned pattern,
                                       unsigned tall, unsigned c1, unsigned c2, unsigned c3)
{
  DISPLAY_ATTR_ADDR = 4 * s;
  DISPLAY_ATTR_DATA = ((x + 48) & 0x3ff) | tall << 10 | pattern << 11;
  DISPLAY_ATTR_DATA = (y + 42) & 0x3ff;
  DISPLAY_ATTR_DATA = c1 | c2 << 4 | c3 << 8;
}

/* Set sprite pattern p, 0-15, from words[0 .. 62]: 24 by 21 pixels of 2
   bits, value 0 always transparent and 1-3 the sprite's colours c1-c3.  Row r, 0-20,
   is words 3r to 3r + 2, 8 pixels each, its leftmost pixel in a word's low
   two bits.  As with display_set_sprite, call display_vblank first if the
   pattern is in use.  */
static inline void display_set_pattern (unsigned p, const uint16_t *words)
{
  DISPLAY_PAT_ADDR = 64 * p;
  for (unsigned i = 0; i < 63; i++) DISPLAY_PAT_DATA = words[i];
}

#ifdef __cplusplus
}
#endif

#endif
