; ============================================================================
; digits3.s - three decimal digits of a number below 1000, with no divide
; ============================================================================
;
;       void digits3(uint16_t n, char *buf)     r0 = n < 1000, r1 = buf
;
; Writes exactly three ASCII digits to buf[0..2], most significant first, with
; leading zeros and no terminator.  Returns nothing.  Two arguments, so under
; isa/abi.s r0, r1 and r5 are caller saved - which is all this touches, so
; there is no prologue.
;
; ----------------------------------------------------------------------------
; THE IDEA: DON'T DIVIDE, PEEL
; ----------------------------------------------------------------------------
; 41n is n/100 in fixed point with 12 fraction bits.  The hundreds digit is
; bits 15..12.  Mask them off and what is left is the fraction, (n mod 100)/100;
; multiply it by ten and the tens digit is in bits 15..12.  Once more for the
; units.  No quotient is ever multiplied back to find a remainder, and there is
; no correction step.
;
; IT IS EXACT FOR EVERY n < 1000, and the reason is that the error only goes
; one way.  41/4096 exceeds 1/100 by 1/102400, so 41n overshoots n/100 by less
; than 999/102400 < 0.0098 - and nothing afterwards adds error, because the
; masks and the multiplies by ten are exact.  Two multiplies by ten scale the
; overshoot to under 0.98 of a unit, which cannot carry any digit past its
; floor.  An estimate that could come in LOW would need a fixup branch; this
; one cannot.  tests/sim-check.mjs runs all 1000 inputs.
;
; IT FITS IN 16 BITS.  41 * 999 = 40959, and a fraction below 4096 times ten is
; below 40960.  Unsigned throughout, so nothing may treat bit 15 as a sign.
;
; ----------------------------------------------------------------------------
; MEASURED
; ----------------------------------------------------------------------------
;       digits3         41 bytes, 44 cycles for every n, no branches
;
; For comparison, a divmod10 by 51/512 with one correction - also exact below
; 1000, and needing the fixup because 51/512 undershoots - inlined twice with
; the same stores came to 75 bytes and 74..78 cycles.
;
; The encodings it leans on, none of which expands through r5:
;   0x0fff and 0x30     both in immask5, so the mask and the `+ '0'` (an `or`,
;                       since a digit is below 16) are two bytes each
;   mov r1, r0          one of the two one-byte copies.  Then the TIED lsr,
;                       whose count is imm5, reaches 12 - the three-register
;                       form's shift3 table stops at 8, so `lsr r1, r0, #12`
;                       would be two instructions
;   add r0, r0, r1      one of the two one-byte adds
;
; which is why the running value lives in r0, the digit in r1, and buf moves
; out of r1 into r5 - one two-byte mov, instead of a two-byte copy into some
; other scratch register for every digit.
;
; ----------------------------------------------------------------------------
; GETTING BELOW 1000 IN THE FIRST PLACE
; ----------------------------------------------------------------------------
; Not written in assembly yet - kept here in C until there is a compiler.  1000
; is 1024 - 24, so a 32-bit divmod by 1000 needs no multiply by anything bigger
; than 24:
;
;   struct divmod1000 { uint32_t q; uint16_t r; };
;
;   struct divmod1000 divmod1000(uint32_t d) {
;     uint32_t acc = 0;
;     while (d >= 1024) {
;       uint16_t m = d & 1023;
;       d >>= 10;         // divide by 1024
;       acc += d;
;       d *= 24;          // 1024q = 1000q + 24q, so the 24q goes back in d
;       d += m;           // and 1000*acc + d is the original number throughout
;     }
;     if (d >= 1000) {    // d is below 1024 now, so once is enough
;       acc++;
;       d -= 1000;
;     }
;     return (struct divmod1000){acc, d};
;   }
;
; THE LOOP MUST TEST 1024, NOT 1000.  For d in 1000..1023, d >> 10 is zero and
; the iteration changes nothing, so `while (d >= 1000)` spins forever - and not
; only for inputs that start there, since an iteration can land there: 65023
; does.  1560 inputs below 65536 hang that way.  Likewise the final test is
; `>=`: `d > 1000` returns 1000 as the remainder of 1000.
;
; Brute force: exact on 0..2^20, the top 100000 values below 2^32, and two
; million random 32-bit inputs.  At most 6 iterations, and at most 3 of them
; while d is still wider than 16 bits.
; ============================================================================

digits3:
        mov     r5, r1                  ; buf, out of the way of the digit
        shl     r1, r0, #2
        add     r1, r1, r0              ; 5n
        shl     r1, r1, #3              ; 40n
        add     r0, r0, r1              ; 41n = n/100, 12 fraction bits
        mov     r1, r0
        lsr     r1, r1, #12             ; hundreds
        or      r1, r1, #0x30
        st8     r1, [r5, #0]
        and     r0, r0, #0x0fff         ; the fraction
        shl     r1, r0, #2
        add     r0, r0, r1              ; 5f
        add     r0, r0, r0              ; 10f
        mov     r1, r0
        lsr     r1, r1, #12             ; tens
        or      r1, r1, #0x30
        st8     r1, [r5, #1]
        and     r0, r0, #0x0fff
        shl     r1, r0, #2
        add     r0, r0, r1              ; 5f - and 10f >> 12 is 5f >> 11, so
        lsr     r0, r0, #11             ; the units need no doubling
        or      r0, r0, #0x30
        st8     r0, [r5, #2]
        ret
