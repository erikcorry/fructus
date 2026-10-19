; ============================================================================
; branch-cost.s - one of each control transfer, for the cost model to be
;                 checked against
; ============================================================================
;
; The spec says a conditional branch costs what any instruction does when it
; falls through as guessed - one cycle, while the fetcher keeps up - three
; when guessed taken and taken, and five when guessed wrong: it is decided in
; the ALU stage `taken_branch_penalty` cycles after its dispatch, and the
; right target dispatches two cycles after that.  jmp and call to an address
; in their bytes read it as they dispatch: two cycles and three.  Through a
; register they are five, or two and three when the jmp ra predictor guessed
; the target, and ret five, or two when the return stack guessed it.  Each is
; one more when the instruction at the target spans two words - two bytes at
; an odd address, or three at any - as every target below does, except a call
; that went straight to its target:
; it holds dispatch two cycles after its target's word is read, and the
; fetcher brings the second word in that time.  Every performance figure in
; this repo rests on that, and nothing else in the suite would notice if the
; simulator stopped applying it - the numbers would all shift together and
; every assertion would be re-tightened around the new wrong value.
; tests/cpu-check.mjs holds the simulator to the processor on random
; programs; this holds it to the spec.
;
; So each instruction below is stepped ONCE by tests/sim-check.mjs, from a
; full buffer and an empty branch predictor, with its cost read off directly.
; Entered with r0 = 0, so `eq #0` is taken and `ne #0` is not.  THE
; ADDRESSES MATTER, so nothing may be inserted above the last label without
; redoing the column on the right.
;
; THE PAIR THAT MATTERS IS THE SAME BRANCH TAKEN AND NOT TAKEN, at even
; addresses.  Same opcode, same three bytes, same operands - and the penalty
; and the target's two words apart, which isolates the taking as the thing
; being paid for rather than the length or the decode.  Both are forward, so
; the empty predictor guesses not taken, and the taken one is guessed wrong.
; And the same branch not taken at an odd address pays one more, though the
; buffer is full: it and the three-byte instruction after it, 0x03 to 0x08,
; touch four words, and the buffer holds three.
;
; THE REGISTER FORMS COST THREE MORE UNGUESSED, WHATEVER THEIR LENGTH - `jmp
; r0` in two bytes and `ret` in one - because the target is the register's,
; known in the ALU cycle, and goes through a flop before the fetch.  `call lr`
; goes to the NEW lr, the next instruction, reads no register, and costs one
; less.  Guessed right, `jmp r0` and `call r0` cost what the absolute forms do.
; ============================================================================

b_taken:        br      eq, r0, #0, b_taken_x   ; 0x00, 3 bytes, taken, guessed not -> 6
b_taken_x:
b_odd:          br      ne, r0, #0, b_odd_x     ; 0x03, 3 bytes, odd, not taken  -> 2
b_odd_x:
b_even:         br      ne, r0, #0, b_even_x    ; 0x06, 3 bytes, even, not taken -> 1
b_even_x:
j_abs:          jmp     j_abs_x                 ; 0x09, 3 bytes, absolute  -> 3
j_abs_x:
c_abs:          call    c_abs_x                 ; 0x0c, 3 bytes, absolute  -> 3
c_abs_x:
c_lr:           call    lr                      ; 0x0f, 2 bytes, the new lr -> 5
c_lr_x:
j_reg:          jmp     r0                      ; 0x11, 2 bytes, register  -> 6, guessed 3
j_reg_x:
i_ret:          ret                             ; 0x13, 1 byte,  register  -> 6
i_ret_x:
c_reg:          call    r0                      ; 0x14, 2 bytes, register  -> 6, guessed 3
