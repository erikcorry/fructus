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
; which it does, with __umulsidi3 for 32 x 32 -> 64 as well.  With -mmul a
; 16 x 16 -> 32 is two instructions inline, and the wider products call the
; `_mul' routines instead, which are built from the multiplier - see WITH
; THE MULTIPLIER below.
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
; With -mmul gcc calls `_mul' versions of every one of these instead:
; __udivmodhi4_mul and its four wrappers, __udivmodsi4_mul and four 32-bit
; helpers - so that 32-bit division is assembly too, there - and the six
; 64-bit ones, all built on recip.  Like the products' `_mul' routines they
; are separate names because this library is built once, without -mmul, and
; has to run on a part with no multiplier.
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
        push    r2, r3, lr              ; 7
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
        pop     lr, r3, r2              ; 6
        ret                             ; 4
.narrow:
        push    lr                      ; 5
        call    __mulhi3.sorted         ; 3   past the comparison already made
        pop     lr                      ; 4
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
        push    r2, r3, lr              ; 7
        mov     r2, r0                  ; 1   keep a
        mov     r3, r1                  ; 1   keep b
        call    __umulhisi3             ; 3   r0:r1 = low:high, unsigned
        brclr   r2, #0x8000, .a_pos     ; 2   a negative?
        rsb     r1, r3, r1              ; 1   high -= b
.a_pos:
        brclr   r3, #0x8000, .b_pos     ; 1   b negative?
        rsb     r1, r2, r1              ; 1   high -= a
