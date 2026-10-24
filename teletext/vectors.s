; ============================================================================
; vectors.s - the exception vectors, and the interrupt's way into C
; ============================================================================
;
; ld/fructus-writethru.ld puts .vectors at 0xffcc: thirteen four-byte slots,
; each a three-byte jmp and a byte spare ([cpu.vectors] in isa/fructus.toml).
; The CPU starts at 0, crt0.s's jmp to _start, so the reset slot is only for
; tidiness.
;
; THE INTERRUPT LINE ENTERS AT brk.  Entry has put the interrupted lr in
; shadow_lr, the return address in lr and the interrupt stack in sp, and rti
; undoes all three.  The stub keeps what a void (void) C function may
; clobber - r0, r1, r5 and lr; r2 and r3 are callee saved when nothing is
; passed in them - and calls teletext_rx_interrupt.  A `brk' comes here too;
; the handler finds nothing received and returns.
;
; THE REST STOP.  The I/O guard is a stack run into the I/O page, and the
; reserved slots are hardware this system does not have; none is meant to
; return from, so each halts with interrupts off - for good, with the
; address after the fault in lr for a debugger to find.
; ============================================================================

        .section .vectors,"ax"
        jmp     stop            ; 0xffcc io_guard
        .byte   0
        .rept   8               ; 0xffd0 - 0xffec irq0 - irq7
        jmp     stop
        .byte   0
        .endr
        jmp     stop            ; 0xfff0 nmi
        .byte   0
        jmp     stop            ; 0xfff4 illegal_insn
        .byte   0
        jmp     interrupt       ; 0xfff8 brk, and the interrupt line
        .byte   0
        jmp     _start          ; 0xfffc reset
        .byte   0

        .text
interrupt:
        push    r0, r1, r5
        push    lr
        call    teletext_rx_interrupt
        pop     lr
        pop     r5, r1, r0
        rti

stop:
        cli
        halt
        jmp     stop
