; ============================================================================
; libgcc/lib1funcs.s - the multiply, divide and shift helpers GCC calls
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
; which it does, with __umulsidi3 for 32 x 32 -> 64 as well.  With -mmul it
; calls the `_mul' routines after __umulsidi3 instead, which are built from
; the multiplier - see WITH THE MULTIPLIER below.
;
; There is no divide instruction either, so the same again for division:
;
;       __udivhi3       16 / 16           every unsigned int division
;       __umodhi3       16 % 16
;       __divhi3        16 / 16           signed
;       __modhi3        16 % 16
;
; all four built on __udivmodhi4, which returns BOTH results - the quotient in
; r0 and the remainder in r1, which is one 32-bit value to a C caller.  A
; compiler that wants `x / 10' and `x % 10' together can then have them for one
; call.  The 32-bit division helpers are still C, in the GCC tree's
; libgcc/config/fructus/lib2div.c.  The 64-bit ones are here, six entry points
; on one division:
;
;       __udivdi3  __umoddi3  __udivmoddi4  __divdi3  __moddi3  __divmoddi4
;
; And the shifts by a variable count, at the end of the file:
;
;       __ashlsi3  __lshrsi3  __ashrsi3     32-bit <<, unsigned >>, signed >>
;       __ashldi3  __lshrdi3  __ashrdi3     the same for 64 bits
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
; THESE ARE SPLIT ONE ROUTINE TO A SECTION, so that a program which multiplies
; two ints does not link the 32-bit helper, the 64-bit helper and the whole of
; division along with them - which it did, and which cost 528 bytes in a
; program whose only use of any of it was a single calloc.
;
; Not by the `#ifdef L_mulhi3` guards lib1funcs.S conventionally uses: those
; would put directives in THIS file, and it has to stay pure customasm, because
; the suite assembles it with customasm, decodes the bytes back through the
; disassembler, and compares gas against customasm byte for byte.  The copy in
; the GCC tree is generated instead, by tools/gen-lib1funcs.js, with a .globl
; and a section apiece.  It splits at the boundaries marked below, and refuses
; to split anywhere a routine could be entered by falling through.
; ============================================================================


; ============================================================================
; __mulhi3 - 16 x 16 -> 16, signed or unsigned                       39 bytes
; ============================================================================
;       r0  a, then the product              r5  the multiplier
;       r1  b, then the multiplicand          lr  untouched: this is a leaf
;
; r1 IS LEFT AS RUBBISH - the multiplicand, shifted up by however many nibbles
; the loop ran.  Zeroing it would make the pair r0:r1 a well-formed 32-bit
; value, low half first as isa/abi.s has it, and let __umulhisi3 tail-call this
; routine when the product provably fits.  But every int multiply would pay the
; cycle for the zero, so __umulhisi3 writes the high half itself.
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
        br      ls, r1, r0, .sorted     ; 1   b <= a: b is the multiplier
        mov     r5, r0                  ; 1   otherwise a is, and b stays put
        jmpr    .go                     ; 3
.sorted:                                ;     ENTRY: r1 already the smaller
        mov     r5, r1                  ; 1   the multiplier
        mov     r1, r0                  ; 1   the multiplicand, pinned
.go:
        mov     r0, #0                  ; 1   the accumulator, pinned
.top:
        brclr   r5, #0x0001, .s0        ; 2
        add     r0, r0, r1              ; 1
.s0:
        brclr   r5, #0x0002, .s1        ; 2
        add     r0, r0, r1              ; 1   twice: r1 has not moved, and
        add     r0, r0, r1              ; 1   two of a<<i is a<<(i+1)
.s1:
        shl     r1, r1, #2              ; 1   one shift for the pair
        brclr   r5, #0x0004, .s2        ; 1
        add     r0, r0, r1              ; 1
.s2:
        brclr   r5, #0x0008, .s3        ; 1
        add     r0, r0, r1              ; 1
        add     r0, r0, r1              ; 1
.s3:
        shl     r1, r1, #2              ; 1
        lsr     r5, r5, #4              ; 1
        br      ne, r5, #0, .top        ; 2
        ret                             ; 4


; ============================================================================
; __umulhisi3 - 16 x 16 -> 32, unsigned                              67 bytes
; ============================================================================
;       r0  a, then the product LOW         r2  multiplicand high
;       r1  b, then the product HIGH        r3  accumulator high
;       lr  multiplicand low                r5  scratch
;
; THE PAIR IS r0:r1 AS LOW:HIGH, which is what isa/abi.s says a 32-bit value
; is, and the same order as snippets/mul.s's mul_16_16_32.  This one is called
; by compiler-generated code and has to match.
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
; IT IS A CALL AND NOT A TAIL CALL.  __mulhi3 returns the product in r0, which
; is already the low half, but r1 has to be zeroed after the multiply, which
; `jmpr` cannot do.  A tail call would need __mulhi3 to zero r1 itself, and
; every int multiply would pay for that.

__umulhisi3:
        br      ls, r1, r0, .sorted     ; 2   b is already the smaller
        mov     r5, r0                  ; 1
        mov     r0, r1                  ; 1   pinned
        mov     r1, r5                  ; 1
.sorted:
        lsr     r5, r0, #8              ; 1   the LARGER operand only
        br      eq, r5, #0, .narrow     ; 2   under 256: it cannot overflow

        ; --- the general case: shift and add, both sides widened -------------
        push    r2, r3, lr              ; 10
        lsr     r2, r0, #15             ; 1   multiplicand high = a >> 15
        shl     lr, r0, #1              ; 1   multiplicand low  = a << 1
        mov     r3, #0                  ; 1   accumulator high
        brset   r1, #1, .entry          ; 1   bit 0 set: r0 is already the sum
        mov     r0, #0                  ; 1
        jmpr    .entry                  ; 3
.set:
        add     r0, r0, lr              ; 1
        add     r3, r3, r2              ; 1
        br      hs, r0, lr, .clear      ; 1   sum >= addend means no carry
        add     r3, r3, #1              ; 1
.clear:
        lsr     r5, lr, #15             ; 1   the bit leaving the low half
        shl     r2, r2, #1              ; 1
        or      r2, r2, r5              ; 1
        shl     lr, lr, #1              ; 1
.entry:
        lsr     r1, r1, #1              ; 1   LOGICAL, or the loop never ends
.end:
        brset   r1, #1, .set            ; 2
        br      ne, r1, #0, .clear      ; 1
.done:
        mov     r1, r3                  ; 1   the high half; the low is in r0
        pop     lr, r3, r2              ; 9
        ret                             ; 4
.narrow:
        push    lr                      ; 6
        call    __mulhi3.sorted         ; 3   past the comparison already made
        pop     lr                      ; 5
        mov     r1, #0                  ; 1   the product is the LOW half, in r0
        ret                             ; 4


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
        push    r2, r3, lr              ; 10
        mov     r2, r0                  ; 1   keep a
        mov     r3, r1                  ; 1   keep b
        call    __umulhisi3             ; 3   r0:r1 = low:high, unsigned
        brclr   r2, #0x8000, .a_pos     ; 2   a negative?
        rsb     r1, r3, r1              ; 1   high -= b
.a_pos:
        brclr   r3, #0x8000, .b_pos     ; 1   b negative?
        rsb     r1, r2, r1              ; 1   high -= a
.b_pos:
        pop     lr, r3, r2              ; 9
        ret                             ; 4


