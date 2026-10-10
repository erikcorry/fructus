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
; COMPACT, NOT MAXIMAL.  Both bulk loops move 16 bytes an iteration, with
; ldm and stm, which move three registers each through pointers of their own -
; ldm through r1, stm through r5 - so sp stays the stack, and an interrupt in
; the middle of a copy is harmless.
; ============================================================================


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
; ONLY dest MOVES.  ldm loads through r1, which is where src arrives, and stm
; stores through r5, the one register every caller already gives up; so dest
; is copied to r5, the length stays in r2, and r0 is left alone as the return
; value.  The data goes in r3, r4 and lr, and one push saves all three - r3
; first, where memmove's pushes lr first, which is how tests/libc-check.mjs
; tells which of the two ran.

memcpy:
        push    r3, r4, lr              ; callee saved: data, all three
        mov     r5, r0                  ; r5 = dest, for stm; r0 is the result
        brclr   r1, #1, .aligned        ; source already even
        br      eq, r2, #0, .aligned    ; nothing to copy
        ld8     r3, [r1]                ; one byte makes the source even
        st8     r3, [r5]
        add     r5, r5, #1
        add     r1, r1, #1
        add     r2, r2, #-1
.aligned:
        brclr   r2, #0xfff0, .tail      ; fewer than 16
.top:
        ldm     r3, r4, lr              ; src +0  .. +5
        stm     r3, r4, lr
        ldm     r3, r4, lr              ; src +6  .. +11
        stm     r3, r4, lr
        ldm     r3, r4                  ; src +12 .. +15
        stm     r3, r4
        add     r2, r2, #-16
        brset   r2, #0xfff0, .top       ; 16 or more left
.tail:
        brclr   r2, #8, .lt8
        ldm     r3, r4, lr
        stm     r3, r4, lr
        ldm     r3
        stm     r3
.lt8:
        brclr   r2, #4, .lt4
        ldm     r3, r4
        stm     r3, r4
.lt4:
        brclr   r2, #3, .done           ; a multiple of four, the common case
        brclr   r2, #2, .lt2
        ldm     r3
        stm     r3
.lt2:
        brclr   r2, #1, .done
        ld8     r3, [r1]
        st8     r3, [r5]
.done:
        pop     lr, r4, r3
        ret

; ZERO LENGTH FALLS STRAIGHT THROUGH: the alignment byte is skipped, r2 is 0,
; and every bit test of the tail finds its bit clear.


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
; What is left - dest strictly inside the source - is the case a forward
; copy cannot fix.  Copying one byte at a time does not help: `memmove(p+1, p,
; n)` smears p[0] across the whole region whatever the granularity.  The only
; answer is to walk downwards.
;
; BOTH TESTS ARE INCLUSIVE.  Regions that abut exactly - dest + n == src, or
; src + n == dest - do not overlap, so the fast path is correct for them and
; `ls` lets them take it.  The descending copy is nearly as fast as memcpy now,
; so this is worth less than it was, but `lo` would still send both the long
; way round for nothing.
;
; THE CHEAPER TEST GOES FIRST.  dest <= src needs no arithmetic and leaves in
; three bytes; the other has to compute src + n first.  A copy into a fresh
; buffer usually satisfies the first one, so the common path is also the short
; one.
;
; MEMMOVE COMES AFTER MEMCPY so that both branches to it are backwards and
; short.  The descending copy is long enough that memcpy would be out of an
; 8-bit branch's reach below it, and tools/fcc gives each routine a section of
; its own, so memmove cannot simply fall through into memcpy either.
;
; tests/libc-check.mjs checks which path ran, for every placement.  Correctness
; alone would not pin this down: a memmove that always descends copies the right
; bytes and is a little slower, and nothing in a byte comparison notices.

memmove:
        br      ls, r0, r1, memcpy      ; dest at or below src: ascending is safe
        add     r5, r1, r2              ; end of the source
        br      ls, r5, r0, memcpy      ; source ends at or before dest: no overlap

