; ============================================================================
; speed-of-light-memset-core.s - how fast can this machine fill memory?
; ============================================================================
;
; `push` writes three registers in one instruction AND advances the
; pointer for free, because that is what a stack pointer does.  Point sp at the
; end of the buffer, load the fill value into three registers, and the whole
; loop is pushes and a branch.  There is no pointer arithmetic in it anywhere.
;
;       sp  the buffer, filling DOWNWARD          r3  fill
;       r2  low limit + 258                       r4  fill
;                                                 r5  fill
;
; INTERRUPTS MUST HAVE THEIR OWN STACK POINTER, exactly as in the memcpy core.
; sp is a data pointer here.
;
; ----------------------------------------------------------------------------
; WHY THIS IS SO MUCH FASTER THAN memcpy
; ----------------------------------------------------------------------------
; Two of the three costs disappear.  A push stops the pipeline while its six
; bytes go out, a cycle each, and for four cycles more - see the cost model
; under [cpu] in the spec.
;
;       1.000   one WRITE per byte, and no read            IRREDUCIBLE
;       0.667   the push: four cycles beyond its bytes, over the 6 it writes
;       0.000   pointer maintenance: push does it
;       -----
;       1.667   the floor, plus the branch
;
; memcpy pays 2.000 for data because every byte is read and written, and it
; pays 2.000 more for starting its stores, because the destination goes
; through `st`, four cycles of overhead per two bytes.  memset reads nothing,
; and its destination is the side that gets sp - so it collects push's rate on
; the only side there is.
;
; The exact cost of P pushes and one branch is
;
;       (10P + 4) / 6P  =  1.6667 + 0.6667/P
;
; where the branch is four cycles, taken.  So the branch is the entire gap
; above the floor, and P is capped only by how much code you are willing to
; spend.  P = 43 fills 258 bytes per iteration in 89 bytes of code.  (The
; byte-serial core charged a push the same ten cycles by a different route -
; two for its bytes, six for its data, one for the address and one for the
; data flop - so the figures below did not move.)
;
; ----------------------------------------------------------------------------
; MEASURED
; ----------------------------------------------------------------------------
;   258 bytes/iteration   89 bytes   1.6822 cycles/byte
;
; Against the memcpy core in the neighbouring file at 4.6667, and against a
; 6502, which needs about 4 cycles a byte with unrolled self-modifying stores.
; Filling is where this machine is furthest ahead of a 6502, because `push` is
; doing three things at once that a 6502 does in three instructions.
;
; NO MODULO, AND NO MULTIPLE-OF-258 REQUIREMENT.  The terminator is `hs`, not
; `ne`: the loop runs while at least 258 bytes remain and falls out with the
; rest unfilled, so the caller sets r2 = low + 258 and handles a remainder of
; 0..257 however it likes.  Verified at sizes of 259, 300, 515, 517 and 1000 -
; it fills floor(size/258)*258 and never writes below the buffer.
; ============================================================================

memset_core:
  push r3, r4, r5
  push r3, r4, r5
  push r3, r4, r5
  push r3, r4, r5
  push r3, r4, r5
  push r3, r4, r5
  push r3, r4, r5
  push r3, r4, r5
  push r3, r4, r5
  push r3, r4, r5
  push r3, r4, r5
  push r3, r4, r5
  push r3, r4, r5
  push r3, r4, r5
  push r3, r4, r5
  push r3, r4, r5
  push r3, r4, r5
  push r3, r4, r5
  push r3, r4, r5
  push r3, r4, r5
  push r3, r4, r5
  push r3, r4, r5
  push r3, r4, r5
  push r3, r4, r5
  push r3, r4, r5
  push r3, r4, r5
  push r3, r4, r5
  push r3, r4, r5
  push r3, r4, r5
  push r3, r4, r5
  push r3, r4, r5
  push r3, r4, r5
  push r3, r4, r5
  push r3, r4, r5
  push r3, r4, r5
  push r3, r4, r5
  push r3, r4, r5
  push r3, r4, r5
  push r3, r4, r5
  push r3, r4, r5
  push r3, r4, r5
  push r3, r4, r5
  push r3, r4, r5
  br hs, r6, r2, memset_core
memset_core_end:
