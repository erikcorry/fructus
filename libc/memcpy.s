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
; COMPACT, NOT MAXIMAL.  The bulk loop moves 16 bytes an iteration where
; snippets/speed-of-light-memcpy-core.s moves 60.  That gives up about 9% of
; the throughput for a quarter of the code, which is the right trade for a
; libc: the routine is linked into everything, and most calls are short.
;
; INTERRUPTS MUST HAVE THEIR OWN STACK POINTER.  The bulk loop points sp at the
; source and reads through it with `pop`, which is the whole reason it is fast -
; nothing else in the machine moves three registers per instruction.  Anything
; that pushed to sp meanwhile would land in the middle of the source buffer.
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
; round for nothing.  Measured, the descending loop is 14.2 cycles/byte against
; the bulk loop's 3.8, so the difference is a factor of three on a case that
; turns up whenever a caller copies into the slot next to its source.
;
; THE CHEAPER TEST GOES FIRST.  dest <= src needs no arithmetic and leaves in
; three bytes; the other has to compute src + n first.  A copy into a fresh
; buffer usually satisfies the first one, so the common path is also the short
; one - 294 cycles against 299 for a 64-byte move.
;
; tests/libc-check.mjs measures which loop ran, for every placement.  Correctness
; alone would not pin this down: a memmove that always descends copies the right
; bytes and is three times slower, and nothing in a byte comparison notices.

memmove:
        br      ls, r0, r1, memcpy      ; dest at or below src: ascending is safe
        add     r5, r1, r2              ; end of the source
        br      ls, r5, r0, memcpy      ; source ends at or before dest: no overlap

        add     r0, r0, r2              ; point both cursors one past the end
        add     r1, r1, r2
.down:
        add     r0, r0, #-1             ; one byte: the pinned form
        add     r1, r1, #-1
        ld8     r5, [r1]
        st8     r5, [r0]
        sub     r2, r2, #1
        br      ne, r2, #0, .down
        ret

; NO PROLOGUE AND NO EPILOGUE.  The descending loop steps r0 down exactly n
; times from dest + n, so it finishes holding dest - the return value, already
; in place.  It touches r0, r1, r2 and r5, all of which a three-argument
; function owns outright, so there is nothing to save and nothing to restore.
;
; n = 0 CANNOT REACH THIS LOOP, which matters because it is do-while.  Getting
; past the second test needs dest > src and src + n > dest, and those together
; force n >= 2.  Every shorter case leaves through memcpy, which handles zero.


; ============================================================================
; memcpy
; ============================================================================
; A byte loop to bring n down to a multiple of 16, then a 16-byte bulk loop.
;
; THE HEAD IS A LOOP RATHER THAN A COUNTED RUN because there is no register to
; spare for a second counter: r0, r1 and r2 are the arguments, r5 is the byte in
; flight, and lr holds the mask.  Re-testing `n & 15` each time round costs two
; bytes of code and at most fifteen trips, which is cheaper than saving r3.

memcpy:
        push    r0, lr                  ; keep the return value, and free lr
        mov     lr, #15                 ; the mask, in the only register left
        jmpr    .tidy
.slow:
        ld8     r5, [r1]
        st8     r5, [r0]
        add     r0, r0, #1              ; one byte: the pinned form
        add     r1, r1, #1
        sub     r2, r2, #1
.tidy:
        and     r5, r2, lr
        br      ne, r5, #0, .slow

; --- the bulk loop, 16 bytes an iteration ----------------------------------
; sp becomes the source cursor and `pop` advances it for free; the destination
; is written with ordinary stores.  The store offsets have to come out of imm3,
; which holds { -1, 0, 1, 2, 3, 4, 6, 8 } - so the longest run of even offsets
; available is 0, 2, 4, 6, and r0 has to move twice per iteration.

        push    r3, r4
        mov     lr, sp                  ; the mask is dead; reuse lr for the real sp
        mov     sp, r1                  ; sp is the source from here on
        add     r2, r2, r1              ; r2 = end of the source
        jmpr    .bottom
.top:
        pop     r3, r4, r5              ; src +0 .. +5                  8
        st      r3, [r0]                ;                               4
        st      r4, [r0, #2]            ;                               4
        st      r5, [r0, #4]            ;                               4
        pop     r3, r4, r5              ; src +6 .. +11                 8
        st      r3, [r0, #6]            ;                               4
        add     r0, r0, #8              ;                               2
        st      r4, [r0]                ; dest +8                       4
        st      r5, [r0, #2]            ; dest +10                      4
        pop     r3, r4                  ; src +12 .. +15                6
        st      r3, [r0, #4]            ; dest +12                      4
        st      r4, [r0, #6]            ; dest +14                      4
        add     r0, r0, #8              ;                               2
.bottom:
        br      ne, sp, r2, .top        ;                               3

        mov     sp, lr                  ; hand the real stack back
        pop     r4, r3
        pop     lr, r0                  ; ... and the return value
        ret

; ZERO LENGTH FALLS STRAIGHT THROUGH.  `n & 15` is 0, so the byte loop never
; runs; then r2 = 0 + src = src, sp = src, and the bottom test finds them equal
; before the first iteration.  It costs the prologue and nothing else.
;
; THE ORDER OF THE TWO SAVES MATTERS.  r3 and r4 are pushed BEFORE lr takes a
; copy of sp, so the copy includes them and `mov sp, lr` lands back on top of
; the pair rather than under it.
