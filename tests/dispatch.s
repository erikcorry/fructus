; Dispatch bytes for tests/dispatch.c, through R_FRUCTUS_8_DISPATCH:
; `dispatch(sym)' is the byte whose handler, at 0x10000 - 16 * byte, is sym.
; run.sh defines the handlers with --defsym, so the bytes are the linker's,
; and the last is a constant, which is gas's.

        .section .rodata
        .globl  stream
stream:
        .byte   0x42
        .byte   dispatch(h_low), dispatch(h_high), dispatch(h_low + 0x20)
        .byte   dispatch(0xffb0)
