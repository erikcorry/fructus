; ============================================================================
; libc/strcmp.s - strcmp, strncmp and strlen
; ============================================================================
;
;       int    strcmp (const char *s1, const char *s2);
;       int    strncmp(const char *s1, const char *s2, size_t n);
;       size_t strlen (const char *s);
;
; ----------------------------------------------------------------------------
; MEASURED, against the C in crt/libc.c compiled at -Os
; ----------------------------------------------------------------------------
;                       here        C       faster by
;       strlen          4.2500     13.00      3.06x      optimistic path
;       strlen          6.7500     13.00      1.93x      every block a false
;                                                        alarm - see below
;       strcmp         17.0000     22.00      1.29x
;       strncmp        20.0000     23.00      1.15x
;
; Cycles per byte of string, differenced across two lengths so the call and the
; setup cancel.  The C figures are if anything generous: those functions are
; static with one call site, so the compiler is free to inline them and skip the
; call entirely.
;
; strncmp costs three a byte more than strcmp, and that is the whole of the
; difference between them: the limit test `br eq, r2, r0` at the top of the
; loop, which strcmp does not need.
; ============================================================================

; Not unrolled, register relative, 17 cycles/length.
strcmp:
  push lr
  rsb r1, r0, r1  ; r1 is now difference between two strings.

.top:
  ld8 r5, [r0]  ; Zero extending                  4
  ld8 lr, [r0, r1]  ; Zero extending              4
  br ne, r5, lr, .mismatch                     ;  3
  add r0, r0, #1                               ;  2
  br ne, r5, #0, .top                          ;  4
  ; They are equal, return 0
  mov r0, #0
  pop lr
  ret
.mismatch:
  rsb r0, lr, r5  ; r0 = *s1 - *s2
  pop lr
  ret

; Not unrolled, register relative, 20 cycles/length - three more than strcmp,
; which is the limit test at the top of the loop.
strncmp:
  push lr
  rsb r1, r0, r1  ; r1 is now difference between two strings.
  add r2, r2, r0  ; r2 is now max address to compare.

.top:
  br eq, r2, r0, .equal
  ld8 r5, [r0]  ; Zero extending                  4
  ld8 lr, [r0, r1]  ; Zero extending              4
  br ne, r5, lr, .mismatch                     ;  3
  add r0, r0, #1                               ;  2
  br ne, r5, #0, .top                          ;  4
  ; They are equal, return 0
.equal:
  mov r0, #0
  pop lr
  ret
.mismatch:
  rsb r0, lr, r5  ; r0 = *s1 - *s2
  pop lr
  ret

; Optimistic strlen assuming io ports do not start on addresses not divisible
; by 4, ie the first io port in a contiguous block is at a mod4=0 address.
;
; Also assumes optimistically that adjacent characters do not and-to-zero very
; often unless one of them is zero.  On regular ASCII text the most common
; failure of this assumption is probably a space character just before or after
; a capital letter, but the slower fallback is still pretty fast.
;
; 4.25 cycles/byte when the optimism holds.  A false alarm costs a second trip
; round the byte tests, and there are TWO ways in, at two prices: the low bytes
; AND to zero (6.75), or the high bytes do (5.75).  The second is cheaper
; because reaching it means both low bytes are already known non-zero, so only
; the high ones are worth testing - which is why the fall-through has its own
; two tests rather than sharing .slow_block's four.
;
; Either way it is a SLOWDOWN AND NOT AN ERROR: both paths return to .top when
; they find no zero byte, which is what the two `brset ..., .top` are for.
; Measured over all 625 four-byte patterns drawn from { 01, 0f, 10, f0, ff },
; at two lengths each: worst 6.75 cycles/byte, none wrong.
;
; ldm walks r2 and only r2, so r2 is the cursor and the pair lands in r1 and
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
  mov r2, r0                         ; ldm's cursor
.top:
  ldm r1, r3        ; Load 32 bits, r2 += 4   ; 8
  and r0, r1, r3                              ; 2
  brclr   r0, #0xff, .slow_block              ; 3
  brset r0, #0xff00, .top                     ; 4
; Slow case, but the low bytes are known not zero.
  brclr   r1, #0xff00, .minus3                ; 3
  brset r3, #0xff00, .top    ; no zero byte here after all: keep scanning
  jmpr .minus1
.slow_block:
  brclr   r1, #0xff, .minus4                  ; 3
  brclr   r1, #0xff00, .minus3                ; 3
  brclr   r3, #0xff, .minus2                  ; 3
  brset r3, #0xff00, .top    ; no zero byte here after all: keep scanning
  jmpr .minus1               ; r3's high byte is the zero
.minus4:
  add r2, r2, #-1
.minus3:
  add r2, r2, #-1
.minus2:
  add r2, r2, #-1
.minus1:
  add r2, r2, #-1
  mov r0, r2
  pop r3, r2
.done:
  rsb r0, r5, r0     ; length = cursor - start
  ret
