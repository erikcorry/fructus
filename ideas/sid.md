# A SID-like sound engine in the FPGA

The inside of the FPGA; `ideas/audio.md` is the circuit outside it.  That
circuit takes one bitstream pin and doesn't care what makes the bits, so all of
this can change without touching the board.

Aim: something like the C64's SID, not a copy.  Three voices, four waveforms,
ADSR envelopes, a filter with low, band and high pass and resonance, using the
multipliers.  Not register-compatible and not cycle-exact; a driver can
translate SID tunes' register writes if that's wanted.

Nothing here is built.  **Every cell count for the engine is a guess until
stage 2 below measures it.**

## Smallest version: a square wave buzzer

For a build with no room for the rest.  Same pin, same board, same register page.

| version | cells (guess) | needs the CPU to keep it going? |
|---|---|---|
| one output bit, toggled by software | under 10 | yes, every half period |
| period register and counter: 12 bits each, a /64 prescale | 30 - 40 | no, it plays until stopped |

With the counter, a half period of N gives 25.175 MHz / 64 / 2 / N: 48 Hz to about
4.4 kHz, and at the top one step of N is about 38 cents, so high notes are slightly
out of tune.

- **It's loud, with no volume control.**  Square waves swing the full range: 2.6 V
  peak across the speaker with the 18k default, about 0.85 W into 8 ohm, twice the
  sine figure in `audio.md`.  Check the speaker's rating.  Gating the output with a
  fast duty pattern would make volume steps for a few cells more, and the board's
  filter removes the pattern.
- **Stop it at a constant level.**  Stopping clicks, and that's accepted.
- **`amp_sd_n` is still wanted**, as in Start-up below, unless the thump at power-on
  is acceptable.

## Room, and audio as a build option

The system with UART and USB is 4946 of 5280 logic cells (d47bd62), 29.62 MHz
median, 31.07 best, so 334 are free.  A full system is hard to place and slows
down, so not all of those are usable.

An FPGA needn't hold everything at once.  Audio becomes an option, like
`FRUCTUS_UART` and `FRUCTUS_USB`, and an audio build can leave other things out.
Places to find room:

| leave out | saves | costs | status |
|---|---|---|---|
| USB port | about 170 cells | no keyboard or mouse | already an option |
| UART | about 110 cells | no serial console | already an option |
| dynamic branch predictor | to measure | CoreMark about 5 - 9% slower, DeltaBlue about 5%, from when it landed | needs an option in `rtl/cpu.sv` |
| return stack | about 150 cells | Richards and the like slower; FM to measure | needs an option |
| sprites | to measure | no sprites | to look at |

All of these keep the instruction set, so one binary runs on every build, only
at a different speed.  The processor only has to stay above the 25.175 MHz pixel
clock: the 4 MHz of margin today may also be spent, and a fuller chip will use
it.  Software can't tell a missing predictor, but can tell a missing device, so
programs that use one need that build.

Leaving out the predictor means simulator and model cycle figures need to know
the variant if they're to be compared with that build.

## Resources

| resource | used | free | engine needs |
|---|---|---|---|
| SB_MAC16 | 2 of 8 | 6 | up to 4: plentiful, so spend them to save cells |
| block RAM | 8 of 30 for the core; the system's total to measure | at least several | 3 or so |
| I/O page | 0x0436 - 0x047f free | 37 words | about 19 words |

**Registers need no load path.**  The engine's registers are write-only, and a
load gets `ram_lo`'s copy of what was stored, so software can read back what it
wrote at no cost.  Nothing joins the late-bit load mux (`late-bit-io`), which
has cost MHz before.  So no voice 3 readback at first; add it through the late
port if something wants it.

## Design: one small datapath and a table

Two ways to build it:

- **Each voice in its own logic.**  Three of everything, plus a multiplier and
  a block of flops each.  My guess is 600 cells or more.  Doesn't fit in any
  plausible build.
