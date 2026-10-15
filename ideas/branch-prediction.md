# Static branch prediction, and what abc does with it

Where things stand (2026-10-15): branch `branch-prediction`, three commits
on f694d87:

- 8ca04e5 - jmp and call to an absolute address (0xa9, 0xaa) redirect as
  they dispatch: both 2 cycles.
- b6e0c8d - the same for jmp; call fetches its target at dispatch but
  leaves the pc for its ALU cycle: 3 cycles, and a third of the LUTs.
- the tip - backward conditional branches predicted taken, the guess's
  target in tgt_q, no guess while a branch is in the ALU stage.  Chosen on
  CoreMark: -3.0% at -Os, -5.5% at -O2.  2728 cells, 2378 LUT4, 29.11 MHz
  against main's 2570, 2237, 29.26.

All of them pass tests/cpu-check.mjs except the three blit-mode programs
main fails too (the pop fault release).  cpu-check gained a directed loop
program: all seven branch opcodes backward, taken and not, a never-taken
one, a branch two ahead, a push before, a call inside, nested loops.

## The designs

**jmp and call.**  dispatch recognises 0xa9/0xaa from the buffer's flops,
both candidate bytes, as `lenr` does; the target is {ib2, ib1}.  The
address arm is spelled from flops only (`pjr & slot & ~aphase & nw >= 2`),
and `go` reaches only flop inputs.  Putting `go` - which carries the length
classifier - in front of the address pins cost 1.2 MHz; a stall in `ready`
when the sequencer had the bus cost about 1 more.  Now a jump that meets a
store's last access is simply not predicted: the old 4 cycles.

call leaves the pc on the next instruction - its return address, so `lr`
is the plain `d_next` - and stops dispatch; its ALU cycle moves the pc
through jnow's arm, which `e_pj` keeps off the bus and the buffer.  That
saved the `d_pc + 3` adder, ~59 LUT4.

**Backward branches.**  All seven are three bytes with the displacement
last, so ib2[7] is the sign.  At dispatch `pc + 3 + sext(ib2)` goes into a
flop; the next cycle `pbq` redirects as taken_q does, without the squash.
The branch itself goes on with its condition inverted and the fall-through
(`d_next`) as its target - so `taken`/`taken_q` now mean MISPREDICTED, in
both directions, and the recovery is the existing one, unchanged.

| shape                              | before | now           |
| ---------------------------------- | ------ | ------------- |
| jmp abs16                          | 4      | 2 (3 if the target needs two words) |
| call abs16                         | 4      | 3             |
| either, at a store's last access   | 4      | 4             |
| backward branch, taken             | 5 - 6  | 3 - 4         |
| backward branch, not taken         | 1      | 5 - 6         |
| forward branch                     | 1 / 5 - 6 | unchanged  |

Loops: bottom test, taken back edge, 5 - 6 a trip before, 3 now.  The
other shape - `jmp` back to a test at the top, not taken - is 4 a trip
(the jmp is 3 because a three-byte branch needs two words).

## Measured, 16 seeds, plain core

|                                         | cells | LUT4 | MHz   | spread       |
| --------------------------------------- | ----- | ---- | ----- | ------------ |
| main (f694d87)                          | 2570  | 2237 | 29.26 | 28.3 .. 30.1 |
| jmp/call: go & ~take & pjr on the mux   | 2698  | 2329 | 28.02 | 26.5 .. 29.2 |
| jmp/call: flops, stall in ready         | 2710  | 2346 | 28.41 | 27.4 .. 29.1 |
| jmp/call 2 cycles (8ca04e5)             | 2748  | 2390 | 29.61 | 28.7 .. 30.6 |
| jmp 2, call 3 (b6e0c8d)                 | 2645  | 2296 | 29.49 | 28.1 .. 30.3 |
| + backward, target in tgt_q, suppressed | 2728  | 2378 | 29.11 | 27.3 .. 30.1 |
| + backward, target in pbt (not kept)    | 2807  | 2456 | 30.13 | 29.0 .. 31.1 |
| the same RTL, abc9 -D 6347              | 2762  | 2409 | 28.96 | 27.0 .. 30.5 |

Where 8ca04e5's LUT4 went, one piece taken out at a time (abc noise +-20):
return-address adder ~59, the target into fp (+1 and not) ~74, the address
arm ~33, the pc arm ~0, recognition and control ~26.

