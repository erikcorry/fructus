; ============================================================================
; branch-cost.s - one of each control transfer, for the cost model to be
;                 checked against
; ============================================================================
;
; The spec says a relative branch costs one cycle beyond its length WHEN TAKEN,
; and an absolute one costs nothing beyond its length.  Every performance figure
; in this repo rests on that, and nothing else in the suite would notice if the
; simulator stopped applying it - the numbers would all shift together and every
; assertion would be re-tightened around the new wrong value.
;
; So each instruction below is stepped ONCE by tests/sim-check.mjs, with its
; cost read off directly.  Entered with r0 = 0, so `eq #0` is taken and `ne #0`
; is not.
;
; THE PAIR THAT MATTERS IS callr AND call.  Both are three bytes, both transfer
; control, both are always taken - and they differ by exactly one cycle, which
; isolates the relative addressing as the thing being paid for rather than the
; length or the jump.
; ============================================================================

b_taken:        br      eq, r0, #0, b_taken_x   ; 3 bytes, taken     -> 4
b_taken_x:
b_fall:         br      ne, r0, #0, b_fall_x    ; 3 bytes, not taken -> 3
b_fall_x:
j_rel:          jmpr    j_rel_x                 ; 2 bytes, relative  -> 3
j_rel_x:
j_abs:          jmp     j_abs_x                 ; 3 bytes, absolute  -> 3
j_abs_x:
c_rel:          callr   c_rel_x                 ; 3 bytes, relative  -> 4
c_rel_x:
c_abs:          call    c_abs_x                 ; 3 bytes, absolute  -> 3
c_abs_x:
i_ret:          ret                             ; 1 byte,  absolute  -> 1
