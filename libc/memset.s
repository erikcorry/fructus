; ============================================================================
; libc/memset.s - memset and bzero
; ============================================================================
;
;       void *memset(void *s, int c, size_t n)      r0 = s, r1 = c, r2 = n
;       void  bzero (void *s, size_t n)             r0 = s, r1 = n
;
; Both return with r0 untouched, so memset's return value costs nothing.
;
; THE TRICK IS THAT `push` WRITES THREE REGISTERS FOR TWO INSTRUCTION BYTES and
; steps the pointer itself.  memset never reads, so there is no second pointer
; to maintain and no load to pay for - which is why the fill loop gets closer to
; its floor than the copy loop in memcpy.s gets to its own.  It runs backwards,
; from the end of the region down to the start, because that is the direction
; push goes; nothing about memset cares which way it is filled.
;
; INTERRUPTS MUST HAVE THEIR OWN STACK POINTER.  sp is the fill cursor for the
; whole routine, so anything that pushed to it would land in the buffer.
;
; ----------------------------------------------------------------------------
; MEASURED, by tests/libc-check.mjs
; ----------------------------------------------------------------------------
;       fill loop       1.4688 cycles/byte      32 bytes an iteration
;       byte head       6.0000 cycles/byte      up to 31 bytes
;       sizes           bzero 12 bytes, memset 43, 55 together
;
; The floor is 1.00 - one bus cycle to write each byte - and 15 bytes of loop
; get to 1.47.  snippets/speed-of-light-memset-core.s reaches 1.3450 and spends
; 89 bytes doing it, so this gives up 9% for a quarter of the code.
;
; THE HEAD IS THE WEAK PART.  Everything below 32 bytes goes through a `push8`
; loop at 6 cycles a byte, so clearing a 24-byte struct costs 170 cycles where
; the 32-byte case costs 73.  See the note at the bottom.
; ============================================================================


; ============================================================================
; bzero                                                             12 bytes
; ============================================================================
; THE SAVE IS THE ARITY-DEPENDENT ABI BITING, and it is worth understanding
; rather than removing.  bzero takes two arguments, so under isa/abi.s r2 is not
; an argument to it and is therefore CALLEE saved - bzero's caller is entitled
; to find r2 intact.  memset takes three, so r2 is an argument to memset and is
; caller saved there, and memset duly destroys it.
;
; So the obvious tail call is wrong: `mov r2, r1; mov r1, #0; jmpr memset` would
; return with r2 clobbered and break bzero's own contract.  Four bytes of save
; and restore are the price of the arity difference, and no cheaper arrangement
; exists - r2 has to survive a call that is entitled to destroy it.

bzero:
        push    r2, lr                  ; r2 is callee saved HERE and not in memset
        mov     r2, r1                  ; the length moves up one place
        mov     r1, #0                  ; ... and the fill byte takes its slot
        callr   memset
        pop     lr, r2
        ret


; ============================================================================
; memset                                                            43 bytes
; ============================================================================
; sp walks down from the end of the region to the start, in two phases:
;
;       s                    s + (n & ~31)              s + n
;       |---- fill loop ----------|--- byte head ---------|
;                                 <---------------------- filled first
;
; The byte head runs FIRST because it is the high end and push descends.  It is
; also the only part that can use the fill byte before it has been doubled,
; which is why the doubling sits between the two loops rather than at the top.

memset:
        mov     r5, sp                  ; the real stack, out of the way
        add     sp, r0, r2              ; sp = one past the end
        and     r2, r2, #-32            ; the length, rounded down to a block
        add     r2, r0, r2              ; ... as an address: where the head stops

        br      eq, sp, r2, .headdone   ; n was already a multiple of 32
.head:
        push8   r1                      ;                               3
        br      ne, sp, r2, .head       ;                               3
.headdone:

; --- double the byte -------------------------------------------------------
; r2 is finished with, so it is the temporary.  The shift comes first: it reads
; r1 while the high byte is still whatever the caller passed, and discards it
; anyway, so only r1 itself needs clearing.  C says memset takes an int and uses
; `(unsigned char)c`, so a caller passing 0x12ff must fill with 0xff - the zxt8
; is what makes that true, not decoration.

        shl     r2, r1, #8              ; 8 is in shift3, so this is two bytes
        zxt8    r1, r1                  ; and (unsigned char)c is the contract
        or      r1, r1, r2              ; r1 = c:c

; --- the fill loop, 32 bytes an iteration ----------------------------------
; Sixteen words: five triples and a single.  Nothing here maintains a pointer,
; because push already does, and nothing reads memory at all.

        jmpr    .bottom
.top:
        push    r1, r1, r1              ;                               8
        push    r1, r1, r1              ;                               8
        push    r1, r1, r1              ;                               8
        push    r1, r1, r1              ;                               8
        push    r1, r1, r1              ;                               8
        push    r1                      ;                               4
.bottom:
        br      ne, sp, r0, .top        ;                               3

        mov     sp, r5                  ; hand the real stack back
        ret

; r5 HOLDS THE REAL STACK POINTER, AND r5 IS THE ASSEMBLER'S SCRATCH.  Any
; immediate that does not fit its instruction expands through r5, which here
; would silently destroy the saved sp rather than fail.  It is safe only because
; nothing in this file needs an expansion - and that is not a matter of opinion:
; tests/run.sh assembles libc against the --noat ruledef, which omits every rule
; that borrows the scratch, so a future edit that needs one fails to assemble
; instead of corrupting the stack.  Do not remove that check.
;
; THE HEAD COULD BE THREE AND A HALF CYCLES A BYTE INSTEAD OF SIX, for seven
; more bytes.  Double the fill byte at the very top - r5 is free before it takes
; sp - then peel one `push8` if n is odd and push WORDS down to the block
; boundary.  Measured against this version: 24 bytes falls from 170 cycles to
; 113, 31 bytes from 212 to 139, and every exact multiple of 32 costs 3 more.
; That is a 35% saving on precisely the sizes a compiler emits for clearing a
; struct, which is most memset calls in most programs.  Left undone on purpose:
; 43 bytes is the version that fits the brief.
