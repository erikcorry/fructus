; ============================================================================
; libc/strcmp.s - strcmp, strncmp and strlen
; ============================================================================
;
;       int    strcmp (const char *s1, const char *s2);
;       int    strncmp(const char *s1, const char *s2, size_t n);
;       size_t strlen (const char *s);
;
; ----------------------------------------------------------------------------
; MEASURED, by tests/string-check.mjs, against the C that crt/libc.c had
; ----------------------------------------------------------------------------
;                       here        s2 odd      C       faster by
;       strlen          2.2500                 12.00      5.33x  optimistic path
;       strlen          4.5000                 12.00      2.67x  every block a
;                                                                false alarm
;       strcmp          5.7500     6.2500      19.00      3.30x
;       strncmp         6.5000     7.0000      23.00      3.54x
;
; (The first two columns are the instruction buffer's; the C's, the
; false-alarm row and the breakdown below are still the core's before it,
; rtl/ as of commit 4d59ff9.)
;
; Cycles per byte of string, differenced across two lengths so the call and the
; setup cancel.  The C is the obvious byte loops, compiled noinline at -Os by
; the gcc in vendor/gcc, as measured when this file replaced them; a byte load
; costs what it did then.  `s2 odd' is s2 at the other parity from s1, whose
; words then go a byte at a time.
;
; EVERY OTHER THREE-BYTE BRANCH STARTS AT AN ODD ADDRESS and costs two cycles
; falling through, not one - see the cost model under [cpu] in the spec.  The
; loops are runs of them, and only an instruction of odd length moves the
; parity, which would cost the cycle it saved; so strcmp's loop is 25 cycles
; for four bytes where its instructions' own costs sum to 23.  strncmp's is 28:
; its count, and a test of it in place of strcmp's last branch.  The figures
; are for the file assembled at an even address; at an odd one strncmp's loop
; can pay one more.
; ============================================================================

; ============================================================================
; strcmp and strncmp
; ============================================================================
; FOUR BYTES A TRIP: ldm reads two words of s1 through r1, and two `ld`s the
; same two words of s2 through r0.  A pair of words that matches and holds no
; zero byte costs a brclr or a br per byte, falling through; anything else
; leaves the loop and is settled byte by byte, at the word where it happened.
;
; s1 IS MADE A MULTIPLE OF FOUR FIRST, a byte at a time, which keeps ldm's
; reads inside the aligned four bytes that hold the terminator - the
; assumption strlen below makes, for the reason it gives.  s2 is read at
; whatever parity that leaves it: a word at an odd address is two accesses,
; a cycle more for each, and still right.  So s2 may be read up to three
; bytes past its terminator, into the next aligned word.
;
; r1 is s2 - s1 while the bytes are peeled, so that one cursor serves both
; through `ld8 lr, [r0, r1]`.  Then two instructions turn the pair round - r0
; becomes s2 and r1 becomes s1 - and r2 is never needed.
;
; THE ANSWER IS THE DIFFERENCE OF THE FIRST BYTES THAT DIFFER, as unsigned
; chars - or 0 if a terminator comes first.  At a word that differs, its low
; bytes decide unless they are equal; if they are equal and zero the strings
; were, and otherwise the high bytes decide.  A matching word with a zero in
; either byte ends the strings equal.

strcmp:
        push    lr, r3, r4
        rsb     r1, r0, r1              ; r1 = s2 - s1, while peeling
        brclr   r0, #3, .aligned
.peel:
        ld8     r5, [r0]
        ld8     lr, [r0, r1]
        br      ne, r5, lr, .bytes
        br      eq, r5, #0, .zero
        add     r0, r0, #1
        brset   r0, #3, .peel
.aligned:
        add     r0, r0, r1              ; r0 = s2
        rsb     r1, r1, r0              ; r1 = s1, ldm's cursor
.top:
        ldm     r3, r4                  ; s1, four bytes, r1 += 4       5
        ld      r5, [r0]                ; s2                            4
        ld      lr, [r0, #2]            ;                               4
        add     r0, r0, #4              ;                               1
        br      ne, r3, r5, .w0         ;                               1
        brclr   r3, #0x00ff, .zero      ; at an odd address             2
        brclr   r3, #0xff00, .zero      ;                               1
        br      ne, r4, lr, .w1         ; odd                           2
        brclr   r4, #0x00ff, .zero      ;                               1
        brset   r4, #0xff00, .top       ; odd, taken                    4
.zero:
        mov     r0, #0
        jmpr    .out
.w1:
        mov     r3, r4                  ; the second word is the one
        mov     r5, lr
.w0:
        lsr     r0, r5, #8              ; s2's high byte
        and     lr, r5, #0x00ff         ; s2's low byte
        and     r5, r3, #0x00ff         ; s1's low byte
        br      ne, r5, lr, .bytes      ; the low bytes decide
        br      eq, r5, #0, .zero       ; equal, and the end
        lsr     r5, r3, #8              ; or the high bytes do
        mov     lr, r0
.bytes:
        rsb     r0, lr, r5              ; *s1 - *s2
.out:
        pop     r4, r3, lr
        ret

; strncmp IS strcmp WITH A COUNT, in r2 where n arrived.  The count is what is
; left of n, never an end address, since n = 0xffff ("no limit") would wrap
; one.  The loop runs while four bytes or more are left, and the last zero to
; three go through the byte loop at .tail.  r2 is an argument here, so it is
; caller saved and not pushed.

strncmp:
        push    lr, r3, r4
        rsb     r1, r0, r1              ; r1 = s2 - s1, while peeling
        brclr   r0, #3, .aligned
.peel:
        br      eq, r2, #0, .zero
        ld8     r5, [r0]
        ld8     lr, [r0, r1]
        br      ne, r5, lr, .bytes
        br      eq, r5, #0, .zero
        add     r0, r0, #1
        add     r2, r2, #-1
        brset   r0, #3, .peel
.aligned:
        add     r0, r0, r1              ; r0 = s2
        rsb     r1, r1, r0              ; r1 = s1, ldm's cursor
        brclr   r2, #0xfffc, .tail      ; fewer than four left
.top:
        ldm     r3, r4                  ; s1, four bytes, r1 += 4       5
        ld      r5, [r0]                ; s2                            4
        ld      lr, [r0, #2]            ;                               4
        add     r0, r0, #4              ;                               1
        add     r2, r2, #-4             ;                               1
        br      ne, r3, r5, .w0         ;                               1
        brclr   r3, #0x00ff, .zero      ; at an odd address             2
        brclr   r3, #0xff00, .zero      ;                               1
        br      ne, r4, lr, .w1         ; odd                           2
        brclr   r4, #0x00ff, .zero      ;                               1
        brclr   r4, #0xff00, .zero      ; odd                           2
        brset   r2, #0xfffc, .top       ;                               4
.tail:
        br      eq, r2, #0, .zero
        ld8     r5, [r1]
        ld8     lr, [r0]
        br      ne, r5, lr, .bytes
        br      eq, r5, #0, .zero
        add     r1, r1, #1
        add     r0, r0, #1
        add     r2, r2, #-1
        jmpr    .tail
.zero:
        mov     r0, #0
        jmpr    .out
.w1:
        mov     r3, r4                  ; the second word is the one
        mov     r5, lr
.w0:
        lsr     r0, r5, #8              ; s2's high byte
        and     lr, r5, #0x00ff         ; s2's low byte
        and     r5, r3, #0x00ff         ; s1's low byte
        br      ne, r5, lr, .bytes      ; the low bytes decide
        br      eq, r5, #0, .zero       ; equal, and the end
        lsr     r5, r3, #8              ; or the high bytes do
        mov     lr, r0
.bytes:
        rsb     r0, lr, r5              ; *s1 - *s2
.out:
        pop     r4, r3, lr
        ret

; ============================================================================
; strlen
; ============================================================================
; Optimistic strlen assuming io ports do not start on addresses not divisible
; by 4, ie the first io port in a contiguous block is at a mod4=0 address.
;
; Also assumes optimistically that adjacent characters do not and-to-zero very
; often unless one of them is zero.  On regular ASCII text the most common
; failure of this assumption is probably a space character just before or after
; a capital letter, but the slower fallback is still pretty fast.
;
; 2.5 cycles/byte when the optimism holds: the loop is unrolled once, eight
; bytes a trip, so one taken branch serves two blocks.  A false alarm costs a
; second trip round the byte tests, and there are TWO ways in, at two prices:
; the low bytes AND to zero (4.50), or the high bytes do (4.00).  The second is
; cheaper because reaching it means both low bytes are already known non-zero,
; so only the high ones are worth testing - which is why it has its own two
; tests rather than sharing .slow_block's four.
;
; THE UNROLL MADE THAT SECOND PATH DEARER: 3.75 before it, 4.50 after - and
; 4.00 now, since ldm moved to r1 and every branch below changed parity.  Both
; paths return to .top, the first half, and there a high-byte alarm is a taken
; `brclr` to .slow_block_low_bytes_ok, four cycles, where the second half's
; falls through for one.  Every block that alarmed on its high bytes paid three
; more, and every eight clean bytes saved three; on text, where it takes a
; space beside a capital letter, the unroll is far ahead.
;
; Either way it is a SLOWDOWN AND NOT AN ERROR: both paths return to .top when
; they find no zero byte, which is what the two `brset ..., .top` are for.
; Measured over all 625 four-byte patterns drawn from { 01, 0f, 10, f0, ff },
; at two lengths each: worst 4.50 cycles/byte, none wrong.
;
; ldm walks r1 and only r1, so r1 is the cursor and the pair lands in r2 and
; r3.  r0 is free to be the block-AND scratch: r5 holds the start, and the
; length is recovered from the cursor at the end.
strlen:
  mov r5, r0   ; Save start
  brclr   r0, #3, .aligned
.unaligned:
  ld8 r1, [r0]
  br eq, r1, #0, .done
  add r0, r0, #1
  brset r0, #3, .unaligned
.aligned:
  push r2, r3
  mov r1, r0                         ; ldm's cursor
.top:
  ldm r2, r3        ; Load 32 bits, r1 += 4   ; 5
  and r0, r2, r3                              ; 1
  brclr   r0, #0xff, .slow_block              ; 1, at an even address
  brclr r0, #0xff00, .slow_block_low_bytes_ok ; 2, at an odd address
  ldm r2, r3        ; Load 32 bits, r1 += 4   ; 5
  and r0, r2, r3                              ; 1
  brclr   r0, #0xff, .slow_block              ; 1, at an even address
  brset r0, #0xff00, .top                     ; 4
.slow_block_low_bytes_ok:
; Slow case, but the low bytes are known not zero.
  brclr   r2, #0xff00, .minus3                ; 1
  brset r3, #0xff00, .top    ; no zero byte here after all: keep scanning
  jmpr .minus1
.slow_block:
  brclr   r2, #0xff, .minus4                  ; 1
  brclr   r2, #0xff00, .minus3                ; 2
  brclr   r3, #0xff, .minus2                  ; 1
  brset r3, #0xff00, .top    ; no zero byte here after all: keep scanning
  jmpr .minus1               ; r3's high byte is the zero
.minus4:
  add r1, r1, #-1
.minus3:
  add r1, r1, #-1
.minus2:
  add r1, r1, #-1
.minus1:
  add r1, r1, #-1
  mov r0, r1
  pop r3, r2
.done:
  rsb r0, r5, r0     ; length = cursor - start
  ret
