; Tagged pointers for tests/tag1.c, through R_FRUCTUS_16_TAG1: `tag1(sym)'
; is sym's address plus one, and the linker refuses an odd sym.  The table is
; aligned; the stream is a bytecode stream, an opcode byte and then two
; tagged operands, so both operands are at odd addresses.

        .section .rodata
        .globl  table
        .p2align 1
table:
        .2byte  tag1(o1), tag1(o2 + 8), tag1(0x1234)

        .globl  stream
        .p2align 1
stream:
        .byte   0x42
        .short  tag1(o1)
        .short  tag1(o2 + 4)

; And as immediates, which is how generated code loads one: a symbol takes
; the three-byte mov, whose 16-bit field the same relocation fills.
        .text
        .globl  tagged_o1, tagged_o2_1
tagged_o1:
        mov     r0, #tag1(o1)
        ret
tagged_o2_1:
        mov     r0, #tag1(o2 + 4)
        ret
