# VGA output

## Frame buffers

Two 32 KB buffers, A and B, enough for a VT100 or teletext display. At any
moment each buffer has one owner, so the video never stalls the CPU:

- one buffer serves the display, and
- the other is either attached to the CPU or in **write-through** mode.

In write-through, the two buffers share an address bus. Every word the
display reads from its buffer is also written, at the same address, into the
write-through buffer.

### Double buffering

The CPU owns A and the display shows B. To publish a new image:

1. The CPU finishes drawing in A.
2. For one frame (16 ms, vsync to vsync) the display shows A, and B is in
   write-through. A is complete, so what is shown is correct.
3. The display goes back to B, which now shows the same image. The CPU owns
   A again.

A always holds the latest image, so the CPU draws incrementally (scroll a
line, change a character). A plain page flip would hand back an image two
frames old.

The CPU cannot use A during the copy frame.

### Why one frame's reads are enough

The copy writes only the addresses the display fetched. Unused glyphs,
off-screen memory and the CPU's own data in B are left stale. That is enough
because B is only ever read by the display. Showing the same bytes, it
fetches the same addresses it fetched during the copy.

This holds only if **the set of addresses fetched depends on the buffer
contents and nothing else.** Anything else that changes the fetch pattern
while B is on screen reads addresses that were never copied:

| feature | rule |
|---|---|
| blink (VT100 blink, teletext flash) | always fetch the glyph; blank it after the fetch |
| teletext conceal/reveal | always fetch; hide on output |
| cursor | an overlay after the fetch, never a substituted character code |
| scroll offset, start address, mode | change only while A is shown, then copy again |

Every visual effect is a mask applied after the fetch, never a change to what
is fetched. Teletext double height is safe: it depends only on control codes
in the buffer.

### On an iCE40 UP5K

Each buffer can be one SPRAM block (16K × 16 = 32 KB, single ported); the
UP5K has four. SPRAM reads are registered, so the data comes a cycle after
its address: the write-through address into B is the display's read address
delayed one clock.

SPRAM is static: no refresh. But unlike EBR it is not loaded by the
bitstream, and comes up holding garbage, so the CPU writes the line tables
and font before the display is enabled. Its `STANDBY`, `SLEEP` and
`POWEROFF` inputs are tied inactive; `POWEROFF` loses the contents.

## Line tables

The start of each frame buffer holds four 480-entry arrays of 16-bit entries,
one entry per scan line:

| address | array | entry |
|---|---|---|
| 0x0000 | `background_color` | pointer to the line's background pixels |
| 0x0400 | `graphics_mode` | the line's [mode word](#mode-word) |
| 0x0800 | `character_data` | pointer to the line's character codes |
| 0x0c00 | `character_color` | pointer to the line's foreground colours |

At the start of scan line n the GPU reads the four entries for line n, 8
bytes in all. Every line therefore has its own mode, font row and data
location, set by the table and not by interrupts: the Elite split-screen
trick, systematized. Scrolling rewrites pointers and moves no text.

