; ============================================================================
; add32.s - add two 32-bit values held in register pairs
; ============================================================================
;
; There is no add-with-carry.  There does not need to be: the carry out of a
; 16-bit addition is recoverable from the result alone.
;
;       carry out of (A + B)   <=>   (A + B) mod 2^16  <  A
;                              <=>   (A + B) mod 2^16  <  B
;
; No carry: the sum is A + B, which is >= both operands, since neither is
; negative.  Carry: the sum is A + B - 65536, and because B < 65536 that is
; strictly less than A - and by symmetry strictly less than B too.  Either
; operand works as the comparison partner, which is what lets the low add
; happen in place.
;
; Both boundaries behave: B = 0 gives sum = A, and `A < A` is false.
;
; DO NOT reach for a negate here.  `A + B >= 2^16` looks like `A >= -B`, but
; negating 0 wraps to 0, so that test reports a carry on every `A + 0`.  If
; you want the predicate without the sum, complement instead of negating -
; `A + B >= 2^16` is exactly `A > ~B`, and `~0 = 65535` behaves correctly.
;
; ----------------------------------------------------------------------------
; The comparison must be br16, not br8.  br8 compares low bytes only and would
; miss every carry that depends on the upper half of the sum.
; ----------------------------------------------------------------------------


; ============================================================================
; 32-bit add, in place                                              8 bytes
; ============================================================================
; X in r0:r1 as high:low, Y in r2:r3 as high:low.  X += Y.
;
; The low add runs first and in place, which destroys XL - so the carry test
; compares the sum against YL rather than XL.  They are equivalent, and only
; one of them is still available.

        add     r1, r1, r3              ; XL += YL, wrapping            2
        add     r0, r0, r2              ; XH += YH                      2
        br16    hs, r1, r3, no_carry    ; sum >= YL means no carry      3
        add     r0, r0, #1              ; propagate                     1
no_carry:

; The last instruction is ONE byte only because the destination is r0: the
; one-byte region has `add r0, r0, #1` at 0x04.  Put the high half anywhere
; else and it becomes the two-byte tied form, for nine bytes total.  Worth
; keeping in mind when allocating registers around multi-word arithmetic.


; ============================================================================
; 32-bit add, high half not in r0                                   9 bytes
; ============================================================================
; X in r4:r5, Y in r6:r7.  Identical shape, one byte more.

        add     r5, r5, r7              ; XL += YL                      2
        add     r4, r4, r6              ; XH += YH                      2
        br16    hs, r5, r7, no_carry2   ; sum >= YL means no carry      3
        add     r4, r4, #1              ; propagate, tied imm5 form     2
no_carry2:


; ============================================================================
; 32-bit += 3, in place                                             6 bytes
; ============================================================================
; X in r0:r1 as high:low.
;
; Adding a CONSTANT is the same shape, except the comparison partner can be the
; constant itself: after `XL += k`, the carry test is just `sum < k`.  That is a
; register against a constant, which is exactly what the single-register branch
; form and the condimm5 table exist for - so nothing has to be kept alive and
; the add can happen in place.

        add     r1, r1, #3              ; XL += 3, wrapping             2
        br16    hs, r1, #3, no_carry3   ; sum >= 3 means no carry       3
        add     r0, r0, #1              ; propagate                     1
no_carry3:

; The boundary behaves: at k = 0 the sum is XL and `XL >= 0` is always true, so
; it correctly reports no carry.
;
; THIS WORKS FOR k IN {1, 2, 3, 4, 6, 8} - the imm3 values, minus the two that
; are degenerate as unsigned bounds.  That is not a coincidence: condimm5's
; unsigned constants were chosen to be imm3 precisely so that widening an
; `add #k` can test against the same k.  Under the earlier powers-of-two table
; this very sequence was impossible for 3 and 6, and cost eight bytes and a
; scratch register instead of six.
;
; DECREMENT IS NOT THIS SHAPE.  `+= -1` is a 32-bit add of 0xffffffff, so the
; high word adds 0xffff too rather than just taking a carry, and the sequence
; above does not generalise to it.  Subtract instead, and use the borrow form in
; the notes below.


; ============================================================================
; Notes
; ============================================================================
;
; BRANCHLESS is available and is not worth it.  The carry can be computed
; arithmetically as
;
;       carry = ((XL & YL) | ((XL | YL) & ~sum)) >> 15
;
; which is and, or, xor, and, or, lsr - six instructions to produce a 0 or 1,
; plus the two adds and one more add to fold it in.  Nine instructions, 18
; bytes, against 8 for the branched version.  Only reach for it if a
; mispredicted branch costs more than ten bytes of fetch.
;
; SUBTRACTION is the same shape and slightly easier, because the borrow out of
; `A - B` is just `A < B` and can be tested on the original operands, before
; anything is overwritten:
;
;       br16    hs, r1, r3, no_borrow   ; XL >= YL means no borrow
;
; WIDER VALUES chain the same way: each limb adds, then tests its own sum
; against one of its inputs, then conditionally bumps the next limb up.  The
; cost is one branch per limb, which is why a real bignum loop is usually
; better served by keeping the carry in a register and folding it in
; unconditionally.
