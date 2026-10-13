# An instruction buffer and fetcher

An experiment, not the core: nothing in `rtl/`, `docs/` or `tools/sim.js`
reflects it, and the cycle figures there are still the old core's.

## The idea

The pipeline gets one more stage in front.  A fetcher with its own word
pointer, `fp`, reads a word in every cycle the bus is free - the load/store
sequencer and the redirects win any collision - and appends it to a small
buffer.  Dispatch and decode read only the buffer's flops, never the memory
port.  A word is kept only if there will be room for it when it arrives.  A
taken branch or jump empties the buffer, and its target's read is the first
fetch.

Loads and stores lose the bubble in which the old core re-reads the next
instruction, and odd three-byte instructions lose theirs; taken branches and
jumps cost one cycle more.

## The buffer is word-aligned

Whole words go in, so the buffer's first byte is always at an even address:
the opcode is at `pc[0]`, a flop, and an arriving word always lands in a
word slot.  An odd target's low byte is simply passed over.  A first
version shifted bytes, appending a lone high byte after an odd target; its
every byte chose among six sources, and it cost 401 LC.

`W3q` is the one to build on: three words (six bytes) shifted by 0, 1 or 2
words.  Two further choices make it small and keep it off the critical path:

- **The length is classified per byte** (`IB_PRECL`): `iw[0]`'s two bytes
  each have a two-bit length classifier, and `pc[0]` picks the length, so
  the reader's mux is not in the loop from the buffer through the length to
  `go`, `pc` and `fp`.
- **One LUT after the late select** (`IB_1L`).  A slot takes the word at
  position `s`, the number of words shifted out, and position `p` holds
  `iw[p]` if it is valid and the arriving word if not - which is known
  early, from `nw` and the port.  So slot 0 is `s == 2 ? e2 : e1`, slot 1
  `s == 1 ? e2 : port` and slot 2 the port, and holding is the flops' clock
  enable.  A slot at or past `nw` may load anything.

## Results

Cells are pack-only logic cells for the plain core (`tools/fpga-top.sv`);
MHz is the median of 16 nextpnr seeds; cycles are the cut-down DeltaBlue
(SOMpp e62e7f7d, `-mmul`) on the RTL in iverilog.  The checker
disagrees only on program 110, which reads the cycle counter.

| Build  | Defines                  | LC   | MHz   | DeltaBlue cycles | ms    |
|--------|--------------------------|-----:|------:|-----------------:|------:|
| old    | (rtl/)                   | 2421 | 30.11 | 3,875,255        | 128.7 |
| bytes  | (first version)          | 2822 | 29.39 | 3,570,472        | 121.5 |
| W3     |                          | 2683 | 28.12 | 3,570,472        | 127.0 |
| W3p    | IB_PRECL                 | 2696 | 29.01 | 3,570,472        | 123.1 |
| **W3q**| IB_PRECL IB_1L           | 2579 | 28.91 | 3,570,472        | 123.5 |
| W2p    | IB_MAXS1 IB_PRECL        | 2730 | 29.14 | 3,608,288        | 123.8 |
| W4p    | 'IBW_N 4' IB_PRECL       | 2740 | 29.23 | 3,558,530        | 121.7 |
| A8p    | IB_WIN IB_PRECL          | 2843 | 26.05 | 3,558,530        | 136.6 |
| **s1** | W3q, ST_EARLY=1          | 2615 | 30.20 | 3,422,247        | 113.3 |

s1's cells and MHz are on the ISA after 197601f, which dropped the
one-register stm and ldm; W3q there is 2598 LC at 29.78 MHz.  Its DeltaBlue
cycles are on the ISA before, since the SOM++ binary's hand-written libc and
libgcc routines still use them (`git show 197601f^` gives the generators).

W3q is +158 LC over the old core for -7.9% cycles.  Its critical paths are
the ALU's and the microcode's (`aq`, `bq` -> `R`, ROM -> `aq`), as the old
core's are; the buffer is in none of the 16 seeds' but one, `ie -> fp`.

Lessons:

- Limiting the shift to one word (W2) saves nothing: on a LUT4 a 3:1 mux
  costs what a 4:1 does, and the bubble costs 1.1%.
- The window (A8, eight bytes that never move, read through 8:1 muxes) is
  small but slow: `pc[2]` is `pcb[0] ^ pcc`, a level more in the loop.
- Drops are negligible in real code; four bytes against six is banking.
  DeltaBlue's mean instruction is 2.19 bytes against a fetch of two a cycle.
- The length the buffer shifts by must not wait for `take` (masking `take`
  into the opcode first cost 7 MHz), and late signals must only select
  among candidates worked out from flops.

## Stores release a step early (s1)

With the buffer, dispatch no longer needs the bus, so a store releases
dispatch a step before its last access: the next instruction reaches decode
in step N + 1, after the routine's last read through decode's borrowed port
in step N - 1, and a block move's pointer, written at N + 1, reaches it
through the bypass of the routine's last write.  A store of one access
releases in its ALU cycle, through predecode's `urs`, as a one-access load
does.  Only the generators change, `st-early.patch`; `ST_EARLY=1` with
`mk.sh` applies it to a copy of `tools/` and regenerates `ucode.sv` and
`classify.sv`.

Every store is a cycle shorter - 3 cycles for one access, against 4 in W3q
and 5 in the old core - and DeltaBlue is -4.2% on W3q, -11.7% on the old
core, for 17 LC and no loss of clock.  Two steps early would gain nothing:
a store that is not a block move has at most two accesses, and a block
move's pointer is written through the ALU at N + 1.

**It breaks the I/O guard trap by one instruction.**  `gq` is set from the
store's access, and the instruction after the store now dispatches in that
cycle, so it runs before io_guard is entered (the checker's programs 106 and
107).  The fix is either a guard test on the first address in the ALU
cycle - through the adder, as the blit stack fault was - or squashing that
instruction in decode.

## Still to do

- Blit mode (the delayed load) and traps with the buffer, including the
  guard trap above.
- One-byte instructions (`mov` to and from r5 is very common), and a branch
  predictor fed from the fetcher.
- Then `tools/sim.js`'s cost model, `tests/cpu-check.mjs`'s cadence and the
  documented cycle counts.

## Reproducing

From the repo root:

    experiments/ib/mk.sh w3q IB_PRECL IB_1L        # build/ib/rtl-w3q
    ST_EARLY=1 experiments/ib/mk.sh s1 IB_PRECL IB_1L
    experiments/ib/cells.sh build/ib/rtl-w3q w3q   # LUT4 and LC

The checker and `tools/speed.mjs` take the RTL from `FRUCTUS_RTL`
(`tools/speed.mjs` needs that two-line change, and `SPEED_OUT` for its
output directory, applied by hand for now):

    FRUCTUS_RTL=build/ib/rtl-w3q node tests/cpu-check.mjs

`tests/cpu-check.mjs` will report cadence mismatches against the old cost
model; only the register and memory disagreements matter here.

DeltaBlue: write SOMpp's `build-fructus-awfy-mmul/SOM++.bin` as a 64K-byte
hex file, one byte per line, to `build/ib/db.hex`, then

    iverilog -g2012 -o build/ib/run-w3q.vvp \
      build/ib/rtl-w3q/{cpu,classify,alu,ucode,lhs,dest,immgen,cond,compare,recip}.sv \
      experiments/ib/run.sv
    vvp build/ib/run-w3q.vvp      # about ten minutes
