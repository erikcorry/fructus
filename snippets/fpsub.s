; ============================================================================
; fpsub.s - the mantissa path of a BBC-style floating point subtract
; ============================================================================
;
; Same format as fpadd.s: an 8-bit biased exponent and a 32-bit mantissa whose
; top bit is the implicit 1 of a normalised significand, replaced by the sign in
; storage.
;
; This runs after the sign comparison has chosen subtraction, and after the
; caller has swapped the operands so the larger EXPONENT is first, unpacked both
; implicit ones, and shifted the second down to align.
;
;       in      r0:r1   X, high:low, unsigned, implicit bit restored
;               r2:r3   Y, high:low, unsigned, implicit bit restored then
;                       shifted right to match X's exponent
;       out     r0:r1   X - Y, normalised, with bit 31 holding the SIGN of the
;                       result rather than the implicit one
;               r2      exponent adjustment: 0 or negative
;       clobbers r3, r4, r5.
;
; r4 CARRIES A MASK, NOT A FLAG.  The comparison at the top has to record which
; operand was larger somewhere, and the cheapest thing to record is not a 0/1
; boolean but the mask that step 4 will need anyway - 0x7fff to clear the
; implicit bit, or 0xffff to leave it standing as a sign.  Applying it is then
; one `and`, with no branch and no test.  See step 4.
;
; NOT AN ABI FUNCTION.  It uses the whole register file, which collides with the
; calling convention in isa/abi.s at both ends: it writes r4, which is callee
; saved, and it writes r5, which is the assembler's immediate scratch.  Neither
; breaks anything here - every immediate in this routine is small enough to need
; no expansion - but a callable wrapper around it must save and restore r4, and
; nothing may be inserted into it that needs a long immediate.
;
; ----------------------------------------------------------------------------
; WHY THE RESULT CAN BE NEGATIVE
; ----------------------------------------------------------------------------
; The caller ordered the operands by EXPONENT, not by value.  When the exponents
; differ, Y has been shifted down below 2^31 while X is still normalised, so
; X > Y and the difference is positive.  When the exponents are EQUAL nothing is
; shifted, both operands are in [2^31, 2^32), and either may be the larger.
;
; So the sign is decided by a full 32-bit comparison, and it is only ever
; interesting in the equal-exponent case - which is also the case that produces
; the massive cancellations below.
;
; ----------------------------------------------------------------------------
; THE EXPONENT ADJUSTMENT IS A RANGE, NOT A BIT
; ----------------------------------------------------------------------------
; This is the whole difference from addition.  Adding two normalised
; significands can only overflow by one bit, so the adjustment is 0 or +1 and a
; single test settles it.  Subtracting them can CANCEL any number of leading
; bits: X - Y with X and Y adjacent leaves a single 1 at the bottom, thirty-one
; places from where it needs to be.
;
; So the normalise is a leading-zero count and a variable shift, and the
; adjustment runs from 0 down to -31.  There is no bound to exploit and no
; branch that avoids the general case.
;
; EXACT CANCELLATION is the one case with no answer.  X == Y gives zero, which
; has no normalised form and no meaningful exponent - so the routine returns a
; zero mantissa and an adjustment of 0, and THE CALLER MUST NOTICE, and write
; the format's zero encoding rather than trusting the exponent it started with.
; ============================================================================

fpsub_mantissa:

; --- 1. which operand is larger, and the magnitude of the difference --------
; The comparison has to happen before anything is overwritten, and it settles
; the sign at the same time.  Both arms then subtract in the order that gives a
; non-negative result, which is cheaper than subtracting one way and negating:
; `rsb` already computes its operands the other way round, so the second arm
; costs an extra byte rather than an extra ten.
        br      lo, r0, r2, y_bigger    ; XH < YH                          3
        br      hi, r0, r2, x_bigger    ; XH > YH                          3
        br      lo, r1, r3, y_bigger    ; high halves equal: low decides   3
x_bigger:
        br      hs, r1, r3, xb_nb       ; XL >= YL: no borrow              3
        add     r0, r0, #-1             ; propagate the borrow             1
xb_nb:
        sub     r1, r1, r3              ; XL -= YL                         2
        sub     r0, r0, r2              ; XH -= YH                         2
        mov     r4, #0x7fff             ; positive: mask off the top bit    2
        jmpr    have_mag                ;                                  2
y_bigger:
        br      hs, r3, r1, yb_nb       ; YL >= XL: no borrow              3
        add     r2, r2, #-1             ; propagate the borrow             2
yb_nb:
        rsb     r1, r1, r3              ; r1 = YL - XL                     2
        rsb     r0, r0, r2              ; r0 = YH - XH                     2
        mov     r4, #-1                 ; negative: leave the top bit set   2
have_mag:

