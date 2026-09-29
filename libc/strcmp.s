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
;       strlen          3.5000     12.00      3.43x      optimistic path
;       strlen          5.2500     12.00      2.29x      every block a false
;                                                        alarm - see below
;       strcmp         14.0000     19.00      1.36x
;       strncmp        16.0000     23.00      1.44x
;
; Cycles per byte of string, differenced across two lengths so the call and the
; setup cancel.  The C is the obvious loops, compiled noinline at -Os by the
; gcc in vendor/gcc; they were in crt/libc.c until this file replaced them.
;
; strncmp costs two a byte more than strcmp, and only one of them is the limit
; test `br eq, r2, r0` at the top of the loop, which strcmp does not need.  The
; other is where that test puts the rest: three bytes later, so the mismatch
; test starts at an odd address and costs two cycles falling through where
; strcmp's costs one - see the cost model under [cpu] in the spec.
; ============================================================================

; Not unrolled, register relative, 14 cycles/length.
strcmp:
  push lr
  rsb r1, r0, r1  ; r1 is now difference between two strings.

.top:
  ld8 r5, [r0]  ; Zero extending                  4
  ld8 lr, [r0, r1]  ; Zero extending              4
  br ne, r5, lr, .mismatch                     ;  1
  add r0, r0, #1                               ;  1
  br ne, r5, #0, .top                          ;  4
  ; They are equal, return 0
  mov r0, #0
  pop lr
  ret
.mismatch:
  rsb r0, lr, r5  ; r0 = *s1 - *s2
  pop lr
  ret

; Not unrolled, register relative, 16 cycles/length - two more than strcmp:
; the limit test at the top of the loop, and the mismatch test at an odd address.
strncmp:
  push lr
  rsb r1, r0, r1  ; r1 is now difference between two strings.
  add r2, r2, r0  ; r2 is now max address to compare.

.top:
  br eq, r2, r0, .equal                        ;  1
  ld8 r5, [r0]  ; Zero extending                  4
  ld8 lr, [r0, r1]  ; Zero extending              4
  br ne, r5, lr, .mismatch                     ;  2, three bytes at an odd address
  add r0, r0, #1                               ;  1
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
; 3.50 cycles/byte when the optimism holds.  A false alarm costs a second trip
; round the byte tests, and there are TWO ways in, at two prices: the low bytes
; AND to zero (5.25), or the high bytes do (4.25).  The second is cheaper
; because reaching it means both low bytes are already known non-zero, so only
; the high ones are worth testing - which is why the fall-through has its own
; two tests rather than sharing .slow_block's four.
;
; Either way it is a SLOWDOWN AND NOT AN ERROR: both paths return to .top when
; they find no zero byte, which is what the two `brset ..., .top` are for.
; Measured over all 625 four-byte patterns drawn from { 01, 0f, 10, f0, ff },
; at two lengths each: worst 5.25 cycles/byte, none wrong.
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
  ldm r1, r3        ; Load 32 bits, r2 += 4   ; 7
  and r0, r1, r3                              ; 1
  brclr   r0, #0xff, .slow_block              ; 2, at an odd address
  brset r0, #0xff00, .top                     ; 4
; Slow case, but the low bytes are known not zero.
  brclr   r1, #0xff00, .minus3                ; 2
  brset r3, #0xff00, .top    ; no zero byte here after all: keep scanning
  jmpr .minus1
.slow_block:
  brclr   r1, #0xff, .minus4                  ; 2
  brclr   r1, #0xff00, .minus3                ; 1
  brclr   r3, #0xff, .minus2                  ; 2
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