; ============================================================================
; __mulsi3 - 32 x 32 -> 32, signed or unsigned                       40 bytes
; ============================================================================
;       a in r0:r1 as low:high          b in r2:r3 as low:high
;       result in r0:r1 as low:high
;
; Four argument registers, so by isa/abi.s's sliding rule r2 and r3 are
; caller-saved here and this routine owns r0, r1, r2, r3 and r5 outright.  Only
; r4 and lr have to be saved.
;
;       (ah:al) * (bh:bl)  =  al*bl  +  ((al*bh + ah*bl) << 16)
;
; The ah*bh term is entirely above bit 31 and is not computed.  The two cross
; terms only need their low sixteen bits, which is __mulhi3; the al*bl term
; needs all thirty-two, which is __umulhisi3 - and its low:high result is
; already in the right registers, so folding the cross terms in is one `add`.
;
; ONE PUSH, NOT TWO.  A three-register push is ten cycles and two bytes where
; pushing two and then one is fourteen cycles and four - a push stops the
; pipeline for four cycles beyond its bytes however many registers it carries,
; see the cost model under [cpu] in the spec - and the order works out: `push
; r4, lr, r0` writes r4 highest and al lowest, so `ld r0, [sp]` finds al, and
; the later `pop r0` then `pop lr, r4` unwind it in the right order.
;
; NEITHER HELPER TOUCHES r2, r3 OR r4.  __mulhi3 uses r0, r1 and r5 and nothing
; else; __umulhisi3 saves r2 and r3 and restores them.  So bl and bh sit in
; their argument registers across all three calls and only al has to be spilled
; - once, and read back without popping the first time it is wanted.
;
; ----------------------------------------------------------------------------
; BOTH HIGH WORDS ZERO IS A TAIL CALL
; ----------------------------------------------------------------------------
; If ah and bh are both zero then a and b are 16-bit values, both cross terms
; vanish, and the answer is just the widening product of the low halves - which
; __umulhisi3 already returns as low:high in r0:r1, exactly where this routine
; has to leave it.  Nothing to fix up afterwards, so it is a real tail call:
; the test happens before the prologue and there is no lr to save.
;
;       or      r5, r1, r3              ; both high words at once
;
; Two cycles to ask, and it turns 443 into about 221 - or about 83 when the
; low halves are small enough for __umulhisi3's own shortcut.  A `long` holding
; a value that fits in sixteen bits is the common case in real code by a wide
; margin, which is what makes this worth its eleven bytes.
;
; ONLY ONE HIGH WORD ZERO is not tested for.  It would kill one cross term
; rather than both, which is a third of the work for another test on each of
; two paths, and the case is much rarer than both being zero.

__mulsi3:
        or      r5, r1, r3              ; 1   ah | bh
        br      eq, r5, #0, .narrow     ; 1   both zero: a 16 x 16 widening
        push    r4, lr, r0              ; 10  one push, not two:
                                        ;     al ends up lowest, so [sp] finds it
        mov     r0, r2                  ; 1   bl * ah, with ah already in r1
        call    __mulhi3                ; 3
        mov     r4, r0                  ; 1
        ld      r0, [sp]                ; 5   al back, but leave it there
        mov     r1, r3                  ; 1   al * bh
        call    __mulhi3                ; 3
        add     r4, r4, r0              ; 1   the two cross terms
        pop     r0                      ; 5   al, for the last time
        mov     r1, r2                  ; 1   al * bl, widened
        call    __umulhisi3             ; 3
        add     r1, r1, r4              ; 1   fold the cross terms into the high
        pop     lr, r4                  ; 7
        ret                             ; 4
.narrow:
        mov     r1, r2                  ; 1   bl; al is already in r0
        jmp     __umulhisi3             ; 3   its low:high result is ours


; ============================================================================
; __umulsidi3 - 32 x 32 -> 64, unsigned
; ============================================================================
;       a in r0:r1 as low:high          b in r2:r3 as low:high
;       result in r0:r1:r2:r3, low word to high word
;
; This is what libgcc2.c builds __muldi3 out of, so it is the last helper a
; port needs for `long long`.  The result exactly overwrites its arguments,
; which is what the new 64-bit return rule in isa/abi.s buys.
;
;       (ah:al) * (bh:bl)  =  P3<<32  +  (P1 + P2)<<16  +  P0
;
;       P0 = al*bl   P1 = al*bh   P2 = ah*bl   P3 = ah*bh
;
; ALL FOUR PRODUCTS ARE NEEDED, unlike __mulsi3 which throws P3 away.  Four
; calls to __umulhisi3 and a 64-bit accumulation.
;
; THE CROSS TERMS ARE SUMMED FIRST, into a 33-bit X = P1 + P2 with its carry
; kept separately.  That is what keeps the register pressure survivable: the
; four operands live on the stack, __umulhisi3 preserves r2, r3 and r4, and
; those three hold X and its carry across every call.
;
;       w0 = P0.lo
;       w1 = P0.hi + X.lo               carry k1
;       w2 = P3.lo + X.hi + k1          carry k2
;       w3 = P3.hi + cx + k2
;
; WHERE A CARRY CAN AND CANNOT WRAP AGAIN is the whole difficulty, and it is
; decided by bounds rather than by testing everywhere:
;
;   P2.hi <= 0xfffe, because ah*bl <= 0xfffe0001.  So folding the carry out of
;   X.lo into P2.hi before adding it cannot overflow, and needs no second test.
;
;   X.hi CAN be 0xffff, so the carry out of w1 folded into it CAN wrap, and
;   that one is tested.
;
;   cx and the carries above it never exceed 2 before P3.hi arrives, so
;   `add r4, r4, #1` there is always safe.
;
; The one test that guards a carry-of-a-carry is reached by almost no operands:
; deleting it leaves 3700 random 32-bit products all correct.  It takes a sweep
; of halves near 0xffff to find, which tests/libgcc-check.mjs does deliberately.

