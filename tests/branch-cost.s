; ============================================================================
; branch-cost.s - one of each control transfer, for the cost model to be
;                 checked against
; ============================================================================
;
; The spec says a conditional branch costs what any instruction does when it
; falls through - one cycle, while the fetcher keeps up - and when it is taken
; reads its target `taken_branch_penalty` cycles after its dispatch, which
; dispatches two cycles later: five in all.  A jump or call is four, and five
; through a register.  Each of those is one more when the instruction at the
; target spans two words - two bytes at an odd address, or three at any - as
; every target below does.  Every performance figure in this repo rests on
; that, and nothing else in the suite would notice if the simulator stopped
; applying it - the numbers would all shift together and every assertion would
; be re-tightened around the new wrong value.  tests/cpu-check.mjs holds the
; simulator to the processor on random programs; this holds it to the spec.
;
; So each instruction below is stepped ONCE by tests/sim-check.mjs, from a
; full buffer, with its cost read off directly.  Entered with r0 = 0, so `eq
; #0` is taken and `ne #0` is not.  THE ADDRESSES MATTER, so nothing may be
; inserted above the last label without redoing the column on the right.
;
; THE PAIR THAT MATTERS IS THE SAME BRANCH TAKEN AND NOT TAKEN, at even
; addresses.  Same opcode, same three bytes, same operands - and the penalty
; and the target's two words apart, which isolates the taking as the thing
; being paid for rather than the length or the decode.  And the same branch
; not taken at an odd address pays one more, though the buffer is full: it
; and the three-byte instruction after it, 0x03 to 0x08, touch four words,
; and the buffer holds three.
;
; THE REGISTER FORMS COST ONE MORE WHATEVER THEIR LENGTH - `jmp r0` in two
; bytes and `ret` in one - because the target goes through a flop before the
; fetch.  `call lr` is the exception that proves it: it goes to the NEW lr,
; the next instruction, reads no register, and costs what an absolute call
; does.
; ============================================================================

b_taken:        br      eq, r0, #0, b_taken_x   ; 0x00, 3 bytes, taken     -> 6
b_taken_x:
b_odd:          br      ne, r0, #0, b_odd_x     ; 0x03, 3 bytes, odd, not taken  -> 2
b_odd_x:
b_even:         br      ne, r0, #0, b_even_x    ; 0x06, 3 bytes, even, not taken -> 1
b_even_x:
j_rel:          jmpr    j_rel_x                 ; 0x09, 2 bytes, relative  -> 5
j_rel_x:
j_abs:          jmp     j_abs_x                 ; 0x0b, 3 bytes, absolute  -> 5
j_abs_x:
c_abs:          call    c_abs_x                 ; 0x0e, 3 bytes, absolute  -> 5
c_abs_x:
c_lr:           call    lr                      ; 0x11, 2 bytes, the new lr -> 5
c_lr_x:
j_reg:          jmp     r0                      ; 0x13, 2 bytes, register  -> 6
j_reg_x:
i_ret:          ret                             ; 0x15, 1 byte,  register  -> 6