- **One datapath, time-shared (recommended).**  A few MACs doing the arithmetic, a
  program in block RAM saying what each step is, and all state in block RAM.
  My guess is 250 - 300 cells, and the filter is nearly free, being more steps
  on the same hardware.

There are many clocks per sample, so sharing costs nothing audible.  It's the
same move as `immgen` and the predecode ROM: table instead of logic.  It also
suits iterating, because many changes are only new ROM contents.

```
          +--------+    +--------+
step ---->| step   |--->| regs   |---+--> voice MAC  (wave former in) --> mix
counter   | ROM    |    | BRAM   |   |
          |        |--->| state  |---+--> filter MAC --> state write, mix
          +--------+    | BRAM   |   |
                        +--------+   +--> phase MAC ---> state write

CPU store --> regs BRAM's write port
```

A block RAM has one read and one write port, so it takes two: **regs** (the CPU
writes, the engine reads) and **state** (the engine reads and writes).  That
also means the CPU's stores never collide with the engine.

### Timing

64 clocks a sample gives 25.175 MHz / 64 = 393 kHz.  A rough budget:

| work | steps each | total |
|---|---|---|
| 3 voices: phase, noise, wave, envelope, multiply, mix | 12 | 36 |
| filter | 8 | 8 |
| output, clamp | 4 | 4 |
| spare | | 16 |

