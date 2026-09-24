# VGA output

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

### Counters

```systemverilog
logic [9:0] hc, vc;                  // 0..799, 0..524

always_ff @(posedge pclk) begin
    if (hc == 799) begin
        hc <= 0;
        vc <= (vc == 524) ? 0 : vc + 1;
    end else
        hc <= hc + 1;
end

wire visible = hc < 640 && vc < 480;
wire hsync_n = !(hc >= 656 && hc < 752);   // 640+16 .. +96
wire vsync_n = !(vc >= 490 && vc < 492);   // 480+10 .. +2
```

- `hsync_n`, `vsync_n` and `visible` go through as many flops as the pixel
  pipeline (fetch, palette EBR, output register), so sync and blanking line
  up with the pixels they belong to.
- The DAC pins are forced to 0 whenever the delayed `visible` is false. The
  monitor takes the back porch as its black reference; colour there tints
  or drifts the picture.
- The syncs are registered, ideally in IO flops: the comparisons are
  combinational, and a glitch on HSYNC causes jitter.

### Electrical

The sync inputs are high-impedance TTL, so 3.3 V drives them directly. Each
goes through a 47–100 Ω series resistor to damp ringing and protect the pin.

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