.b_pos:
        pop     lr, r3, r2              ; 6
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
; ONE PUSH, NOT TWO.  A three-register push is seven cycles and two bytes
; where pushing two and then one is eleven cycles and four - a push stops the
; pipeline for four cycles beyond its words however many registers it carries,
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
        push    r4, lr, r0              ; 7   one push, not two:
                                        ;     al ends up lowest, so [sp] finds it
        mov     r0, r2                  ; 1   bl * ah, with ah already in r1
        call    __mulhi3                ; 3
        mov     r4, r0                  ; 1
        ld      r0, [sp]                ; 4   al back, but leave it there
        mov     r1, r3                  ; 1   al * bh
        call    __mulhi3                ; 3
        add     r4, r4, r0              ; 1   the two cross terms
        pop     r0                      ; 4   al, for the last time
        mov     r1, r2                  ; 1   al * bl, widened
        call    __umulhisi3             ; 3
        add     r1, r1, r4              ; 1   fold the cross terms into the high
        pop     lr, r4                  ; 5
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
        push    r4, lr, r1              ; 7   r4, lr, ah      ah lowest
        push    r0, r3, r2              ; 7   al, bh, bl      bl lowest
        add     sp, sp, #-2             ; 1   and a slot for w0
        ;      w0(0)  bl(2)  bh(4)  al(6)  ah(8)  lr(10)  r4(12)

        ; --- P1 = al * bh ---------------------------------------------------
        ld      r0, [sp, #6]            ; 4
        ld      r1, [sp, #4]            ; 4
        call    __umulhisi3             ; 3
        mov     r2, r1                  ; 1   X.hi
        mov     r3, r0                  ; 1   X.lo

        ; --- P2 = ah * bl, and X = P1 + P2 ----------------------------------
        ld      r0, [sp, #8]            ; 4
        ld      r1, [sp, #2]            ; 4
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
        ld      r0, [sp, #6]            ; 4
        ld      r1, [sp, #2]            ; 4
        call    __umulhisi3             ; 3
        st      r0, [sp, #0]            ; 5   w0 is finished
        add     r3, r3, r1              ; 1   w1 = X.lo + P0.hi
        br      hs, r3, r1, .nc3        ; 1
        add     r2, r2, #1              ; 1   k1 into X.hi ...
        br      ne, r2, #0, .nc3        ; 2   ... which CAN wrap
        add     r4, r4, #1              ; 1
.nc3:

        ; --- P3 = ah * bh ---------------------------------------------------
        ld      r0, [sp, #8]            ; 4
        ld      r1, [sp, #4]            ; 4
        call    __umulhisi3             ; 3
        add     r2, r2, r0              ; 1   w2 = X.hi + k1 + P3.lo
        br      hs, r2, r0, .nc4        ; 2
        add     r4, r4, #1              ; 1
.nc4:
        add     r4, r4, r1              ; 1   w3 = P3.hi + cx + k2

        ; --- place the four words and unwind --------------------------------
        mov     r1, r3                  ; 1   w1; w2 is in r2 already
        mov     r3, r4                  ; 1   w3, before the pop restores r4
        ld      r0, [sp, #0]            ; 4   w0
        add     sp, sp, #10             ; 1
        pop     lr, r4                  ; 5
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
; mul is the low half of a 16 x 16 product and mulhu the high, so a part with
; a multiplier makes a 16 x 16 -> 32 in two instructions, and gcc puts those
; inline.  Anything wider still has helpers - just much faster ones.  They
; have names of their own rather than replacing the routines above: this
; library is built once, without -mmul, and has to run on a part without
; one.  A program built with -mmul calls these; --gc-sections drops the rest.
;
;       __mulsi3_mul        32 x 32 -> 32            13 bytes  14 cycles
;       __umulsidi3_mul     32 x 32 -> 64 unsigned   83 bytes  15, or 54 on average
;
; and __muldi3_mul, in C on top of them, in the GCC tree's
; libgcc/config/fructus/lib2mul.c.  The cycles are from entry to the return.
; __mulsi3_mul never branches; __umulsidi3_mul is 15 when both high words
; are zero, and 54 is its mean over random full-width operands.

; ============================================================================
; __mulsi3_mul - 32 x 32 -> 32, signed or unsigned, with mul         13 bytes
; ============================================================================
;       a in r0:r1 as low:high          b in r2:r3 as low:high
;       result in r0:r1 as low:high
;
;       (ah:al) * (bh:bl)  =  al*bl  +  ((al*bh + ah*bl) << 16)
;
; The cross terms are wanted only to sixteen bits, which is two plain muls;
; al*bl is wanted whole, which is mul and mulhu.  gcc -O2 puts the same
; inline.

__mulsi3_mul:
        mul     r3, r3, r0              ; 2   bh*al
        mul     r1, r1, r2              ; 2   ah*bl
        add     r1, r1, r3              ; 1   the cross terms
        mulhu   r3, r0, r2              ; 2   al*bl, high
        add     r1, r1, r3              ; 1   hi
        mul     r0, r0, r2              ; 2   lo
        ret                             ; 4


; ============================================================================
; __umulsidi3_mul - 32 x 32 -> 64, unsigned, with mul                83 bytes
; ============================================================================
;       a in r0:r1 as low:high          b in r2:r3 as low:high
;       result w0..w3 in r0..r3, lowest first
;
; Four 16 x 16 -> 32 products, P0 = al*bl, P1 = al*bh, P2 = ah*bl and
; P3 = ah*bh, each a mul and a mulhu, summed by columns:
;
;       w0 = P0.lo
;       w1 = P0.hi + P1.lo + P2.lo                carry into w2
;       w2 = P1.hi + P2.hi + P3.lo + carries      carry into w3
;       w3 = P3.hi + carries                      which cannot overflow
;
; A CARRY IS A COMPARE AND A BRANCH: the sum is below an addend exactly when
; it wrapped.  The branch goes to the carry, out of line, so that no carry
; is a branch not taken - one or two cycles against four.  Between random
; 32-bit operands a carry is about as likely as not, and this is still 54
; cycles on average against 56 the other way round; between operands whose
; high words are small, a carry is rare and the difference larger.
;
; Each of a and b is read by two products and dies after its second, and the
; products are ordered so that seven registers suffice - r4 and lr, saved,
; beside the five this owns.

__umulsidi3_mul:
        or      r5, r1, r3              ; 1   ah | bh
        br      eq, r5, #0, .narrow     ; 2   both zero: it is a 16 x 16
        push    r4, lr                  ; 6
        mulhu   r4, r0, r3              ; 2   w2 = P1.hi
        mul     r5, r0, r3              ; 2   w1 = P1.lo
        mul     lr, r1, r3              ; 2   P3.lo
        mulhu   r3, r1, r3              ; 2   w3 = P3.hi; bh is dead
        add     r4, r4, lr              ; 1   w2 += P3.lo
        br      lo, r4, lr, .k1         ; 1   a carry: out of line
.r1:
        mulhu   lr, r1, r2              ; 2   P2.hi
        mul     r1, r1, r2              ; 2   P2.lo; ah is dead
        add     r4, r4, lr              ; 1   w2 += P2.hi
        br      lo, r4, lr, .k2         ; 2
.r2:
        add     r5, r5, r1              ; 1   w1 += P2.lo
        br      lo, r5, r1, .k3         ; 1
.r3:
        mulhu   r1, r0, r2              ; 2   P0.hi
        mul     r0, r0, r2              ; 2   w0 = P0.lo
        add     r1, r5, r1              ; 1   w1 += P0.hi
        br      lo, r1, r5, .k4         ; 2
.r4:
        mov     r2, r4                  ; 1   w2
        pop     lr, r4                  ; 5
        ret                             ; 4

; The carries.  One into w2 can wrap w2 in turn, and then it carries on into
; w3, which itself cannot overflow: the product fits in 64 bits.
.k1:
        add     r3, r3, #1
        jmpr    .r1
.k2:
        add     r3, r3, #1
        jmpr    .r2
.k3:
        add     r4, r4, #1
        br      ne, r4, #0, .r3
        add     r3, r3, #1
        jmpr    .r3
.k4:
        add     r4, r4, #1
        br      ne, r4, #0, .r4
        add     r3, r3, #1
        jmpr    .r4

.narrow:
        mulhu   r1, r0, r2              ; 2   al*bl, high
        mul     r0, r0, r2              ; 2   and low
        mov     r2, #0                  ; 1   w2
        mov     r3, r2                  ; 1   w3
        ret                             ; 4

; ============================================================================
; __udivmodhi4 - 16 / 16 -> quotient and remainder, unsigned
; ============================================================================
;       a in r0, b in r1        ->      quotient in r0, remainder in r1
;
; Two arguments and a 32-bit result, so by isa/abi.s this owns r0, r1 and r5
; and must give back r2, r3 and r4 - which is why the general loop, needing a
; fourth register, borrows r2 - five cycles to push it and four to pop it.
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
        push    r2                      ; 5   the fourth register, the quotient
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
        pop     r2                      ; 4
        ret                             ; 4
.smaller:
        mov     r1, r0                  ; 1   pinned
        mov     r0, #0                  ; 1   pinned
        ret                             ; 4

; ============================================================================
; __udivmodhi4_mul - 16 / 16 -> quotient and remainder, unsigned, -mmul version
; ============================================================================
;       a in r0, b in r1        ->      quotient in r0, remainder in r1
;
; Two arguments and a 32-bit result, so by isa/abi.s this owns r0, r1 and r5
; and must give back r2, r3 and r4.
; This version is picked when using -mmul, which means the CPU has mul and
; recip instructions.
;
; The quotient estimate is never too big and at most one too small, over
; every 16-bit a and b, so one unsigned compare finishes it.  Division by
; zero returns junk and does not hang.
;
; We make use of the fact that losing a bit of the reciprocal will never
; put us in a situation where we need more than one fixup.  So making the
; implicit top bit explicit is the easiest solution for this non-widening
; div routine.  Throwing away this bit makes the result a tiny bit
; smaller so we have to do a few more fixups, but the effect is small.
__udivmodhi4_mul:
        mov r5, #10                     ; Not one of the available immediates.
        br eq, r1, r5, .ten             ; Common enough to special case.
        ; Recip takes an argument that is normalized to have a 1 in the high
        ; bit and returns its reciprocal, as defined by Möller and Granlund.
        push lr                         ; 5   We need one more register
        clz r5, r1                      ; 2   Bits to shift away
        shl lr, r1, r5                  ; 1   Normalize
        recip lr, lr                    ; 5   Reciprocal
        lsr lr, lr, #1                  ; 1   The reciprocal has an implicit 1
                                        ;     in bit 16, so shift down...
        or lr, lr, #0x8000              ; 1   ... and make the top bit explicit
        mulhu lr, lr, r0                ; 2   Multiply a by 1/b, get high part
        rsb r5, r5, #15                 ; 1   We are going to shift 16-n, but
                                        ;     one less because we lsr'ed 1.
        lsr lr, lr, r5                  ; 1   Undo normalization
        mul r5, lr, r1                  ; 2   Multiply answer with divisor
        rsb r0, r5, r0                  ; 1   Remainder in r0: a is dead now
        br hs, r0, r1, .adjust          ; 1   Unsigned, and rarely taken
        mov r1, r0                      ; 1   Put remainder in r1
        mov r0, lr                      ; 1   Put result in r0
        pop lr                          ; 4
        ret                             ; 4
.adjust:
        rsb r1, r1, r0                  ; 1   Subtract one divisor from remainder
        add r0, lr, #1                  ; 1   Increase answer by one.
        pop lr                          ; 4
        ret                             ; 4
.ten:
        or      r1, r0, #0              ; 1
        mov     r0, #0xcccd             ; 1 or 2
        mulhu   r0, r1, r0              ; 2
        lsr     r0, r0, #3              ; 1
        mul     r5, r0, #10             ; 2
        rsb     r1, r5, r1              ; 1
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
        push    lr                      ; 5
        call    __udivmodhi4            ; 3
        mov     r0, r1                  ; 1   the remainder, pinned
        pop     lr                      ; 4
        ret                             ; 4

; C rounds a signed quotient TOWARDS ZERO, so the magnitudes divide and the
; sign goes back on after: negative exactly when the operands' signs differ,
; which is the top bit of a ^ b.
__divhi3:
        push    lr, r2                  ; 6
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
        pop     r2, lr                  ; 5
        ret                             ; 4

; And a remainder takes the sign of the DIVIDEND, so that a == (a/b)*b + a%b.
__modhi3:
        push    lr, r2                  ; 6
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
        pop     r2, lr                  ; 5
        ret                             ; 4

; ============================================================================
; The same four with recip, for -mmul
; ============================================================================
; The wrappers above, around __udivmodhi4_mul instead.  It uses r0, r1, r5
; and a saved lr, so r2 is free to carry a sign across the call here too.

__udivhi3_mul:
        jmp     __udivmodhi4_mul        ; 3

__umodhi3_mul:
        push    lr                      ; 5
        call    __udivmodhi4_mul        ; 3
        mov     r0, r1                  ; 1   the remainder, pinned
        pop     lr                      ; 4
        ret                             ; 4

__divhi3_mul:
        push    lr, r2                  ; 6
        xor     r2, r0, r1              ; 1   bit 15 is the quotient's sign
        br      ge, r0, #0, .a_pos      ; 3+1
        rsb     r0, r0, #0              ; 1   |a|
.a_pos:
        br      ge, r1, #0, .b_pos      ; 3+1
        rsb     r1, r1, #0              ; 1   |b|
.b_pos:
        call    __udivmodhi4_mul        ; 3
        br      ge, r2, #0, .pos        ; 3+1
        rsb     r0, r0, #0              ; 1
.pos:
        pop     r2, lr                  ; 5
        ret                             ; 4

__modhi3_mul:
        push    lr, r2                  ; 6
        mov     r2, r0                  ; 1   keep a, for its sign
        br      ge, r0, #0, .a_pos      ; 3+1
        rsb     r0, r0, #0              ; 1   |a|
.a_pos:
        br      ge, r1, #0, .b_pos      ; 3+1
        rsb     r1, r1, #0              ; 1   |b|
.b_pos:
        call    __udivmodhi4_mul        ; 3
        mov     r0, r1                  ; 1   the remainder, pinned
        br      ge, r2, #0, .pos        ; 3+1
        rsb     r0, r0, #0              ; 1
.pos:
        pop     r2, lr                  ; 5
        ret                             ; 4

; ============================================================================
; __udivmodsi4_mul - 32 / 32 -> quotient and remainder, unsigned, with recip
; ============================================================================
;       n in r0:r1, d in r2:r3          ->      quotient in r0:r1,
;                                               remainder in r2:r3
;
; Both results in one 64-bit return, which is what gcc -mmul registers as
; the SImode udivmod libfunc: `x / y' and `x % y' on a long are one call.
; Four argument registers, so this owns r0-r3 and r5, and saves r4 and lr.
;
; IT IS LONG DIVISION IN BASE 65536, a quotient word per step, each step
; Moller and Granlund's division by an invariant integer: a multiply by the
; divisor's reciprocal, which recip makes, and a correction.  The divisor is
; first shifted until its top bit is set, and the dividend with it.
;
; A DIVISOR UNDER 65536 is their 2/1 division, two steps: the dividend's high
; word, and then the remainder with the low word below it.
;
;       q1:q0 = v * u1 + u1:u0      q1 += 1      r = u0 - q1 * d
;       if (r > q0)  q1 -= 1, r += d    and rarely, if (r >= d) once more
;
; all mod 65536.  q1 + 1 is too big 62% of the time, so that correction is
; the fall-through and its absence the branch.  The first step is skipped
; when the dividend's high word is below d, so a 16-bit dividend in a long
; costs one step.
;
; A DIVISOR OF 65536 OR MORE leaves a quotient of one word, which is their
; 3/2 division: one step, with the reciprocal of both of the divisor's words.
; recip makes the 2/1 reciprocal of the high word, and their Algorithm 6
; folds the low word into it with one more product and two rare corrections;
; it needs three registers where two are free, so u0 waits on the stack.
; A high word of n below d's is a quotient of 0, and is tested first.
;
; DIVISION BY ZERO returns junk and does not hang: there is no loop.

__udivmodsi4_mul:
        br      ne, r3, #0, .wide       ; 1
        ; --- d < 65536 -------------------------------------------------------
        clz     r5, r2                  ; 2   s
        push    r4, lr, r5              ; 7   s, for the remainder, at [sp]
        shl     r2, r2, r5              ; 1   d, normalised
        rsb     lr, r5, #15             ; 1   15 - s: a shift by 16 - s is
        lsr     r4, r1, #1              ; 1   two, since 16 would read as 0
        lsr     r4, r4, lr              ; 1   u2
        lsr     r3, r0, #1              ; 1
        lsr     r3, r3, lr              ; 1
        shl     r1, r1, r5              ; 1
        or      r1, r1, r3              ; 1   u1
        shl     r0, r0, r5              ; 1   u0
        recip   r3, r2                  ; 5   v
        br      ne, r4, #0, .hi         ; 1   u2:u1 >= d: a high quotient
        br      hs, r1, r2, .hi         ; 1   word to make first
        mov     lr, #0                  ; 1   otherwise it is 0, and u1 is
        mov     r4, r1                  ; 1   what is left over
.lo:    ; (r4:r0) / r2  ->  quotient r1, remainder r4
        mulhu   r1, r3, r4              ; 2
        mul     r5, r3, r4              ; 2
        add     r5, r5, r0              ; 1   q0
        add     r1, r1, r4              ; 1
        add     r1, r1, #1              ; 1   q1 + 1
        br      hs, r5, r0, .lc         ; 1   no carry out of q0
        add     r1, r1, #1              ; 1
.lc:
        mul     r4, r1, r2              ; 2
        rsb     r4, r4, r0              ; 1   r = u0 - q1 * d
        br      ls, r4, r5, .lk         ; 1   r <= q0: q1 stands
        sub     r1, r1, #1              ; 1
        add     r4, r4, r2              ; 1
.lk:
        br      hs, r4, r2, .lg         ; 1   rare
.ld:
        pop     r5                      ; 4   s
        lsr     r2, r4, r5              ; 1   the remainder
        mov     r3, #0                  ; 1
        mov     r0, r1                  ; 1   pinned
        mov     r1, lr                  ; 1
        pop     lr, r4                  ; 5
        ret                             ; 4
.lg:
        add     r1, r1, #1              ; 1
        rsb     r4, r2, r4              ; 1
        jmpr    .ld                     ; 3
.hi:    ; (r4:r1) / r2  ->  quotient lr, remainder r4
        mulhu   lr, r3, r4              ; 2
        mul     r5, r3, r4              ; 2
        add     r5, r5, r1              ; 1
        add     lr, lr, r4              ; 1
        add     lr, lr, #1              ; 1
        br      hs, r5, r1, .hc         ; 1
        add     lr, lr, #1              ; 1
.hc:
        mul     r4, lr, r2              ; 2
        rsb     r4, r4, r1              ; 1
        br      ls, r4, r5, .hk         ; 1
        sub     lr, lr, #1              ; 1
        add     r4, r4, r2              ; 1
.hk:
        br      lo, r4, r2, .lo         ; 1
        add     lr, lr, #1              ; 1
        rsb     r4, r2, r4              ; 1
        jmpr    .lo                     ; 3

.less:
        mov     r2, r0                  ; 1
        mov     r3, r1                  ; 1
        mov     r0, #0                  ; 1   pinned
        mov     r1, r0                  ; 1   pinned
        ret                             ; 4

        ; --- d >= 65536: one quotient word -----------------------------------
.wide:
        br      lo, r1, r3, .less       ; 1   n < d
        clz     r5, r3                  ; 2   s
        push    r4, lr, r5              ; 7   s at [sp]
        mov     r4, #0                  ; 1   u2, if d is normalised already
        br      eq, r5, #0, .go         ; 1
        rsb     lr, r5, #0              ; 1   16 - s, in the bits that count
        shl     r3, r3, r5              ; 1
        lsr     r4, r2, lr              ; 1
        or      r3, r3, r4              ; 1   d1
        shl     r2, r2, r5              ; 1   d0
        lsr     r4, r1, lr              ; 1   u2
        shl     r1, r1, r5              ; 1
        lsr     lr, r0, lr              ; 1
        or      r1, r1, lr              ; 1   u1
        shl     r0, r0, r5              ; 1   u0
.go:    ; v, the 3/2 reciprocal: d1's, with d0 folded in - Algorithm 6
        push    r0                      ; 5   u0, for a register
        recip   lr, r3                  ; 5   v from d1 alone
        mul     r5, r3, lr              ; 2   p = d1 * v + d0, mod 65536
        add     r5, r5, r2              ; 1
        br      hs, r5, r2, .va         ; 1   no carry, 37%
        sub     lr, lr, #1              ; 1
        br      hs, r5, r3, .ve         ; 1   p >= d1, rarely
.vb:
        rsb     r5, r3, r5              ; 1   p -= d1
.va:
        mulhu   r0, lr, r2              ; 2   t1
        add     r5, r5, r0              ; 1   p += t1
        br      lo, r5, r0, .vf         ; 1   a carry, 29%
.vc:
        pop     r0                      ; 4
        mulhu   r5, lr, r4              ; 2
        mul     lr, lr, r4              ; 2
        add     lr, lr, r1              ; 1   q0
        add     r5, r5, r4              ; 1   q1; u2 is dead
        br      hs, lr, r1, .wc         ; 1
        add     r5, r5, #1              ; 1
.wc:
        mul     r4, r5, r3              ; 2
        rsb     r1, r4, r1              ; 1   r1 = u1 - q1 * d1
        mulhu   r4, r5, r2              ; 2
        rsb     r1, r4, r1              ; 1   r1:r0 = r1:u0 - q1 * d0 ...
        mul     r4, r5, r2              ; 2
        br      hs, r0, r4, .wb0        ; 1
        sub     r1, r1, #1              ; 1
.wb0:
        rsb     r0, r4, r0              ; 1
        br      hs, r0, r2, .wb1        ; 1   ... - d
        sub     r1, r1, #1              ; 1
.wb1:
        rsb     r0, r2, r0              ; 1
        rsb     r1, r3, r1              ; 1
        add     r5, r5, #1              ; 1   q1 + 1
        br      lo, r1, lr, .wk         ; 1   r1 < q0: q1 stands
        sub     r5, r5, #1              ; 1
        add     r0, r0, r2              ; 1   r += d
        add     r1, r1, r3              ; 1
        br      hs, r0, r2, .wk         ; 1
        add     r1, r1, #1              ; 1
.wk:
        br      lo, r1, r3, .wd         ; 1   r >= d is rare
        br      hi, r1, r3, .wg         ; 1
        br      hs, r0, r2, .wg         ; 1
.wd:
        mov     r4, r5                  ; 1   the quotient
        pop     r5                      ; 4   s
        rsb     lr, r5, #15             ; 1   r1:r0 >> s, with r1 << (16 - s)
        lsr     r2, r0, r5              ; 1   in two shifts as above
        shl     r3, r1, #1              ; 1
        shl     r3, r3, lr              ; 1
        or      r2, r2, r3              ; 1
        lsr     r3, r1, r5              ; 1
        mov     r0, r4                  ; 1
        mov     r1, #0                  ; 1
        pop     lr, r4                  ; 5
        ret                             ; 4
.wg:
        add     r5, r5, #1              ; 1
        br      hs, r0, r2, .wg1        ; 1
        sub     r1, r1, #1              ; 1
.wg1:
        rsb     r0, r2, r0              ; 1
        rsb     r1, r3, r1              ; 1
        jmpr    .wd                     ; 3
.ve:    ; the fold's rare cases: d0's carry with p >= d1 ...
        sub     lr, lr, #1              ; 1
        rsb     r5, r3, r5              ; 1
        jmp     .vb                     ; 3
.vf:   ; ... and t1's carry: v one less, or two if p:t0 >= d1:d0, t0 the
        sub     lr, lr, #1              ; 1   low half of the old v * d0
        br      hs, r5, r3, .vg         ; 1
        jmp     .vc                     ; 3
.vg:
        br      hi, r5, r3, .vg2        ; 1
        mul     r0, lr, r2              ; 2
        add     r0, r0, r2              ; 1   t0
        br      lo, r0, r2, .vc         ; 1
.vg2:
        sub     lr, lr, #1              ; 1
        jmp     .vc                     ; 3


; ============================================================================
; The 32-bit helpers GCC calls, with recip
; ============================================================================
; Four arguments, so r2 and r3 are the callee's: __udivsi3_mul is a tail
; call, and the signed pair carry their sign in r4, which they save.  The
; magnitudes divide and the signs go back on, as for 16 bits.

__udivsi3_mul:
        jmp     __udivmodsi4_mul        ; 3

__umodsi3_mul:
        push    lr                      ; 5
        call    __udivmodsi4_mul        ; 3
        mov     r0, r2                  ; 1
        mov     r1, r3                  ; 1
        pop     lr                      ; 4
        ret                             ; 4

__divsi3_mul:
        push    r4, lr                  ; 6
        xor     r4, r1, r3              ; 1   bit 15 is the quotient's sign
        br      ge, r1, #0, .a_pos      ; 3+1
        rsb     r0, r0, #0              ; 1   |a|: the low word negated, and
        xor     r1, r1, #-1             ; 1   the high one inverted, plus a
        br      ne, r0, #0, .a_pos      ; 1   carry when the low word is 0
        add     r1, r1, #1              ; 1
.a_pos:
        br      ge, r3, #0, .b_pos      ; 3+1
        rsb     r2, r2, #0              ; 1   |b|
        xor     r3, r3, #-1             ; 1
        br      ne, r2, #0, .b_pos      ; 1
        add     r3, r3, #1              ; 1
.b_pos:
        call    __udivmodsi4_mul        ; 3
        br      ge, r4, #0, .pos        ; 3+1
        rsb     r0, r0, #0              ; 1
        xor     r1, r1, #-1             ; 1
        br      ne, r0, #0, .pos        ; 1
        add     r1, r1, #1              ; 1
.pos:
        pop     lr, r4                  ; 5
        ret                             ; 4

__modsi3_mul:
        push    r4, lr                  ; 6
        mov     r4, r1                  ; 1   keep a's high word, for its sign
        br      ge, r1, #0, .a_pos      ; 3+1
        rsb     r0, r0, #0              ; 1   |a|
        xor     r1, r1, #-1             ; 1
        br      ne, r0, #0, .a_pos      ; 1
        add     r1, r1, #1              ; 1
.a_pos:
        br      ge, r3, #0, .b_pos      ; 3+1
        rsb     r2, r2, #0              ; 1   |b|
        xor     r3, r3, #-1             ; 1
        br      ne, r2, #0, .b_pos      ; 1
        add     r3, r3, #1              ; 1
.b_pos:
        call    __udivmodsi4_mul        ; 3
        mov     r0, r2                  ; 1   the remainder
        mov     r1, r3                  ; 1
        br      ge, r4, #0, .pos        ; 3+1
        rsb     r0, r0, #0              ; 1
        xor     r1, r1, #-1             ; 1
        br      ne, r0, #0, .pos        ; 1
        add     r1, r1, #1              ; 1
.pos:
        pop     lr, r4                  ; 5
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
;       divisor bits        1-16       17-32      33-48      49-64
;       here                1140-1200  2740-3120  1590-2010  690-990
;       -mmul, below        275-280    370-375    605-610    420
;       libgcc2.c's         ~4100      ~3000      ~3300      1600-2600
;
; The range is over the widths in each column, 30 dividends a width.  561
; bytes for all six, and 928 for the six with recip below, where libgcc2.c's
; were 2.3K to 3.2K EACH, before the 32-bit division, multiply and clz table
; they called.  A divisor of 17 to 32 bits is the slow case: 48 steps of the
; general loop, and a loop of its own with R in two registers would be about
; 80 bytes more.

__udivmoddi4:
        mov     r5, sp                  ; 1   d, which becomes the remainder
        push    lr                      ; 5
        call    .core                   ; 3
        ld      r5, [sp, #10]           ; 4   rp, past the pushed lr
        br      eq, r5, #0, .norp       ; 1
        ld      lr, [sp, #2]            ; 4
        st      lr, [r5, #0]            ; 5
        ld      lr, [sp, #4]            ; 4
        st      lr, [r5, #2]            ; 5
        ld      lr, [sp, #6]            ; 4
        st      lr, [r5, #4]            ; 5
        ld      lr, [sp, #8]            ; 4
        st      lr, [r5, #6]            ; 5
.norp:
        pop     lr                      ; 4
        ret                             ; 4

; --- the core -----------------------------------------------------------------
;       in:  r0:r1:r2:r3  n             r5  -> d, four words
;       out: r0:r1:r2:r3  n / d         [r5] n % d, over d          r4 kept
.core:
        push    r4, lr, r5              ; 7   [sp]: p, lr, r4
        ld      r4, [r5, #2]            ; 4   d1 | d2 | d3: under 65536?
        ld      lr, [r5, #4]            ; 4
        or      r4, r4, lr              ; 1
        ld      lr, [r5, #6]            ; 4
        or      r4, r4, lr              ; 1
        br      ne, r4, #0, .wide       ; 1

        ; --- d < 65536: R in r4 (zero already), d in r5 ------------------------
        ld      r5, [r5, #0]            ; 4   d
        push    r5                      ; 5   kept, for after each rotation
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
        ld      r5, [sp, #0]            ; 4   d again
        br      ne, lr, #0, .nword      ; 3+1
        ld      r5, [sp, #2]            ; 4   p: the remainder is R, and d's
        st      r4, [r5, #0]            ; 5   other words are zero already
        add     sp, sp, #4              ; 1
        pop     lr, r4                  ; 5
        ret                             ; 4

        ; --- the general case: R in r0-r3, the rest in the frame -------------
.wide:
        ld      r4, [r5, #6]            ; 4
        ld      lr, [r5, #4]            ; 4
        push    r4, lr                  ; 6   d3 d2
        ld      r4, [r5, #2]            ; 4
        ld      lr, [r5, #0]            ; 4
        push    r4, lr                  ; 6   d1 d0
        push    r3, r2, r1              ; 7
        push    r0                      ; 5
        ;      n0(0) n1(2) n2(4) n3(6) d0(8) d1(10) d2(12) d3(14) p(16)

        ; j = (m - 1) + leading zero words of n: the words that go in whole
        mov     r5, #3                  ; 1
        ld      r4, [sp, #14]           ; 4   d3
        br      ne, r4, #0, .m          ; 3+1
        mov     r5, #2                  ; 1
        ld      r4, [sp, #12]           ; 4   d2
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
        push    r5                      ; 5
        ;      T(0) n0(2) n1(4) n2(6) n3(8) d0(10) d1(12) d2(14) d3(16)
        ;      p(18) lr(20) r4(22)          word i at 2 + 2i, which is lr / 8
        mov     r0, #0                  ; 1   R
        mov     r1, r0                  ; 1
        mov     r2, r0                  ; 1
        mov     r3, r0                  ; 1
        mov     lr, #64                 ; 1
.word:
        ld      r4, [sp, #0]            ; 4   T
        br      ls, lr, r4, .wbits      ; 1
        lsr     r5, lr, #3              ; 1   this word goes into R whole
        mov     r3, r2                  ; 1
        mov     r2, r1                  ; 1
        mov     r1, r0                  ; 1
        ld      r0, [sp, r5]            ; 4
        mov     r4, #0                  ; 1   and its quotient word is zero
        st      r4, [sp, r5]            ; 5
        add     lr, lr, #-16            ; 1
        br      ne, lr, #0, .word       ; 3+1
        jmp     .wend                   ; 3
.wbits:
        lsr     r5, lr, #3              ; 1
        ld      r4, [sp, r5]            ; 4   the word to feed in, in r4
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
        ld      r5, [sp, #16]           ; 4   R >= d, from the top word down
        br      hi, r3, r5, .sub        ; 3+1
        br      lo, r3, r5, .next       ; 3+1
        ld      r5, [sp, #14]           ; 4
        br      hi, r2, r5, .sub        ; 3+1
        br      lo, r2, r5, .next       ; 3+1
        ld      r5, [sp, #12]           ; 4
        br      hi, r1, r5, .sub        ; 3+1
        br      lo, r1, r5, .next       ; 3+1
        ld      r5, [sp, #10]           ; 4
        br      lo, r0, r5, .next       ; 3+1
.sub:
        ; R -= d.  A borrow decrements the words above it, and a word that
        ; was zero passes it on - it becomes 0xffff, which is then never below
        ; its own word of d, so no word ever borrows twice.
        ld      r5, [sp, #10]           ; 4
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
        ld      r5, [sp, #12]           ; 4
        br      hs, r1, r5, .s1         ; 3+1
        br      ne, r2, #0, .u2         ; 3+1
        sub     r3, r3, #1              ; 1
.u2:
        sub     r2, r2, #1              ; 1
.s1:
        rsb     r1, r5, r1              ; 1
        ld      r5, [sp, #14]           ; 4
        br      hs, r2, r5, .s2         ; 3+1
        sub     r3, r3, #1              ; 1
.s2:
        rsb     r2, r5, r2              ; 1
        ld      r5, [sp, #16]           ; 4
        rsb     r3, r5, r3              ; 1
        add     r4, r4, #1              ; 1   quotient bit
.next:
        add     lr, lr, #-1             ; 1
        brclr   lr, #0x000f, .wdone     ; 1
        jmpr    .bits                   ; 3
.wdone:
        lsr     r5, lr, #3              ; 1   the word just finished is
        add     r5, r5, #2              ; 1   one above lr / 8 now
        st      r4, [sp, r5]            ; 5   its quotient word
        br      eq, lr, #0, .wend       ; 3+1 the loop is longer than a
        jmp     .word                   ; 3   branch reaches
.wend:
        ld      r5, [sp, #18]           ; 4   p: R is the remainder, stored
        stm     r0, r1, r2              ; 7   through it
        stm     r3                      ; 5
        pop     r0, r0, r1              ; 6   and the quotient, popped: T goes
        pop     r2, r3                  ; 5   into r0 and is overwritten
        add     sp, sp, #10             ; 1   d and p
        pop     lr, r4                  ; 5
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
        push    lr                      ; 5
        call    __udivmoddi4.core       ; 3
        pop     lr                      ; 4
        mov     r1, sp                  ; 1   ldm loads through r1, so its
        ldm     r0, r5                  ; 5   own word goes to r5 first:
        ldm     r2, r3                  ; 5   r5 is free at the return
        mov     r1, r5                  ; 1
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
        push    lr                      ; 5
        call    .signed                 ; 3
        ld      r5, [sp, #10]           ; 4   rp
        br      eq, r5, #0, .norp       ; 1
        ld      lr, [sp, #2]            ; 4
        st      lr, [r5, #0]            ; 5
        ld      lr, [sp, #4]            ; 4
        st      lr, [r5, #2]            ; 5
        ld      lr, [sp, #6]            ; 4
        st      lr, [r5, #4]            ; 5
        ld      lr, [sp, #8]            ; 4
        st      lr, [r5, #6]            ; 5
.norp:
        pop     lr                      ; 4
        ret                             ; 4

.signed:
        push    r4, lr, r5              ; 7   [sp]: p, lr, r4
        ld      lr, [r5, #6]            ; 4   d3
        xor     lr, lr, r3              ; 1   the quotient's sign ...
        lsr     lr, lr, #1              ; 1   ... to bit 14
        mov     r4, r3                  ; 1
        and     r4, r4, #0x8000         ; 1   n's in bit 15
        or      r4, r4, lr              ; 1
        brclr   r3, #0x8000, .npos      ; 3+1
        call    .neg                    ; 3   |n|
.npos:
        push    r3, r2, r1              ; 7   |n|, while d is fetched
        push    r0                      ; 5
        mov     r1, r5                  ; 1   d, through ldm's r1, whose own
        ldm     r0, lr, r2              ; 6   word goes by lr: free here
        ldm     r3                      ; 4
        mov     r1, lr                  ; 1
        brclr   r3, #0x8000, .dpos      ; 3+1
        call    .neg                    ; 3   |d|
.dpos:
        push    r3, r2, r1              ; 7   |d| below |n|, where the core
        push    r0                      ; 5   can have it
        add     r1, sp, #8              ; 1   |n| back, the same way
        ldm     r0, lr, r2              ; 6
        ldm     r3                      ; 4
        mov     r1, lr                  ; 1
        mov     r5, sp                  ; 1
        call    __udivmoddi4.core       ; 3
        brclr   r4, #0x4000, .qpos      ; 3+1
        call    .neg                    ; 3
.qpos:
        add     r5, sp, #8              ; 1   the quotient over |n|
        stm     r0, r1, r2              ; 7
        stm     r3                      ; 5
        pop     r0, r1, r2              ; 6   and the remainder popped out of
        pop     r3                      ; 4   |d|'s slots
        brclr   r4, #0x8000, .rpos      ; 3+1
        call    .neg                    ; 3
.rpos:
        ld      r5, [sp, #8]            ; 4   p
        stm     r0, r1, r2              ; 7
        stm     r3                      ; 5
        pop     r0, r1, r2              ; 6   the quotient, with p into r5 to
        pop     r3, r5                  ; 5   step over it
        pop     lr, r4                  ; 5
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
        push    lr                      ; 5
        call    __divmoddi4.signed      ; 3
        pop     lr                      ; 4
        mov     r1, sp                  ; 1   ldm loads through r1, so its
        ldm     r0, r5                  ; 5   own word goes to r5 first:
        ldm     r2, r3                  ; 5   r5 is free at the return
        mov     r1, r5                  ; 1
        ret                             ; 4

; ============================================================================
; 64-bit division with recip, for -mmul
; ============================================================================
;       __udivdi3_mul  __umoddi3_mul  __udivmoddi4_mul      unsigned
;       __divdi3_mul   __moddi3_mul   __divmoddi4_mul       signed
;
; The same six entry points and the same conventions as above, and a core
; with the same convention too: n in r0:r1:r2:r3, r5 pointing at d, the
; quotient back in r0:r1:r2:r3 and the remainder written over d, r4 kept.
; What differs is that it divides a WORD at a time, by Moller and Granlund's
; method - see __udivmodsi4_mul - with Knuth's long division around it.
; Three cases, by how many words d has, m:
;
; m = 1, d < 65536: the 2/1 step, once per word of n, in a loop.  A word
; whose remainder so far is 0 and which is itself below d is a quotient word
; of 0 and costs no multiply, so a long long that holds a small number costs
; little more than a long.
;
; m = 2: the 3/2 step, a local routine called once per quotient word, three
; times.  The 3/2 quotient of a three-word number by a two-word one is exact,
; so there is nothing else to it.
;
; m = 3 or 4: Knuth's algorithm D, with the 3/2 step on d's top two words as
; the estimate.  The estimate is never too small and at most one too big;
; what is left of d below its top two words is multiplied by it and
; subtracted, and in the rare case that goes negative, d is added back and
; the quotient word decremented.  m = 3 is made m = 4 by shifting n and d up
; a word together, which leaves the quotient alone and the remainder a word
; up, so there is one loop: once for m = 4, twice for m = 3.
;
; EVERY CASE NORMALISES FIRST: d is shifted up until its top bit is set, and
; n by the same.  A shift by s is a mul by 2^s for the low half of each word
; and a mulhu for the bits it pushes into the next, which is the same two
; instructions for every s, s = 0 included.
;
; DIVISION BY ZERO returns junk and does not hang: d = 0 takes the m = 1
; loop, whose count is fixed.

__udivmoddi4_mul:
        mov     r5, sp                  ; 1   d, which becomes the remainder
        push    lr                      ; 5
        call    .core                   ; 3
        ld      r5, [sp, #10]           ; 4   rp, past the pushed lr
        br      eq, r5, #0, .norp       ; 1
        push    r0, r1                  ; 6   r0 and r1 free for the copy
        add     r1, sp, #6              ; 1   the remainder, past them and lr
        ldm     r0, lr                  ; 5
        stm     r0, lr                  ; 6   through rp in r5
        ldm     r0, lr                  ; 5
        stm     r0, lr                  ; 6
        pop     r1, r0, lr              ; 6   lr's pop comes free with them
        ret                             ; 4
.norp:
        pop     lr                      ; 4
        ret                             ; 4

; --- the core -----------------------------------------------------------------
;       in:  r0:r1:r2:r3  n             r5  -> d, four words
;       out: r0:r1:r2:r3  n / d         [r5] n % d, over d          r4 kept
.core:
        push    r4, lr, r5              ; 7   [sp]: p, lr, r4
        ld      r4, [r5, #6]            ; 4   d3
        ld      lr, [r5, #4]            ; 4   d2
        or      lr, r4, lr              ; 1
        br      eq, lr, #0, .small      ; 1
        jmp     .big                    ; 3   m = 3 or 4
.small:
        ld      lr, [r5, #2]            ; 4   d1
        br      eq, lr, #0, .m1         ; 1
        jmp     .m2                     ; 3

        ; --- m = 1: d < 65536 ------------------------------------------------
.m1:
        ld      r4, [r5, #0]            ; 4   d
        clz     r4, r4                  ; 2   s
        call    .shift                  ; 3   n << s, five words u4..u0
        push    r0                      ; 5
        ;      u0(0) u1(2) u2(4) u3(6) u4(8) p(10) lr(12) r4(14)
        ld      r5, [sp, #10]           ; 4   p
        ld      r1, [r5, #0]            ; 4   d
        clz     r5, r1                  ; 2
        shl     r1, r1, r5              ; 1   D, normalised
        recip   r2, r1                  ; 5   v
        ld      r0, [sp, #8]            ; 4   R = u4, which is below D
        mov     lr, #6                  ; 1   u3's offset: the count too
.nloop:
        ld      r3, [sp, lr]            ; 4   u_j
        br      ne, r0, #0, .ndiv       ; 1
        br      hs, r3, r1, .ndiv       ; 1
        st      r0, [sp, lr]            ; 5   R = 0 and u_j < D: q_j = 0,
        mov     r0, r3                  ; 1   and R = u_j
        jmpr    .nnext                  ; 3
.ndiv:  ; R:u_j / D  ->  quotient r4, remainder R
        mulhu   r4, r2, r0              ; 2
        mul     r5, r2, r0              ; 2
        add     r5, r5, r3              ; 1   q0
        add     r4, r4, r0              ; 1
        add     r4, r4, #1              ; 1   q1 + 1
        br      hs, r5, r3, .nc         ; 1
        add     r4, r4, #1              ; 1
.nc:
        mul     r0, r4, r1              ; 2
        rsb     r0, r0, r3              ; 1   r = u_j - q1 * D
        br      ls, r0, r5, .nk         ; 1   r <= q0: q1 stands
        sub     r4, r4, #1              ; 1
        add     r0, r0, r1              ; 1
.nk:
        br      hs, r0, r1, .ng         ; 1   rare
.nst:
        st      r4, [sp, lr]            ; 5   q_j over u_j
.nnext:
        add     lr, lr, #-2             ; 1
        br      ge, lr, #0, .nloop      ; 3+1
        ld      r5, [sp, #10]           ; 4   p
        ld      r1, [r5, #0]            ; 4
        clz     r1, r1                  ; 2   s again
        lsr     r0, r0, r1              ; 1   the remainder; d's other
        st      r0, [r5, #0]            ; 5   words are zero already
        pop     r0                      ; 4   and the quotient
        pop     r1, r2, r3              ; 6
        add     sp, sp, #4              ; 1   u4 and p
        pop     lr, r4                  ; 5
        ret                             ; 4
.ng:
        add     r4, r4, #1              ; 1
        rsb     r0, r1, r0              ; 1
        jmpr    .nst                    ; 3

; n << s, for all four cases: five words, of which the top four are pushed
; and the bottom one is left in r0.  A shift by s is a mul by 2^s for each
; word's low half and a mulhu for the bits it pushes into the next word up.
;       in:  r0:r1:r2:r3  n             r4  s
;       out: [sp] u1 u2 u3 u4, u4 deepest   r0 u0, r3 u3, r4 2^s, r5 not kept
; THE TOP FOUR WORDS GO ON THE STACK because the return address takes the
; register they would need.  Done inline, the shift used lr for 2^s and r4
; and r5 for the carries; as a call, lr holds the way back.  But the words
; come out top first, the order a push wants them in, and every caller
; pushes them anyway: u4 goes as soon as it is made, which frees its
; register to carry the rest.
.shift:
        mov     r5, #1                  ; 1
        shl     r4, r5, r4              ; 1   2^s
        mulhu   r5, r3, r4              ; 2   u4
        push    r5                      ; 5
        mul     r3, r3, r4              ; 2
        mulhu   r5, r2, r4              ; 2
        or      r3, r3, r5              ; 1   u3
        mul     r2, r2, r4              ; 2
        mulhu   r5, r1, r4              ; 2
        or      r2, r2, r5              ; 1   u2
        mul     r1, r1, r4              ; 2
        mulhu   r5, r0, r4              ; 2
        or      r1, r1, r5              ; 1   u1
        mul     r0, r0, r4              ; 2   u0
        push    r3, r2, r1              ; 7
        ret                             ; 4

; The 3/2 step, for m = 2 and for the estimate at m = 3 and 4.
;       in:  r4:r1:r0 = u2:u1:u0, below D * 65536    r3:r2 = D, normalised
;            v at the caller's [sp]
;       out: r5 the quotient, r1:r0 the remainder   r2, r3 kept, r4 not
.step:
        push    lr                      ; 5
        ld      lr, [sp, #2]            ; 4   v
        mulhu   r5, lr, r4              ; 2
        mul     lr, lr, r4              ; 2
        add     lr, lr, r1              ; 1   q0
        add     r5, r5, r4              ; 1   q1
        br      hs, lr, r1, .sc         ; 1
        add     r5, r5, #1              ; 1
.sc:
        mul     r4, r5, r3              ; 2
        rsb     r1, r4, r1              ; 1   r1 = u1 - q1 * d1
        mulhu   r4, r5, r2              ; 2
        rsb     r1, r4, r1              ; 1   r1:r0 = r1:u0 - q1 * d0 ...
        mul     r4, r5, r2              ; 2
        br      hs, r0, r4, .sb0        ; 1
        sub     r1, r1, #1              ; 1
.sb0:
        rsb     r0, r4, r0              ; 1
        br      hs, r0, r2, .sb1        ; 1   ... - D
        sub     r1, r1, #1              ; 1
.sb1:
        rsb     r0, r2, r0              ; 1
        rsb     r1, r3, r1              ; 1
        add     r5, r5, #1              ; 1   q1 + 1
        br      lo, r1, lr, .sk         ; 1   r1 < q0: q1 stands
        sub     r5, r5, #1              ; 1
        add     r0, r0, r2              ; 1   r += D
        add     r1, r1, r3              ; 1
        br      hs, r0, r2, .sk         ; 1
        add     r1, r1, #1              ; 1
.sk:
        br      lo, r1, r3, .sd         ; 1   r >= D is rare
        br      hi, r1, r3, .sg         ; 1
        br      hs, r0, r2, .sg         ; 1
.sd:
        pop     lr                      ; 4
        ret                             ; 4
.sg:
        add     r5, r5, #1              ; 1
        br      hs, r0, r2, .sg1        ; 1
        sub     r1, r1, #1              ; 1
.sg1:
        rsb     r0, r2, r0              ; 1
        rsb     r1, r3, r1              ; 1
        jmpr    .sd                     ; 3

        ; --- m = 2: d1 is not zero, and in lr ---------------------------------
.m2:
        clz     r4, lr                  ; 2   s
        call    .shift                  ; 3   n << s, as for m = 1
        push    r0                      ; 5
        add     sp, sp, #-2             ; 1   and a slot for v
        ;      v(0) u0(2) u1(4) u2(6) u3(8) u4(10) p(12) lr(14) r4(16)
        ld      r5, [sp, #12]           ; 4   p
        ld      r1, [sp, #10]           ; 4   the remainder so far, u4:u3
        mov     r0, r3                  ; 1
        ld      r2, [r5, #0]            ; 4   d << s
        ld      r3, [r5, #2]            ; 4
        mulhu   lr, r2, r4              ; 2
        mul     r2, r2, r4              ; 2   D0
        mul     r3, r3, r4              ; 2
        or      r3, r3, lr              ; 1   D1
        recip   r5, r3                  ; 5   v from D1, then D0 in, as in
        mul     lr, r3, r5              ; 2   __udivmodsi4_mul
        add     lr, lr, r2              ; 1
        br      hs, lr, r2, .ia         ; 1   no carry, 37%
        sub     r5, r5, #1              ; 1
        br      hs, lr, r3, .ie         ; 1   p >= d1, rarely
.ib:
        rsb     lr, r3, lr              ; 1   p -= d1
.ia:
        mulhu   r4, r5, r2              ; 2   t1
        add     lr, lr, r4              ; 1   p += t1
        br      lo, lr, r4, .if         ; 1   a carry, 29%
.ic:
        st      r5, [sp, #0]            ; 5
        mov     r4, r1                  ; 1   q2 ...
        mov     r1, r0                  ; 1
        ld      r0, [sp, #6]            ; 4
        call    .step                   ; 3
        st      r5, [sp, #6]            ; 5
        mov     r4, r1                  ; 1   q1 ...
        mov     r1, r0                  ; 1
        ld      r0, [sp, #4]            ; 4
        call    .step                   ; 3
        st      r5, [sp, #4]            ; 5
        mov     r4, r1                  ; 1   q0
        mov     r1, r0                  ; 1
        ld      r0, [sp, #2]            ; 4
        call    .step                   ; 3
        st      r5, [sp, #2]            ; 5
        ld      r5, [sp, #12]           ; 4   p
        ld      r4, [r5, #2]            ; 4
        clz     r4, r4                  ; 2   s again
        rsb     r3, r4, #15             ; 1   r1:r0 >> s; r1 << (16 - s) is
        lsr     r0, r0, r4              ; 1   two shifts, since 16 would
        shl     r2, r1, #1              ; 1   read as 0
        shl     r2, r2, r3              ; 1
        or      r0, r0, r2              ; 1
        lsr     r1, r1, r4              ; 1
        stm     r0, r1                  ; 6   the remainder, through p; d's
                                        ;     top words are zero already
        add     sp, sp, #2              ; 1   v
        pop     r0                      ; 4   the quotient
        pop     r1, r2                  ; 5
        mov     r3, #0                  ; 1
        add     sp, sp, #6              ; 1   u3, u4 and p
        pop     lr, r4                  ; 5
        ret                             ; 4

.ie:    ; the fold's rare cases: d0's carry with p >= d1 ...
        sub     r5, r5, #1              ; 1
        rsb     lr, r3, lr              ; 1
        jmpr    .ib                     ; 3
.if:   ; ... and t1's carry: v one less, or two if p:t0 >= d1:d0, t0 the
        sub     r5, r5, #1              ; 1   low half of the old v * d0
        br      hs, lr, r3, .ig         ; 1
        jmpr    .ic                     ; 3
.ig:
        br      hi, lr, r3, .ig2        ; 1
        mul     r4, r5, r2              ; 2
        add     r4, r4, r2              ; 1   t0
        br      lo, r4, r2, .ic         ; 1
.ig2:
        sub     r5, r5, #1              ; 1
        jmpr    .ic                     ; 3

        ; --- m = 3 or 4: d3 in r4 ---------------------------------------------
        ; The frame, once built, with R the six words of n shifted, j the
        ; quotient word being made, and D the four words of d shifted:
        ;
        ;      v(0) D0(2) D1(4) D2(6) D3(8) 2j(10) R0..R5(12..22)
        ;      p(24) lr(26) r4(28)
.big:
        br      eq, r4, #0, .w1         ; 1
        clz     r4, r4                  ; 2   m = 4: c, with n and d where
        mov     r5, #0                  ; 1   they are
        push    r5                      ; 5   R5 = 0
        call    .shift                  ; 3   R4 R3 R2 R1
        push    r0                      ; 5   R0
        ld      r1, [sp, #12]           ; 4   p, for ldm; its own word goes
        ldm     r0, lr, r2              ; 6   by lr, free until j
        ldm     r3                      ; 4
        mov     r1, lr                  ; 1
        mov     lr, #0                  ; 1   one quotient word, j = 0
        jmpr    .bd                     ; 3
.w1:
        ld      r4, [r5, #4]            ; 4   m = 3: c from d2, and n and d
        clz     r4, r4                  ; 2   a word up
        call    .shift                  ; 3   R5 R4 R3 R2
        mov     r5, #0                  ; 1
        push    r0, r5                  ; 6   R1, and R0 = 0
        ld      r1, [sp, #12]           ; 4   p, for ldm: d0 goes by lr
        ldm     lr, r2, r3              ; 6
        mov     r1, lr                  ; 1
        mov     r0, #0                  ; 1
        mov     lr, #2                  ; 1   two quotient words, j = 1
.bd:
        push    lr                      ; 5   2j
        mulhu   r5, r2, r4              ; 2   d << c, top word first, by
        mul     r3, r3, r4              ; 2   .shift's 2^c
        or      r3, r3, r5              ; 1   D3
        mulhu   r5, r1, r4              ; 2
        mul     r2, r2, r4              ; 2
        or      r2, r2, r5              ; 1   D2
        mulhu   r5, r0, r4              ; 2
        mul     r1, r1, r4              ; 2
        or      r1, r1, r5              ; 1   D1
        mul     r0, r0, r4              ; 2   D0
        push    r3, r2, r1              ; 7
        push    r0                      ; 5
        recip   r5, r3                  ; 5   v from D3, then D2 in, as in
        mul     lr, r3, r5              ; 2   __udivmodsi4_mul
        add     lr, lr, r2              ; 1
        br      hs, lr, r2, .ja         ; 1   no carry, 37%
        sub     r5, r5, #1              ; 1
        br      hs, lr, r3, .je         ; 1   p >= d1, rarely
.jb:
        rsb     lr, r3, lr              ; 1   p -= d1
.ja:
        mulhu   r4, r5, r2              ; 2   t1
        add     lr, lr, r4              ; 1   p += t1
        br      lo, lr, r4, .jf         ; 1   a carry, 29%
.jc:
        push    r5                      ; 5
        jmpr    .bloop                  ; 3
.je:    ; the fold's rare cases: d0's carry with p >= d1 ...
        sub     r5, r5, #1              ; 1
        rsb     lr, r3, lr              ; 1
        jmpr    .jb                     ; 3
.jf:   ; ... and t1's carry: v one less, or two if p:t0 >= d1:d0, t0 the
        sub     r5, r5, #1              ; 1   low half of the old v * d0
        br      hs, lr, r3, .jg         ; 1
        jmpr    .jc                     ; 3
.jg:
        br      hi, lr, r3, .jg2        ; 1
        mul     r4, r5, r2              ; 2
        add     r4, r4, r2              ; 1   t0
        br      lo, r4, r2, .jc         ; 1
.jg2:
        sub     r5, r5, #1              ; 1
        jmpr    .jc                     ; 3
; R's top two words are D's.  The 3/2 step cannot take that - its quotient
; would not fit a word - but the remainder so far is below D, so its next
; two words are below D1:D0, and that makes q_j exactly 0xffff: R is at
; least 65536 D less D1:D0:0, which is more than 65535 D since D > 2^63.
; Then the top three words less 0xffff times D3:D2 is D3:D2 + R[j+2], and
; what is left below is subtracted as for any other estimate.  It cannot go
; negative, and 0xffff as the old r1 keeps the test for that from firing.
.top:
        mov     r5, #-1                 ; 1   q_j
        st      r5, [lr, #20]           ; 5
        st      r5, [lr, #18]           ; 5
        add     r0, r0, r2              ; 1   D3:D2 + R[j+2]
        mov     r1, r3                  ; 1
        br      hs, r0, r2, .lower      ; 1
        add     r1, r1, #1              ; 1
        jmpr    .lower                  ; 3
.bloop:
        ld      lr, [sp, #10]           ; 4   2j, and from it the address
        add     lr, lr, sp              ; 1   of R[j] less 12
        ld      r4, [lr, #20]           ; 4   R[j+4]
        ld      r1, [lr, #18]           ; 4   R[j+3]
        ld      r0, [lr, #16]           ; 4   R[j+2]
        ld      r2, [sp, #6]            ; 4   D2
        ld      r3, [sp, #8]            ; 4   D3
        br      ne, r4, r3, .est        ; 1
        br      eq, r1, r2, .top        ; 1
.est:
        call    .step                   ; 3   the estimate, and the remainder
        ld      lr, [sp, #10]           ; 4   of the top three words by D's
        add     lr, lr, sp              ; 1   top two in r1:r0
        st      r5, [lr, #20]           ; 5   q_j over R[j+4], which is done
        st      r1, [lr, #18]           ; 5   r1 kept, to tell the sign by
.lower:
        ; --- R[j+3..j] -= q_j * D1:D0, with r1:r0 as R[j+3]:R[j+2] ---------
        ld      r4, [sp, #2]            ; 4   D0
        mulhu   r3, r5, r4              ; 2
        mul     r4, r5, r4              ; 2   p0
        ld      r2, [sp, #4]            ; 4   D1
        mul     lr, r5, r2              ; 2
        mulhu   r5, r5, r2              ; 2   p2
        add     r3, r3, lr              ; 1   p1
        br      hs, r3, lr, .bc         ; 1
        add     r5, r5, #1              ; 1
.bc:
        ld      lr, [sp, #10]           ; 4
        add     lr, lr, sp              ; 1
        ld      r2, [lr, #12]           ; 4   R[j]
        ld      lr, [lr, #14]           ; 4   R[j+1]
        ; r1:r0:lr:r2 -= 0:r5:r3:r4.  A borrow decrements the words above,
        ; and passes through a word that was 0, which becomes 0xffff and so
        ; never borrows again - as in the core above.
        br      hs, r2, r4, .b0         ; 1
        br      ne, lr, #0, .b0x        ; 1
        br      ne, r0, #0, .b0y        ; 1
        sub     r1, r1, #1              ; 1
.b0y:
        sub     r0, r0, #1              ; 1
.b0x:
        sub     lr, lr, #1              ; 1
.b0:
        rsb     r2, r4, r2              ; 1
        br      hs, lr, r3, .b1         ; 1
        br      ne, r0, #0, .b1y        ; 1
        sub     r1, r1, #1              ; 1
.b1y:
        sub     r0, r0, #1              ; 1
.b1:
        rsb     lr, r3, lr              ; 1
        br      hs, r0, r5, .b2         ; 1
        sub     r1, r1, #1              ; 1
.b2:
        rsb     r0, r5, r0              ; 1
        ; A borrow out of the top word went negative.  At most one reaches
        ; it, so it went negative exactly when r1 came out above where it
        ; started.
        ld      r4, [sp, #10]           ; 4
        add     r4, r4, sp              ; 1
        ld      r3, [r4, #18]           ; 4   r1 as it was
        br      hi, r1, r3, .back       ; 1   rare
.bst:
        add     r5, r4, #12             ; 1   the remainder so far, through
        stm     r2, lr, r0              ; 7   r5, free until the next q_j
        stm     r1                      ; 5
        ld      r4, [sp, #10]           ; 4
        add     r4, r4, #-2             ; 1   the next word down
        st      r4, [sp, #10]           ; 5
        br      lt, r4, #0, .bend       ; 1   the loop is longer than a
        jmp     .bloop                  ; 3   branch reaches
.bend:
        ; The remainder is R3..R0 shifted back down, by c for m = 4, and by
        ; a word and c for m = 3.  The quotient is R5:R4 for both: R5 is
        ; q1 for m = 3, and for m = 4 it was 0 and never written.
        ld      r5, [sp, #24]           ; 4   p
        ld      r4, [r5, #6]            ; 4   d3
        ld      r3, [sp, #18]           ; 4   R3
        ld      r2, [sp, #16]           ; 4   R2
        ld      r1, [sp, #14]           ; 4   R1
        br      eq, r4, #0, .e1         ; 1
        ld      r0, [sp, #12]           ; 4   R0
        clz     r4, r4                  ; 2   c
        jmpr    .e                      ; 3
.e1:
        mov     r0, r1                  ; 1   down a word: R0 is 0
        mov     r1, r2                  ; 1
        mov     r2, r3                  ; 1
        mov     r3, #0                  ; 1
        ld      r4, [r5, #4]            ; 4   d2
        clz     r4, r4                  ; 2   c
.e:
        rsb     lr, r4, #15             ; 1   each word >> c, with the bits
        lsr     r0, r0, r4              ; 1   of the next one up shifted
        shl     r5, r1, #1              ; 1   into it by 16 - c, in two
        shl     r5, r5, lr              ; 1
        or      r0, r0, r5              ; 1
        lsr     r1, r1, r4              ; 1
        shl     r5, r2, #1              ; 1
        shl     r5, r5, lr              ; 1
        or      r1, r1, r5              ; 1
        lsr     r2, r2, r4              ; 1
        shl     r5, r3, #1              ; 1
        shl     r5, r5, lr              ; 1
        or      r2, r2, r5              ; 1
        lsr     r3, r3, r4              ; 1
        ld      r5, [sp, #24]           ; 4   p, stm's pointer
        stm     r0, r1, r2              ; 7
        stm     r3                      ; 5
        add     sp, sp, #20             ; 1   the quotient, R5:R4, popped
        pop     r0, r1, r5              ; 6   with p into r5 to step over it
        mov     r2, #0                  ; 1
        mov     r3, r2                  ; 1
        pop     lr, r4                  ; 5
        ret                             ; 4
; The estimate was one too big: one less, and D back on.  A carry passes up
; through a word that was 0xffff, which becomes 0 and so never carries
; again; the carry out of the top cancels the borrow that brought us here.
.back:
        ld      r3, [r4, #20]           ; 4
        sub     r3, r3, #1              ; 1
        st      r3, [r4, #20]           ; 5   q_j - 1
        ld      r3, [sp, #2]            ; 4   D0
        add     r2, r2, r3              ; 1
        br      hs, r2, r3, .a0         ; 1
        add     lr, lr, #1              ; 1
        br      ne, lr, #0, .a0         ; 1
        add     r0, r0, #1              ; 1
        br      ne, r0, #0, .a0         ; 1
        add     r1, r1, #1              ; 1
.a0:
        ld      r3, [sp, #4]            ; 4   D1
        add     lr, lr, r3              ; 1
        br      hs, lr, r3, .a1         ; 1
        add     r0, r0, #1              ; 1
        br      ne, r0, #0, .a1         ; 1
        add     r1, r1, #1              ; 1
.a1:
        ld      r3, [sp, #6]            ; 4   D2
        add     r0, r0, r3              ; 1
        br      hs, r0, r3, .a2         ; 1
        add     r1, r1, #1              ; 1
.a2:
        ld      r3, [sp, #8]            ; 4   D3
        add     r1, r1, r3              ; 1
        jmp     .bst                    ; 3

__udivdi3_mul:
        mov     r5, sp                  ; 1
        jmp     __udivmoddi4_mul.core   ; 3

__umoddi3_mul:
        mov     r5, sp                  ; 1
        push    lr                      ; 5
        call    __udivmoddi4_mul.core   ; 3
        pop     lr                      ; 4
        mov     r1, sp                  ; 1   ldm loads through r1, so its
        ldm     r0, r5                  ; 5   own word goes to r5 first:
        ldm     r2, r3                  ; 5   r5 is free at the return
        mov     r1, r5                  ; 1
        ret                             ; 4

; The signed three: __divmoddi4's wrapper word for word, around the core
; above.  A copy, and not that one with the core passed in, because there is
; no register free to pass it in, and because a call to either core by name
; would link it into programs that only want the other.

__divmoddi4_mul:
        mov     r5, sp                  ; 1
        push    lr                      ; 5
        call    .signed                 ; 3
        ld      r5, [sp, #10]           ; 4   rp
        br      eq, r5, #0, .norp       ; 1
        ld      lr, [sp, #2]            ; 4
        st      lr, [r5, #0]            ; 5
        ld      lr, [sp, #4]            ; 4
        st      lr, [r5, #2]            ; 5
        ld      lr, [sp, #6]            ; 4
        st      lr, [r5, #4]            ; 5
        ld      lr, [sp, #8]            ; 4
        st      lr, [r5, #6]            ; 5
.norp:
        pop     lr                      ; 4
        ret                             ; 4

.signed:
        push    r4, lr, r5              ; 7   [sp]: p, lr, r4
        ld      lr, [r5, #6]            ; 4   d3
        xor     lr, lr, r3              ; 1   the quotient's sign ...
        lsr     lr, lr, #1              ; 1   ... to bit 14
        mov     r4, r3                  ; 1
        and     r4, r4, #0x8000         ; 1   n's in bit 15
        or      r4, r4, lr              ; 1
        brclr   r3, #0x8000, .npos      ; 3+1
        call    .neg                    ; 3   |n|
.npos:
        push    r3, r2, r1              ; 7   |n|, while d is fetched
        push    r0                      ; 5
        mov     r1, r5                  ; 1   d, through ldm's r1, whose own
        ldm     r0, lr, r2              ; 6   word goes by lr: free here
        ldm     r3                      ; 4
        mov     r1, lr                  ; 1
        brclr   r3, #0x8000, .dpos      ; 3+1
        call    .neg                    ; 3   |d|
.dpos:
        push    r3, r2, r1              ; 7   |d| below |n|, where the core
        push    r0                      ; 5   can have it
        add     r1, sp, #8              ; 1   |n| back, the same way
        ldm     r0, lr, r2              ; 6
        ldm     r3                      ; 4
        mov     r1, lr                  ; 1
        mov     r5, sp                  ; 1
        call    __udivmoddi4_mul.core   ; 3
        brclr   r4, #0x4000, .qpos      ; 3+1
        call    .neg                    ; 3
.qpos:
        add     r5, sp, #8              ; 1   the quotient over |n|
        stm     r0, r1, r2              ; 7
        stm     r3                      ; 5
        pop     r0, r1, r2              ; 6   and the remainder popped out of
        pop     r3                      ; 4   |d|'s slots
        brclr   r4, #0x8000, .rpos      ; 3+1
        call    .neg                    ; 3
.rpos:
        ld      r5, [sp, #8]            ; 4   p
        stm     r0, r1, r2              ; 7
        stm     r3                      ; 5
        pop     r0, r1, r2              ; 6   the quotient, with p into r5 to
        pop     r3, r5                  ; 5   step over it
        pop     lr, r4                  ; 5
        ret                             ; 4

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

__divdi3_mul:
        mov     r5, sp                  ; 1
        jmp     __divmoddi4_mul.signed  ; 3

__moddi3_mul:
        mov     r5, sp                  ; 1
        push    lr                      ; 5
        call    __divmoddi4_mul.signed  ; 3
        pop     lr                      ; 4
        mov     r1, sp                  ; 1   ldm loads through r1, so its
        ldm     r0, r5                  ; 5   own word goes to r5 first:
        ldm     r2, r3                  ; 5   r5 is free at the return
        mov     r1, r5                  ; 1
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
        ld      r5, [sp, #0]            ; 4   the count
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
        push    r4, lr                  ; 6
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
        pop     lr, r4                  ; 5
.done:
        ret                             ; 4

__lshrdi3:
        ld      r5, [sp, #0]            ; 4
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
        push    r4, lr                  ; 6
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
        pop     lr, r4                  ; 5
.done:
        ret                             ; 4

__ashrdi3:
        ld      r5, [sp, #0]            ; 4
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
        push    r4, lr                  ; 6
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
        pop     lr, r4                  ; 5
.done:
        ret                             ; 4
