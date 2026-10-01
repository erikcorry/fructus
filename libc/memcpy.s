; ============================================================================
; libc/memcpy.s - memcpy and memmove
; ============================================================================
;
;       void *memcpy (void *dest, const void *src, size_t n)
;       void *memmove(void *dest, const void *src, size_t n)
;
;       r0  dest, and the return value          r3, r4  callee saved
;       r1  src                                 r5      caller saved
;       r2  n                                   r6 = sp, r7 = lr
;
; COMPACT, NOT MAXIMAL.  The bulk loop moves 16 bytes an iteration, with
; ldm and stm, which move three registers each through pointers of their own -
; ldm through r2, stm through r1 - so sp stays the stack, and an interrupt in
; the middle of a copy is harmless.
; ============================================================================


; ============================================================================
; memmove
; ============================================================================
; Two dispositions are safe for an ascending copy, and memmove tests both
; before giving up and copying downwards:
;
;       dest <= src             ascending never overtakes
;       src + n <= dest         the regions do not touch at all
;
; BOTH TESTS ARE UNSIGNED.  `ls` and its swapped partner `hs` are the unsigned
; pair; signed `le` here would mis-order any pointer above 0x8000, which on a
; 16-bit machine is half of memory and includes the stack.
;
; What is left - dest strictly inside the source - is the case a forward byte
; loop cannot fix.  Copying one byte at a time does not help: `memmove(p+1, p,
; n)` smears p[0] across the whole region whatever the granularity.  The only
; answer is to walk downwards.
;
; BOTH TESTS ARE INCLUSIVE, and that is not cosmetic.  Regions that abut exactly
; - dest + n == src, or src + n == dest - do not overlap, so the fast path is
; correct for them and `ls` lets them take it; `lo` would send both the long way
; round for nothing.  Measured, the descending loop is 15.0 cycles/byte against
; the bulk loop's 2.63 - 3.13 when dest and src differ in parity - so the
; difference is more than a factor of four on a case that turns up whenever a
; caller copies into the slot next to its source.
;
; THE CHEAPER TEST GOES FIRST.  dest <= src needs no arithmetic and leaves in
; three bytes; the other has to compute src + n first.  A copy into a fresh
; buffer usually satisfies the first one, so the common path is also the short
; one - 216 cycles against 218 for a 64-byte move, even, or 231 against 233
; odd.
;
; tests/libc-check.mjs measures which loop ran, for every placement.  Correctness
; alone would not pin this down: a memmove that always descends copies the right
; bytes and is three times slower, and nothing in a byte comparison notices.

memmove:
        br      ls, r0, r1, memcpy      ; dest at or below src: ascending is safe
        add     r5, r1, r2              ; end of the source
        br      ls, r5, r0, memcpy      ; source ends at or before dest: no overlap

        add     r1, r1, r2              ; point source cursor one past the end
        add     r2, r0, r2              ; point dest cursor one past the end
.down:
        add     r2, r2, #-1             ; one byte: the pinned form
        add     r1, r1, #-1
        ld8     r5, [r1]
        st8     r5, [r2]
        br      ne, r2, r0, .down
        ret

; NO PROLOGUE AND NO EPILOGUE, AND NO COUNTER.  The descending loop steps r2
; down from dest + n until it meets r0, which is dest - so r0 is both the end
; of the loop and the return value, already in place.  It touches r1, r2 and
; r5, all of which a three-argument function owns outright, so there is
; nothing to save and nothing to restore.
;
; n = 0 CANNOT REACH THIS LOOP, which matters because it is do-while.  Getting
; past the second test needs dest > src and src + n > dest, and those together
; force n >= 2.  Every shorter case leaves through memcpy, which handles zero.


; ============================================================================
; memcpy
; ============================================================================
; ONE BYTE TO ALIGN THE SOURCE, then a 16-byte bulk loop of ldm and stm, then
; what is left - 0 to 15 bytes - by its bits: 8, 4, 2 and 1.
;
; THE SOURCE IS THE ONE ALIGNED.  ldm and stm each go a word at a time when
; their pointer is even and a byte at a time when it is odd, and one byte moved
; first makes the source even.  If dest and src have the same parity that
; makes both even; if not, nothing can, and the stores go a byte at a time
; whichever pointer is chosen.
;
; THE POINTERS ARE SHUFFLED because ldm loads through r2 and stm stores
; through r1: src goes to r2, dest to r1, and the length to r3.  r0 is free
; once it is saved as the return value, and carries data with r4 and r5.

memcpy:
        push    r0, lr                  ; keep the return value
        push    r3, r4                  ; callee saved: the length, and data
        brclr   r1, #1, .aligned        ; source already even
        br      eq, r2, #0, .aligned    ; nothing to copy
        ld8     r5, [r1]                ; one byte makes the source even
        st8     r5, [r0]
        add     r0, r0, #1
        add     r1, r1, #1
        add     r2, r2, #-1
.aligned:
        mov     r3, r2                  ; r3 = what is left
        mov     r2, r1                  ; r2 = src, for ldm
        mov     r1, r0                  ; r1 = dest, for stm
        brclr   r3, #0xfff0, .tail      ; fewer than 16
.top:
        ldm     r0, r4, r5              ; src +0  .. +5
        stm     r0, r4, r5
        ldm     r0, r4, r5              ; src +6  .. +11
        stm     r0, r4, r5
        ldm     r0, r4                  ; src +12 .. +15
        stm     r0, r4
        add     r3, r3, #-16
        brset   r3, #0xfff0, .top       ; 16 or more left
.tail:
        brclr   r3, #8, .lt8
        ldm     r0, r4, r5
        stm     r0, r4, r5
        ldm     r0
        stm     r0
.lt8:
        brclr   r3, #4, .lt4
        ldm     r0, r4
        stm     r0, r4
.lt4:
        brclr   r3, #3, .done           ; a multiple of four, the common case
        brclr   r3, #2, .lt2
        ldm     r0
        stm     r0
.lt2:
        brclr   r3, #1, .done
        ld8     r0, [r2]
        st8     r0, [r1]
.done:
        pop     r4, r3
        pop     lr, r0                  ; ... and the return value
        ret

; ZERO LENGTH FALLS STRAIGHT THROUGH: the alignment byte is skipped, r3 is 0,
; and every bit test of the tail finds its bit clear.
