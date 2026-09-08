; ============================================================================
; libgcc/lib1funcs.s - the multiply helpers GCC calls
; ============================================================================
;
; With short = int = 16 bits and long = 32, GCC names its helpers after machine
; modes - QI is 8, HI is 16, SI is 32, DI is 64 - and emits calls to these:
;
;       __mulhi3        16 x 16 -> 16     every char, short and int multiply
;       __mulsi3        32 x 32 -> 32     every long multiply
;       __umulsidi3     32 x 32 -> 64     what libgcc2.c builds __muldi3 from
;       __muldi3        64 x 64 -> 64     long long, in C, given the two above
;
; and, if the port declares the widening optabs in its machine description,
;
;       __umulhisi3     16 x 16 -> 32     unsigned widening
;       __mulhisi3      16 x 16 -> 32     signed widening
;
; ONE ROUTINE SERVES SIGNED AND UNSIGNED for everything that is not widening.
; The low n bits of a two's complement product do not depend on the signedness
; of the operands, so __mulhi3 is the signed helper as well.  Only the widening
; pair have to differ.
;
; char AND short NEVER GET THEIR OWN ROUTINE.  C promotes both to int before
; arithmetic and int is 16 bits here, so `c1 * c2` is a 16 x 16 multiply.
; __mulqi3 exists as a name but a port only sees it if its machine description
; declares a QImode mult pattern, and there is no reason to.
;
; A REAL PORT SPLITS THESE, one function per object, with the `#ifdef L_mulhi3`
; guards lib1funcs.S conventionally uses, so a program that multiplies ints
; does not link the 32-bit helpers.  There is no linker yet, so they are one
; file and the boundaries are marked.
; ============================================================================


; ============================================================================
; __mulhi3 - 16 x 16 -> 16, signed or unsigned                       39 bytes
; ============================================================================
;       r0  a, then the product              r5  the multiplier
;       r1  b, then the multiplicand          lr  untouched: this is a leaf
;
; r1 IS LEFT AS RUBBISH - the multiplicand, shifted up by however many nibbles
; the loop ran.  An earlier draft zeroed it, so that the pair r0:r1 would be a
; well-formed 32-bit value and __umulhisi3 could tail-call this routine when
; the product provably fit.  isa/abi.s puts the HIGH half of a pair in r0, so
; that would have been the wrong way round; __umulhisi3 has to exchange the two
; halves after the call and sets both, and the two bytes bought nothing.
;
; THE SMALLER OPERAND BECOMES THE MULTIPLIER, because the loop costs time per
; bit of it and stops as soon as it runs out.  The test doubles as the setup:
; whichever way it goes, one of the two operands has to move into r5 anyway,
; and the case where they are already the right way round needs the extra
; `mov r1, r0` - which is the pinned one-byte encoding at 0x0a.
;
; `__mulhi3.sorted` IS A SECOND ENTRY POINT for callers that have already put
; the smaller operand in r1.  __umulhisi3 sorts before it decides whether the
; product can overflow, so by the time it reaches here the comparison has been
; made and does not want making again.
;
; THE MULTIPLICAND LIVES IN r1 so that every accumulate is `add r0, r0, r1`,
; the pinned one-byte encoding at 0x07.  Six of them in the loop.

__mulhi3:
        br      ls, r1, r0, .sorted     ; 3   b <= a: b is the multiplier
        mov     r5, r0                  ; 2   otherwise a is, and b stays put
        jmpr    .go                     ; 2
.sorted:                                ;     ENTRY: r1 already the smaller
        mov     r5, r1                  ; 2   the multiplier
        mov     r1, r0                  ; 1   the multiplicand, pinned
.go:
        mov     r0, #0                  ; 1   the accumulator, pinned
.top:
        brclear r5, #0x0001, .s0        ; 3
        add     r0, r0, r1              ; 1
.s0:
        brclear r5, #0x0002, .s1        ; 3
        add     r0, r0, r1              ; 1   twice: r1 has not moved, and
        add     r0, r0, r1              ; 1   two of a<<i is a<<(i+1)
.s1:
        shl     r1, r1, #2              ; 2   one shift for the pair
        brclear r5, #0x0004, .s2        ; 3
        add     r0, r0, r1              ; 1
.s2:
        brclear r5, #0x0008, .s3        ; 3
        add     r0, r0, r1              ; 1
        add     r0, r0, r1              ; 1
.s3:
        shl     r1, r1, #2              ; 2
        lsr     r5, r5, #4              ; 2
        br      ne, r5, #0, .top        ; 3
        ret                             ; 1


; ============================================================================
; __umulhisi3 - 16 x 16 -> 32, unsigned                              59 bytes
; ============================================================================
;       r0  a, then the product HIGH        r2  multiplicand high
;       r1  b, then the product LOW         r3  accumulator high
;       lr  multiplicand low                r5  scratch
;
; THE PAIR IS r0:r1 AS HIGH:LOW, which is what isa/abi.s says a 32-bit value is
; and NOT what snippets/mul.s uses - that file's mul_16_16_32 is a library
; internal and returns low:high.  This one is called by compiler-generated code
; and has to match.
;
; IT SORTS FIRST AND ASKS ABOUT OVERFLOW SECOND, which makes both cheaper.
; Sorted, the overflow question is about the LARGER operand alone - if that is
; under 256 then so is the other and the product is under 65536 - so the test
; is one shift and a branch rather than an `or` of both.  And the general path
; below needs the same sort anyway, so it is done once for both.
;
; The narrow path then enters __mulhi3 at `.sorted`, past the comparison it has
; already made.
;
; IT IS A CALL AND NOT A TAIL CALL, and that is the high:low convention's
; doing.  __mulhi3 returns the product in r0, and this routine needs it in r1
; with zero in r0 - so the two have to be set after the multiply, which `jmpr`
; cannot do.
;
;       tail call, returning low:high    72 cycles   60 bytes   ABI-wrong
;       call and exchange, high:low      84          68         correct
;
; Twelve cycles and eight bytes for the convention.  Both halves are written
; explicitly here, so __mulhi3 does not have to leave anything particular in
; r1 - which is why it no longer bothers.

