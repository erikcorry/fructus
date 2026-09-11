; The caller side of the sliding convention, written by hand so that nothing
; about it comes from the compiler under test.  Before each call r2, r3 and
; r4 hold sentinels; after it, the registers the callee's ABI keeps must
; still hold them.  main returns 0, or the number of the first failed check.

        .text
        .globl  main
main:
        push    lr

        ; one (int): r2, r3, r4 preserved
        mov     r2, #0x2222
        mov     r3, #0x3333
        mov     r4, #0x4444
        mov     r0, #5
        call    one
        mov     r5, #0x2222
        mov     r0, #1
        br      ne, r2, r5, fail
        mov     r5, #0x3333
        mov     r0, #2
        br      ne, r3, r5, fail
        mov     r5, #0x4444
        mov     r0, #3
        br      ne, r4, r5, fail

        ; two (int, int): r2, r3, r4 preserved
        mov     r2, #0x2222
        mov     r3, #0x3333
        mov     r0, #5
        mov     r1, #6
        call    two
        mov     r5, #0x2222
        mov     r0, #4
        br      ne, r2, r5, fail
        mov     r5, #0x3333
        mov     r0, #5
        br      ne, r3, r5, fail
        mov     r5, #0x4444
        mov     r0, #6
        br      ne, r4, r5, fail

        ; three (int, int, int): r3, r4 preserved
        mov     r3, #0x3333
        mov     r0, #5
        mov     r1, #6
        mov     r2, #7
        call    three
        mov     r5, #0x3333
        mov     r0, #7
        br      ne, r3, r5, fail
        mov     r5, #0x4444
        mov     r0, #8
        br      ne, r4, r5, fail

        ; four (int x4): r4 preserved
        mov     r0, #5
        mov     r1, #6
        mov     r2, #7
        mov     r3, #8
        call    four
        mov     r5, #0x4444
        mov     r0, #9
        br      ne, r4, r5, fail

        ; wide (int) returning 64 bits: r4 preserved
        mov     r0, #5
        call    wide
        mov     r5, #0x4444
        mov     r0, #10
        br      ne, r4, r5, fail

        mov     r0, #0
fail:
        pop     lr
        ret