"Suppressed" shares tgt_q, so it makes no guess when a branch is in the ALU
stage - dispatched exactly two cycles before - whose verdict owns tgt_q.

## Cycles, on the sim

CoreMark at 3 iterations (the same CoreMark/MHz as a full run), both -mmul;
DeltaBlue cut down, SOMpp build-fructus-awfy-mmul.  CRCs identical on all.

|                                | LUT4 | DeltaBlue           | CoreMark -Os ticks  | CoreMark -O2 ticks  |
| ------------------------------ | ---- | ------------------- | ------------------- | ------------------- |
| main                           | 2237 | 3,415,058           | 3,213,064 (0.934)   | 2,664,224 (1.126)   |
| jmp 2 / call 3 (b6e0c8d)       | 2296 | 3,372,145 (-1.26%)  | 3,175,861 (-1.16%)  | 2,620,001 (-1.66%)  |
| jmp 2 / call 2 (8ca04e5)       | 2390 | 3,347,497 (-1.98%)  | 3,172,026 (-1.28%)  | 2,616,494 (-1.79%)  |
| b6e0c8d + backward (the tip)   | 2378 | 3,399,131 (-0.47%)  | 3,115,977 (-3.02%)  | 2,517,555 (-5.51%)  |
| the same, guess in a flop, pbt | 2456 | 3,399,131 (-0.47%)  | 3,115,977 (-3.02%)  | 2,517,555 (-5.51%)  |
| 8ca04e5 + backward, sim only   | -    | 3,384,926 (-0.88%)  | 3,114,190 (-3.08%)  | 2,514,464 (-5.62%)  |

Calls in 2 cycles rather than 3 are worth 0.4 - 0.7% on DeltaBlue, which is
call-heavy, and 0.1% on CoreMark, for ~94 LUT4.

(CoreMark/MHz in brackets: 0.934 -> 0.945 -> 0.963 at -Os, 1.126 -> 1.145
-> 1.192 at -O2.)  Suppressed and pbt give identical counts on all three:
the guess is suppressed 0 times in DeltaBlue and 26 / 27 in CoreMark, none
in its timed region.  **pbt's 78 LUT4 buy nothing; keep the suppressed one.**

