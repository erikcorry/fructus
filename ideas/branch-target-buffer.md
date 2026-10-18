# A taken branch in two cycles: not by adding early, perhaps by a BTB

Where things stand (2026-10-18): tried on main 5430006 and not landed.
The experiment is build/cmp/pb2.patch (rtl/cpu.sv, tools/sim.js,
tests/cpu-check.mjs). It is not in git.

## What was tried

A conditional branch predicted taken reads its target the cycle after it
dispatches: it dispatches, `pc + 3 + sext(ib2)` goes into tgt_q, and `pbq`
redirects the next cycle. That is three cycles, against jmp's two, which
reads `{ib2, ib1}` straight from the buffer's flops as it dispatches.

The aim was to give the branch what jmp has: a target already in flops when
the branch reaches ib0. `ntgt`, a flop, held the target of whatever would be
at ib0 next cycle if it were a branch. Where that instruction's displacement
comes from depends on how far the pc moves now, and the classifier says
that late. So there were four sums, one for each dispatch length 1, 2 and 3
and one for none, each from flops and the arriving word (e1, e2,
mem_rdata), and `lenr` only picked one into the flop. The sum for no
dispatch counts from `jaddr` in a predicted call's ALU cycle: the buffer
then holds the target's words while the pc is only moving there.

A predicted branch then read `ntgt` as it dispatched (`pb`, spelled from
flops as `pj` is). The pc moved to the fall-through, so decode still had it
for a misprediction, and `pbm` moved the pc to tgt_q the cycle after. If the
sequencer had the bus, the old `pbq` path read the target a cycle later.

It passed cpu-check, interrupted and in blit mode, and dontcare-check. The
check needed a new program: a call whose target is a branch back, which
dispatches the cycle after the call's ALU cycle. Without that program,
`nb0 = pc` (dropping the jaddr case) passed every test.

## What it bought and cost

Sim (FructusMark -Os -mmul): 108.7 to 111.9, +2.9%. CoreMark -3.5% cycles,
compress -3.5%, eqntott -3.3%, richards -3.3%, DeltaBlue -1.7%.

| 16 seeds                            | cells | MHz   | spread                 |
| ----------------------------------- | ----- | ----- | ---------------------- |
| core, main                          | 2889  | 29.69 | 27.1 .. 30.3           |
| core, ntgt through raddr's +1       | 3064  | 26.18 | 24.7 .. 28.3           |
| core, ntgt with its own +1          | 3068  | 26.76 | 25.4 .. 28.3           |
| system, main                        | 4482  | 26.48 | 25.4 .. 26.9           |
| system, ntgt through raddr's +1     | 4620  | 23.34 | 21.3 .. 23.6           |
| system, ntgt with its own +1        | 4692  | -     | seed 2: no legal placement |

Breaking even needed a loss under about 0.8 MHz; it lost 2.9 on the core.
The system went below the pixel clock and then stopped placing.

## Why

The four adders were never on a critical path; the carry-select arrangement
worked. What cost was `pb` choosing the fetch. In 12 seeds of 16 the core's
critical path ends at `fp`, 9 cells from rst, pcl or taken_q. That path is
the decision to take the branch:
- `pbr`, the opcode check on whichever byte is ib0;
- the table's three tag compares against gh;
- the way's counter or ib2's sign;
- `~e_cbr`, `slot` and `nw >= 2`;
then fp's mux and the address mux.

jmp gets away with the same arm because its decision is an opcode compare
alone. The lesson in ideas/branch-prediction.md holds again: a late
signal is free into a flop's D input, but anything that chooses the next
fetch must come out of flops nearly as it is. So the taken decision has to
be a flop too, made a cycle or more before the branch reaches ib0.

## A latched guess loses almost nothing (2026-10-18)

Measured in a copy of tools/sim.js (build/bpv) on the seven -Os -mmul
FructusMark binaries. The question was whether the gh table's guess can
be worked out a cycle early and held in a flop. The table is indexed by
history alone, not by pc, so the guess does not need to know which branch
it is for. Only the sign bit, used on a miss, needs the branch's bytes.

The trap is learning. If the guess is read with an older history but the
table learns at the current one, the entry that was read never learns:

| variant                                              | FructusMark | CoreMark cycles | richards misses |
| ---------------------------------------------------- | ----------- | --------------- | --------------- |
| today: sign bit if the word is stale                 | 1.0000      | -               | 8.27%           |
| latched (index from 2 edges ago, tag from 1), learns at current gh | 0.9935 | +1.08% | 33.10% |
| latched, learns in the word it read                  | 0.9995      | +0.13%          | 8.70%           |
| index and tag both from 2 edges ago, learns there    | 0.9985      | +0.35%          | 8.75%           |
| no stale check, learns in the word it read           | 1.0004      | -0.14%          | 8.19%           |

