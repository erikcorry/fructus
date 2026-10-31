# Audio: external circuit for the board

For the board design.  Mono output, one FPGA pin, to two places:

- a 3.5 mm jack (TRS, no mic) for headphones, or as a line out for eg active
  PC speakers;
- a 1 - 2 inch speaker, which the jack's own switch silences when a plug is in.

Nothing here is built or measured; the figures are calculated.  The sound
itself (voices, envelopes, SID-style filter, mixing) is all in the FPGA, so
none of it affects the board.

## The signal from the FPGA

`audio_out` is a first-order sigma-delta bitstream, one bit per 25.175 MHz
clock, so it toggles at up to 12.6 MHz.  Its average voltage is the audio.
Silence is mid-scale: toggling, with an average of half the supply.

## Circuit

```
              A3V3
               |
FPGA     +-----------+                 filter node
audio_out|74LVC1G34  |--33R--4.7k--+-----+---- 1uF ---+----> op-amp IN+
    ---->|  buffer   |             |     |            |
         +-----------+           1.8k   10nF         100k
                                   |     |            |
                                  AGND  AGND         VMID

VMID:  A3V3 --100k--+--100k-- AGND, with 10uF from VMID to AGND


op-amp (TLV9061 as a unity-gain follower, on A3V3)

OUT --+--33R--[+ 100uF -]--+-------------> jack TIP
      |                    |
      |                    +--10k-- AGND
      |
      +--33R--[+ 100uF -]--+-------------> jack RING
      |                    |
      |                    +--10k-- AGND
      |
      (the amp's feed comes from TIP, through the switch below)

                                            jack SLEEVE --> AGND


jack's switch (closed to TIP when no plug is in, open when one is)

SW --+-- 0.22uF -- 18k --> PAM8302 IN+
     |
    100k
     |
    AGND                AGND -- 0.22uF -- 18k --> PAM8302 IN-


PAM8302 OUT+ --[ferrite + cap]--> speaker +
PAM8302 OUT- --[ferrite + cap]--> speaker -
```

## Values and why

| part | value | why |
|---|---|---|
| buffer | 74LVC1G34 on A3V3 | Its output levels come from the quiet rail, not the FPGA's noisy I/O supply.  Noise on that rail goes straight into the audio |
| damping R | 33 ohm, at the buffer | Tames the edges.  Part of the filter's source resistance, but small |
| divider | 4.7k over 1.8k | 3.3 V down to 0.91 V p-p |
| filter C | 10 nF, C0G or film | With the divider's 1.30k, cutoff 12.2 kHz.  X7R changes value with voltage |
| input C | 1 uF | With the 100k, a 1.6 Hz corner.  Removes the divider's DC |
| VMID | 100k, 100k, 10 uF | Biases the op-amp to 1.65 V.  Time constant 0.5 s, so it rises slowly and the output caps charge without a thump |
| op-amp | TLV9061 or equivalent | Needs at least 30 mA of output, 10 nV/rtHz or so.  TLV9061: 1.8 - 5.5 V, typically +/-50 mA short-circuit, 10 nV/rtHz at 10 kHz |
| series R | 33 ohm, one per channel | Isolates the op-amp from the 100 uF and the cable; limits the current; a mono plug shorting RING to SLEEVE is harmless |
| output C | 100 uF, 6.3 V or more | Into 32 ohm + 33 ohm, a 24 Hz corner; into 16 ohm + 33 ohm, 32 Hz.  Positive side towards the op-amp |
| bleed R | 10k | Holds the jack side at 0 V, so plugging in doesn't click |
| SW pull-down | 100k | Holds the amp's input cap when a plug is in, so the amp's input doesn't float |
| amp input C | 0.22 uF, both inputs | With 18k + the internal 10k, a 26 Hz corner, below what these speakers can make |
| amp input R | 18k, both inputs, 1% | Sets the gain, see below.  Diodes' evaluation board guide asks for 1% to match the two sides |

TIP and RING carry the same signal, each through its own resistor and cap.

## Levels

Op-amp output at full scale: 0.91 V p-p, centred on 1.65 V.

| load | level | power |
|---|---|---|
| line in, 10k or more | about 0.9 V p-p, consumer line level | - |
| 32 ohm headphones | 0.45 V p-p per ear | about 0.8 mW per ear |
| 16 ohm headphones | 0.30 V p-p per ear | about 0.7 mW per ear |
| 8 ohm speaker | 5.2 V p-p across it | about 0.42 W |
| 4 ohm speaker | 5.2 V p-p across it | about 0.84 W |

Worst-case op-amp current is about 27 mA peak: both channels shorted at the
plug, 0.45 V across 33 ohm each.

Amp gain, from the datasheet: `2 * 80k / (10k internal + external R)`.

| external R | gain | across the speaker | into 8 ohm |
|---|---|---|---|
| 18k (default) | 5.7 | 5.2 V p-p | 0.42 W |
| 10k | 8 | 7.3 V p-p | 0.83 W |