; DOWNWARDS, WITH THE SAME ldm AND stm AS memcpy.  They only step up, so each
; chunk is copied upwards inside itself and the pointers are pulled back down
; between chunks - one `add` a pointer a chunk, six an iteration where memcpy
; has none.  That is all it costs: 47 cycles for 16 bytes against 42, or
; 2.94 a byte against 2.63.
;
; A CHUNK IS SAFE WHEREVER dest IS.  Every word of it is loaded before any is
; stored, and a store lands dest - src above the word it came from, so the only
; source bytes it can overwrite are ones this chunk or a higher one has already
; read.  The chunks themselves have to go top first, though: two in a row
; going up would have the second read source bytes the first had just written
; over.
;
; NOT push.  Pointing sp at the destination and pushing runs downwards for
; free, and was tried; but BLIT mode stops the machine on a push above 0x8000
; (see docs/vga.md), which is just where a memmove scrolling the frame buffer
; would put it, and every interrupt would have had to run on a stack of its own.
;
; THE SOURCE END IS THE ONE ALIGNED, by a byte at the top, as memcpy aligns the
; source start.  The tail is at the bottom, 0 to 15 bytes, and goes a word at
; a time and then an odd byte, which is the last one moved.
;
; THE TAIL IS A LOOP, NOT memcpy's STEPS BY THE BITS.  Steps of 8, 4, 2 and 1
; took 50 bytes, because a downward step of more than one word is two adds
; before and two after.  The loop is under a third of that.  It costs 45
; cycles more on the longest tail, seven words, and saves 8 when there is no
; tail at all.
;
; BOTH LOOPS RUN ON A LIMIT, NOT A COUNT, which saves memcpy's `add` on a
; counter.  r4 is where r5 will be when only the tail is left, and then one
; above dest, where r5 will be when only an odd byte is.  The bulk loop keeps
; the pointers six below the top of what is still to copy - the first chunk's
; start - so it adds nothing before its first ldm.

        push    lr, r3, r4              ; a limit, and data with r2
        mov     r1, r5                  ; r1 = src end, for ldm
        add     r5, r0, r2              ; r5 = dest end, for stm
        brclr   r1, #1, .aligned        ; source end already even
        add     r5, r5, #-1             ; one byte makes it even
        add     r1, r1, #-1
        ld8     r3, [r1]
        st8     r3, [r5]
        add     r2, r2, #-1
.aligned:
        brclr   r2, #0xfff0, .tail      ; fewer than 16
        and     r4, r2, #15             ; the tail's length ...
        add     r4, r4, r0              ; ... where the loop stops above it ...
        add     r4, r4, #-6             ; ... six below, as the pointers are
        add     r5, r5, #-6
        add     r1, r1, #-6
.top:
        ldm     r2, r3, lr              ; top -6  .. top
        stm     r2, r3, lr
        add     r5, r5, #-12
        add     r1, r1, #-12
        ldm     r2, r3, lr              ; top -12 .. top -6
        stm     r2, r3, lr
        add     r5, r5, #-10
        add     r1, r1, #-10
        ldm     r2, r3                  ; top -16 .. top -12
        stm     r2, r3
        add     r5, r5, #-10            ; the next top, less six
        add     r1, r1, #-10
        br      ne, r5, r4, .top
        add     r5, r5, #6
        add     r1, r1, #6
.tail:
        add     r4, r0, #1              ; r5 here means one byte is left
        br      ls, r5, r4, .lt2        ; fewer than two
.word:
        add     r5, r5, #-2             ; subtract first: -2 is not in imm3,
        add     r1, r1, #-2             ; so [r, #-2] would take the three-byte
        ld      r3, [r1]                ; form
        st      r3, [r5]
        br      hi, r5, r4, .word       ; two or more left
.lt2:
        br      eq, r5, r0, .done
        ld8     r3, [r1, #-1]           ; the bottom byte, dest's first
        st8     r3, [r0]
.done:
        pop     r4, r3, lr
        ret

; n = 0 CANNOT GET THIS FAR.  Getting past the second test needs dest > src
; and src + n > dest, and those together force n >= 2.  Every shorter case
; leaves through memcpy, which handles zero.  The tail would cope with nothing
; left anyway: it tests before its first word and before the odd byte.
