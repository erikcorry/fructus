/* display.c - colour bars, a line of text and a sprite, on the display.

     tools/fcc -O2 examples/display.c -o build/display
     node tools/fcc-run.mjs build/display.bin --x11 --scale 2
     node tools/fcc-run.mjs build/display.bin --frames build/display-frames

   Draws into buffer A in WRITETHRU mode while B is shown, shows A, and then
   moves a sprite across it a frame at a time.  */
#include <fructus/display.h>

/* An 8x8 font of just the glyphs used, code 0 a space.  */
static const char letters[] = " HELOFRUCTS";
static const uint8_t glyphs[][8] = {
  { 0, 0, 0, 0, 0, 0, 0, 0 },
  { 0x66, 0x66, 0x66, 0x7e, 0x66, 0x66, 0x66, 0 },   /* H */
  { 0x7e, 0x60, 0x60, 0x7c, 0x60, 0x60, 0x7e, 0 },   /* E */
  { 0x60, 0x60, 0x60, 0x60, 0x60, 0x60, 0x7e, 0 },   /* L */
  { 0x3c, 0x66, 0x66, 0x66, 0x66, 0x66, 0x3c, 0 },   /* O */
  { 0x7e, 0x60, 0x60, 0x7c, 0x60, 0x60, 0x60, 0 },   /* F */
  { 0x7c, 0x66, 0x66, 0x7c, 0x6c, 0x66, 0x66, 0 },   /* R */
  { 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x3c, 0 },   /* U */
  { 0x3c, 0x66, 0x60, 0x60, 0x60, 0x66, 0x3c, 0 },   /* C */
  { 0x7e, 0x18, 0x18, 0x18, 0x18, 0x18, 0x18, 0 },   /* T */
  { 0x3c, 0x66, 0x60, 0x3c, 0x06, 0x66, 0x3c, 0 },   /* S */
};
static const char message[] = "HELLO FRUCTUS";

/* Sixteen bars from red through green to blue, in direct colours.  */
static const uint8_t bars[16] = {
  DISPLAY_RGB (5, 0, 0), DISPLAY_RGB (5, 2, 0), DISPLAY_RGB (5, 4, 0), DISPLAY_RGB (5, 6, 0),
  DISPLAY_RGB (3, 6, 0), DISPLAY_RGB (1, 6, 0), DISPLAY_RGB (0, 6, 1), DISPLAY_RGB (0, 6, 3),
  DISPLAY_RGB (0, 6, 4), DISPLAY_RGB (0, 4, 4), DISPLAY_RGB (0, 2, 4), DISPLAY_RGB (0, 0, 4),
  DISPLAY_RGB (2, 0, 4), DISPLAY_RGB (4, 0, 4), DISPLAY_RGB (5, 0, 3), DISPLAY_RGB (2, 2, 2),
};
/* The sprite's colours 1-3: palette entries 1-3.  */
static const uint8_t ball_colours[3] = {
  DISPLAY_RGB (5, 6, 4), DISPLAY_RGB (5, 5, 0), DISPLAY_RGB (0, 0, 0),
};

/* Where things go in the buffer, as the processor addresses it.  */
#define BARS   ((uint8_t *)0x8000)     /* 80 pixels at 8 bpp: 80 bytes */
#define CODES  ((uint8_t *)0x8100)     /* 80 character codes */
#define INK    ((uint8_t *)0x8200)     /* and their colours */
#define FONT   ((uint8_t *)0xe000)     /* the font register's 0x6000 */
#define TEXT_TOP 232                   /* 8 glyph rows, each shown twice */

static void draw (void)
{
  /* The bars: pixel p of 80, each 8 columns wide, is bar p / 5.  */
  for (unsigned p = 0; p < 80; p++)
    BARS[p] = bars[p / 5];

  /* The font, row-major: 64 glyphs, so glyph row r is font_line r.  */
  for (unsigned r = 0; r < 8; r++)
    for (unsigned c = 0; c < sizeof glyphs / sizeof glyphs[0]; c++)
      FONT[64 * r + c] = glyphs[c][r];

  /* The text line: the message in the middle of 80 cells.  */
  unsigned start = (80 - (sizeof message - 1)) / 2;
  for (unsigned i = 0; i < 80; i++) {
    unsigned code = 0;
    if (i >= start && i < start + sizeof message - 1)
      for (unsigned c = 0; c < sizeof letters - 1; c++)
        if (letters[c] == message[i - start]) code = c;
    CODES[i] = code;
    INK[i] = DISPLAY_RGB (5, 6, 4);
  }

  for (unsigned n = 0; n < 480; n++) {
    DISPLAY_BACKGROUND[n] = (uint16_t)BARS;
    DISPLAY_CHARS[n] = (uint16_t)CODES;
    DISPLAY_COLOURS[n] = (uint16_t)INK;
    unsigned mode = DISPLAY_8BPP | DISPLAY_WIDTH (8);
    if (n >= TEXT_TOP && n < TEXT_TOP + 16)
      mode |= DISPLAY_FONT_LINE ((n - TEXT_TOP) / 2);
    else
      mode |= DISPLAY_NO_TEXT;
    DISPLAY_LINEMODE[n] = mode;
  }
}

/* A ball, 2 bits per pixel: an outline, a body and a highlight.  */
static void make_ball (uint16_t *words)
{
  for (int r = 0; r < 21; r++)
    for (int w = 0; w < 3; w++) {
      unsigned v = 0;
      for (int j = 0; j < 8; j++) {
        int x = 8 * w + j - 11, y = r - 10, d = x * x + y * y;
        int h = (x + 4) * (x + 4) + (y + 4) * (y + 4);
        unsigned px = h < 8 ? 1 : d < 90 ? 2 : d < 110 ? 3 : 0;
        v |= px << (2 * j);
      }
      words[3 * r + w] = v;
    }
}

int main (void)
{
  uint16_t ball[63];
  make_ball (ball);

  display_set_pattern (0, ball);
  display_set_palette (1, ball_colours, 3);

  /* B is shown at power-up, so A is the processor's.  */
  DISPLAY_MODE = DISPLAY_WRITETHRU;
  draw ();
  DISPLAY_MODE = DISPLAY_SHOW_A | DISPLAY_CPU;
  display_sync ();

  int x = 0, y = 100, dx = 6, dy = 4;
  for (int frame = 0; frame < 60; frame++) {
    display_vblank ();
    display_set_sprite (0, x, y, 0, 0, 1, 2, 3);
    x += dx; y += dy;
    if (x < 0 || x > 640 - 24) dx = -dx;
    if (y < 0 || y > 480 - 21) dy = -dy;
  }
  return 0;
}