__umulhisi3:
        br      ls, r1, r0, .sorted     ; 3   b is already the smaller
        mov     r5, r0                  ; 2
        mov     r0, r1                  ; 1   pinned
        mov     r1, r5                  ; 2
.sorted:
        lsr     r5, r0, #8              ; 2   the LARGER operand only
        br      eq, r5, #0, .narrow     ; 3   under 256: it cannot overflow

        ; --- the general case: shift and add, both sides widened -------------
        push    r2, r3, lr              ; 8
        lsr     r2, r0, #15             ; 2   multiplicand high = a >> 15
        shl     lr, r0, #1              ; 2   multiplicand low  = a << 1
        mov     r3, #0                  ; 2   accumulator high
        brset   r1, #1, .entry          ; 3   bit 0 set: r0 is already the sum
        mov     r0, #0                  ; 1
        jmpr    .entry                  ; 3
.set:
        add     r0, r0, lr              ; 2
        add     r3, r3, r2              ; 2
        br      hs, r0, lr, .clear      ; 3   sum >= addend means no carry
        add     r3, r3, #1              ; 2
.clear:
        lsr     r5, lr, #15             ; 2   the bit leaving the low half
        shl     r2, r2, #1              ; 2
        or      r2, r2, r5              ; 2
        shl     lr, lr, #1              ; 2
.entry:
        lsr     r1, r1, #1              ; 2   LOGICAL, or the loop never ends
.end:
        brset   r1, #1, .set            ; 3
        br      ne, r1, #0, .clear      ; 3
.done:
        mov     r1, r0                  ; 1   the low half moves to r1 ...
        mov     r0, r3                  ; 2   ... and the high half to r0
        pop     lr, r3, r2              ; 8
        ret                             ; 1
.narrow:
        push    lr                      ; 4
        callr   __mulhi3.sorted         ; 4   past the comparison already made
        pop     lr                      ; 4
        mov     r1, r0                  ; 1   the product is the LOW half
        mov     r0, #0                  ; 1   ... and the high half is zero
        ret                             ; 1


; ============================================================================
; __mulhisi3 - 16 x 16 -> 32, signed                                 22 bytes
; ============================================================================
; A correction on the unsigned one.  Reading each operand as signed subtracts
; 65536 from it when its top bit is set, so
;
;       a_s * b_s = a_u * b_u - 65536*(a15*b_u + b15*a_u) + 65536^2*(a15*b15)
;
; and the last term is a multiple of 2^32, which is not in the answer.  So the
; unsigned product is right except that the HIGH half needs b subtracted from
; it when a is negative and a subtracted when b is negative.  Two tests and at
; most two subtracts, on a value we already have.
;
; __umulhisi3 saves and restores r2 and r3, so the operands parked there
; survive the call and do not need a second copy.

__mulhisi3:
        push    r2, r3, lr              ; 8
        mov     r2, r0                  ; 2   keep a
        mov     r3, r1                  ; 2   keep b
        callr   __umulhisi3             ; 4   r0:r1 = high:low, unsigned
        brclear r2, #0x8000, .a_pos     ; 3   a negative?
        rsb     r0, r3, r0              ; 2   high -= b
.a_pos:
        brclear r3, #0x8000, .b_pos     ; 3   b negative?
        rsb     r0, r2, r0              ; 2   high -= a
.b_pos:
        pop     lr, r3, r2              ; 8
        ret                             ; 1


; ============================================================================
; __mulsi3 - 32 x 32 -> 32, signed or unsigned                       32 bytes
; ============================================================================
;       a in r0:r1 as high:low          b in r2:r3 as high:low
;       result in r0:r1 as high:low
;
; Four argument registers, so by isa/abi.s's sliding rule r2 and r3 are
; caller-saved here and this routine owns r0, r1, r2, r3 and r5 outright.  Only
; r4 and lr have to be saved.
;
;       (ah:al) * (bh:bl)  =  al*bl  +  ((al*bh + ah*bl) << 16)
;
; The ah*bh term is entirely above bit 31 and is not computed.  The two cross
; terms only need their low sixteen bits, which is __mulhi3; the al*bl term
; needs all thirty-two, which is __umulhisi3 - and its high:low result is
; already in the right registers, so folding the cross terms in is one `add`.
;
; NEITHER HELPER TOUCHES r2, r3 OR r4.  __mulhi3 uses r0, r1 and r5 and nothing
; else; __umulhisi3 saves r2 and r3 and restores them.  So bh and bl sit in
; their argument registers across all three calls and only al has to be spilled
; - once, and read back without popping the first time it is wanted.

__mulsi3:
        push    r4, lr                  ; 6
        push    r1                      ; 4   al, wanted twice more
        mov     r1, r3                  ; 2   ah * bl
        callr   __mulhi3                ; 4
        mov     r4, r0                  ; 2
        ld      r0, [sp]                ; 4   al back, but leave it there
        mov     r1, r2                  ; 2   al * bh
        callr   __mulhi3                ; 4
        add     r4, r4, r0              ; 2   the two cross terms
        pop     r0                      ; 4   al, for the last time
        mov     r1, r3                  ; 2   al * bl, widened
        callr   __umulhisi3             ; 4
        add     r0, r0, r4              ; 2   fold the cross terms into the high
        pop     lr, r4                  ; 6
        ret                             ; 1
