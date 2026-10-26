; ============================================================================
; vectors.s - the exception vectors, for ld/fructus-writethru.ld
; ============================================================================
;
; Thirteen four-byte slots from 0xffcc, each a three-byte jmp and a byte
; spare ([cpu.vectors] in isa/fructus.toml).  The terminal polls the serial
; line and takes no interrupt, so every slot but reset halts with interrupts
; off, the address after the fault in lr for a debugger to find.
; ============================================================================

        .section .vectors,"ax"
        .rept   12              ; 0xffcc - 0xfff8: io_guard, irq0-7, nmi,
        jmp     stop            ; illegal_insn, brk
        .byte   0
        .endr
        jmp     _start          ; 0xfffc reset
        .byte   0

        .text
stop:
        cli
        halt
        jmp     stop
