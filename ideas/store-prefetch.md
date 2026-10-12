# Fetch behind a store

Let a store dispatch the next instruction straight after its last address,
instead of a cycle later, so that a store of N accesses costs N + 3 cycles
like a load, not N + 4. `st` and `st8` would go from 5 cycles to 4, and every
`push` and `stm` would save one.

Parked until there is real silicon to try it on: the idea relies on how
the SPRAM's output behaves during a write, and so far only yosys's simulation
model has been checked, not the hardware.

## Where the cycle goes

`st r1, [r2, #4]`, aligned, with cycle 0 as its dispatch:

| Cycle | Stage | Port |
|---|---|---|
| 0 | dispatch | the word after pc's |
| 1 | decode | pc's word (`go = 0`) |
| 2 | ALU: address into `mar`, data into `wq` | **pc's word**: the default arm |
| 3 | the sequencer's access; `mrestart` | `mar`, written |
| 4 | the bubble | pc's word, again |
| 5 | the next instruction dispatches | |

A store's first access waits a cycle because of its data, not its address. It
reads `rs` through decode's left port in the ALU cycle (`kreg`, `wq`), so
nothing can be written before cycle 3. A load has no data to read, so its
first address goes out from the adder in the ALU cycle (`ldnow`). That is
also why loads can't get the same saving: they already use the port in that
cycle.

In cycle 2 nothing claims the port, and the address mux in `rtl/cpu.sv` falls
through to `{pcw, 1'b0}`. pc moved on to the next instruction when the store
dispatched, so the SPRAM is already reading the next instruction's word. That
word arrives in cycle 3 and nothing takes it. The bubble in cycle 4 reads it
again.

## The change

In yosys's `SB_SPRAM256KA` model (`/usr/share/yosys/ice40/cells_sim.v`),
`DATAOUT` is loaded only when `!WREN`. A write leaves it alone. If the silicon
does the same, the word read in cycle 2 is still on `mem_rdata` after any
number of store accesses. The next instruction can then dispatch in the cycle
after the last address and read the port as it always does, with no new mux
in front of decode. (A capture flop and a mux would also work, but decode's
path from the SPRAM is the critical one: a mux there once cost
27.35 MHz → 25.58.)

In `rtl/cpu.sv`, that means a store's `mrestart` sets `go <= 1` rather than
`stop <= 0`, and `use_nxt` stays clear. The pc's base and carry are resolved
combinationally (`pch`), so they don't need the bubble.

## What has to hold

1. **The silicon keeps `DATAOUT` through a write.** Check Lattice's SPRAM
   documentation, then test on the board: write a store followed by an
   instruction whose bytes differ from the previous read's, and run it in
   every alignment.
2. **`tools/fpga-system.sv` keeps its read selection through a write.**
   `src <= hi` and `io_q` update every cycle, so a store to the other 32K half
   or to an I/O register would switch `rdata` away from the word that was read.
   Both should load only when `we` is clear. Do the same for anything else
   that sits between the SPRAM and `mem_rdata`, including the blit build's
   `mem_data` and `mem_late`.
3. **A store into the next instruction's own word.** Today the bubble reads
   that word after the write, so the new bytes run. With the change, the old
   bytes would run. Either compare `mar[15:1]` against pc's word and keep the
   bubble when they match, or make the spec say a store to the next
   instruction's word takes effect only after a jump. The compare is 15 bits
   from flops, so it is off decode's path.
4. **The guard trap.** It looks safe: for a store, `ghit` is `gmar & weq &
   aphase` in the access cycle, so `gq` is set in time for `take = go & (...
   | gq)` in the new dispatch cycle. But the comment beside it ("the next
   dispatch is two after the last address either way") needs rewriting, and
   the timing should be confirmed in simulation.
5. **Pointer writes.** A store's routine writes its pointer last (`uP`).
   "Every write lands before the next instruction reaches decode" must still
   hold with decode one cycle earlier. If it doesn't, the routine has to write
   the pointer a step sooner.

## The cost model

Change N + 4 to N + 3 for stores in `[cpu]` in `isa/fructus.toml`, in
`tools/sim.js`, in the README's cost-model paragraph and in the header of
`rtl/cpu.sv`. `tests/cpu-check.mjs` will flag any place the RTL and the
simulator disagree.

Measure with `just speed 16`. A median within the noise of the current
30.8 MHz is good enough to keep the change. On `tests/bench`, count how many
cycles the stores take now, to see how much the change is worth.
