; ============================================================================
; speed-of-light-memcpy-core.s - how fast can this machine copy memory?
; ============================================================================
;
; The trick is that `pop` moves three registers in one two-byte instruction, so
; the SOURCE pointer costs almost nothing to read through - if you are willing
; to point sp at it.  The destination is written with ordinary stores.
;
; Entry, for both cores below:
;
;       sp  source, and it advances                 lr  the real sp, saved
;       r0  destination, and it advances            r3  data
;       r1  10, the destination bump                r4  data
;       r2  destination limit                       r5  data
;
; INTERRUPTS MUST HAVE THEIR OWN STACK POINTER while this runs.  sp is a data
; pointer here, and anything that pushed to it would land in the middle of the
; source buffer.  That is a real constraint on the machine, not a detail of the
; routine - it is the price of the whole technique.
;
; ----------------------------------------------------------------------------
; THE COST MODEL
; ----------------------------------------------------------------------------
; See [cpu] in the spec.  The processor dispatches an instruction a cycle, and
; its length costs nothing but space - except that three bytes at an odd
; address cost a cycle more.  A memory instruction stops dispatch while it
; moves its bytes, one a cycle: a load of N bytes costs N + 3 cycles and a
; store N + 4.  A taken branch costs 4.  tools/sim.js counts exactly that, and
; every figure here is measured, not counted by hand.
;
; Copying a byte costs two cycles that no instruction set can avoid: one to
; read it and one to write it.  Everything above 2.000 is what the memory
; instructions pay to get started, and the ALU instructions around them:
;
;       2.000   data: one cycle per byte read, one per byte written  IRREDUCIBLE
;       2.000   the stores: 4 cycles each beyond their bytes, over the 2 they write
;       0.500   the pops: 3 cycles each beyond their bytes, over the 6 they read
;       0.100   pointer bump: 1 cycle per 5 stores
;       0.067   the branch: 4 cycles over 60 bytes
;       -----
;       4.667   the floor for this instruction mix, at N = 60
;
; THE BRANCH TERM IS THE ONLY ONE THAT SHRINKS WITH N, which is what makes a
; longer loop worth anything at all once the rest is fixed: at N = 32 it is
; 0.125 and at N = 60 it is 0.067.
;
; THE STORE IS WHAT COSTS: six cycles to move two bytes, where `push` moves six
; in ten.  Nothing else writes more than one register to memory per
; instruction, and push and pop cannot both use sp at once.  On the byte-serial
; core, where a `mov` was two cycles, swapping sp between source and destination
; came out exactly break-even against storing.  ON THIS ONE IT WINS: a `mov` is
; a cycle, and
;
;       mov sp, r0 / pop r3, r4, r5 / mov r0, sp / mov sp, r1 /
;       push r5, r4, r3 / add r1, sp, #12
;
; moves six bytes in 23 cycles, 3.833 a byte, where a pop and three stores take
; 27 for the same six, 4.500, before the pointer bumps.  MEASURED, as a loop of
; two such chunks, 29 bytes: 4.2500
; cycles/byte, and of six, 81 bytes: 4.0278 - both better than the 89-byte core
; below.  It is not written in here yet; it needs the same entry conventions
; worked out, and every chunk is 13 bytes, so every other chunk's three-byte
; `add` lands at an odd address and costs a cycle more.
;
; WHY FIVE STORES PER BUMP.  A store reaches [r0, #imm3], and imm3 holds
; { -1, 0, 1, 2, 3, 4, 6, 8 }.  The offsets have to be two apart, and the
; longest run of those in the table is 0, 2, 4, 6, 8 - five of them.  Then r0
; has to move, and `add r0, r0, r1` is one byte only because r0 and r1 are the
; registers the one-byte abbreviation at 0x07 pins.
;
; ----------------------------------------------------------------------------
; MEASURED
; ----------------------------------------------------------------------------
;   erik   32 bytes/iteration   51 bytes   4.8125 cycles/byte
;   mine   60 bytes/iteration   89 bytes   4.6667 cycles/byte
;
; For scale: a 6502 does 13 cycles/byte, or 10 with self-modifying code.
;
; 4.6667 is the best this instruction mix does under a 90-byte core.  Every
; candidate has the same stores and pops per byte, and a bump costs a cycle
; whatever its length, so the family is 4.600 + 4/N and the longest loop wins:
; N = 60, the longest that is a multiple of both six and ten and still in the
; branch's reach.  The next step up, N = 66, needs 98 bytes.  (On the
; byte-serial core the one-byte bump cost two cycles and the search came out
; the same way, at 4.9333.)
; ============================================================================


; ============================================================================
; erik - 32 bytes per iteration, 51 bytes, 4.8125 cycles/byte
; ============================================================================
; Correct, and the sp lands exactly on src + n.  What holds it back is that 32
; bytes is 16 words, which is not a multiple of three - so the last `pop` moves
; a single register and pays a pop's three cycles of overhead for two bytes,
; and it takes a fourth bump to make the stores come out.

