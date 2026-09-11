; ============================================================================
; crt0.s - start-up for compiled C on the simulator
; ============================================================================
;
; gas syntax, not customasm: this is linked, and sections and relocations are
; the point.  It goes with ld/fructus-sim.ld, which puts everything in RAM and
; leaves .bss to the loader - the simulator's memory starts zeroed, so there
; is nothing to copy and nothing to clear.
;
; THE EXIT STATUS IS r0 AT THE `halt'.  exit() is therefore nothing but a
; halt: its argument is already in r0.  abort() halts with 134, which is what
; a shell reports for SIGABRT, so a test runner can tell the two apart.
; ============================================================================

        .section .text.startup,"ax"
        .globl  _start
_start:
        mov     sp, #__stack_top
        call    main
        ; main's return value is in r0, which is exit's argument: fall in.

        .globl  exit
        .globl  _exit
exit:
_exit:
        halt

        .globl  abort
abort:
        mov     r0, #134
        halt