**Choose the 18k to suit the speaker's rating.**  The internal resistors have
a tolerance (24 dB +/-1.5 dB with no external R), so leave some margin.  Don't
go below 10k without checking clipping against the 5 V supply.

## Silencing the speaker

The jack's switch does this with no FPGA pin or software.  With no plug in, the
closed switch feeds TIP's signal to the amp.  A plug opens it, the amp gets no
signal and the speaker is silent.  Nothing in the amp's gain or
settings changes.

The switch must be in the **amp's input**, not in the speaker wires:

- **Never connect OUT+ or OUT- to ground or to each other.**  Both are driven
  (bridged, 250 kHz switching) and the speaker floats between them.
- The speaker is not connected to the jack in any way.

The amp stays powered with a plug in, 4 mA typical with no load.

## Power

| rail | source | use |
|---|---|---|
| A3V3 | own AP2127K-3.3, fed from 5 V through a ferrite bead | buffer, op-amp, VMID only |
| 5 V | USB 5 V through a ferrite bead | amp, at most 5.5 V |

At full scale, on a sine, the amp averages about 100 mA from 5 V at 0.42 W and
about 200 mA at 0.83 W, with peaks of twice that.
Decouple it as the datasheet asks: 1 uF ceramic at the VDD pin, 10 uF or more
close by.

AGND is the same ground plane as everything else, not a split: a name for the
quiet region, with the return currents of the FPGA and amp routed away from it.

## Pins

`audio_out` and `amp_sd_n` on ordinary I/O, near this circuit.  Not 39 - 41,
which are the open-drain LED pins.  2 and 3 are free in `fructus.pcf` today;
take whichever suits the layout, and update that file.

`amp_sd_n` goes to the amp's `SD`, with a 100k pull-down so the amp is off until
the FPGA has started.  SD needs 1.2 V or more for on, 0.4 V or less for off, so
3.3 V logic drives it directly.  This is not for the jack, but for start-up:

- the FPGA's I/O pull-ups hold `audio_out` high during configuration;
- so the filter node sits at 0.91 V, and moving to mid-scale would thump;
- the RTL or software keeps SD low, ramps from full to mid-scale over about
  100 ms, waits for VMID (2 s from power-up), then raises SD.

The datasheet also says to be in shutdown before power on or off for least pop.

## Layout

In order of importance:

1. Keep the amp, its ferrite and its speaker traces away from the filter, the
   op-amp and the jack.  Its switching currents are the noisiest thing here.
2. Keep the buffer and the trace from it to the filter short: it carries 3.3 V edges at 12.6 MHz.  The filter
   node and everything after it is quiet and high-impedance; keep it away from
   the VGA signals and the 25 MHz clock.
3. Keep the amp's input pair close together and equal, to keep its common-mode
   rejection.
4. Speaker wires under 20 cm where possible.  The datasheet's Figure 1 is the
   ferrite filter; follow its values for parts.
5. Bring the speaker out to a 2-pin connector, not soldered pads, so it can be
   mounted in the case.

Optional: 5 V bidirectional low-capacitance ESD diodes on TIP and RING, since a
plug is touched by people.  Worth leaving footprints.

## Parts

Each needs its datasheet in `board/datasheets/` and a line in `board/README.md`.

| part | what | status |
|---|---|---|
| PAM8302AASCR, LCSC C113367, MSOP-8; or PAM8302AADCR, C112137, SOP-8 | amp | Datasheet read for the figures above, except pinout and Figure 1 values, which are drawings.  SOP-8 has much the better thermal resistance, 115 vs 180 C/W: take it |
| TLV9061, SOT-23-5 | op-amp | Figures from TI's datasheet.  LCSC number to find |
| 74LVC1G34, SOT-23-5 or SC70 | buffer | Not yet checked |
| AP2127K-3.3TRG1 | regulator | Already on the board |
| 3.5 mm TRS jack with a normally-closed **tip** switch | jack | **Not chosen.**  Listings disagree: PJ-320D is variously sold with a detect switch and without, and with different pinouts under the same name.  Confirm from the datasheet of the exact LCSC part that the switch opens on insertion and is on the tip contact |
| speaker, 1 - 2 inch, 8 ohm, 0.5 W or more | speaker | Not chosen; sets the amp's input R |

## To check on the first board

- Noise floor at the jack with the output at mid-scale.
- Whether one RC is enough for the amp: its 250 kHz switching can beat with
  what's left of the bitstream, mainly near 0 and full scale.  Leave footprints
  for a second pole at the op-amp's input, after the 1 uF: 13k in series (fit
  0 ohm for now) and 1 nF to AGND (not fitted).  Fitted, that is 12.2 kHz, and
  the 13k with the 100k bias drops the level by about 12%.
- Any pop at plug-in and at start-up.