32 clocks (787 kHz, nearer the SID's 1 MHz) gives less aliasing, if the program
fits.  Decide from the model in stage 1.  The sample rate depends on the system
clock, so this assumes the VGA clock; a build at another clock would be off
pitch unless software scales its frequency values.

## The pieces

**Phase.**  A 24-bit accumulator per voice, two state words.  A 16-bit frequency
register, shifted left 2 at 393 kHz: steps of 0.094 Hz, top 6.1 kHz.  The SID's
top is about 3.9 kHz.

**Waveforms**, from the top 12 bits of phase:

| wave | how | logic |
|---|---|---|
| saw | those bits | none |
| triangle | low 11 bits, XORed with the top bit, shifted up | 12 XORs |
| pulse | compare with the 12-bit width register | the adder, or about 7 cells |
| noise | 23-bit LFSR, clocked when phase bit 19 rises; 8 of its bits | state words, a few cells |

Selecting several ANDs them, which is about what the SID does.  Its real combined
waves are analog oddities and won't match.  Worth 12 cells or so, not more.

**Modulation.**  Sync resets a voice's phase when the previous voice's top bit
rises; ring XORs the triangle's fold bit with the previous voice's top bit.  A few
cells between them, and they make a lot of the strange SID sounds.

**Pulse width sweeps** stay in software, as on the C64, written once a frame or
faster.  It's cheap: a store.

**Envelope.**  A gate bit starts attack, decay, sustain; release on gate off.
Level is a 16-bit state word.  Attack adds a rate.  Decay and release subtract
`level * rate` using the MAC, which gives a true exponential with no piecewise
table.  Rates are 16 words of ROM, picked by the SID's 4-bit values, or software
writes the rates directly.  Software-only envelopes at 50 Hz would be too slow
for percussive sounds, so this is the first thing to keep in hardware.

**Multipliers.**  Free ones are plentiful and cells aren't, so don't share one
if sharing takes operand muxes.  Each SB_MAC16 also holds a 32-bit adder and
accumulator with a load input, so it can replace fabric adders too:

| MAC | job | operands |
|---|---|---|
| voice | `wave * level`, and its accumulator sums the voices into the mix | wave former, state BRAM |
| filter | `f * band`, `q * band`, and the integrators' additions | regs BRAM, state BRAM |
| phase (maybe) | the 24-bit phase and noise-clock addition, instead of a fabric adder | state BRAM, regs BRAM |
| DAC (maybe) | the sigma-delta's accumulator, carry out to the pin, if the carry can reach fabric | sample register |

Wired straight from a block RAM's output, an operand costs no cells at all, which
may take the engine well below the guess above.  Check this first in stage 2,
including whether a BRAM-to-DSP path is fast enough at 25.175 MHz, and whether the
carry output is usable.  See `nextpnr-blind-to-sb-mac16`: nextpnr doesn't time
through the DSP, so use icetime too, and don't pass -dsp.

**Filter.**  One Chamberlin state-variable filter, the same two-integrator shape
as the SID's analog one:

```
low  += f * band
high  = in - low - q * band
band += f * high
```

- `f = 2 sin(pi fc / fs)`.  Software computes `f` and `q` and writes them.  So no
  table in hardware; the driver can have a table matching whichever SID it likes.
- Stable while `fc` is under about `fs/6`, so easily here.
- At 393 kHz, 30 Hz is `f` of about 0.0005.  So the state wants about 24 bits:
  the top 16 go to the MAC, and all 24 accumulate.  Too few bits gives noise or
  stuck tones at low cutoff.  Check in the model.
- Each voice has a bit for through the filter or around it.  Mode bits add any of
  low, band and high to the output, so notch and the like come free.
- Saturate on `band` for some 6581 grit, and to tame high resonance.  Later.

**Output.**  Sum to a 16-bit value, clamped since resonance can overshoot, times a
master volume, held for the DAC.

**DAC.**  First-order sigma-delta at the full clock.  16 bits in:

```verilog
reg [16:0] acc;
always @(posedge clk) acc <= acc[15:0] + sample;
assign audio_out = acc[16];     // the carry
```

Its idle tones are worst near 0 and full scale; centred audio mostly avoids them.

## Registers

About 19 words at 0x0440 - 0x0466, all write-only:

| what | words |
|---|---|
| each voice: frequency, pulse width, control (gate, sync, ring, wave bits, filter route), attack/decay, sustain/release | 5, x 3 |
| filter `f`, filter `q`, filter mode, master volume | 4 |

Stage 0's sample register and amp enable are 2 more, 0x0436 and 0x0438.  Stage 0
writes samples there; once the engine is in, its output replaces them.

## Start-up

From `ideas/audio.md`: the pin is pulled high during configuration, which holds
the filter at the top of its range.  So after reset the sample register starts at
full scale, software ramps to mid-scale over about 100 ms, waits for the board's
bias (2 s from power-up), then sets `amp_sd_n`.  Its reset value is 0.

## Stages

Each is useful alone, and stops being worth continuing if the last one disappoints.

0. **The DAC alone.**  Sample register, sigma-delta, amp enable: about 35 cells,
   so it fits now.  Software writes samples.  This proves the board and the noise
   floor.  An interrupt per sample, say at 15 kHz, leaves about 1700 cycles each,
   so simple software voices are possible, though with audible aliasing.
1. **A model.**  JS next to `tools/sim.js`, writing WAV (ffmpeg is here, aplay too).
   Needs no FPGA.  Settles clocks per sample, word widths, the envelope and the
   filter by ear, and gets a test vector for stage 2.  reSID makes a reference for
   how close it sounds.  This is the cheap place to iterate.
2. **One voice in RTL, then three.**  First real cell count.  Register-level
   behaviour checked against the model's samples, as `cpu-check` does for the core.
3. **The filter.**  Mostly ROM.
4. **Pick what to leave out.**  Measure the variants in the table with
   `speed.mjs --system`, 16 seeds, median and best, and FM for the performance
   cost, then choose.  If the engine fits with USB gone and the rest is intact,
   the predictor stays.

## Questions for later

- How many cells does the predictor really save?  It holds its table in block RAM,
  so the logic is what comes back, and I don't have that figure.
- Do more voices come free?  With a time-shared engine, voices cost steps and state,
  not cells, so 4 - 6 may well be possible with the same logic.
- Should software see voice 3's output or envelope, as on the SID, for modulation?
  It needs the late port, so only if it earns it.