erik:
  pop r3, r4, r5
  st r3, [r0, #0]
  st r4, [r0, #2]
  st r5, [r0, #4]
  pop r3, r4, r5
  st r3, [r0, #6]
  st r4, [r0, #8]
  add r0, r0, r1
  st r5, [r0, #0]
  pop r3, r4, r5
  st r3, [r0, #2]
  st r4, [r0, #4]
  st r5, [r0, #6]
  pop r3, r4, r5
  st r3, [r0, #8]
  add r0, r0, r1
  st r4, [r0, #0]
  st r5, [r0, #2]
  pop r3, r4, r5
  st r3, [r0, #4]
  st r4, [r0, #6]
  st r5, [r0, #8]
  pop r3
  add r0, r0, #2
  st r3, [r0, #8]
  add r0, r0, r1
  br ne, r0, r2, erik
erik_end:


; ============================================================================
; 60 bytes per iteration, 89 bytes, 4.6667 cycles/byte
; ============================================================================
; Sixty is the smallest length that makes both counts come out whole: it is a
; multiple of six, so every `pop` moves three registers, and a multiple of ten,
; so every pointer bump is followed by exactly five stores.  Nothing in the loop
; is a partial anything.
;
; That is the entire improvement.  The instruction mix is identical to erik`s;
; it just stops wasting the ends.

memcpy_core:
  pop r3, r4, r5
  st r3, [r0, #0]
  st r4, [r0, #2]
  st r5, [r0, #4]
  pop r3, r4, r5
  st r3, [r0, #6]
  st r4, [r0, #8]
  add r0, r0, r1
  st r5, [r0, #0]
  pop r3, r4, r5
  st r3, [r0, #2]
  st r4, [r0, #4]
  st r5, [r0, #6]
  pop r3, r4, r5
  st r3, [r0, #8]
  add r0, r0, r1
  st r4, [r0, #0]
  st r5, [r0, #2]
  pop r3, r4, r5
  st r3, [r0, #4]
  st r4, [r0, #6]
  st r5, [r0, #8]
  add r0, r0, r1
  pop r3, r4, r5
  st r3, [r0, #0]
  st r4, [r0, #2]
  st r5, [r0, #4]
  pop r3, r4, r5
  st r3, [r0, #6]
  st r4, [r0, #8]
  add r0, r0, r1
  st r5, [r0, #0]
  pop r3, r4, r5
  st r3, [r0, #2]
  st r4, [r0, #4]
  st r5, [r0, #6]
  pop r3, r4, r5
  st r3, [r0, #8]
  add r0, r0, r1
  st r4, [r0, #0]
  st r5, [r0, #2]
  pop r3, r4, r5
  st r3, [r0, #4]
  st r4, [r0, #6]
  st r5, [r0, #8]
  add r0, r0, r1
  br ne, r0, r2, memcpy_core
memcpy_core_end:


; ============================================================================
; THE MULTIPLE-OF-N PROBLEM, AND WHAT IT ACTUALLY COSTS
; ============================================================================
;
; Both cores above end in `br ne, r0, r2, ...`, which is why the length has to
; be an exact multiple: the test only stops if r0 lands on r2 exactly.  That is
; fine for 32, where the caller splits the length with `and r5, r2, #31`, and
; miserable for 60, where it needs a division.
;
; IT DOES NOT NEED A DIVISION.  Change the terminator to
;
;       br lo, r0, r2, memcpy_core           ; r2 = dst + count - N + 1
;
; and the loop runs while at least N bytes remain, then falls out with the
; remainder unhandled.  Same instruction, same three bytes, same 4.6667
; cycles/byte - measured, including at counts of 61, 119, 121 and 613, where it
; copies floor(count/60)*60 and never overruns.  No modulo anywhere, for either
; core.  This is strictly better than `ne` and the only reason not to write it
; that way above is that the figures were measured with `ne`.
;
; SO THE REAL COST IS NOT THE MODULO, IT IS THE REMAINDER.  N = 60 leaves up to
; 59 bytes for a tail loop; N = 32 leaves up to 31.  Tails, both `lo`
; terminated: six bytes at a time is 13 bytes of code at 5.3333 cycles/byte -
; a pop, three stores, a bump and a taken branch, 32 cycles - and two at a time
; is 8 bytes at 8.0000, 16 cycles for a one-register pop, a store, a bump and
; the branch.
;
; THOSE TWO FIGURES AND THE TABLE BELOW ARE COMPUTED, NOT MEASURED - the tails
; are described here and not written out - from the cost model and the cores'
; measured 154 and 280 cycles an iteration.
;
; Whole-copy cost with those tails, in cycles:
;
;       bytes      N=32     N=60
;          32       154      176     N=32, by 12.5%
;          64       308      312     N=32, by 1.3%
;         100       494      504     N=32, by 2.0%
;         128       616      608     N=60, by 1.3%
;         300      1450     1400     N=60, by 3.4%
;        1024      4928     4792     N=60, by 2.8%
;        4096     19712    19136     N=60, by 2.9%
;
; N = 60 wins for EVERY even length from 240 bytes up, and on 106 of the 116
; from 128 to 358.  Below that it is a coin toss decided by where the remainder
; falls, and at exactly 32 bytes the smaller core is clearly better.
;
; WHICH MEANS THE ANSWER DEPENDS ON THE CORPUS, not on the loop.  A memcpy that
; mostly moves structs of a few dozen bytes should keep N = 32; one that mostly
; moves buffers should take N = 60 and the 3%.  The honest summary of this whole
; exercise is that the last 3% costs 38 bytes of code and is only collectable on
; large copies - which is exactly the shape of most unrolling decisions, and
; worth knowing before spending the space.  And that both lose to swapping sp
; with `mov`s, above, now that a `mov` costs a cycle.