__umulsidi3:
        or      r5, r1, r3              ; 1   ah | bh
        br      eq, r5, #0, .narrow     ; 1   both zero: it is a 16 x 16
        push    r4, lr, r1              ; 10  r4, lr, ah      ah lowest
        push    r0, r3, r2              ; 10  al, bh, bl      bl lowest
        add     sp, sp, #-2             ; 1   and a slot for w0
        ;      w0(0)  bl(2)  bh(4)  al(6)  ah(8)  lr(10)  r4(12)

        ; --- P1 = al * bh ---------------------------------------------------
        ld      r0, [sp, #6]            ; 5
        ld      r1, [sp, #4]            ; 5
        call    __umulhisi3             ; 3
        mov     r2, r1                  ; 1   X.hi
        mov     r3, r0                  ; 1   X.lo

        ; --- P2 = ah * bl, and X = P1 + P2 ----------------------------------
        ld      r0, [sp, #8]            ; 5
        ld      r1, [sp, #2]            ; 5
        call    __umulhisi3             ; 3
        mov     r4, #0                  ; 1   cx
        add     r3, r3, r0              ; 1   X.lo
        br      hs, r3, r0, .nc1        ; 2
        add     r1, r1, #1              ; 1   into P2.hi; it cannot wrap
.nc1:
        add     r2, r2, r1              ; 1   X.hi
        br      hs, r2, r1, .nc2        ; 1
        add     r4, r4, #1              ; 1
.nc2:

        ; --- P0 = al * bl ---------------------------------------------------
        ld      r0, [sp, #6]            ; 5
        ld      r1, [sp, #2]            ; 5
        call    __umulhisi3             ; 3
        st      r0, [sp, #0]            ; 6   w0 is finished
        add     r3, r3, r1              ; 1   w1 = X.lo + P0.hi
        br      hs, r3, r1, .nc3        ; 1
        add     r2, r2, #1              ; 1   k1 into X.hi ...
        br      ne, r2, #0, .nc3        ; 2   ... which CAN wrap
        add     r4, r4, #1              ; 1
.nc3:

        ; --- P3 = ah * bh ---------------------------------------------------
        ld      r0, [sp, #8]            ; 5
        ld      r1, [sp, #4]            ; 5
        call    __umulhisi3             ; 3
        add     r2, r2, r0              ; 1   w2 = X.hi + k1 + P3.lo
        br      hs, r2, r0, .nc4        ; 2
        add     r4, r4, #1              ; 1
.nc4:
        add     r4, r4, r1              ; 1   w3 = P3.hi + cx + k2

        ; --- place the four words and unwind --------------------------------
        mov     r1, r3                  ; 1   w1; w2 is in r2 already
        mov     r3, r4                  ; 1   w3, before the pop restores r4
        ld      r0, [sp, #0]            ; 5   w0
        add     sp, sp, #10             ; 1
        pop     lr, r4                  ; 7
        ret                             ; 4

; BOTH HIGH WORDS ZERO leaves only P0, so the answer is one widening multiply
; with two zero words above it.  IT IS A TAIL CALL: the zero words go in r2 and
; r3 before the jump, and __umulhisi3 preserves both, so they are still there
; when it returns P0 in r0:r1 - which is where w0 and w1 belong.
.narrow:
        mov     r1, r2                  ; 1   bl; al is already in r0
        mov     r2, #0                  ; 1   w2
        mov     r3, r2                  ; 1   w3
        jmp     __umulhisi3             ; 3

; ============================================================================
; WITH THE MULTIPLIER - what gcc -mmul calls instead
; ============================================================================
; mul is the LOW half of a 16 x 16 product and nothing more, so a part with a
; multiplier still needs helpers for anything wider - just much faster ones.
; They have names of their own rather than replacing the routines above: this
; library is built once, without -mmul, and has to run on a part without one.
; A program built with -mmul calls these; --gc-sections drops the rest.
;
;       __umulhisi3_mul     16 x 16 -> 32 unsigned   45 bytes  39 cycles
;       __mulhisi3_mul      16 x 16 -> 32 signed     45 bytes  39 cycles
;       __mulsi3_mul        32 x 32 -> 32            53 bytes  43 cycles
;       __umulsidi3_mul     32 x 32 -> 64 unsigned  102 bytes  50..266
;
; and __muldi3_mul, in C on top of them, in the GCC tree's
; libgcc/config/fructus/lib2mul.c.  The cycles are from entry to the return.
; The first three take the same for every operand, because they never
; branch; __umulsidi3_mul is 50 when both high words are zero.
;
; ----------------------------------------------------------------------------
; FOUR BYTE PRODUCTS, AND NO CARRY TESTED
; ----------------------------------------------------------------------------
; Split into bytes, every partial product fits in sixteen bits:
;
;       a*b = p11<<16 + (p01 + p10)<<8 + p00      p00 = a0*b0   p01 = a0*b1
;                                                 p10 = a1*b0   p11 = a1*b1
;
; The cross products straddle the halves, which is where a carry would be.
; Instead the low bytes are summed apart from the high bytes - three bytes
; come to at most 0x2fc, so the sum cannot overflow and its top bits ARE the
; carry:
;
;       s  = (p00 >> 8) + (p01 & 255) + (p10 & 255)
;       lo = s:p00, a byte each                         - one movhi
;       hi = p11 + (p01 >> 8) + (p10 >> 8) + (s >> 8)
;
; On a machine without flags a carry is a compare and a branch, and a taken
; branch is four cycles; there are none here.
;
; s IS FORMED WITHOUT THE TWO MASKS, which would want a sixth register: the
; whole of p01 and p10 are added, wrapping, and h << 8 taken back out, where
; h = (p01 >> 8) + (p10 >> 8) is wanted for the high half anyway.  That is
; exact modulo 2^16, and s's true value is far below it.
;
; SIGNED IS THE SAME CODE with four shifts arithmetic: the high bytes of the
; operands, and of the two cross products.  a1*b0 is in -32640..32385 and
; a1*b1 in -16256..16384, so every partial product is still exact in sixteen
; bits and nothing needs correcting afterwards, as __mulhisi3 above does.
; p00 and s are never negative, so their shifts stay logical.
;
; gcc emits the same sequence inline at -O2 - fructus.cc's
; fructus_expand_byte_products - and for dividing by a constant, the high
; half alone, with the divisor's reciprocal in mul's immediates.  These are
; what -Os calls.

; ============================================================================
; __umulhisi3_mul - 16 x 16 -> 32, unsigned, with mul               45 bytes
; ============================================================================
;       r0  a, then the product LOW        r1  b, then the product HIGH
;
; Five values are live when the products are formed, and two arguments with a
; 32-bit result make r2 and r3 callee saved under isa/abi.s - so eleven of the
; 39 cycles are saving them.  Inline, gcc's allocator does better.

__umulhisi3_mul:
        push    r2, r3                  ; 6
        lsr     r5, r0, #8              ; 1   a1
        and     r0, r0, #0x00ff         ; 1   a0
        lsr     r2, r1, #8              ; 1   b1
        and     r1, r1, #0x00ff         ; 1   b0
        mul     r3, r5, r1              ; 2   p10 = a1*b0
        mul     r5, r5, r2              ; 2   p11 = a1*b1
        mul     r2, r0, r2              ; 2   p01 = a0*b1
        mul     r0, r0, r1              ; 2   p00 = a0*b0
        lsr     r1, r0, #8              ; 1   p00 >> 8
        add     r1, r1, r2              ; 1   + p01, wrapping
        add     r1, r1, r3              ; 1   + p10
        lsr     r2, r2, #8              ; 1
        lsr     r3, r3, #8              ; 1
        add     r2, r2, r3              ; 1   h = (p01 >> 8) + (p10 >> 8)
        add     r5, r5, r2              ; 1   p11 + h
        shl     r2, r2, #8              ; 1
        rsb     r1, r2, r1              ; 1   s, the low bytes' sum
        movhi   r0, r0, r1              ; 1   lo = s:p00
        lsr     r1, r1, #8              ; 1   s's carry, 0..2
        add     r1, r5, r1              ; 1   hi
        pop     r3, r2                  ; 5
        ret                             ; 4


; ============================================================================
; __mulhisi3_mul - 16 x 16 -> 32, signed, with mul                  45 bytes
; ============================================================================
; __umulhisi3_mul with the four high-byte shifts arithmetic.

__mulhisi3_mul:
        push    r2, r3                  ; 6
        asr     r5, r0, #8              ; 1   a1, signed
        and     r0, r0, #0x00ff         ; 1   a0
        asr     r2, r1, #8              ; 1   b1, signed
        and     r1, r1, #0x00ff         ; 1   b0
        mul     r3, r5, r1              ; 2   p10 = a1*b0
        mul     r5, r5, r2              ; 2   p11 = a1*b1
        mul     r2, r0, r2              ; 2   p01 = a0*b1
        mul     r0, r0, r1              ; 2   p00 = a0*b0
        lsr     r1, r0, #8              ; 1   p00 >> 8: p00 is never negative
        add     r1, r1, r2              ; 1
        add     r1, r1, r3              ; 1
        asr     r2, r2, #8              ; 1
        asr     r3, r3, #8              ; 1
        add     r2, r2, r3              ; 1   h
        add     r5, r5, r2              ; 1
        shl     r2, r2, #8              ; 1
        rsb     r1, r2, r1              ; 1   s, never negative either
        movhi   r0, r0, r1              ; 1   lo
        lsr     r1, r1, #8              ; 1
        add     r1, r5, r1              ; 1   hi
        pop     r3, r2                  ; 5
        ret                             ; 4


; ============================================================================
; __mulsi3_mul - 32 x 32 -> 32, signed or unsigned, with mul         53 bytes
; ============================================================================
;       a in r0:r1 as low:high          b in r2:r3 as low:high
;       result in r0:r1 as low:high
;
;       (ah:al) * (bh:bl)  =  al*bl  +  ((al*bh + ah*bl) << 16)
;
; The cross terms are wanted only to sixteen bits, which is two plain muls;
; al*bl is the byte products above.  Four argument registers make r2 and r3
; ours, but the cross terms' sum is a sixth live value beside the byte
; products' five, so r4 is saved for it.  NOT A CALL to __umulhisi3_mul,
; which would cost its own r2 and r3 as well as the call.

__mulsi3_mul:
        push    r4                      ; 6
        mul     r1, r1, r2              ; 2   ah*bl
        mul     r3, r3, r0              ; 2   bh*al
        add     r4, r3, r1              ; 1   the cross terms
        lsr     r5, r0, #8              ; 1   a1, of al
        and     r0, r0, #0x00ff         ; 1   a0
        lsr     r3, r2, #8              ; 1   b1, of bl
        and     r2, r2, #0x00ff         ; 1   b0
        mul     r1, r5, r2              ; 2   p10
        mul     r5, r5, r3              ; 2   p11
        mul     r3, r0, r3              ; 2   p01
        mul     r0, r0, r2              ; 2   p00
        add     r5, r5, r4              ; 1   p11 + the cross terms
        lsr     r2, r0, #8              ; 1
        add     r2, r2, r3              ; 1
        add     r2, r2, r1              ; 1
        lsr     r3, r3, #8              ; 1
        lsr     r1, r1, #8              ; 1
        add     r3, r3, r1              ; 1   h
        add     r5, r5, r3              ; 1
        shl     r3, r3, #8              ; 1
        rsb     r2, r3, r2              ; 1   s
        movhi   r0, r0, r2              ; 1   lo
        lsr     r2, r2, #8              ; 1
        add     r1, r5, r2              ; 1   hi
        pop     r4                      ; 5
        ret                             ; 4


; ============================================================================
; __umulsidi3_mul - 32 x 32 -> 64, unsigned, with mul                102 bytes
; ============================================================================
; __umulsidi3 above, calling __umulhisi3_mul.  Everything that routine says
; about its carries holds unchanged: what it relies on of its helper is the
; product, low:high in r0:r1, and r2, r3 and r4 preserved - which
; __umulhisi3_mul gives too.  A COPY rather than one body with the helper in
; a register, because `call' through a register loaded from the frame is
; five cycles more a product, four times over.

__umulsidi3_mul:
        or      r5, r1, r3              ; 1   ah | bh
        br      eq, r5, #0, .narrow     ; 1   both zero: it is a 16 x 16
        push    r4, lr, r1              ; 10  r4, lr, ah      ah lowest
        push    r0, r3, r2              ; 10  al, bh, bl      bl lowest
        add     sp, sp, #-2             ; 1   and a slot for w0
        ;      w0(0)  bl(2)  bh(4)  al(6)  ah(8)  lr(10)  r4(12)

        ; --- P1 = al * bh ---------------------------------------------------
        ld      r0, [sp, #6]            ; 5
        ld      r1, [sp, #4]            ; 5
        call    __umulhisi3_mul         ; 3
        mov     r2, r1                  ; 1   X.hi
        mov     r3, r0                  ; 1   X.lo

        ; --- P2 = ah * bl, and X = P1 + P2 ----------------------------------
        ld      r0, [sp, #8]            ; 5
        ld      r1, [sp, #2]            ; 5
        call    __umulhisi3_mul         ; 3
        mov     r4, #0                  ; 1   cx
        add     r3, r3, r0              ; 1   X.lo
        br      hs, r3, r0, .nc1        ; 2
        add     r1, r1, #1              ; 1   into P2.hi; it cannot wrap
.nc1:
        add     r2, r2, r1              ; 1   X.hi
        br      hs, r2, r1, .nc2        ; 1
        add     r4, r4, #1              ; 1
.nc2:

        ; --- P0 = al * bl ---------------------------------------------------
        ld      r0, [sp, #6]            ; 5
        ld      r1, [sp, #2]            ; 5
        call    __umulhisi3_mul         ; 3
        st      r0, [sp, #0]            ; 6   w0 is finished
        add     r3, r3, r1              ; 1   w1 = X.lo + P0.hi
        br      hs, r3, r1, .nc3        ; 1
        add     r2, r2, #1              ; 1   k1 into X.hi ...
        br      ne, r2, #0, .nc3        ; 2   ... which CAN wrap
        add     r4, r4, #1              ; 1
.nc3:

        ; --- P3 = ah * bh ---------------------------------------------------
        ld      r0, [sp, #8]            ; 5
        ld      r1, [sp, #4]            ; 5
        call    __umulhisi3_mul         ; 3
        add     r2, r2, r0              ; 1   w2 = X.hi + k1 + P3.lo
        br      hs, r2, r0, .nc4        ; 2
        add     r4, r4, #1              ; 1
.nc4:
        add     r4, r4, r1              ; 1   w3 = P3.hi + cx + k2

        ; --- place the four words and unwind --------------------------------
        mov     r1, r3                  ; 1   w1; w2 is in r2 already
        mov     r3, r4                  ; 1   w3, before the pop restores r4
        ld      r0, [sp, #0]            ; 5   w0
        add     sp, sp, #10             ; 1
        pop     lr, r4                  ; 7
        ret                             ; 4

.narrow:
        mov     r1, r2                  ; 1   bl; al is already in r0
        mov     r2, #0                  ; 1   w2
        mov     r3, r2                  ; 1   w3
        jmp     __umulhisi3_mul         ; 3

; ============================================================================
; __udivmodhi4 - 16 / 16 -> quotient and remainder, unsigned
; ============================================================================
;       a in r0, b in r1        ->      quotient in r0, remainder in r1
;
; Two arguments and a 32-bit result, so by isa/abi.s this owns r0, r1 and r5
; and must give back r2, r3 and r4 - which is why the general loop, needing a
; fourth register, borrows r2 - six cycles to push it and five to pop it.
;
; BOTH RESULTS AT ONCE, because the caller usually wants both.  `x / 10' and
; `x % 10' next to each other is every digit of every number ever printed,
; and a quotient-only routine does that work twice.  r0:r1 is what abi.s
; calls a 32-bit return, so to C this is one `unsigned long' with the quotient
; in the low half and the remainder in the high.
;
; ----------------------------------------------------------------------------
; THREE PATHS, AND THE MIDDLE ONE IS WHY
; ----------------------------------------------------------------------------
; The general algorithm below costs an iteration per bit of the QUOTIENT, so
; its cost depends on the divisor and not on the machine:
;
;       random 16-bit divisor    1.17 iterations, mean
;       divisor 1000             6
;       divisor 100              9
;       divisor 10               12
;
; A random divisor is nearly free - it is large, so the quotient is small.
; Ten is the worst case in the whole range and also the commonest divisor
; there is, so it gets its own path, and powers of two get one because a mask
; and a shift are obviously cheaper than any loop.
;
; DIVISION BY ZERO returns junk and does not hang, which is all that is
; required of it: popcount 0 is 0 so it is not the power-of-two path, and in
; the loop `r >= 0' is always true, so the loop runs its bounded count and
; leaves the quotient all ones.
;
; ----------------------------------------------------------------------------
; DIVIDING BY TEN WITH SHIFTS
; ----------------------------------------------------------------------------
; 1/10 is 0.0001100110011... in binary, so
;
;       q = a/2 + a/4           0.75 a
;       q += q >> 4             0.796875 a
;       q += q >> 8             0.79999237 a
;       q >>= 3                 0.09999905 a
;
; is a/10 a little low, and the remainder a - 10q is then in 0..19, so ONE
; conditional correction finishes it.  Exactly one: brute force over all
; 65536 dividends says 50286 need no correction and 15250 need one, none
; needs two, and no intermediate overflows 16 bits - which is what the
; halving first buys, since 0.75 * 65535 still fits.
;
; It is exact for EVERY 16-bit dividend, so there is no range to check first.
;
; ----------------------------------------------------------------------------
; THE GENERAL CASE
; ----------------------------------------------------------------------------
; Restoring division, one bit of quotient per iteration, with the divisor
; pre-shifted up to align with the dividend:
;
;       s = clz(b) - clz(a)             how far apart their top bits are
;       d = b << s
;       repeat s+1 times:
;         q <<= 1
;         if (r >= d) { r -= d; q |= 1 }
;         d >>= 1
;
; THE ALIGNMENT IS ONE INSTRUCTION EACH, which is what `clz' is for.  The C
; routine this replaces walks the divisor up a bit at a time, and then runs
; its subtract loop over the whole word width; here the loop runs only as
; many times as the quotient has bits, and s doubles as the counter.
;
; a < b needs no loop at all and is tested for, both because it is common and
; because s is only meaningful when a >= b.
; ============================================================================

__udivmodhi4:
        popcount r5, r1                 ; 4
        br      ne, r5, #1, .not_pow2   ; 1   0 bits set is not 1 either
        ; --- b is a power of two: mask and shift -----------------------------
        clz     r5, r1                  ; 4   15 - log2(b)
        rsb     r5, r5, #15             ; 1   log2(b), and imm5 reaches 15
        sub     r1, r1, #1              ; 1   b - 1, the remainder's mask
        and     r1, r1, r0              ; 1   a mod b
        lsr     r0, r0, r5              ; 1   a div b
        ret                             ; 4

.not_pow2:
        mov     r5, #10                 ; 1   condimm5 has no 10, so compare
        br      ne, r1, r5, .general    ; 1   against a register

        ; --- b is ten --------------------------------------------------------
        lsr     r5, r0, #1              ; 1
        lsr     r1, r0, #2              ; 1
        add     r5, r5, r1              ; 1   0.75 a
        lsr     r1, r5, #4              ; 1
        add     r5, r5, r1              ; 1   0.796875 a
        lsr     r1, r5, #8              ; 1
        add     r5, r5, r1              ; 1   0.79999237 a
        lsr     r5, r5, #3              ; 1   q, at most one too low
        shl     r1, r5, #3              ; 1   8q
        add     r1, r1, r5              ; 1   9q
        add     r1, r1, r5              ; 1   10q
        rsb     r1, r1, r0              ; 1   r = a - 10q, in 0..19
        add     r1, r1, #-10            ; 1   the corrected remainder ...
        add     r0, r5, #1              ; 1   ... and the corrected quotient
        br      ge, r1, #0, .ten_ret    ; 3+1 r was >= 10: they are the answer
        mov     r0, r5                  ; 1   otherwise put both back
        add     r1, r1, #10             ; 1
.ten_ret:
        ret                             ; 4

.general:
        br      lo, r0, r1, .smaller    ; 3+1 a < b: quotient 0, remainder a
        push    r2                      ; 6   the fourth register, the quotient
        clz     r5, r1                  ; 4
        clz     r2, r0                  ; 4
        rsb     r5, r2, r5              ; 1   s = clz(b) - clz(a), >= 0 here
        shl     r1, r1, r5              ; 1   d = b << s
        mov     r2, #0                  ; 1   the quotient
.loop:
        add     r2, r2, r2              ; 1   q <<= 1
        br      lo, r0, r1, .nofit      ; 3+1
        rsb     r0, r1, r0              ; 1   r -= d
        add     r2, r2, #1              ; 1   q |= 1
.nofit:
        lsr     r1, r1, #1              ; 1   d >>= 1
        add     r5, r5, #-1             ; 1   s is the counter too
        br      ge, r5, #0, .loop       ; 3+1 s+1 iterations
        mov     r1, r0                  ; 1   the remainder, pinned
        mov     r0, r2                  ; 1   the quotient
        pop     r2                      ; 5
        ret                             ; 4
.smaller:
        mov     r1, r0                  ; 1   pinned
        mov     r0, #0                  ; 1   pinned
        ret                             ; 4


; ============================================================================
; The four helpers GCC actually calls
; ============================================================================
; All of them are __udivmodhi4 with the signs put back on afterwards, and all
; have two arguments and a 16-bit return, so r2, r3 and r4 have to survive -
; which for the signed pair means the sign has to live somewhere across the
; call, and r2 is where.
;
; __udivhi3 IS A TAIL CALL: the quotient is already in r0, and leaving the
; remainder in r1 is allowed, since a 16-bit return says nothing about r1.

__udivhi3:
        jmp     __udivmodhi4            ; 3

__umodhi3:
        push    lr                      ; 6
        call    __udivmodhi4            ; 3
        mov     r0, r1                  ; 1   the remainder, pinned
        pop     lr                      ; 5
        ret                             ; 4

; C rounds a signed quotient TOWARDS ZERO, so the magnitudes divide and the
; sign goes back on after: negative exactly when the operands' signs differ,
; which is the top bit of a ^ b.
__divhi3:
        push    lr, r2                  ; 8
        xor     r2, r0, r1              ; 1   bit 15 is the quotient's sign
        br      ge, r0, #0, .a_pos      ; 3+1
        rsb     r0, r0, #0              ; 1   |a|
.a_pos:
        br      ge, r1, #0, .b_pos      ; 3+1
        rsb     r1, r1, #0              ; 1   |b|
.b_pos:
        call    __udivmodhi4            ; 3
        br      ge, r2, #0, .pos        ; 3+1
        rsb     r0, r0, #0              ; 1
.pos:
        pop     r2, lr                  ; 7
        ret                             ; 4

; And a remainder takes the sign of the DIVIDEND, so that a == (a/b)*b + a%b.
__modhi3:
        push    lr, r2                  ; 8
        mov     r2, r0                  ; 1   keep a, for its sign
        br      ge, r0, #0, .a_pos      ; 3+1
        rsb     r0, r0, #0              ; 1   |a|
.a_pos:
        br      ge, r1, #0, .b_pos      ; 3+1
        rsb     r1, r1, #0              ; 1   |b|
.b_pos:
        call    __udivmodhi4            ; 3
        mov     r0, r1                  ; 1   the remainder, pinned
        br      ge, r2, #0, .pos        ; 3+1
        rsb     r0, r0, #0              ; 1
.pos:
        pop     r2, lr                  ; 7
        ret                             ; 4

; ============================================================================
; 64-bit division
; ============================================================================
;       __udivdi3    __umoddi3    __udivmoddi4      unsigned
;       __divdi3     __moddi3     __divmoddi4       signed
;
;       n in r0:r1:r2:r3, low word first; d on the stack at [sp]; and for the
;       divmod pair a pointer to the remainder at [sp, #8], which may be null.
;       The answer comes back in r0:r1:r2:r3.
;
; ONE DIVISION, SIX ENTRY POINTS.  libgcc2.c's are C, each with its own copy of
; the whole of __udivmoddi4 inlined, and each a quotient digit at a time in
; 32-bit words - which on this machine is calls to __udivsi3, __umodsi3 and
; __mulsi3 and a 256-byte table for clz.  A program that wanted / and % on a
; long long carried two copies, over 4.5K of it.  Here the six share one core,
; .core below, and the signed three one sign-fixing wrapper around it.
;
; THE CORE'S CONVENTION IS ITS OWN: n in r0:r1:r2:r3 and r5 pointing at d,
; and it returns the quotient in r0:r1:r2:r3 and WRITES THE REMAINDER OVER d.
; Over d because d is in the caller's argument slots, which C hands to the
; callee: __udivdi3 is then `mov r5, sp' and a jump, and __umoddi3 reads its
; answer back out of its own arguments.  It keeps r4, so a jump into it is
; a tail call of a function with __udivdi3's convention.
;
; ----------------------------------------------------------------------------
; A BIT AT A TIME - BUT NOT ALL SIXTY-FOUR OF THEM
; ----------------------------------------------------------------------------
; Restoring division, the remainder R shifted left a bit at a time with the
; dividend's next bit coming in underneath and the quotient's going out into
; the dividend word that bit came from:
;
;       R = 2R + next bit of n;  if (R >= d) { R -= d; quotient bit = 1 }
;
; WHOLE WORDS NEED NO STEPS WHILE THEY ARE SMALLER THAN d.  If d has m words
; that count - the highest one non-zero - then any m-1 words are below it, so
; the first m-1 words of n go into R whole, as quotient words of zero, and
; only the rest are fed a bit at a time.  Leading zero words of n count the
; same way.  So dividing by a 48-bit value is 32 steps, and anything whose
; dividend has fewer words than its divisor is no steps at all.
;
; A DIVISOR UNDER 65536 HAS A LOOP OF ITS OWN, because it is the common one -
; ten, to print a number - and because then R < d fits one register too, and
; the whole division lives in seven: n and the quotient in r0-r3, a word at a
; time in r3 and rotated round after each, R in r4, d in r5, the count in lr.
; About thirteen cycles a step.  The general loop keeps R in r0-r3, the
; dividend and quotient words in the frame, and d there too, compared and
; subtracted a word at a time.
;
; THE COUNT IS ALSO THE WORD.  Steps are counted down in lr from 64, sixteen
; to a word, so lr's low four bits are zero exactly at a word boundary - one
; brclr - and lr / 8 is the frame offset of the word about to be fed.
;
; DIVISION BY ZERO returns junk and does not hang: d = 0 takes the narrow loop,
; whose count is fixed, and every step subtracts nothing.
;
; ----------------------------------------------------------------------------
; MEASURED, a full 64-bit dividend, mean cycles of __udivdi3
; ----------------------------------------------------------------------------
;       divisor bits        1-16    17-32    33-48    49-64
;       here                1150    2700-3100 1600-2000 700-980
;       libgcc2.c's         ~4100   ~3000    ~3300    1600-2600
;
; 597 bytes for all six, where libgcc2.c's were 2.3K to 3.2K EACH, before the
; 32-bit division, multiply and clz table they called.  A divisor of 17 to 32
; bits is the slow case: 48 steps of the general loop, and a loop of its own
; with R in two registers would be about 80 bytes more.

__udivmoddi4:
        mov     r5, sp                  ; 1   d, which becomes the remainder
        push    lr                      ; 6
        call    .core                   ; 3
        ld      r5, [sp, #10]           ; 5   rp, past the pushed lr
        br      eq, r5, #0, .norp       ; 1
        ld      lr, [sp, #2]            ; 5
        st      lr, [r5, #0]            ; 6
        ld      lr, [sp, #4]            ; 5
        st      lr, [r5, #2]            ; 6
        ld      lr, [sp, #6]            ; 5
        st      lr, [r5, #4]            ; 6
        ld      lr, [sp, #8]            ; 5
        st      lr, [r5, #6]            ; 6
.norp:
        pop     lr                      ; 5
        ret                             ; 4

; --- the core -----------------------------------------------------------------
;       in:  r0:r1:r2:r3  n             r5  -> d, four words
;       out: r0:r1:r2:r3  n / d         [r5] n % d, over d          r4 kept
.core:
        push    r4, lr, r5              ; 10  [sp]: p, lr, r4
        ld      r4, [r5, #2]            ; 5   d1 | d2 | d3: under 65536?
        ld      lr, [r5, #4]            ; 5
        or      r4, r4, lr              ; 1
        ld      lr, [r5, #6]            ; 5
        or      r4, r4, lr              ; 1
        br      ne, r4, #0, .wide       ; 1

        ; --- d < 65536: R in r4 (zero already), d in r5 ------------------------
        ld      r5, [r5, #0]            ; 5   d
        push    r5                      ; 6   kept, for after each rotation
        mov     lr, #64                 ; 1
.nword:
        br      ne, r4, #0, .nbits      ; 1   a zero word with nothing carried
        br      ne, r3, #0, .nbits      ; 1   in is a zero quotient word:
        add     lr, lr, #-16            ; 1   no steps
        jmpr    .nrot                   ; 3
.nbits:
        brset   r4, #0x8000, .nbig      ; 1   2R overflows: it is above d
        shl     r4, r4, #1              ; 1
        brclr   r3, #0x8000, .n0        ; 3+1 the dividend's next bit
        add     r4, r4, #1              ; 1
.n0:
        shl     r3, r3, #1              ; 1   ... and room for the quotient's
        br      lo, r4, r5, .nnext      ; 3+1
.nsub:
        rsb     r4, r5, r4              ; 1   R -= d
        add     r3, r3, #1              ; 1   quotient bit
.nnext:
        add     lr, lr, #-1             ; 1
        brclr   lr, #0x000f, .nrot      ; 1   end of a word
        jmpr    .nbits                  ; 3
.nbig:
        shl     r4, r4, #1              ; 1   2R - 65536 ...
        brclr   r3, #0x8000, .n1        ; 3+1
        add     r4, r4, #1              ; 1
.n1:
        shl     r3, r3, #1              ; 1
        jmpr    .nsub                   ; 3   ... less d is exact mod 65536
.nrot:
        mov     r5, r3                  ; 1   the next word down into r3,
        mov     r3, r2                  ; 1   and the quotient word just made
        mov     r2, r1                  ; 1   round to r0: four rotations
        mov     r1, r0                  ; 1   put every word back in place
        mov     r0, r5                  ; 1
        ld      r5, [sp, #0]            ; 5   d again
        br      ne, lr, #0, .nword      ; 3+1
        ld      r5, [sp, #2]            ; 5   p: the remainder is R, and d's
        st      r4, [r5, #0]            ; 6   other words are zero already
        add     sp, sp, #4              ; 1
        pop     lr, r4                  ; 7
        ret                             ; 4

        ; --- the general case: R in r0-r3, the rest in the frame -------------
.wide:
        ld      r4, [r5, #6]            ; 5
        ld      lr, [r5, #4]            ; 5
        push    r4, lr                  ; 8   d3 d2
        ld      r4, [r5, #2]            ; 5
        ld      lr, [r5, #0]            ; 5
        push    r4, lr                  ; 8   d1 d0
        push    r3, r2, r1              ; 10
        push    r0                      ; 6
        ;      n0(0) n1(2) n2(4) n3(6) d0(8) d1(10) d2(12) d3(14) p(16)

        ; j = (m - 1) + leading zero words of n: the words that go in whole
        mov     r5, #3                  ; 1
        ld      r4, [sp, #14]           ; 5   d3
        br      ne, r4, #0, .m          ; 3+1
        mov     r5, #2                  ; 1
        ld      r4, [sp, #12]           ; 5   d2
        br      ne, r4, #0, .m          ; 3+1
        mov     r5, #1                  ; 1   then d1, which is not zero
.m:
        br      ne, r3, #0, .z          ; 3+1
        add     r5, r5, #1              ; 1
        br      ne, r2, #0, .z          ; 3+1
        add     r5, r5, #1              ; 1
        br      ne, r1, #0, .z          ; 3+1
        add     r5, r5, #1              ; 1
.z:
        shl     r5, r5, #4              ; 1
        rsb     r5, r5, #64             ; 1   T = 64 - 16j: the step count
        br      ge, r5, #0, .t          ; 3+1 below which words go bit by bit
        mov     r5, #0                  ; 1   n < d: every word goes in whole
.t:
        push    r5                      ; 6
        ;      T(0) n0(2) n1(4) n2(6) n3(8) d0(10) d1(12) d2(14) d3(16)
        ;      p(18) lr(20) r4(22)          word i at 2 + 2i, which is lr / 8
        mov     r0, #0                  ; 1   R
        mov     r1, r0                  ; 1
        mov     r2, r0                  ; 1
        mov     r3, r0                  ; 1
        mov     lr, #64                 ; 1
.word:
        ld      r4, [sp, #0]            ; 5   T
        br      ls, lr, r4, .wbits      ; 1
        lsr     r5, lr, #3              ; 1   this word goes into R whole
        mov     r3, r2                  ; 1
        mov     r2, r1                  ; 1
        mov     r1, r0                  ; 1
        ld      r0, [sp, r5]            ; 5
        mov     r4, #0                  ; 1   and its quotient word is zero
        st      r4, [sp, r5]            ; 6
        add     lr, lr, #-16            ; 1
        br      ne, lr, #0, .word       ; 3+1
        jmp     .wend                   ; 3
.wbits:
        lsr     r5, lr, #3              ; 1
        ld      r4, [sp, r5]            ; 5   the word to feed in, in r4
.bits:
        ; R:w <<= 1.  Unlike the narrow loop's, 2R cannot overflow: R is
        ; what is left of the dividend's bits above w's next, which are at
        ; most n >> 1 and below 2^63, so R's top bit is always clear.
        shl     r3, r3, #1              ; 1
        lsr     r5, r2, #15             ; 1
        or      r3, r3, r5              ; 1
        shl     r2, r2, #1              ; 1
        lsr     r5, r1, #15             ; 1
        or      r2, r2, r5              ; 1
        shl     r1, r1, #1              ; 1
        lsr     r5, r0, #15             ; 1
        or      r1, r1, r5              ; 1
        shl     r0, r0, #1              ; 1
        lsr     r5, r4, #15             ; 1
        or      r0, r0, r5              ; 1
        shl     r4, r4, #1              ; 1
        ld      r5, [sp, #16]           ; 5   R >= d, from the top word down
        br      hi, r3, r5, .sub        ; 3+1
        br      lo, r3, r5, .next       ; 3+1
        ld      r5, [sp, #14]           ; 5
        br      hi, r2, r5, .sub        ; 3+1
        br      lo, r2, r5, .next       ; 3+1
        ld      r5, [sp, #12]           ; 5
        br      hi, r1, r5, .sub        ; 3+1
        br      lo, r1, r5, .next       ; 3+1
        ld      r5, [sp, #10]           ; 5
        br      lo, r0, r5, .next       ; 3+1
.sub:
        ; R -= d.  A borrow decrements the words above it, and a word that
        ; was zero passes it on - it becomes 0xffff, which is then never below
        ; its own word of d, so no word ever borrows twice.
        ld      r5, [sp, #10]           ; 5
        br      hs, r0, r5, .s0         ; 3+1
        br      ne, r1, #0, .t1         ; 3+1
        br      ne, r2, #0, .t2         ; 3+1
        sub     r3, r3, #1              ; 1
.t2:
        sub     r2, r2, #1              ; 1
.t1:
        sub     r1, r1, #1              ; 1
.s0:
        rsb     r0, r5, r0              ; 1
        ld      r5, [sp, #12]           ; 5
        br      hs, r1, r5, .s1         ; 3+1
        br      ne, r2, #0, .u2         ; 3+1
        sub     r3, r3, #1              ; 1
.u2:
        sub     r2, r2, #1              ; 1
.s1:
        rsb     r1, r5, r1              ; 1
        ld      r5, [sp, #14]           ; 5
        br      hs, r2, r5, .s2         ; 3+1
        sub     r3, r3, #1              ; 1
.s2:
        rsb     r2, r5, r2              ; 1
        ld      r5, [sp, #16]           ; 5
        rsb     r3, r5, r3              ; 1
        add     r4, r4, #1              ; 1   quotient bit
.next:
        add     lr, lr, #-1             ; 1
        brclr   lr, #0x000f, .wdone     ; 1
        jmpr    .bits                   ; 3
.wdone:
        lsr     r5, lr, #3              ; 1   the word just finished is
        add     r5, r5, #2              ; 1   one above lr / 8 now
        st      r4, [sp, r5]            ; 6   its quotient word
        br      eq, lr, #0, .wend       ; 3+1 the loop is longer than a
        jmp     .word                   ; 3   branch reaches
.wend:
        ld      r5, [sp, #18]           ; 5   p: R is the remainder
        st      r0, [r5, #0]            ; 6
        st      r1, [r5, #2]            ; 6
        st      r2, [r5, #4]            ; 6
        st      r3, [r5, #6]            ; 6
        ld      r0, [sp, #2]            ; 5   and the quotient
        ld      r1, [sp, #4]            ; 5
        ld      r2, [sp, #6]            ; 5
        ld      r3, [sp, #8]            ; 5
        add     sp, sp, #20             ; 1
        pop     lr, r4                  ; 7
        ret                             ; 4

; ============================================================================
; __udivdi3 and __umoddi3 - into the core, and out again
; ============================================================================
; __udivdi3 is a tail call: the core keeps r4 and returns the quotient where
; the caller wants it.  __umoddi3 finds the remainder in its own arguments.

__udivdi3:
        mov     r5, sp                  ; 1
        jmp     __udivmoddi4.core       ; 3

__umoddi3:
        mov     r5, sp                  ; 1
        push    lr                      ; 6
        call    __udivmoddi4.core       ; 3
        pop     lr                      ; 5
        ld      r0, [sp, #0]            ; 5
        ld      r1, [sp, #2]            ; 5
        ld      r2, [sp, #4]            ; 5
        ld      r3, [sp, #6]            ; 5
        ret                             ; 4

; ============================================================================
; __divmoddi4, __divdi3 and __moddi3 - the magnitudes divide
; ============================================================================
; C truncates a quotient towards zero and gives the remainder the dividend's
; sign, so the core divides |n| by |d| and .signed puts the signs back: the
; quotient negative when exactly one operand was, the remainder when n was.
; .signed has the core's convention, and both results are fixed every time -
; a few dozen cycles that __divdi3 and __moddi3 each spend on the other's,
; for one copy of all of it.
;
; The signs ride in r4, which the core keeps: bit 15 is n's and bit 14 the
; quotient's.  -2^63 has no positive counterpart, but its magnitude is 2^63
; unsigned, which is what the core wants.

__divmoddi4:
        mov     r5, sp                  ; 1
        push    lr                      ; 6
        call    .signed                 ; 3
        ld      r5, [sp, #10]           ; 5   rp
        br      eq, r5, #0, .norp       ; 1
        ld      lr, [sp, #2]            ; 5
        st      lr, [r5, #0]            ; 6
        ld      lr, [sp, #4]            ; 5
        st      lr, [r5, #2]            ; 6
        ld      lr, [sp, #6]            ; 5
        st      lr, [r5, #4]            ; 6
        ld      lr, [sp, #8]            ; 5
        st      lr, [r5, #6]            ; 6
.norp:
        pop     lr                      ; 5
        ret                             ; 4

.signed:
        push    r4, lr, r5              ; 10  [sp]: p, lr, r4
        ld      lr, [r5, #6]            ; 5   d3
        xor     lr, lr, r3              ; 1   the quotient's sign ...
        lsr     lr, lr, #1              ; 1   ... to bit 14
        mov     r4, r3                  ; 1
        and     r4, r4, #0x8000         ; 1   n's in bit 15
        or      r4, r4, lr              ; 1
        brclr   r3, #0x8000, .npos      ; 3+1
        call    .neg                    ; 3   |n|
.npos:
        push    r3, r2, r1              ; 10  |n|, while d is fetched
        push    r0                      ; 6
        ld      r0, [r5, #0]            ; 5
        ld      r1, [r5, #2]            ; 5
        ld      r2, [r5, #4]            ; 5
        ld      r3, [r5, #6]            ; 5
        brclr   r3, #0x8000, .dpos      ; 3+1
        call    .neg                    ; 3   |d|
.dpos:
        push    r3, r2, r1              ; 10  |d| below |n|, where the core
        push    r0                      ; 6   can have it
        ld      r0, [sp, #8]            ; 5
        ld      r1, [sp, #10]           ; 5
        ld      r2, [sp, #12]           ; 5
        ld      r3, [sp, #14]           ; 5
        mov     r5, sp                  ; 1
        call    __udivmoddi4.core       ; 3
        brclr   r4, #0x4000, .qpos      ; 3+1
        call    .neg                    ; 3
.qpos:
        st      r0, [sp, #8]            ; 6   the quotient over |n|, and the
        st      r1, [sp, #10]           ; 6   remainder out of |d|'s slots
        st      r2, [sp, #12]           ; 6
        st      r3, [sp, #14]           ; 6
        ld      r0, [sp, #0]            ; 5
        ld      r1, [sp, #2]            ; 5
        ld      r2, [sp, #4]            ; 5
        ld      r3, [sp, #6]            ; 5
        brclr   r4, #0x8000, .rpos      ; 3+1
        call    .neg                    ; 3
.rpos:
        ld      r5, [sp, #16]           ; 5   p
        st      r0, [r5, #0]            ; 6
        st      r1, [r5, #2]            ; 6
        st      r2, [r5, #4]            ; 6
        st      r3, [r5, #6]            ; 6
        ld      r0, [sp, #8]            ; 5
        ld      r1, [sp, #10]           ; 5
        ld      r2, [sp, #12]           ; 5
        ld      r3, [sp, #14]           ; 5
        add     sp, sp, #18             ; 1
        pop     lr, r4                  ; 7
        ret                             ; 4

; r0:r1:r2:r3 = -(r0:r1:r2:r3): every bit inverted, and one added, carried
; up only as far as a word that did not wrap to zero.
.neg:
        xor     r0, r0, #-1             ; 1
        xor     r1, r1, #-1             ; 1
        xor     r2, r2, #-1             ; 1
        xor     r3, r3, #-1             ; 1
        add     r0, r0, #1              ; 1
        br      ne, r0, #0, .negd       ; 3+1
        add     r1, r1, #1              ; 1
        br      ne, r1, #0, .negd       ; 3+1
        add     r2, r2, #1              ; 1
        br      ne, r2, #0, .negd       ; 3+1
        add     r3, r3, #1              ; 1
.negd:
        ret                             ; 4

__divdi3:
        mov     r5, sp                  ; 1
        jmp     __divmoddi4.signed      ; 3

__moddi3:
        mov     r5, sp                  ; 1
        push    lr                      ; 6
        call    __divmoddi4.signed      ; 3
        pop     lr                      ; 5
        ld      r0, [sp, #0]            ; 5
        ld      r1, [sp, #2]            ; 5
        ld      r2, [sp, #4]            ; 5
        ld      r3, [sp, #6]            ; 5
        ret                             ; 4

; ============================================================================
; The shifts by a variable count
; ============================================================================
;       __ashlsi3   __lshrsi3   __ashrsi3     32-bit value in r0:r1, count in r2
;       __ashldi3   __lshrdi3   __ashrdi3     64-bit value in r0:r1:r2:r3,
;                                             count on the stack at [sp]
;
; GCC calls the 32-bit ones at -Os - at -O2 it expands a two-word shift inline
; - and the 64-bit ones always.  The count is an int, so the 64-bit value fills
; every argument register and the count is the one stack argument.
;
; EVERY MACHINE SHIFT READS ONLY THE LOW FOUR BITS OF ITS COUNT, so a shift of
; a multi-word value is done in two stages.  The high bits of the count move
; whole words - bit 5 moves two of them, bit 4 one - which is register moves
; and nothing else.  Then the low four bits, n, shift every word by n and carry
; the n bits that cross each boundary into the neighbouring word.
;
; THE CROSSING BITS NEED A SHIFT BY 16 - n, and that is one `rsb` from #0, not
; from #16: only the low four bits of the distance are read, and those are the
; same for -n as for 16 - n.  #0 is imm5 and two bytes; #16 is three.  At n = 0
; the distance would read as 0 and the whole word would cross, so n = 0 is
; tested for first and returns - it is the whole-words-only case anyway.
;
; A COUNT OF THE VALUE'S WIDTH OR MORE is undefined in C.  These read only the
; bits a legal count can have, so 32 shifts a long by 0 rather than clearing it.
;
; The 32-bit ones take three argument registers, so r3 and r4 are callee saved
; there, and they touch neither: r0, r1, r2 and r5 are enough.  The 64-bit ones
; need two more registers than they own - one for 16 - n and one for the bits
; in transit - and borrow r4 and lr, which is one push and one pop.

__ashlsi3:
        brclr   r2, #0x0010, .lt16      ; 1   under 16: no whole word moves
        mov     r1, r0                  ; 1   pinned
        mov     r0, #0                  ; 1   pinned
.lt16:
        brclr   r2, #0x000f, .done      ; 2   a whole number of words
        rsb     r5, r2, #0              ; 1   16 - n, in the bits that count
        lsr     r5, r0, r5              ; 1   the bits crossing into the high
        shl     r1, r1, r2              ; 1
        or      r1, r1, r5              ; 1
        shl     r0, r0, r2              ; 1
.done:
        ret                             ; 4

__lshrsi3:
        brclr   r2, #0x0010, .lt16      ; 2
        mov     r0, r1                  ; 1   pinned
        mov     r1, #0                  ; 1
.lt16:
        brclr   r2, #0x000f, .done      ; 2
        rsb     r5, r2, #0              ; 1   16 - n
        shl     r5, r1, r5              ; 1   the bits crossing into the low
        lsr     r0, r0, r2              ; 1
        or      r0, r0, r5              ; 1
        lsr     r1, r1, r2              ; 1
.done:
        ret                             ; 4

__ashrsi3:
        brclr   r2, #0x0010, .lt16      ; 2
        mov     r0, r1                  ; 1   pinned
        asr     r1, r1, #15             ; 1   the sign, in every bit
.lt16:
        brclr   r2, #0x000f, .done      ; 2
        rsb     r5, r2, #0              ; 1   16 - n
        shl     r5, r1, r5              ; 1
        lsr     r0, r0, r2              ; 1   LOGICAL: the low word has no sign
        or      r0, r0, r5              ; 1
        asr     r1, r1, r2              ; 1
.done:
        ret                             ; 4

__ashldi3:
        ld      r5, [sp, #0]            ; 5   the count
        brclr   r5, #0x0020, .lt32      ; 2   whole words, two at a time ...
        mov     r3, r1                  ; 1
        mov     r2, r0                  ; 1
        mov     r0, #0                  ; 1   pinned
        mov     r1, r0                  ; 1   pinned
.lt32:
        brclr   r5, #0x0010, .lt16      ; 1   ... then one
        mov     r3, r2                  ; 1
        mov     r2, r1                  ; 1
        mov     r1, r0                  ; 1   pinned
        mov     r0, #0                  ; 1   pinned
.lt16:
        brclr   r5, #0x000f, .done      ; 2
        push    r4, lr                  ; 8
        rsb     r4, r5, #0              ; 1   16 - n
        shl     r3, r3, r5              ; 1   top word first, while the word
        lsr     lr, r2, r4              ; 1   below it is still unshifted
        or      r3, r3, lr              ; 1
        shl     r2, r2, r5              ; 1
        lsr     lr, r1, r4              ; 1
        or      r2, r2, lr              ; 1
        shl     r1, r1, r5              ; 1
        lsr     lr, r0, r4              ; 1
        or      r1, r1, lr              ; 1
        shl     r0, r0, r5              ; 1
        pop     lr, r4                  ; 7
.done:
        ret                             ; 4

__lshrdi3:
        ld      r5, [sp, #0]            ; 5
        brclr   r5, #0x0020, .lt32      ; 2
        mov     r0, r2                  ; 1
        mov     r1, r3                  ; 1
        mov     r2, #0                  ; 1
        mov     r3, r2                  ; 1
.lt32:
        brclr   r5, #0x0010, .lt16      ; 1
        mov     r0, r1                  ; 1   pinned
        mov     r1, r2                  ; 1
        mov     r2, r3                  ; 1
        mov     r3, #0                  ; 1
.lt16:
        brclr   r5, #0x000f, .done      ; 1
        push    r4, lr                  ; 8
        rsb     r4, r5, #0              ; 1   16 - n
        lsr     r0, r0, r5              ; 1   bottom word first, while the
        shl     lr, r1, r4              ; 1   word above it is unshifted
        or      r0, r0, lr              ; 1
        lsr     r1, r1, r5              ; 1
        shl     lr, r2, r4              ; 1
        or      r1, r1, lr              ; 1
        lsr     r2, r2, r5              ; 1
        shl     lr, r3, r4              ; 1
        or      r2, r2, lr              ; 1
        lsr     r3, r3, r5              ; 1
        pop     lr, r4                  ; 7
.done:
        ret                             ; 4

__ashrdi3:
        ld      r5, [sp, #0]            ; 5
        brclr   r5, #0x0020, .lt32      ; 1
        mov     r0, r2                  ; 1
        mov     r1, r3                  ; 1
        asr     r3, r3, #15             ; 1   the sign, in every bit ...
        mov     r2, r3                  ; 1   ... of both top words
.lt32:
        brclr   r5, #0x0010, .lt16      ; 2
        mov     r0, r1                  ; 1   pinned
        mov     r1, r2                  ; 1
        mov     r2, r3                  ; 1
        asr     r3, r3, #15             ; 1
.lt16:
        brclr   r5, #0x000f, .done      ; 2
        push    r4, lr                  ; 8
        rsb     r4, r5, #0              ; 1   16 - n
        lsr     r0, r0, r5              ; 1
        shl     lr, r1, r4              ; 1
        or      r0, r0, lr              ; 1
        lsr     r1, r1, r5              ; 1
        shl     lr, r2, r4              ; 1
        or      r1, r1, lr              ; 1
        lsr     r2, r2, r5              ; 1
        shl     lr, r3, r4              ; 1
        or      r2, r2, lr              ; 1
        asr     r3, r3, r5              ; 1   only the top word is signed
        pop     lr, r4                  ; 7
.done:
        ret                             ; 4
