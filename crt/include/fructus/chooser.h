/* fructus/chooser.h - the flash's directory of bootable images, for the chooser.

   ideas/chooser-format.txt is the design.  The chooser is the power-on image:
   the flash's bitstream 0 and its 64 KB memory image at 0x100000, which
   rtl/spiboot.sv loads.  It shows a strip of icons, one per entry below,
   picked with the cursor keys; the hard boot button, on CRESET_N, always
   comes back to it.

   EVERYTHING IS A FIXED SIZE AT A FIXED ADDRESS, since the flash is far
   bigger than needed: entry k is CHOOSER_ENTRY_SIZE bytes at
   CHOOSER_ENTRY (k), and its memory image is the 64 KB at CHOOSER_MEMORY (k).
   No offsets or lengths to check, and an entry can be rewritten without
   touching the others: each is two of the flash's 4 KB erase sectors.

     0x000000  icemulti's header and up to 4 bitstreams, 128 KB aligned
     0x100000  the chooser's memory image, spiboot's OFFSET
     0x110000  CHOOSER_ENTRIES entries of 8 KB, to 0x150000
     0x200000  their memory images, 64 KB each, to the end of the 4 MB flash

   A slot is used if its magic is CHOOSER_MAGIC.  Erased flash reads 0xff, so
   an unwritten slot is skipped with no directory to keep.  Reserved bytes are
   written 0 and ignored.

   Every byte is a byte, and the only wider fields are uint16_t at even
   offsets, little-endian as the processor and an x86 host store them: the
   same struct describes the flash on both.  CHOOSER_CHECK below holds the
   layout.

   COLOURS are bytes in the 8-bit pixel format, docs/vga.md, as DISPLAY_RGB
   makes them: 0x20 and up.  An icon is shown at 8 bpp, where 0x00 - 0x1f
   would be palette lookups, and a look's colours go into the palette, where
   0x00 - 0x1f shows black and 4 - 7 is blanking on HDMI.  */
#ifndef _FRUCTUS_CHOOSER_H
#define _FRUCTUS_CHOOSER_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define CHOOSER_ENTRIES      32
#define CHOOSER_ENTRY_SIZE   0x2000
#define CHOOSER_ENTRY(k)     (0x110000ul + (uint32_t)(k) * CHOOSER_ENTRY_SIZE)
#define CHOOSER_MEMORY(k)    (0x200000ul + (uint32_t)(k) * 0x10000ul)

#define CHOOSER_MAGIC        "FRCH"     /* 4 bytes, no terminator */
#define CHOOSER_VERSION      1

#define CHOOSER_ICON_W       52
#define CHOOSER_ICON_H       39
#define CHOOSER_LOOKS        16
#define CHOOSER_STEPS        128
#define CHOOSER_FIELD        9          /* a text field under the icon */
#define CHOOSER_LINE         40         /* a line of the description */
#define CHOOSER_LINES        10
#define CHOOSER_QR_MAX       32         /* modules a side; version 3 is 29 */

/* A LOOK of the sprite drawn over the icon: one 24 x 21 pattern at 2 bits a
   pixel, as display_set_pattern takes it - row r is pattern[3r .. 3r + 2], 8
   pixels a word, the leftmost in a word's low two bits.  Pixel value 0 is
   transparent, 1 and 2 are colour1 and colour2, and 3 is always white, an
   entry every icon shares.  About 7 icons are on screen and the sprites have
   15 palette entries, so each icon gets two, which the chooser rewrites when
   its sprite changes look.  128 bytes.  */
struct chooser_look {
  uint16_t pattern[63];
  uint8_t colour1, colour2;             /* direct colours, 0x20 and up */
};

/* A STEP of the sprite's timeline: show look `look` at (x, y), relative to
   the icon's top left and free to overhang it, for `frames` 60 Hz frames,
   then go on to the next step.  A look of CHOOSER_RESTART goes back to step
   0, and one at step 0 means the icon has no sprite.  A frames of 0 stays on
   the step for good, so a still sprite is one step.  4 bytes.  */
#define CHOOSER_RESTART  255
struct chooser_step {
  uint8_t look;                         /* 0 - 15, or CHOOSER_RESTART */
  int8_t  x, y;
  uint8_t frames;                       /* 1 - 255, or 0 for ever */
};

/* AN ENTRY: one bootable image.  Text is ASCII padded with spaces or NULs,
   with no terminator, so a field may use all 9 or 40 characters.  The QR
   code is its modules, not its URL, so the chooser needs no encoder: row r
   is qr[r][0 .. 3], bit 0 of qr[r][0] its leftmost module, 1 dark, with no
   quiet zone.  The chooser shows it with a font of 1 x 2 blocks, two rows a
   character, so 32 modules square is 32 x 16 characters.  8 KB.  */
struct chooser_entry {
  /* 0: the header */
  char     magic[4];                    /* CHOOSER_MAGIC, or the slot is empty */
  uint8_t  version;                     /* CHOOSER_VERSION */
  uint8_t  bitstream;                   /* 0 - 3, SB_WARMBOOT's image; 0 is the
                                           chooser's own hardware */
  uint8_t  qr_size;                     /* modules a side, 0 for no QR code */
  uint8_t  reserved0[9];

  /* 16: under the icon */
  char     name[2][CHOOSER_FIELD];
  char     version_text[CHOOSER_FIELD];
  char     author[3][CHOOSER_FIELD];
  uint8_t  reserved1[128 - 16 - 6 * CHOOSER_FIELD];

  /* 128: the QR code, and the description shown for the entry selected */
  uint8_t  qr[CHOOSER_QR_MAX][CHOOSER_QR_MAX / 8];
  char     description[CHOOSER_LINES][CHOOSER_LINE];
  uint8_t  reserved2[1024 - 256 - CHOOSER_LINES * CHOOSER_LINE];

  /* 1024: the sprite */
  struct chooser_step timeline[CHOOSER_STEPS];
  uint8_t  reserved3[2048 - 1024 - CHOOSER_STEPS * 4];
  struct chooser_look looks[CHOOSER_LOOKS];

  /* 4096: the icon, row by row, as 8 bpp shows it */
  uint8_t  icon[CHOOSER_ICON_H][CHOOSER_ICON_W];
  uint8_t  reserved4[CHOOSER_ENTRY_SIZE - 4096 - CHOOSER_ICON_H * CHOOSER_ICON_W];
};

/* Each part where the comments say, and an entry exactly its slot: a
   mistake here is a compile error, on the processor and on the host.  */
#ifdef __cplusplus
#define CHOOSER_ASSERT(e) static_assert (e, #e)
#else
#define CHOOSER_ASSERT(e) _Static_assert (e, #e)
#endif
#define CHOOSER_AT(f, n) \
  CHOOSER_ASSERT (__builtin_offsetof (struct chooser_entry, f) == n)
CHOOSER_ASSERT (sizeof (struct chooser_look) == 128);
CHOOSER_ASSERT (sizeof (struct chooser_step) == 4);
CHOOSER_AT (name, 16);
CHOOSER_AT (qr, 128);
CHOOSER_AT (description, 256);
CHOOSER_AT (timeline, 1024);
CHOOSER_AT (looks, 2048);
CHOOSER_AT (icon, 4096);
CHOOSER_ASSERT (sizeof (struct chooser_entry) == CHOOSER_ENTRY_SIZE);
#undef CHOOSER_AT
#undef CHOOSER_ASSERT

#ifdef __cplusplus
}
#endif

#endif
