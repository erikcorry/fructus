; The zero page from assembly, for tests/zp.c: a variable of its own in
; zp_hi, and C's variables read through the base with R_FRUCTUS_ZP10.

        .zphi
        .globl  asm_count
        .p2align 1
asm_count:
        .2byte  0

        .text
        .globl  asm_sum
asm_sum:
        mov     r1, #0x200          ; r0, r1 and r5 only: a function of no
        ld      r0, [r1, #zp(a)]    ; arguments keeps r2-r4 for its caller
        ld      r5, [r1, #zp(b)]
        add     r0, r0, r5
        ld      r5, [r1, #zp(h)]
        add     r0, r0, r5
        ld      r5, [r1, #zp(asm_count)]
        add     r0, r0, r5
        ret
