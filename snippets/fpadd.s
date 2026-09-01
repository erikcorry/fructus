; ============================================================================
; fpadd.s - the mantissa path of a BBC-style floating point add
; ============================================================================
;
; The format is the BBC Micro's five-byte float: an 8-bit biased exponent and a
; 32-bit mantissa whose top bit is the IMPLICIT 1 of a normalised significand.
; That bit is never stored - storage puts the sign there instead:
;
;       stored   s.mmmmmmm mmmmmmmm mmmmmmmm mmmmmmmm
;       unpacked 1.mmmmmmm mmmmmmmm mmmmmmmm mmmmmmmm
;
; This routine runs after the sign comparison has chosen addition, and after the
; caller has done the unpacking and the alignment.
;
;       in      r0:r1   X, high:low.  The larger operand, still normalised,
;                       so bit 31 is set.
;               r2:r3   Y, high:low.  The smaller operand, implicit bit
;                       restored and THEN shifted right to match X's exponent,
;                       so its bit 31 is set only when the exponents were equal.
;       out     r0:r1   the sum, normalised, ready to store
;               r2      exponent adjustment, 0 or 1
;       clobbers r3.  r4 and r5 are untouched.
;
; TRUNCATES.  When the sum reaches bit 32 the shift drops the low bit and it is
; not rounded back in; when it does not, nothing is dropped and the answer is
; exact.  See the notes at the end for why round-to-even is not taken.
;
; BIT 31 OF THE RESULT IS ALWAYS 0.  It is the implicit one, which is not
; stored; the caller drops the sign in on top of it.  So the mantissa comes back
; already in packed shape with the sign slot clear - which costs nothing on the
; overflow path, where `lsr` shifts a zero in, and two instructions on the other.
;
; ----------------------------------------------------------------------------
; THE ADJUSTMENT IS 0 OR 1, AND NEVER MORE
; ----------------------------------------------------------------------------
; X is normalised, so X >= 2^31, and both operands are below 2^32.  The sum is
; therefore in [2^31, 2^33): it can reach bit 32 but never bit 33.
;
;   sum <  2^32     already normalised.  Nothing to shift, exponent unchanged.
;   sum >= 2^32     shift right one place, exponent +1.
;
; There is no loop.  The leading-zero search a general normalise needs belongs
; to the SUBTRACT path, where cancellation can eat any number of bits; adding
; two positive significands can only ever overflow by one bit.
;
; ----------------------------------------------------------------------------
; THE CARRY TEST IS TWO CONDITIONS, NOT ONE
; ----------------------------------------------------------------------------
; This is the part that is easy to get wrong, and it fails silently.
;
; The overflow to detect is the carry out of XH + YH + c, where c is the carry
; from the low halves.  The comparison partner has to be YH, because XH has been
; overwritten by the add.  But the two cases need DIFFERENT conditions:
;
;       c = 0     carried  <=>  sum <  YH        lo
;       c = 1     carried  <=>  sum <= YH        ls
;
; The boundary is real.  With c = 1 and XH = 0xffff the propagate wraps the
; register to zero and the sum comes out exactly equal to YH - a genuine carry
; that `lo` reports as absent.  Using `lo` for both is wrong precisely there,
; and XH = 0xffff with a carrying low half is perfectly reachable.
;
; So the two cases each get their own branch.  Both were checked exhaustively
; against 17-bit arithmetic; see tests/fpadd-check.mjs.
; ============================================================================

fpadd_mantissa:
        add     r1, r1, r3              ; XL += YL, wrapping                2
        add     r0, r0, r2              ; XH += YH, wrapping                2
        br      hs, r1, r3, no_lo       ; no carry out of the low half      3
        add     r0, r0, #1              ; propagate it                      1
        br      ls, r0, r2, shift_down  ; sum <= YH means it carried        3
        jmpr    no_shift                ;                                   2
no_lo:
        br      lo, r0, r2, shift_down  ; sum <  YH means it carried        3

no_shift:                               ; sum < 2^32: already normalised
        and     r0, r0, #0x7fff         ; drop the implicit bit             2
        mov     r2, #0                  ; exponent unchanged                2
        jmpr    done                    ;                                   2

shift_down:                             ; sum reached bit 32
        lsr     r1, r1, #1              ; shift the 33-bit sum right one    2
        shl     r3, r0, #15             ; high bit 0 -> bit 15 of the low   2
        or      r1, r1, r3              ;                                   2
        lsr     r0, r0, #1              ; and bit 31 falls out 0            2
        mov     r2, #1                  ; exponent +1                       2
done:                                   ;                          total   32


; ============================================================================
; Notes
; ============================================================================
;
; DECIDED: THIS ROUTINE TRUNCATES AND DOES NOT ROUND.  Where a bit has to go, it
; is dropped.  Only the overflow path loses anything at all - when the sum stays
; below 2^32 it fits the 32-bit significand exactly and there is no bit to lose.
; Exact-when-possible is not an inconsistency with truncation; it is what
; truncation means when nothing overflows.
;
; ROUND-TO-EVEN WAS AVAILABLE AND IS NOT TAKEN.  It would be nine bytes on the
; overflow path - `brclear r1, #2` to test the bit that will become the new
; low bit, add half an ulp, propagate - and cheap only because a one-place shift
; discards exactly one bit, making every inexact case an exact tie.
;
; But that reasoning dies as soon as the caller aligns.  The alignment shift has
; already dropped bits below the guard, so a tie here need not be a tie in the
; true sum, and correct rounding would need a STICKY bit carried in from the
; alignment - one more input, and one more thing for the caller to maintain.
; Adding the nine bytes without it would round to even on ties that are not
; ties, which is worse than truncating: it would look principled and be wrong.
;
; THE SIGN-BIT CLEAR IS ONE INSTRUCTION, not two.  `and r0, r0, #0x7fff` reads
; as a mask because it is one: 0x7fff is an immbit5 constant - fifteen ones is
; ~(1<<15) - so it fits the same two bytes a `shl` would have.  Before that form
; existed this line was a `shl`/`lsr` pair, four bytes of shifting to express a
; mask the encoding could not name.  Two bytes saved here, and see fpsub.s for
; the version of this that also deletes a branch.
;
; SUBTRACTION IS THE HARDER PATH and none of this transfers - see fpsub.s.
; Cancellation can clear any number of leading bits, so the normalise becomes a
; `clz` and a variable shift rather than a one-place test, and the exponent
; adjustment becomes a range rather than 0 or 1.
