; ============================================================================
; roll32.s - rotate a 32-bit value left by a constant
; ============================================================================
;
; A 32-bit value lives in two registers, a low half and a high half:
;
;       X = (H << 16) | L
;
; Rotating X left by n, with m = n mod 16, gives:
;
;       L' = (L << m) | (H >> (16-m))
;       H' = (H << m) | (L >> (16-m))
;
; The cross-over - each new half taking its low bits from the OTHER register -
; is the rotate by 16, and it costs nothing: it is just renaming which register
; you call "high".  So a rotation by any multiple of 16 is free, and only
; n mod 16 needs real work.
;
; Rotating right by n is rotating left by 32-n, so one sequence covers both.
;
; ----------------------------------------------------------------------------
; WHAT IT COSTS
; ----------------------------------------------------------------------------
; The work is always four shifts and two ORs.  Every one of those is a two-byte
; form, so the floor is 12 bytes and 12 cycles.  What varies is whether the
; shifts can avoid destroying their sources, which depends entirely on whether
; the distance appears in the shift3 table:
;
;       shift3 = { 15, 0, 1, 2, 3, 4, 6, 8 }
;
; A distance in that table can use `shl rd, ra, #k` with rd != ra.  A distance
; outside it must use the tied `shl rd, rd, #imm5` form, which consumes its
; source.  Each rotation needs the pair (m, 16-m), so:
;
;   m = 0             free.  Exchange the register roles, emit nothing.
;   m = 1, 8, 15      both distances in shift3.  12 bytes, ONE scratch
;                     register, and the inputs survive.
;   m = 2,3,4,6,      one distance in shift3.  12 bytes, two scratch
;       10,12,13,14   registers, inputs consumed.
;   m = 5,7,9,11      neither distance in shift3.  14 bytes - one extra
;                     `mov` to put a distance in a register so the
;                     three-register shift form can be used.
;
; Worth knowing for SHA-256, whose ten rotations reduce to m = 14, 3, 10, 10,
; 5, 7, 9, 14, 15, 3 - so three of them land in the expensive group.


; ============================================================================
; roll left by 13     m = 13, distances 13 and 3
; ============================================================================
; r2 = low half, r3 = high half, updated in place.  r4 and r5 are scratch.
;
;       L' = (L << 13) | (H >> 3)
;       H' = (H << 13) | (L >> 3)
;
; 12 bytes, 12 cycles.

        lsr     r4, r3, #3      ; r4 = H >> 3   three-register form: 3 is in
        lsr     r5, r2, #3      ; r5 = L >> 3   shift3, so r2 and r3 survive
        shl     r2, r2, #13     ; r2 = L << 13  tied form: 13 is NOT in shift3,
        shl     r3, r3, #13     ; r3 = H << 13  so these consume their source
        or      r2, r2, r4      ; L' = (L<<13) | (H>>3)
        or      r3, r3, r5      ; H' = (H<<13) | (L>>3)

; THE ORDER IS FORCED.  Both right shifts must happen while r2 and r3 still
; hold the original halves, because the left shifts overwrite them.  Reorder
; these and the result is silently wrong, not rejected.


; ============================================================================
; roll left by 8      m = 8, distances 8 and 8
; ============================================================================
; 8 is in shift3 in both directions, so every shift can name a separate
; destination.  That buys two things: the inputs survive, and only one scratch
; register is needed instead of two.
;
; Result in r0:r1, inputs r2:r3 untouched.  Still 12 bytes.

        shl     r0, r2, #8      ; r0 = L << 8
        lsr     r4, r3, #8      ; r4 = H >> 8
        or      r0, r0, r4      ; L' = (L<<8) | (H>>8)
        shl     r1, r3, #8      ; r1 = H << 8
        lsr     r4, r2, #8      ; r4 = L >> 8   (r4 is dead above, reuse it)
        or      r1, r1, r4      ; H' = (H<<8) | (L>>8)

; The same shape works for m = 1 and m = 15, whose distance pairs are (1,15)
; and (15,1) - both members of shift3.


; ============================================================================
; roll left by 7      m = 7, distances 7 and 9
; ============================================================================
; Neither 7 nor 9 is in shift3, so no two-register immediate shift is
; available.  The cheapest way out is ONE `mov` to park a distance in a
; register and use the three-register shift form for that direction; the other
; direction uses the tied immediate form.
;
; 14 bytes.  Paying 16 - by copying both halves first and using tied shifts
; throughout - is the obvious approach and the wrong one.

        mov     r4, #9          ; r4 = 9, the right-shift distance
        lsr     r5, r3, r4      ; r5 = H >> 9   three-register form
        lsr     r4, r2, r4      ; r4 = L >> 9   count is dead after this read
        shl     r2, r2, #7      ; r2 = L << 7   tied, consumes L
        shl     r3, r3, #7      ; r3 = H << 7   tied, consumes H
        or      r2, r2, r5      ; L' = (L<<7) | (H>>9)
        or      r3, r3, r4      ; H' = (H<<7) | (L>>9)

; Note `lsr r4, r2, r4` reads r4 as the shift count and writes r4 as the
; destination.  That is fine for a single-cycle operation, and it saves a
; register - but only because nothing needs the count afterwards.


; ============================================================================
; roll left by 16     m = 0
; ============================================================================
; Free.  Emit nothing and swap which register the following code treats as the
; high half.
;
; If the surrounding code genuinely cannot absorb the renaming, an exchange
; costs 6 bytes either way - three `mov`s through a scratch register, or the
; three-instruction xor swap below, which needs no scratch:
;
;       xor     r2, r2, r3
;       xor     r3, r3, r2
;       xor     r2, r2, r3
;
; Prefer the renaming.
