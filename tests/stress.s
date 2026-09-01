; Exercises every addressing form, both branch shapes, the aliases, and the
; long-immediate fallbacks.  Assembled by tests/run.sh against both modes.

start:
        nop
        halt
        ld8     r0, [r0, #0]            ; 1  implicit
        ld      r0, [r0, #0]            ; 1  implicit
        ld8     r3, [r3, #-12]          ; 2  tied, imm5
        ld      r2, [r5, #-1]           ; 2  two-reg, imm3 (tag absorbing)
        ld8     r1, [r2, #300]          ; 3  two-reg, imm10
        st8     r1, [r2, #3]            ; 2  two-reg, imm3
        st      r1, [r2, #-500]         ; 3  two-reg, imm10

        add     r0, r0, #1              ; 1
        add     r0, r0, #-1             ; 1
        add     r0, r0, #2              ; 1
        add     r0, r0, r1              ; 1
        add     r1, r1, r0              ; 1
        add     r3, r3, #15             ; 2  tied, imm5
        add     r3, r4, #8              ; 2  two-reg, imm3
        add     r3, r4, #500            ; 3  two-reg, imm10
        add     r3, r4, r6              ; 2  three-reg
        rsb     r1, r2, #0              ; 2  negate
        xor     r1, r2, #-1             ; 2  invert
        and     r1, r2, #0xff00         ; 3  wraps to -256, fits imm10
        or      r0, r1, #0              ; 1  = mov r0, r1
        or      r1, r0, #0              ; 1  = mov r1, r0

        and     r2, r2, #0x7fff         ; 2  immbit5, clear the sign bit
        and     r2, r2, #-2             ; 2  imm5 WINS: -2 is in both
        and     r2, r2, #0xfeff         ; 2  immbit5, clear bit 8
        and     r2, r2, #-9             ; 2  imm5 WINS: -9 is in both
        or      r2, r2, #0x8000         ; 2  immbit5, set the sign bit
        or      r2, r2, #256            ; 2  immbit5, set bit 8
        or      r2, r2, #8              ; 2  imm5 WINS: 8 is in both
        xor     r2, r2, #0x8000         ; 2  immbit5, flip the sign bit
        xor     r2, r2, #1024           ; 2  immbit5, flip bit 10
        xor     r2, r2, #0x7fff         ; 2  immbit5, flip all but the sign
        xor     r2, r2, #4              ; 2  imm5 WINS: 4 is in both
        xor     r2, r2, #-1             ; 2  imm5, the plain complement - 0xffff
                                        ;    is -1, not ~(1<<n), so it is not an
                                        ;    immbit5 value at all
        and     r3, r2, #0x7fff         ; 4  NOT tied, so no two-byte form fits,
                                        ;    and 0x7fff is outside imm10 as well -
                                        ;    this expands to mov + three-reg and,
                                        ;    borrowing the destination as scratch

        mov     r0, r1                  ; 1  alias -> or, then the 1-byte form
        mov     r4, r5                  ; 2  alias -> or, two-reg imm3
        mov     r2, #-5                 ; 2  imm5
        mov     r2, #4                  ; 2  imm5 WINS: 4 is in both
        mov     r2, #16                 ; 2  immbit5 - three bytes before it
        mov     r2, #4096               ; 2  immbit5, was imm16
        mov     r2, #0x8000             ; 2  immbit5
        mov     r2, #0x7fff             ; 2  immbit5, largest positive
        mov     r2, #-17                ; 2  immbit5, ~16
        mov     r2, #4097               ; 3  imm16: two bits set, no shortcut
        sub     r1, r2, r3              ; 2  alias -> rsb, swapped
        sub     r4, r4, #4              ; 2  alias -> add #-4, tied

        shl     r2, r2, #13             ; 2  tied, imm5
        asr     r2, r3, #6              ; 2  two-reg, shift3
        lsr     r2, r3, #15             ; 2  shift3 spells -1 as 15
        shl     r2, r3, r4              ; 2  three-reg

        sxt8    r1, r2
        zxt8    r1, r2

        push    lr
        push    lr, r4
        push    r0, r1, r2
        push8   r1
        pop8    r1
        pop     r2, r1, r0
        pop     r4, lr
        pop     lr
        call    r3

btarget:
        jmpr    btarget                   ; 2  the short jmpr form
        br8     ne, r1, r2, btarget       ; 3
        br      gt, r1, r2, btarget       ; 3  swapped -> lt
        br      eq, r3, #0, btarget       ; 3  condimm5, encoded
        br      hs, r3, #3, btarget       ; 3  condimm5, imm3 constant
        br      lo, r3, #6, btarget       ; 3  condimm5, imm3 constant
        br      lt, r3, #4, btarget       ; 3  condimm5, signed loop bound
        br      ge, r3, #8, btarget       ; 3  condimm5, signed loop bound
        br      vs, r3, #-1, btarget      ; 3  does r3++ overflow
        br      vs, r3, #1, btarget       ; 3  does r3-- underflow
        br      vs, r3, #2, btarget       ; 3  tagged decrement underflows
        br      hs, r3, #1, btarget       ; 3  REWRITE -> ne #0
        br      lo, r3, #1, btarget       ; 3  REWRITE -> eq #0
        br      gt, r3, #1, btarget       ; 3  REWRITE -> ge #2
        br      le, r3, #0, btarget       ; 3  REWRITE -> lt #1
        br      le, r3, #3, btarget       ; 3  REWRITE -> lt #4
        br      gt, r3, #7, btarget       ; 3  REWRITE -> ge #8
        br      le, r3, #-2, btarget      ; 3  REWRITE -> lt #-1
        brset   r4, #0x8000, btarget      ; 3  the sign bit is set
        brclear r4, #1, btarget           ; 3  the low bit is clear
        brclear r4, #0x7fff, btarget      ; 3  NOTHING but the sign bit is set
        brset   r4, #0xfffe, btarget      ; 3  some bit other than 0 is set
        jmp     0x1234
        jmpr    start
        call    0x1234
        callr   start
        ret