So a latched guess costs about 0.05% if it learns where it looked. With
it, the taken decision is `pbr & (hit_q ? ctr_q : ib2[7]) & ~e_cbr`, from
flops, nearly as shallow as jmp's. That is the piece the early-target
attempt lacked. Learning where it looked needs no carried index: a stale
lookup always follows exactly one shift of gh, a branch's guess or a
jump's bit, so the word read is the committed history less its newest bit.
That takes one more bit on `ch`; the latched version needs two, and a
count of 0, 1 or 2 shifts carried down the pipe.

The last row was built (build/cmp/v6.patch, with a cpu-check loop that
catches a wrong write index): plain core 2922 cells / 29.38 MHz against
2889 / 29.69, system 4488 / 27.24 against 4482 / 26.48, both inside the
noise. Not landed: 0.04% is not worth 33 cells on its own. It is worth
building again only as part of the early target, with the guess latched.

## A branch target buffer instead

A BTB makes the decision where the fetcher already is, from the fetch
address, which is a flop, and a block RAM's output, which is a flop as well.

**Keyed by the word being fetched.** Read the BTB at `fp`, in the cycle the
SPRAM reads the word. Three-byte branches mean no two can start in one
word, so one entry per word address is unambiguous. An entry holds:
- the target, 16 bits;
- which byte of the word the opcode is at;
- a two-bit counter;
- a few tag bits of fp.

That is about 32 bits a word, so 256 entries are two SB_RAM40_4Ks.

**The verdict travels with the word.** When the word arrives, the BTB's
answer arrives with it: a hit whose counter says taken. That answer goes
into a flag beside the word in the buffer, and the target into one flop.
At most one such flag can be live: past a branch predicted taken, the
buffer's following words are the wrong path. The fetcher should stop there
until the branch dispatches, or later go on at the target (see below).
At dispatch, `pb` is then the flag of the word at ib0, its byte matching
pcl[0], with `pbr`, `slot`, `nw >= 2` and `~aphase`: flops and an opcode
check, the same depth as `pj`. The target is the flop, with no adder at all.

**What that saves:**
- The four sums go: ntgt's adders, about 180 cells against main.
- Block RAM is not what is short. The UP5K has 30 SB_RAM40_4Ks and the
  system uses 12, while logic cells are at 85% (4482 of 5280).
- The BTB learns targets the same way `bpm` learns now, a cycle after the
  ALU stage, on the separate write port.

**What it asks for:**
- **Direction from the pc, not gh.** At fetch the history is not known; the
  branches between here and dispatch have not been guessed. A per-entry
  counter is bimodal by address. In the 2026-10-15 replays
  (build/dynbp) bimodal x256 missed 9.0 / 8.5 / 12.5%
  (CoreMark -Os, -O2, DeltaBlue), where the current gh table with path bits
  misses about 5.4% on CoreMark -Os and 10.9% on DeltaBlue.
  - Either the BTB says only "a taken branch was here, its target is T",
    and the gh table still decides at dispatch; that brings back the deep
    `pbok`, unless the gh lookup also moves a cycle earlier.
  - Or bimodal decides alone, and the gh table can go, with its cells.
  The replay should say which wins once a correctly predicted taken branch
  costs 2 rather than 3.
- **Verification is the same as now.** The branch goes down the pipe with
  its condition inverted and the fall-through as its target. A stale entry
  on a non-branch is stopped by `pbr` at dispatch, as an aliased tag is by
  the verdict.
- **Redirecting at fetch, later.** Once the verdict is at the fetcher, the
  fetcher could fetch the target as soon as the branch's last word is in,
  and the taken branch would cost one cycle. But the buffer would no longer
  be contiguous: words up to the branch, then the target's words from a
  possibly odd byte. Dispatch's word-leaving logic (`sw`, `sel`), the
  tightest loop in the core, would need that case. Leave it until the
  two-cycle version has been measured.

## To do first

1. Replay the traces (build/dynbp) with a word-keyed BTB: 256 and 512
   entries, a few tag bits or none. Charge 1 for not taken, 2 for taken and
   right, and 5.5 for a miss. Compare against the current gh table at 1 /
   3.5 / 5.5. That says whether bimodal-plus-two-cycles beats
   gh-plus-three before any RTL.
2. If it does, build the flag-and-flop version with the counter in the BTB,
   and check that no seed's critical path goes through `pb` into fp or the
   address mux. Then the system's cells: the gh table out, two RAMs in.