A text line is 80 character codes and 80 foreground colours, one of each per
8-pixel cell. A foreground colour is one byte in the [8-bit pixel
format](#8-bit-pixel-format): 0x00–0x1F select a palette entry, and
0x20–0xFF are direct colours, 0x20 being black.

Under consideration: a mode bit that **doubles pixels horizontally** for the
text generator, giving 40 columns of 16-pixel cells, so each line is 40 codes
and 40 colours. That is native teletext (640 / 40 = 16 = 8 doubled) and a
320-wide tile mode for games.

Also under consideration: a mode bit that **disables the text generator**,
so the fg/bg mux always takes the background. Pointing `character_data` at
a line of spaces shows the same picture, as long as glyph 32 is blank in
the rows used, but it needs the font and the character tables in memory.
With the bit they are free for pixels, which is what lets 320×240 at 3 bpp
fit.

For VT100, 30 text rows of 16 lines: `character_data` holds 16 copies of a
pointer to the first row's 80 bytes, then 16 copies of a pointer to the
second row's, and so on.

### Mode word

Each `graphics_mode` entry is 16 bits, all of them spoken for:

| bits | field | |
|---|---|---|
| 7–0 | `font_line` | the font window, see [Fonts](#fonts) |
| 10–8 | depth | the background's depth and palette range, see [Background](#background) |
| 13–11 | pixel width − 1 | background pixels 1 to 8 columns wide |
| 14 | text doubling | 40 columns of 16-pixel cells |
| 15 | text disable | the fg/bg mux always takes the background |

`font_line` is the low byte, so the CPU can change it with a byte store.

One depth code, `111`, is spare. No "no background" mode is needed: 1 bpp at
width 8 is 80 pixels, so one 10-byte line of zeros serves every line that
wants a plain background, in palette entry 28 (or 30).

### Fonts

Glyphs are always 8 pixels wide, one byte per glyph row. The font area
starts at 0x1000; its size depends on the glyph count and height, typically
4 KB.

At the start of each line the GPU sets

```
font_base = 0x1000 + (font_line << 5)
```

and each character code c then fetches its pixels from `font_base + c`. The
font is stored row-major, row 0 of every glyph, then row 1 of every glyph, so
`font_line` steps by the glyph count divided by 32 for each glyph row:

| font | `font_line` for glyph row r | size, 16 rows |
|---|---|---|
| 256 glyphs | 8r (up to 32 rows) | 4 KB |
| 128 glyphs | 4r | 2 KB |
| ASCII 32–127 | 3r | 1.5 KB |
| 64 or 32 glyphs | 2r or r | 1 KB or 512 B |

The ASCII font works because rows are 96 bytes apart and codes start at 32:
row r covers 0x1000 + 96r + 32 to 0x1000 + 96r + 127, so consecutive rows
touch without overlapping. Only the 32 bytes at 0x1000 are unused.

Games can use the same mechanism for tiles: a 32×32 tile is 4 code points
wide, and a 256-glyph font of 32 rows holds 64 of them.

Because the row comes from the table, some effects are just table contents:

- **Double height:** repeat each `font_line` twice.
- **Smooth scroll:** start the top text row part-way into its glyph.
- **Mixed fonts:** different areas of the screen point at different fonts.

`font_line` is a byte, so the font area ends at most at
0x1000 + 255 × 32 + 255 = 0x30DF.

### Background

A glyph bit of 1 shows the cell's foreground colour; a 0 shows the
background pixel from the line's `background_color` data: 640 screen pixels
at 1, 2, 3, 4 or 8 bits per pixel, each pixel 1 to 8 screen pixels wide, but
**3 bpp only at even widths** (see [Memory cycles](#memory-cycles)). The
pointer is even.

An 8-bit pixel is a byte in the [8-bit pixel format](#8-bit-pixel-format).
Fewer bits select a palette entry, with a fixed prefix per depth so that no
two depths overlap and no addition is needed:

| code | bpp | palette index | entries | pixels per word | bytes per line (width 1) |
|---|---|---|---|---|---|
| `000` | 1 | `1110p` | 28–29 | 16 | 80 |
| `001` | 1 | `1111p` | 30–31 | 16 | 80 |
| `010` | 2 | `110pp` | 24–27 | 8 | 160 |
| `011` | 2 | `010pp` | 8–11 | 8 | 160 |
| `100` | 3 | `10ppp` | 16–23 | 5, bit 15 unused | 256 |
| `101` | 4 | `0pppp` | 0–15 | 4 | 320 |
| `110` | 8 | the byte itself | any | 2 | 640 |
| `111` | spare | | | | |

Code bit 0 picks the variant at 1 and 2 bpp. The index is the pixel ORed
into a fixed value per code, so no addition is needed.

**The two variants double-buffer the palette.** A band of lines at 1 or 2
bpp can use one set of entries while the CPU rewrites the other, and the
line table switches sets at an exact line. The CPU's deadline is the height
of the band, not one line's horizontal blanking. The status register's
current line is enough to know when a band has begun. 2 bpp's second set,
8–11, is also the top half of 4 bpp's entries, which lets a 4 bpp picture
share four colours with a 2 bpp band.

A low-depth pixel so becomes the pixel-format byte `000xxxxx`, and every
depth goes down one path from there. Wider pixels divide the byte count: a
text mode is 8 bits per pixel, 8 wide, so 80 bytes per line, one background
colour per cell. Width 3 gives 213 pixels and leaves the last screen column
over.

A retro game can run at 320×240, 2 bits per pixel, width 2, with each
`background_color` pointer repeated for two lines: 160 bytes × 240 lines =
19,200 bytes.

At 3 bpp, width 2, a line is 64 words, 128 bytes, and 240 lines are 30,720.
With the text generator running that leaves room for 224 lines (28 KB after
the 4 KB of tables). Without it, `character_data`, `character_color` and the
font are not needed, and 0x0800 to the end is exactly 30,720 bytes: 320×240
in 8 colours. A full 640×480 in 8 colours would be 120 KB.

### Unpacking

Pixels are stored least significant bits first, so pixel 0 is the low bits of
its word, matching the little-endian byte order of 8 bpp.

```
width counter   0 .. w-1       steps every pixel clock
pixel counter   0 .. ppw-1     steps when the width counter wraps
shift register  16 bits        shifts right by bpp when the pixel counter
                               steps, loads the next word when it wraps
pixel           the low bpp bits of the shift register
```

3 bpp is not a special case: 5 pixels per word, and bit 15 is dropped when
the next word loads.

`rtl/video/background.sv` implements this: 147 LUT4s and 62 flops by yosys,
about 3% of a UP5K. Its output reaches `pixel` a parameter `LATENCY`
cycles after the column, at least 4; the font/foreground and sync pipelines
are padded to the same depth (see [Timing](#timing)).
`tests/background-check.mjs` checks every column of every depth code and
supported width against a reference built from this section.

### Memory cycles

Counting x from column 0, even cycles belong to the text generator and odd
cycles to the background generator.

The text generator reads bytes: a character code, a foreground colour and a
glyph byte per 8-pixel cell, 3 of its 4 cycles. So `character_data` and
`character_color` may start at any address, odd or even.

The background generator reads 16-bit words. It has to: 8 bpp at width 1 is
one word every two pixels, all of the odd cycles. Its reads are **a fixed
schedule, with no FIFO**. A word arrives the cycle after its read, as from
an SPRAM:

- word 0 is read at x = 1 and goes into the shift register at the end of
  x = 2, so the shift register runs three cycles behind the columns;
- every later word is read two shift-register cycles before its first pixel,
  and lands in the shift register just as the last word's last pixel ends.

That read falls on an odd cycle only if a word lasts an even number of
cycles, pixels per word × width. 16, 8, 4 and 2 pixels always do; 5 pixels,
at 3 bpp, do only at even widths, which is why 3 bpp is restricted to them.
Holding a word for a cycle would lift the restriction for about 35 logic
cells, but no BBC mode or terminal needs 3 bpp at an odd width.

A `background_color` pointer must be even. (An odd one was supported for a
while by dropping the first word's low byte as it loaded; it and a FIFO
were taken out as more hardware than they were worth.)

### Text generator

`rtl/video/foreground.sv` makes the glyph bit and foreground colour for each
column, from three byte reads per cell on the even cycles. At the cell's
phase, x mod 8 (x mod 16 with text doubling):

| phase | |
|---|---|
| 0 | read the character code, `character_data`++ |
| 1 | the glyph address, 0x1000 + (`font_line` << 5) + code |
| 2 | read the glyph byte |
| 4 | read the foreground colour, `character_color`++ |
| 7 | glyph and colour move to the output stage |

Phase 6 is spare. A glyph byte's bit 7 is its leftmost pixel.

**Both cell widths move at phase 7**, so a cell is shown from 8 cycles after
its first column either way and the latency does not depend on the mode: a
doubled cell is still showing its last 8 columns while the next cell's reads
happen, so the next glyph and colour wait in their own registers. With the
output register the text generator's latency is 9, and the background, whose
own minimum is 4, runs at the same `LATENCY`.

151 LUT4s, 37 carry cells and 110 flops by yosys. `tests/foreground-check.mjs`
checks every column at both widths, with text on and off and pointers of
either parity, against a reference built from this section.

### Pixel path

```
glyph bit ? foreground byte : background byte
  → palette, if the top three bits are 000
  → decode to the red, green and blue pin encodings
  → IO flops → DACs
```

Foreground and background are chosen before the palette, so there is one
palette read per pixel: the EBR's read port serves the display and its write
port stays free for the CPU, which can change entries mid-frame.

### Top level

`rtl/video/video.sv` joins the timing, the line tables, both generators, the
palette and the decode:

- **The line tables are read as the front porch ends**: line n's four
  entries are the words at n, 0x200 + n, 0x400 + n and 0x600 + n, on the
  first four cycles after the front porch, and `line_start` follows once the
  last has arrived. So SYNC and back porch together must be at least 6
  cycles, and the front porch at least 2, for the background's last reads
  just past the last column.
- **The pins show column x at LATENCY + 2**: one cycle for the palette read,
  with the direct byte delayed alongside it, and one for the output
  register. HSYNC, VSYNC and visible are delayed to match, and the pins are
  0 when visible is not set.
- **The unused direct codes**, `c[3:0] = 1111`, decode to black, as does a
  palette entry whose own top bits are 000.

The whole display is 514 LUT4s, 85 carry cells, 378 flops and one block RAM
(the palette) by yosys. `tests/video-check.mjs` runs whole frames from random
line tables and a random palette, at the minimum porches and at standard
VGA's, and compares every cycle's syncs and pins with a reference built from
this document.

### Timing

The GPU's reads are completely predictable, so it can fetch as far ahead as
it likes, and there is no timing pressure on the table reads, the
`font_base + c` add or the glyph fetch. The pipelines are padded so that the
background, the font/foreground and the syncs reach the fg/bg mux and the
pins in the same cycle.

PADDING IS NOT FREE ON AN iCE40. A logic cell's flop takes its D input only
from the cell's own LUT, so a flop that registers real logic shares that
cell for nothing, but a flop that only delays another flop takes a whole
cell, its LUT passing the bit through. There is no shift-register
primitive like Xilinx's SRL16. A stage costs a cell per bit: 8 for the
pixel byte, about 3 for HSYNC, VSYNC and `visible`. Cheap - ten stages are
about 2% of a UP5K - and cheaper still because the last stage goes in the
`SB_IO` output flops, which are not logic cells, and because a pipeline can
start its fetch earlier instead of delaying its result.

The worst case is 80-column text over an 8 bpp, width 1 background. Every 16
pixels need 8 background words, 1 word of two character codes, 1 word of two
foreground colours and 2 glyph bytes: 12 reads in 16 pixel clocks. The four
table reads at the start of a line fall in the 160 clocks of horizontal
blanking.

## 8-bit pixel format

```
 7   5 4       0
┌─────┬─────────┐
│  t  │    c    │
└─────┴─────────┘
```

- `t = 000`: `c` indexes a 32-entry palette.
- `t = 001..111`: direct colour. Green is `t - 1` (0–6), and `c` holds red
  (0–5) and blue (0–4):

  ```
  blue = c[3:0] mod 5
  red  = c[3:0] div 5 + 3·c[4]
  ```

  `c[3:0]` runs 0–14, so red × blue = 6 × 5 = 30 of the 32 values of `c`. The
  codes `01111` and `11111` are unused.

That is 7 × 6 × 5 = 210 colours, which is every colour the DACs can make.

Palette entries are stored as 8-bit direct-format bytes and go through the
same decoder as direct pixels. A palette entry with `t = 000` shows black.

The palette lives in one `SB_RAM40_4K` (iCE40 LUTs can't be RAM). It is dual
ported, so the CPU can rewrite entries mid-frame for colour cycling and
flashing. The read is synchronous, so the direct path is delayed a cycle to
match:

```
byte ─┬─ EBR[c] ──┐
      └─ delay ───┴─ select on t==000 ─ decode ─ IO flops ─ pins
```

The nine DAC outputs are registered in the IO flops, so the decode logic's
glitches never reach the pins and all nine switch together.

### Decode

| | LUT4s | layers |
|---|---|---|
| green: `t - 1`, then encode | 3 | 1 |
| blue: `c[3:0] mod 5`, then encode | 3 | 1 |
| red: `c[3:0] div 5` | 2 | 1 |
| red: `+ 3·c[4]`, then encode | 3 | 2 |

The encoding step is free: each output bit is a LUT whatever function it
computes.

## DACs

Each channel is three iCE40 pins into a resistor network, from a 3.3 V bank
(VCCIO = 3.3 V; iCE40 pins are not 5 V tolerant). The monitor terminates
each line in 75 Ω to ground.

```
 x[2] ──[ R2 ]──┐
 x[1] ──[ R1 ]──┼──────────► VGA red / green / blue
 x[0] ──[ R0 ]──┘
```

The pins are not binary weighted. The weights are chosen so that **all three
pins high is exactly full scale (0.7 V)**. As a result:

- No pin pattern overdrives the monitor, whatever the decoder outputs,
  including for the unused `c` codes.
- The worst pin current is about 5 mA, within the rated iCE40 drive. A binary
  ladder for blue 0–4 would need about 12 mA from one pin.

1% resistors. The ratios keep the steps even; the absolute values only set
full scale.

| channel | weights x[2] x[1] x[0] | R2 | R1 | R0 |
|---|---|---|---|---|
| green | 3 2 1 | 562 Ω | 845 Ω | 1.69 kΩ |
| red | 2 2 1 | 698 Ω | 698 Ω | 1.4 kΩ |
| blue | 2 1 1 | 562 Ω | 1.13 kΩ | 1.13 kΩ |

### Pin encodings

| level | green `x[2:0]` | red `x[2:0]` | blue `x[2:0]` |
|---|---|---|---|
| 0 | 000 | 000 | 000 |
| 1 | 001 | 001 | 001 |
| 2 | 010 | 010 | 100 |
| 3 | 100 | 011 | 101 |
| 4 | 101 | 110 | 111 |
| 5 | 110 | 111 | |
| 6 | 111 | | |

### Levels into 75 Ω

Computed with the E96 values above.

| level | green | red | blue |
|---|---|---|---|
| 0 | 0 | 0 | 0 |
| 1 | 0.116 V | 0.139 V | 0.173 V |
| 2 | 0.231 V | 0.280 V | 0.348 V |
| 3 | 0.348 V | 0.419 V | 0.521 V |
| 4 | 0.463 V | 0.559 V | 0.694 V |
| 5 | 0.579 V | 0.698 V | |
| 6 | 0.695 V | | |
| worst pin current | 5.3 mA | 4.3 mA | 5.3 mA |

### No 75 Ω back-termination

The source impedance is about 280 Ω. The monitor end is terminated, so
nothing reflects there and the source mismatch doesn't matter at 640×480
(25 MHz) over a normal cable. Matching it would need a shunt to ground and
much lower resistor values, pushing pin currents past what an iCE40 pin is
rated for (≈ 8 mA at LVCMOS33).

## Sync

640×480 @ 60 Hz. **Both syncs are active low.**

| | visible | front porch | sync | back porch | total |
|---|---|---|---|---|---|
| horizontal (pixels) | 640 | 16 | 96 | 48 | 800 |
| vertical (lines) | 480 | 10 | 2 | 33 | 525 |

Original VGA told the monitor its mode by the sync polarities alone. −/−
means 480 lines. −/+ is the 400-line text mode (640×400, 720×400 @ 70 Hz)
and +/− is 350 lines. Later VESA modes such as 800×600 @ 60 Hz are +/+.

The polarities are fixed at −/−; there are no polarity bits. The target is
640×480 and letterboxed or narrower pictures inside it, which the monitor
sees as the same mode, and modern monitors identify a mode mainly by its
line and frame rates.

### Pixel clock

Officially 25.175 MHz; anything from about 25.0 to 25.2 MHz works. From a
12 MHz board oscillator, `icepll -i 12 -o 25.175` gives 25.125 MHz:

```systemverilog
SB_PLL40_PAD #(
    .FEEDBACK_PATH("SIMPLE"),
    .DIVR(4'd0), .DIVF(7'd66), .DIVQ(3'd5),   // 12 × 67 / 32 = 25.125 MHz
    .FILTER_RANGE(3'd1)
) pll (
    .PACKAGEPIN(clk12), .PLLOUTGLOBAL(pclk),
    .RESETB(1'b1), .BYPASS(1'b0), .LOCK(locked)
);
```

Use `SB_PLL40_CORE` instead if the clock pin can't feed the PLL pad.

### Timing generator

The timing is programmable, in the order the phases happen:

```c
struct timing {
  // Standard VGA             H      V
  uint16_t front_porch;   // 16    10
  uint16_t pulse;         // 96     2
  uint16_t back_porch;    // 48    33
  uint16_t pixels;        // 640  480
  //       total             800  525
};
```

One module, instantiated twice: the horizontal copy steps every pixel clock,
the vertical copy once per line. It never adds the lengths up, so no total
appears in the hardware. Each copy is a 2-bit `state` and a 10-bit
`countdown`:

```
state      0 FP → 1 SYNC → 2 BP → 3 VISIBLE → 0 FP ...
step:      if countdown == 0:  countdown = timing[state + 1] - 1,  state = state + 1
           else:               countdown--
sync_n  =  !(state == SYNC)
active  =   (state == VISIBLE)
```

- The load goes through the counter's own decrementer,
  `next = (countdown == 0 ? timing[state + 1] : countdown) - 1`, so there is
  one 10-bit decrementer and no separate subtract. `timing[state + 1]` is a
  4-to-1 mux with its inputs wired one place round, not an adder.
- **The vertical copy steps when the horizontal state goes from VISIBLE
  back to FP.** Every vertical edge, VSYNC's included, therefore falls at
  the start of a horizontal front porch. The vertical VISIBLE phase starts
  with line 0's horizontal blanking, which is where line 0's four table
  reads happen.
- Every length must be at least 1: a 0 loads 0 − 1 = 1023.
- A timing register written mid-frame takes effect the next time its phase
  is entered.

HSYNC never stops. Each of the 525 lines, blank or not and including the two
VSYNC lines, has its own pulse; vertical blanking is just lines without
pixels.

A line counter, cleared as the vertical VISIBLE phase begins, gives the
line number n that indexes the line tables.

A letterboxed or narrow picture keeps these standard timings and draws black
where the picture isn't, so the monitor sees plain 640×480. An LCD's
auto-adjust finds the picture's edges from where the content stops being
black, though, so run it on a full-screen image or it may stretch or shift a
letterboxed one.

- `hsync_n`, `vsync_n` and `visible` go through as many flops as the pixel
  pipeline (fetch, palette EBR, output register), so sync and blanking line
  up with the pixels they belong to.
- The DAC pins are forced to 0 whenever the delayed `visible` is false. The
  monitor takes the back porch as its black reference; colour there tints
  or drifts the picture.
- The syncs are registered, ideally in IO flops: the phase decode is
  combinational, and a glitch on HSYNC causes jitter.

### Electrical

The sync inputs are high-impedance TTL, so 3.3 V drives them directly. Each
goes through a 47–100 Ω series resistor to damp ringing and protect the pin.

## 640×512 @ 50 Hz (experimental)

For BBC Micro emulation. Horizontal timing is exactly 640×480's; the
vertical total is stretched to make 50 Hz at the same pixel clock:

| | visible | front porch | sync | back porch | total |
|---|---|---|---|---|---|
| horizontal (pixels) | 640 | 16 | 96 | 48 | 800 |
| vertical (lines) | 512 | 46 | 2 | 69 | 629 |

25.175 MHz / 800 / 629 = 50.03 Hz (49.93 Hz from the PLL's 25.125 MHz; the
BBC ran at 50.08 Hz). Syncs −/−, as for 640×480.

Not every monitor will take it. Many LCDs accept 50 Hz for 576p TV timing
(31.25 kHz, 625 lines, close to this), but some are specified from 56 Hz.
It can be tried from a PC's VGA output first:

```
xrandr --newmode "640x512_50" 25.175  640 656 752 800  512 558 560 629  -hsync -vsync
```

512 lines is the most the line tables hold: 512 × 2 bytes fills each 1 KB
array exactly.

### BBC Micro modes

| BBC mode | | here | frame buffer |
|---|---|---|---|
| 0 | 640×256, 2 colours | 1 bpp, width 1, each line pointer twice | 20 KB |
| 1 | 320×256, 4 colours | 2 bpp, width 2 | 20 KB |
| 2 | 160×256, 16 colours | 4 bpp, width 4 | 20 KB |
| 7 | teletext, 40×25 | text, doubled pixels, 20 lines per row | 1 KB + font |

The background palette ranges match the BBC's colour counts: mode 0 uses
entries 28–29, mode 1 24–27, mode 2 0–15. VDU 19 and flashing colours are
palette writes.

### Teletext

Mode 7 is 25 rows of 20 lines, 500 of the 512.

Teletext attributes (colour, mosaics, double height, flash, conceal, hold)
take effect from a control code to the end of the row. The GPU does not
parse them: the CPU walks each 40-byte row as the SAA5050 would and writes
per-cell character codes, foreground colours and background.

**Double height can start mid-row.** The font has 192 glyphs and 40 rows:

| codes | glyphs | rows 0–19 | rows 20–39 |
|---|---|---|---|
| 32–127 | normal | the 20-row glyph | the same again |
| 128–223 | double height | top half, each row twice | bottom half, each row twice |

From a double-height control code on, the CPU adds 96 to the codes. An upper
row uses font rows 0–19 and the row below it rows 20–39, so the same codes
show the bottom halves while normal characters look the same in both.

192 glyphs is a stride of 6: `font_line = 6r`, and row r covers
0x1000 + 192r + 32 to 0x1000 + 192r + 223. A byte of `font_line` reaches
row 42, so all 40 fit: 7,680 bytes, ending at 0x2D5F.

The 128 mosaic glyphs don't fit beside these in 256 codes. They may go in the
background layer instead: a 16-pixel cell is two 8-wide background pixels,
the mosaic's two columns, and its three block rows (6, 8 and 6 lines) are
line-table entries. Contiguous mosaics fit that directly.

Separated mosaics are approximate. The gap between block rows is a line
whose pointer shows the cell's background in mosaic cells, which is cheap.
The gap between the left and right blocks is not possible: a block is one
8-wide pixel, and narrower pixels (width 2, 4 bpp) would cost about 24 KB
for a screen. So separated mosaics are drawn with gap lines but no gap
columns.

## Registers

Under 64 bytes, in an I/O page whose place in the memory map is not yet
chosen.

| register | contents | access |
|---|---|---|
| `timing_h` | `struct timing`, 4 × 16 bits, 10 used | write only |
| `timing_v` | `struct timing`, 4 × 16 bits, 10 used | write only |
| control | display enable, which buffer is shown, write-through request | write |
| status | current line (10 bits), vertical blank, write-through in progress | read |
| palette | 32 × 8 bits | write, through the EBR's second port |

The timing registers are write only because reading them back would need a
16-bit 8-to-1 mux onto the data bus, about 50 LUTs, for values the CPU wrote
itself. The timing costs 80 flops of the UP5K's 5,280.

The status register's current line lets the CPU time a mid-frame palette
change by polling, without an interrupt.

## Connector (DE-15)

| pin | signal |
|---|---|
| 1 | red |
| 2 | green |
| 3 | blue |
| 5, 10 | ground |
| 6, 7, 8 | red, green, blue return: ground |
| 13 | HSYNC |
| 14 | VSYNC |
