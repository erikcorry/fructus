; The caller side of struct passing, written by hand so that nothing about it
; comes from the compiler under test.  Each call puts the fields where
; isa/abi.s says they go and checks what comes back; main returns 0, or the
; number of the first check that failed.
;
;   take2c    {char a, b}            a in r0, b in r1 - a register each
;   takepair  {int a, b}             a in r0, b in r1
;   takemixed {int a; long b}        a in r0, b in r1:r2 as high:low
;   fat_bump  {char *p; unsigned t}  in r0, r1 and back in r0, r1
;   make_pair                        two fields returned in r0 and r1
;   no_room   (int, int, int, {int, int})
;                                    r0, r1, r2, and then the whole struct on
;                                    the stack - it is one value for the no-
;                                    splitting rule, so r3 goes unused
;   takefive  {char a, b, c, d, e}   five fields is five registers, so all of
;                                    it goes on the stack, one byte a field
;   make_three  () -> {int a, b, c}  returned in r0, r1 and r2
;   make_four   () -> {char a, b, c, d}
;                                    returned in r0-r3, a register a field
;
; THE LAST TWO PUT SENTINELS IN r2 AND r3 before the call.  A callee that
; takes no arguments but returns into r2 or r3 must not preserve them, and
; one that wrongly believes it must hands the sentinel back in place of a
; field.
;
; make_four's fields are chars, and a byte in a register has an unspecified
; high byte - isa/abi.s, on arguments and return values - so each is checked
; in its low byte only.  -O0 returns them straight out of 16-bit loads.
;
; THE CHECK NUMBER LIVES IN r4, which is callee saved whatever the arity, so
; it survives every call below without being pushed.  r5 holds what each
; result should be.
;
; EVERY CHECK JUMPS OVER A `jmpr' rather than branching to the end, because a
; conditional branch reaches 127 bytes and this file is longer than that.

        .text
        .globl  main
main:
        push    lr

        ; take2c ({3, 5}) = 305
        mov     r4, #1
        mov     r0, #3
        mov     r1, #5
        call    take2c
        mov     r5, #305
        br      eq, r0, r5, .ok1
        jmpr    fail
.ok1:

        ; takepair ({7, 9}) = 709
        mov     r4, #2
        mov     r0, #7
        mov     r1, #9
        call    takepair
        mov     r5, #709
        br      eq, r0, r5, .ok2
        jmpr    fail
.ok2:

        ; takemixed ({1000, 0x20003}) = 0x000203eb, returned high:low
        mov     r4, #3
        mov     r0, #1000
        mov     r1, #2                  ; the long's high half
        mov     r2, #3                  ; and its low half
        call    takemixed
        mov     r5, #2
        br      eq, r0, r5, .ok3
        jmpr    fail
.ok3:
        mov     r4, #4
        mov     r5, #0x03eb
        br      eq, r1, r5, .ok4
        jmpr    fail
.ok4:

        ; fat_bump ({0x1234, 0xbeef}) = {0x1236, 0xbeef}
        mov     r4, #5
        mov     r0, #0x1234
        mov     r1, #0xbeef
        call    fat_bump
        mov     r5, #0x1236
        br      eq, r0, r5, .ok5
        jmpr    fail
.ok5:
        mov     r4, #6
        mov     r5, #0xbeef
        br      eq, r1, r5, .ok6
        jmpr    fail
.ok6:

        ; make_pair (0x1111, 0x2222) comes back in r0 and r1
        mov     r4, #7
        mov     r0, #0x1111
        mov     r1, #0x2222
        call    make_pair
        mov     r5, #0x1111
        br      eq, r0, r5, .ok7
        jmpr    fail
.ok7:
        mov     r4, #8
        mov     r5, #0x2222
        br      eq, r1, r5, .ok8
        jmpr    fail
.ok8:

        ; no_room (1, 2, 3, {4, 5}) = 546.  Three arguments leave one
        ; register, and a struct that does not fit entirely goes on the stack
        ; as a unit, so r3 is untouched and both fields are pushed.
        mov     r4, #9
        mov     r5, #5                  ; s.b, at the higher address
        push    r5
        mov     r5, #4                  ; s.a, at sp
        push    r5
        mov     r0, #1
        mov     r1, #2
        mov     r2, #3
        mov     r3, #0                  ; nothing is passed here
        call    no_room
        add     sp, sp, #4
        mov     r5, #546
        br      eq, r0, r5, .ok9
        jmpr    fail
.ok9:

        ; takefive ({1, 2, 3, 4, 5}) = 15, all of it on the stack
        mov     r4, #10
        mov     r5, #5
        push8   r5                      ; e, at the highest address
        mov     r5, #4
        push8   r5
        mov     r5, #3
        push8   r5
        mov     r5, #2
        push8   r5
        mov     r5, #1
        push8   r5                      ; a, at sp
        call    takefive
        add     sp, sp, #5
        mov     r5, #15
        br      eq, r0, r5, .ok10
        jmpr    fail
.ok10:

        ; make_three () = {176, 52, 31}, with sentinels in r2 and r3
        mov     r4, #11
        mov     r2, #0x5a5a
        mov     r3, #0xa5a5
        call    make_three
        mov     r5, #176
        br      eq, r0, r5, .ok11
        jmpr    fail
.ok11:
        mov     r4, #12
        mov     r5, #52
        br      eq, r1, r5, .ok12
        jmpr    fail
.ok12:
        mov     r4, #13
        mov     r5, #31
        br      eq, r2, r5, .ok13
        jmpr    fail
.ok13:

        ; make_four () = {1, 2, 3, 4}, with sentinels in r2 and r3
        mov     r4, #14
        mov     r2, #0x5a5a
        mov     r3, #0xa5a5
        call    make_four
        and     r0, r0, #0x00ff
        mov     r5, #1
        br      eq, r0, r5, .ok14
        jmpr    fail
.ok14:
        mov     r4, #15
        and     r1, r1, #0x00ff
        mov     r5, #2
        br      eq, r1, r5, .ok15
        jmpr    fail
.ok15:
        mov     r4, #16
        and     r2, r2, #0x00ff
        mov     r5, #3
        br      eq, r2, r5, .ok16
        jmpr    fail
.ok16:
        mov     r4, #17
        and     r3, r3, #0x00ff
        mov     r5, #4
        br      eq, r3, r5, .ok17
        jmpr    fail
.ok17:

        mov     r0, #0
        pop     lr
        ret
fail:
        mov     r0, r4
        pop     lr
        ret
