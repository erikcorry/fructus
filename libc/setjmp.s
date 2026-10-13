; ============================================================================
; libc/setjmp.s - setjmp and longjmp
; ============================================================================
;       int  setjmp (jmp_buf env)               r0 = env
;       void longjmp (jmp_buf env, int val)     r0 = env, r1 = val
;
; jmp_buf is five words:  r2  r3  r4  sp  lr
;
; WHY THOSE FIVE AND NOTHING ELSE.  longjmp has to leave its caller's caller -
; the function that called setjmp - looking exactly as it did at the setjmp
; call.  That is sp, the return address, and every register setjmp itself
; promised to preserve.  setjmp takes one argument and returns an int, so
; under isa/abi.s it is the r0, r1 convention: r2, r3 and r4 are callee saved.
; Their values ON ENTRY to setjmp are therefore the calling function's own,
; and restoring them is both necessary and enough.
;
; r0, r1 and r5 need no saving because that same convention lets any call
; destroy them, so nothing live is in them across the setjmp.
;
; THE OFFSETS ARE ALL imm3 ENTRIES - 0, 2, 4, 6, 8 are five of the eight - so
; every one of these ten accesses is a two-byte instruction.
;
;       setjmp   12 bytes, 21 cycles
;       longjmp  15 bytes, 26 cycles when val is non-zero, 23 when it is zero
;
; Fifteen of each one's cycles are its five accesses: a load or a store of
; an aligned word stops the pipeline for three cycles - see the cost model
; under [cpu] in the spec.  The zero case is the CHEAPER one, though it has
; to make the 1, because it falls through the branch at one cycle where the
; non-zero case takes it at five.
; ============================================================================

setjmp:
        st      r2, [r0, #0]            ; 3
        st      r3, [r0, #2]            ; 3
        st      r4, [r0, #4]            ; 3
        st      sp, [r0, #6]            ; 3
        st      lr, [r0, #8]            ; 3   where the caller resumes
        mov     r0, #0                  ; 1   pinned: a direct call returns 0
        ret                             ; 5

longjmp:
        ld      r2, [r0, #0]            ; 3
        ld      r3, [r0, #2]            ; 3
        ld      r4, [r0, #4]            ; 3
        ld      sp, [r0, #6]            ; 3   the frame is the caller's again
        ld      lr, [r0, #8]            ; 3
        mov     r0, r1                  ; 1   pinned: val is what setjmp returns
        br      ne, r0, #0, .ret        ; 1, taken 5
        mov     r0, #1                  ; 1   longjmp (env, 0) returns 1, says C
.ret:
        ret                             ; 5   back into the setjmp call