; --- 2. how far is the magnitude from normalised? --------------------------
; A whole empty high half is worth stepping over before counting bits: it costs
; three bytes here and saves the counter a range it cannot reach anyway, since
; `clz` only sees sixteen bits at a time.
        mov     r2, #0                  ; shift count so far               2
        br      ne, r0, #0, have_hi     ; high half already non-zero       3
        br      eq, r1, #0, done        ; both halves zero: exact cancel   3
        mov     r0, r1                  ; step up by sixteen bits          1
        mov     r1, #0                  ;                                  2
        mov     r2, #16                 ; ... and record it                2
have_hi:

; That `mov r2, #16` used to be THREE bytes.  imm5 is signed, so it reaches
; -16..+15: the constant 16 fell just outside it, and -16 did not.  A one-byte
; cliff between #15 and #16 is a silly place for a cliff, and it is the reason
; the immbit5 form exists - 16 is 1<<4, so it is now two bytes like everything
; around it.  See the note at the bottom.

; --- 3. normalise ----------------------------------------------------------
; r0 is non-zero, so clz lands in 0..15 and the shift is a real 32-bit one.
;
; The crossing bits are `lo >> (16 - n)`, and 16 - n is exactly the count a
; shift cannot express: the hardware reads only the low four bits, so a distance
; of 16 would be read as 0 and the whole low half would be OR-ed in when n = 0.
; Shifting right by one first and then by 15 - n keeps every count inside 0..15
; and is correct at both ends.
        clz     r3, r0                  ; leading zeros, 0..15             2
        add     r2, r2, r3              ; total left shift                 2
        shl     r0, r0, r3              ; hi <<= n                         2
        lsr     r5, r1, #1              ; the bits that cross over ...     2
        shl     r1, r1, r3              ; lo <<= n                         2
        rsb     r3, r3, #15             ; 15 - n, n is dead after this     3
        lsr     r5, r5, r3              ; ... = lo >> (16 - n)             2
        or      r0, r0, r5              ; merge them into the high half    2

; --- 4. sign, and the exponent adjustment ----------------------------------
; Normalising leaves bit 31 set, which is the implicit one - and for a negative
; result that is exactly the sign bit wanted.  So the whole of "apply the sign"
; is "clear that bit, or don't", which is an AND with a mask step 1 already
; chose.  No branch, no test, constant time.
        and     r0, r0, r4              ; 0x7fff clears it, 0xffff keeps   2
        rsb     r2, r2, #0              ; the exponent goes DOWN by n      2
done:                                   ;                          total  65


; ============================================================================
; Notes
; ============================================================================
;
; TRUNCATES, like fpadd.s, and for a smaller reason: normalising a subtraction
; shifts LEFT, so nothing is discarded here at all.  Every bit lost was lost by
; the caller's alignment shift before this routine ran.  That is also why
; subtraction is where a guard and sticky bit would earn their keep - massive
; cancellation promotes those discarded bits to the top of the result, which is
; the classic reason a float library carries them.
;
; clz IS TENTATIVE IN THE SPEC, and this routine is the argument for keeping it.
; The interesting part is that it does NOT buy bytes.  A shift-until-normalised
; loop is about the same size:
;
;       norm_loop:
;               brset   r0, #0x8000, norm_done  ; 3
;               lsr     r5, r1, #15             ; 2   the bit crossing over
;               shl     r0, r0, #1              ; 2
;               or      r0, r0, r5              ; 2
;               shl     r1, r1, #1              ; 2
;               add     r2, r2, #1              ; 2
;               br      norm_loop               ; 2
;
; - fifteen bytes against seventeen.  What clz buys is TIME: that loop runs up
; to fifteen times after the 16-bit step, so about 225 cycles worst case against
; a flat 17.  Constant time also matters for its own sake here, because the
; iteration count is the cancellation depth, which is operand data.
;
; THE 16-BIT STEP IS NOT AN OPTIMISATION, it is required.  `clz` reads one
; 16-bit register, so a magnitude whose high half is zero would give a count of
; 16 and a shift distance the instruction cannot express.  Moving the low half
; up first keeps every subsequent count inside 0..15.
;
; ----------------------------------------------------------------------------
; WHAT immbit5 WAS WORTH HERE
; ----------------------------------------------------------------------------
; Six bytes, 71 down to 65, in three places:
;
;   mov r2, #16          3 -> 2   16 is 1<<4, which imm5 could not reach
;   mov r4, #0x7fff      -       a mask is now as cheap to load as a flag
;   and r0, r0, r4       5 -> 2   which is what turned a branch into an and
;
; The last one is the interesting one, and it is not really about the encoding
; of a constant.  `shl`+`lsr` was only ever a way to clear one bit without
; being able to name the mask; once 0x7fff is a two-byte immediate the natural
; instruction is an `and`, and once it is an `and` the two arms differ only in
; their operand - so the branch that chose between them disappears too.
