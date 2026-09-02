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
;       head            3.4839 cycles/byte      up to 31 bytes, in words
;       sizes           bzero 12 bytes, memset 48, 60 together
;
; The floor is 1.00 - one bus cycle to write each byte - and 15 bytes of loop
; get to 1.47.  snippets/speed-of-light-memset-core.s reaches 1.3450 and spends
; 89 bytes doing it, so this gives up 9% for a quarter of the code.
;
; THE HEAD PUSHES WORDS, which is worth having: a byte loop costs 6 cycles a
; byte and clearing a 24-byte struct came to 170 cycles, against 113 now.  Five
; bytes of code buy 34% on every length below 32 and cost 3 cycles on exact
; multiples of 32 - and the sizes below 32 are the ones a compiler emits for
; clearing a struct, which is most memset calls in most programs.
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
; memset                                                            48 bytes
; ============================================================================
; sp walks down from the end of the region to the start, in three phases:
;
;       s                    s + (n & ~31)          s + n - 1   s + n
;       |------ fill loop --------|----- words -----------|-byte-|
;                                                          <----- filled first
;
; The head runs FIRST because it is the high end and push descends.  The odd
; byte goes at the very TOP rather than the bottom, which is a choice and not
; forced: putting it at s would work too, but then the fill loop would have to
; stop at s + 1 instead of s, and its exit test compares against r0 directly.
; At the top it costs nothing - the head simply starts one byte lower.

; --- double the byte, before anything else ---------------------------------
; r5 is the temporary here and takes the real sp immediately afterwards, which
; is the whole reason this can come first: there is no third register free once
; sp has been captured, and the head needs the doubled byte to push words.
;
; C says memset takes an int and uses `(unsigned char)c`, so a caller passing
; 0x12ff must fill with 0xff.  The zxt8 is what makes that true, not decoration.

memset:
        zxt8    r1, r1                  ; (unsigned char)c is the contract
        shl     r5, r1, #8              ; 8 is in shift3, so this is two bytes
        or      r1, r1, r5              ; r1 = c:c
        mov     r5, sp                  ; the real stack, out of the way
        add     sp, r0, r2              ; sp = one past the end

; --- the head: at most 31 bytes, in words ----------------------------------
; An odd length gets one byte peeled off the top, and everything below that is
; pushed two bytes at a time.  Words rather than bytes is worth 3.5 cycles a
; byte instead of 6, which is most of what a small memset costs.
;
; NO `add r2, r2, #-1` AFTER THE PEEL, and that is exact rather than lucky: an
; odd n is never a multiple of 32, so subtracting one from it cannot cross a
; block boundary, and n & ~31 is the same either way.

        brclear r2, #1, .even           ; even length: no byte to peel
        push8   r1                      ; the odd byte, at the very top    3
.even:
        and     r2, r2, #-32            ; the length, rounded down to a block
        add     r2, r0, r2              ; ... as an address: where the head stops

        br      eq, sp, r2, .headdone   ; nothing between the block and the end
.head:
        push    r1                      ;                               4
        br      ne, sp, r2, .head       ;                               3
.headdone:

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
; WHAT THE HEAD IS STILL LEAVING.  Between 3.50 and the 1.47 of the fill loop
; there is one more step - pushing triples down to the block boundary the way
; the fill loop does - but it needs its own entry ladder to know how many
; triples to start with, and that is a jump table or a chain of tests.  Both
; cost more than the case is worth: the head is at most 31 bytes, so the whole
; remaining saving is about 60 cycles on a call that already costs 113.
