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
;       head            3.5000 cycles/byte      up to 15 bytes, in words
;       sizes           bzero 12 bytes, memset 52, 64 together
;
; The floor is 1.00 - one bus cycle to write each byte - and 15 bytes of loop
; get to 1.47.  snippets/speed-of-light-memset-core.s reaches 1.3450 and spends
; 89 bytes doing it, so this gives up 9% for a quarter of the code.
;
; THE HEAD ONLY HAS TO REACH 15 BYTES, because the fill loop can be entered at
; its midpoint - see the loop itself.  Everything from 16 bytes up runs at the
; loop's rate, and the head pushes words rather than bytes, so what began as a
; 6-cycles-a-byte tail is now 3.5 over at most fifteen bytes.
;
; The two steps together, measured, against the original byte head:
;
;       n        byte head    word head    + midpoint entry
;       16         122           85              53
;       24         170          113              81
;       31         212          137             105
;       32          73           76              80
;
; and the cost of each is exact and small: word pushes were 5 bytes and 3 cycles
; on multiples of 32, the midpoint 4 more bytes and 4 more cycles on lengths
; whose bit 4 is clear.  Averaged over every length from 0 to 512 the midpoint
; alone is worth 14 cycles a call: 32 saved on half the lengths, 4 spent on the
; other half.  These are the sizes a compiler emits to clear a struct, which is
; most memset calls in most programs.
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
; memset                                                            52 bytes
; ============================================================================
; sp walks down from the end of the region to the start, in three phases:
;
;       s                        s + (n & ~15)      s + n - 1   s + n
;       |-------- fill loop ----------|--- words --------|-byte-|
;                                                         <----- filled first
;
; The fill loop moves 32 bytes an iteration but can be entered halfway, so the
; boundary is a multiple of 16 rather than 32 and the head never exceeds 15
; bytes.  That is the whole reason for the loop's 3-3-2 3-3-2 shape.
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
        and     r2, r2, #-16            ; the length, rounded down to a half block
        add     r2, r0, r2              ; ... as an address: where the head stops

        br      eq, sp, r2, .headdone   ; nothing between the block and the end
.head:
        push    r1                      ;                               4
        br      ne, sp, r2, .head       ;                               3
.headdone:

; --- the fill loop, 32 bytes an iteration, in two identical halves ---------
; Sixteen words as 3-3-2 twice over, rather than five triples and a single.
; Both spellings are twelve bytes and both cost 44 cycles, so the shape is free
; - but this one has a USABLE MIDPOINT, and that is the whole point.  Entering
; at .mid fills exactly 16 bytes and then falls into the loop test, so the
; routine can start on a half block without a second copy of the code.
;
; That is what lets the head round to 16 rather than 32.  Half the work that
; used to go through the head at 3.5 cycles a byte now goes through the loop at
; 1.47, and the entry ladder costs five bytes: one `sub` to get the length back
; out of the boundary address, and one `brset` on bit 4.
;
; THE `sub` IS NOT BOOKKEEPING.  r2 has been the boundary ADDRESS since the head
; needed something to stop against, and the bit that decides where to enter is
; bit 4 of the LENGTH.  r2 - r0 recovers it, and no register was free to keep
; the length in.  (`xor r2, r2, r0` would do as well, and for a reason worth
; knowing: r2 and r0 agree in bits 0-3, so the subtraction cannot borrow into
; bit 4.  Same two bytes, less obvious, so sub it is.)

        sub     r2, r2, r0              ; the length back: a multiple of 16
        brset   r2, #16, .mid           ; an odd multiple starts halfway in
        jmpr    .bottom
.top:
        push    r1, r1, r1              ;                               8
        push    r1, r1, r1              ;                               8
        push    r1, r1                  ;                               6
.mid:
        push    r1, r1, r1              ;                               8
        push    r1, r1, r1              ;                               8
        push    r1, r1                  ;                               6
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
; WHY THE GRANULARITY STOPS AT 16, which is not squeamishness but arithmetic.
; An entry point is only useful if it leaves a POWER OF TWO to be pushed, since
; that is what one `brset` can select; and the arrangement of a 16-byte half
; decides which remainders exist.  Eight words - sixteen bytes - in six bytes of
; code cost 22 cycles, and every 22-cycle spelling is two triples and a double:
;
;       3-3-2   leaves 16, 10, 4        22 cycles       <- what we use
;       3-2-3   leaves 16, 10, 6        22
;       2-3-3   leaves 16, 12, 6        22
;       3-1-3-1 leaves 16, 10, 8, 2     24              <- an 8, at a price
;       2-2-2-2 leaves 16, 12, 8, 4     24
;
; So 8-byte granularity exists, but only in a spelling that costs two more
; cycles per half - four per 32-byte block, thirty-two on a 256-byte fill - to
; save at most a few cycles on a quarter of the short calls.  The trade goes
; the wrong way, and it goes the wrong way by a wide enough margin that it is
; not worth re-measuring on a whim.
