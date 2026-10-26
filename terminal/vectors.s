; ============================================================================
; vectors.s - the exception vectors, for ld/fructus-writethru.ld
; ============================================================================
;
; Thirteen four-byte slots from 0xffcc, each a three-byte jmp and a byte
; spare ([cpu.vectors] in isa/fructus.toml).  The interrupt line enters at
; brk, and the terminal's one source is the UART's receive interrupt; every
; other slot halts with interrupts off, the address after the fault in lr
; for a debugger to find.
;
; THE INTERRUPT is C's, rx_interrupt in main.cc, called from a shim.  Entry
; has already put the interrupted code's lr and sp in their shadows, the
; address to go back to in lr, and sp on the interrupt stack that main put
; in shadow_isp.  A function of no arguments may change r0, r1 and r5 and
; lr, isa/abi.s, so the shim keeps those; r2 - r4 are the callee's to keep.
; rti puts back the rest and sets ie again.
; ============================================================================

        .section .vectors,"ax"
        .rept   11              ; 0xffcc - 0xfff4: io_guard, irq0-7, nmi,
        jmp     stop            ; illegal_insn
        .byte   0
        .endr
        jmp     interrupt       ; 0xfff8 brk, and the interrupt line
        .byte   0
        jmp     _start          ; 0xfffc reset
        .byte   0

        .text
stop:
        cli
        halt
        jmp     stop

interrupt:
        push    lr, r5, r1
        push    r0
        call    rx_interrupt
        pop     r0
        pop     r1, r5, lr
        rti
