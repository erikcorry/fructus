# pop and ldm at N + 1 — measured 2026-10-23, not on main

ld and ld8 write their register as its word arrives, from the memory's port,
and never stop dispatch (rtl/cpu.sv, THE MEMORY SEQUENCER).  pop and ldm can
do the same.  It works and costs little, but gains almost nothing today, so
it is kept here: `ideas/two-cycle-pop.patch`, on top of the commit that made
ld and ld8 two cycles.  It leaves out the generated rtl/classify.sv and
rtl/ucode.sv: `npm run rtl` after applying it.

## The design

- The pointer is written in the load's ALU cycle, through the ordinary write
  port: the ALU makes where it ends, `aq + 2n` (a block load's `moff_d` is
  +2n, as a push's is -2n), and `pnow` enables `e_ptr` with data `y`.  Its
  first address is the pointer itself, `aq`: the address mux's load arm is
  `e_pa ? aq : asum`, `e_pa` a flop, and `mar` takes the same.  2n is even,
  so the alignment bit is the same.
- Every register is written from the port as its last byte arrives (M);
  done at N; released at N - 2, in the ALU cycle (`urs`) for two accesses,
  and not stopped at all (`skp`) for one.  No P step.
- A loaded register that is the pointer is still not written, so the
  semantics are unchanged.
- Blit mode's late ldm keeps its old routine; pop has no late copy and goes
  N + 1 there too.
- cpu-check passed in full.

A first try put the pointer's own sum, `ptrv`, on the write port as a third
source: 27.42 MHz median over 16 seeds, `a.a -> R[k]` through ptrv's carry
chain.  Letting the ALU make it costs nothing on that path.

## Figures

| tree, 64 seeds, same day | median | best | LUT4 | FM -Os -mmul | FM -O2 -mmul |
|---|---|---|---|---|---|
| HEAD 95b9402 | 29.62 | 32.38 | 2815 | 128.1 | 135.3 |
| ld/ld8 N + 1 | 29.41 | 31.82 | 2888 | 138.4 | 146.5 |
| + pop/ldm N + 1 | 29.26 | 30.95 | 2942 | 138.6 | 146.6 |

## Why the gain is small

The simulator does take the cycle off: pop 4.00 -> 3.00 cycles on average,
ldm 4.48 -> 3.48.  But in DeltaBlue loads saved 33,260 cycles and ret cost
24,534 more (CPI 2.86 -> 3.65), jmp 4,226 more: net 4,154.  An epilogue's
`pop lr, ...; ret` now dispatches the ret while the pop's last address is on
the bus, so the ret's guessed target is read a cycle later through pjq -
exactly when it was read before.  n words and the target are n + 1 bus
cycles whatever dispatch does.

memcpy does gain (CPI 3.53 -> 3.29 in DeltaBlue, 4.18 -> 3.86 in jpeg), but
it is 0.1 - 0.3% of the benchmarks; memmove is 596 instructions in a whole
Richards run, whose sliding collector moves almost nothing.

## What could make it pay

Anything that keeps the ret's target read off the pop's bus cycles:
- GCC popping lr earlier, if the end of the function needs fewer scratch
  registers;
- the predictor spotting the ret earlier;
- a fused pop-lr-and-return;
- a later system with code and data in separate memory banks.