A backward guess saves 2 cycles taken and costs 4 - 5 not taken: it pays
above about 65 - 70% taken.  CoreMark's backward branches are taken 84% /
89%; DeltaBlue's 36% - 12,655, of which 9,564 are within 16 bytes and taken
29%.  Distance does not separate them (CoreMark's short ones: 93 - 96%).
They are loops that run once: VMFrame::GetOuterContext() (3,389 executed,
11 taken), Interpreter::sendMiss() (1,775, 0), highestBelow() (861, 1),
Interpreter::Start() (180, 0) - rotated, so the back edge is met once a call
and falls through.  No static rule sees that; profile-guided layout or a
dynamic predictor would.

GetOuterContext peeled (tried, then reverted in SOMpp - the interpreter
will be hand-written, and its branches chosen for whatever predictor is
there then): DeltaBlue's loss to the backward guess halved, +27,256 ->
+13,744 cycles against jmp/call alone.  gcc at -Os ignored `unlikely` for
layout - it folded the peeled test back into a loop tested at the top, a
forward branch taken on every call - and only `optimize("O2")` on the
function laid it out to fall through.  With static prediction, block
layout IS the predictor, and -Os lays out by source order.

## What abc did

The jumps in LUT4 between versions that differ by a few gates are abc9's,
not the logic's.  abc maps to the best delay its restructuring allows
(`Del` in the log; HX delays, 250 ps a wire), then recovers area under
that.  A lower Del makes it duplicate logic everywhere:

|                    | abc Del | LUT4 | endpoints 10 LUTs deep |
| ------------------ | ------- | ---- | ---------------------- |
| main               | 5970    | 2237 | 3                      |
| b6e0c8d            | 6347    | 2296 | 36                     |
| suppressed         | 6347    | 2377 | 7                      |
| pbt                | 5851    | 2456 | 0                      |
| pbt, -D 6347       | 6347    | 2409 | 32                     |

A logically redundant term - the comparator's `taken` in tgt_q's select,
while dispatch already excluded the case - cost 55 LUT4 by itself.

- `abc9 -D` only relaxes: below the best it warns "Cannot meet the target
  required times".  Relaxing main saves next to nothing - core 2237 ->
  2215 at 7000 ps, system 3353 -> 3350 at 12000 - because area recovery
  already squeezes every path with slack.  So a deliberately deep circuit
  to buy the VGA system cells would not pay.
- A second `&dc2; &dch -f` round (`abc9 -script file` - a yosys `-p`
  string splits on `;`) tightened main's Del to 5802 for +8 LUT4, and was
  SLOWER: core 28.45 against 29.26, system 26.60 against 28.31 (4202
  cells against 4229, slowest seed 25.22), every system seed ending at
  `g_boot.sb.done -> decode`.
- So abc's Del does not predict routed speed.  It gives every input an
  arrival of zero, and reset - one flop driving every flop - is the
  latest signal on the chip.  pbt's 30.13 is about 1.2 MHz of lucky
  mapping (the -D 6347 control), not the predictor.

## Open

1. **Decided: backward prediction, suppressed**, chosen on CoreMark;
   DeltaBlue waits for the hand-written interpreter.
2. **gcc's -Os layout.**  The fructus backend could make -Os honour branch
   probabilities (reorder-blocks stc), so `likely`/`unlikely` count.
3. **Loops that run once.**  gcc could leave a loop unrotated where it
   expects few trips, or the hot SOM++ walks could be written so; a hint
   bit would need an opcode.  A one-bit-per-branch dynamic predictor is
   the hardware answer, and the first thing that costs a RAM.
4. **The system.**  Not placed with any of these; the tip adds 158 cells to
   a system at 4229 (UART: 4385, USB: 4670) of 5280.
5. **gcc's loops.**  With backward prediction the rotated loop gcc makes
   already wins (3 a trip); without it, a top test behind a jmp would.
6. **Reset out of the logic cones.**  `rst -> cl0.t / stop / d_ucode` and
   `g_boot.sb.done -> d_rhs` are critical in most runs today, on the core
   and the system.  If rst reached only flops' reset pins, or a registered
   copy near dispatch, that family of paths goes for every mapping.  A
   separate experiment, and possibly the biggest lever seen here.
7. **-device u.**  speed.mjs (and the board build) never tells abc9 it is
   an UP5K; its delay model is the HX's.  Cheap to try, judged by seeds.

## Dynamic prediction (2026-10-15)

Traces of every conditional branch in CoreMark and DeltaBlue, replayed
against candidate predictors (build/dynbp/), chose: 11 bits of global
history, the old 8 bits (h[10:3]) addressing one SB_RAM40_4K, the newest 3
the tag; three ways a word, each a 3-bit tag and a 2-bit counter.  No hit,
or a word read before gh last changed, and the sign bit guesses as before.

- The address from the OLD bits is both better (in a loop the newest bits
  are all ones, so every loop piles onto a few sets) and what hides the
  RAM's registered read: only the tag compare is in front of `pbok`.
- Writes only on a misprediction (1-bit entries) and LRU were tried: LRU
  buys nothing over insertion order, and round-robin is as good as either.
  Counters beat 1-bit entries once writes are seen to be free - a write
  port of its own - and they tolerate late writes better.
- No valid bit: a zeroed table predicts as well.
- `ch`, the verdicts of the branches that reached the stage after the ALU,
  is gh as each one dispatched, so nothing carries the history down the
  pipeline: -94 cells.

|                         | cells | LUT4 | RAMs | MHz (16 seeds)      |
| ----------------------- | ----- | ---- | ---- | ------------------- |
| core, static (9a866f6)  | 2728  | 2378 | 3    | 29.11 (27.3 .. 30.1) |
| core, dynamic           | 2876  | 2486 | 4    | 30.23 (29.3 .. 31.4) |
| system, dynamic, split 15 | 4574 | 3648 | 12  | 28.38 (27.6 .. 29.3) |

Sim against static: CoreMark -Os -3.53%, -O2 -2.67%, DeltaBlue -2.51%.

Costs quoted in the .s files are estimates now: a loop's cost depends on
what ran before it.  tests/harness.mjs's `near` holds them to a tenth.
