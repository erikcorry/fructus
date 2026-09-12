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
; libgcc/config/fructus/lib2div.c.
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
; __mulsi3 - 32 x 32 -> 32, signed or unsigned                       43 bytes
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
; ONE PUSH, NOT TWO.  A three-register push costs the same eight cycles as
; pushing two separately and two bytes fewer, and the order works out: `push
; r4, lr, r1` writes r4 highest and al lowest, so `ld r0, [sp]` finds al, and
; the later `pop r0` then `pop lr, r4` unwind it in the right order.
;
; NEITHER HELPER TOUCHES r2, r3 OR r4.  __mulhi3 uses r0, r1 and r5 and nothing
; else; __umulhisi3 saves r2 and r3 and restores them.  So bh and bl sit in
; their argument registers across all three calls and only al has to be spilled
; - once, and read back without popping the first time it is wanted.
;
; ----------------------------------------------------------------------------
; BOTH HIGH WORDS ZERO IS A TAIL CALL
; ----------------------------------------------------------------------------
; If ah and bh are both zero then a and b are 16-bit values, both cross terms
; vanish, and the answer is just the widening product of the low halves - which
; __umulhisi3 already returns as high:low in r0:r1, exactly where this routine
; has to leave it.  Nothing to fix up afterwards, so it is a real tail call:
; the test happens before the prologue and there is no lr to save.
;
;       or      r5, r0, r2              ; both high words at once
;
; Five cycles to ask, and it turns 591 into about 330 - or about 95 when the
; low halves are small enough for __umulhisi3's own shortcut.  A `long` holding
; a value that fits in sixteen bits is the common case in real code by a wide
; margin, which is what makes this worth its eleven bytes.
;
; ONLY ONE HIGH WORD ZERO is not tested for.  It would kill one cross term
; rather than both, which is a third of the work for another test on each of
; two paths, and the case is much rarer than both being zero.

__mulsi3:
        or      r5, r0, r2              ; 2   ah | bh
        br      eq, r5, #0, .narrow     ; 3   both zero: a 16 x 16 widening
        push    r4, lr, r1              ; 8   three for the price of two:
                                        ;     al ends up lowest, so [sp] finds it
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
.narrow:
        mov     r0, r1                  ; 1   al, pinned
        mov     r1, r3                  ; 2   bl
        jmpr    __umulhisi3             ; 3   its high:low result is ours


; ============================================================================
; __umulsidi3 - 32 x 32 -> 64, unsigned
; ============================================================================
;       a in r0:r1 as high:low          b in r2:r3 as high:low
;       result in r0:r1:r2:r3, high word to low word
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
        or      r5, r0, r2              ; 2   ah | bh
        br      eq, r5, #0, .narrow     ; 3   both zero: it is a 16 x 16
        push    r4, lr, r0              ; 8   r4, lr, ah      ah lowest
        push    r1, r2, r3              ; 8   al, bh, bl      bl lowest
        add     sp, sp, #-2             ; 2   and a slot for w0
        ;      w0(0)  bl(2)  bh(4)  al(6)  ah(8)  lr(10)  r4(12)

        ; --- P1 = al * bh ---------------------------------------------------
        ld      r0, [sp, #6]            ; 4
        ld      r1, [sp, #4]            ; 4
        callr   __umulhisi3             ; 4
        mov     r2, r0                  ; 2   X.hi
        mov     r3, r1                  ; 2   X.lo

        ; --- P2 = ah * bl, and X = P1 + P2 ----------------------------------
        ld      r0, [sp, #8]            ; 4
        ld      r1, [sp, #2]            ; 4
        callr   __umulhisi3             ; 4
        mov     r4, #0                  ; 2   cx
        add     r3, r3, r1              ; 2   X.lo
        br      hs, r3, r1, .nc1        ; 3
        add     r0, r0, #1              ; 2   into P2.hi; it cannot wrap
.nc1:
        add     r2, r2, r0              ; 2   X.hi
        br      hs, r2, r0, .nc2        ; 3
        add     r4, r4, #1              ; 2
.nc2:

        ; --- P0 = al * bl ---------------------------------------------------
        ld      r0, [sp, #6]            ; 4
        ld      r1, [sp, #2]            ; 4
        callr   __umulhisi3             ; 4
        st      r1, [sp, #0]            ; 4   w0 is finished
        add     r3, r3, r0              ; 2   w1 = X.lo + P0.hi
        br      hs, r3, r0, .nc3        ; 3
        add     r2, r2, #1              ; 2   k1 into X.hi ...
        br      ne, r2, #0, .nc3        ; 3   ... which CAN wrap
        add     r4, r4, #1              ; 2
.nc3:

        ; --- P3 = ah * bh ---------------------------------------------------
        ld      r0, [sp, #8]            ; 4
        ld      r1, [sp, #4]            ; 4
        callr   __umulhisi3             ; 4
        add     r2, r2, r1              ; 2   w2 = X.hi + k1 + P3.lo
        br      hs, r2, r1, .nc4        ; 3
        add     r4, r4, #1              ; 2
.nc4:
        add     r0, r0, r4              ; 2   w3 = P3.hi + cx + k2

        ; --- place the four words and unwind --------------------------------
        mov     r1, r2                  ; 2   w2
        mov     r2, r3                  ; 2   w1
        ld      r3, [sp, #0]            ; 4   w0
        add     sp, sp, #10             ; 2
        pop     lr, r4                  ; 6
        ret                             ; 1

; BOTH HIGH WORDS ZERO leaves only P0, so the answer is one widening multiply
; with two zero words above it.  `mov r1, r0` after r0 is zeroed is the pinned
; one-byte encoding, so both top words cost two bytes between them.
.narrow:
        push    lr                      ; 4
        mov     r0, r1                  ; 1   al, pinned
        mov     r1, r3                  ; 2   bl
        callr   __umulhisi3             ; 4
        mov     r2, r0                  ; 2   w1
        mov     r3, r1                  ; 2   w0
        mov     r0, #0                  ; 1   w3
        mov     r1, r0                  ; 1   w2, pinned
        pop     lr                      ; 4
        ret                             ; 1

; ============================================================================
; __udivmodhi4 - 16 / 16 -> quotient and remainder, unsigned
; ============================================================================
;       a in r0, b in r1        ->      quotient in r0, remainder in r1
;
; Two arguments and a 32-bit result, so by isa/abi.s this owns r0, r1 and r5
; and must give back r2, r3 and r4 - which is why the general loop, needing a
; fourth register, borrows r2 for four cycles each way.
;
; BOTH RESULTS AT ONCE, because the caller usually wants both.  `x / 10' and
; `x % 10' next to each other is every digit of every number ever printed,
; and a quotient-only routine does that work twice.  r0:r1 is what abi.s
; calls a 32-bit return, so to C this is one `unsigned long'.
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
        popcount r5, r1                 ; 2
        br      ne, r5, #1, .not_pow2   ; 3   0 bits set is not 1 either
        ; --- b is a power of two: mask and shift -----------------------------
        clz     r5, r1                  ; 2   15 - log2(b)
        rsb     r5, r5, #15             ; 2   log2(b), and imm5 reaches 15
        sub     r1, r1, #1              ; 2   b - 1, the remainder's mask
        and     r1, r1, r0              ; 2   a mod b
        lsr     r0, r0, r5              ; 2   a div b
        ret                             ; 1

.not_pow2:
        mov     r5, #10                 ; 2   condimm5 has no 10, so compare
        br      ne, r1, r5, .general    ; 3   against a register

        ; --- b is ten --------------------------------------------------------
        lsr     r5, r0, #1              ; 2
        lsr     r1, r0, #2              ; 2
        add     r5, r5, r1              ; 2   0.75 a
        lsr     r1, r5, #4              ; 2
        add     r5, r5, r1              ; 2   0.796875 a
        lsr     r1, r5, #8              ; 2
        add     r5, r5, r1              ; 2   0.79999237 a
        lsr     r5, r5, #3              ; 2   q, at most one too low
        shl     r1, r5, #3              ; 2   8q
        add     r1, r1, r5              ; 2   9q
        add     r1, r1, r5              ; 2   10q
        rsb     r1, r1, r0              ; 2   r = a - 10q, in 0..19
        add     r1, r1, #-10            ; 2   the corrected remainder ...
        add     r0, r5, #1              ; 2   ... and the corrected quotient
        br      ge, r1, #0, .ten_ret    ; 3+1 r was >= 10: they are the answer
        mov     r0, r5                  ; 2   otherwise put both back
        add     r1, r1, #10             ; 2
.ten_ret:
        ret                             ; 1

.general:
        br      lo, r0, r1, .smaller    ; 3+1 a < b: quotient 0, remainder a
        push    r2                      ; 4   the fourth register, the quotient
        clz     r5, r1                  ; 2
        clz     r2, r0                  ; 2
        rsb     r5, r2, r5              ; 2   s = clz(b) - clz(a), >= 0 here
        shl     r1, r1, r5              ; 2   d = b << s
        mov     r2, #0                  ; 2   the quotient
.loop:
        add     r2, r2, r2              ; 2   q <<= 1
        br      lo, r0, r1, .nofit      ; 3+1
        rsb     r0, r1, r0              ; 2   r -= d
        add     r2, r2, #1              ; 2   q |= 1
.nofit:
        lsr     r1, r1, #1              ; 2   d >>= 1
        add     r5, r5, #-1             ; 2   s is the counter too
        br      ge, r5, #0, .loop       ; 3+1 s+1 iterations
        mov     r1, r0                  ; 1   the remainder, pinned
        mov     r0, r2                  ; 2   the quotient
        pop     r2                      ; 4
        ret                             ; 1
.smaller:
        mov     r1, r0                  ; 1   pinned
        mov     r0, #0                  ; 1   pinned
        ret                             ; 1


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
        jmpr    __udivmodhi4            ; 3+1

__umodhi3:
        push    lr                      ; 4
        callr   __udivmodhi4            ; 4
        mov     r0, r1                  ; 1   the remainder, pinned
        pop     lr                      ; 4
        ret                             ; 1

; C rounds a signed quotient TOWARDS ZERO, so the magnitudes divide and the
; sign goes back on after: negative exactly when the operands' signs differ,
; which is the top bit of a ^ b.
__divhi3:
        push    lr, r2                  ; 6
        xor     r2, r0, r1              ; 2   bit 15 is the quotient's sign
        br      ge, r0, #0, .a_pos      ; 3+1
        rsb     r0, r0, #0              ; 2   |a|
.a_pos:
        br      ge, r1, #0, .b_pos      ; 3+1
        rsb     r1, r1, #0              ; 2   |b|
.b_pos:
        callr   __udivmodhi4            ; 4
        br      ge, r2, #0, .pos        ; 3+1
        rsb     r0, r0, #0              ; 2
.pos:
        pop     r2, lr                  ; 6
        ret                             ; 1

; And a remainder takes the sign of the DIVIDEND, so that a == (a/b)*b + a%b.
__modhi3:
        push    lr, r2                  ; 6
        mov     r2, r0                  ; 2   keep a, for its sign
        br      ge, r0, #0, .a_pos      ; 3+1
        rsb     r0, r0, #0              ; 2   |a|
.a_pos:
        br      ge, r1, #0, .b_pos      ; 3+1
        rsb     r1, r1, #0              ; 2   |b|
.b_pos:
        callr   __udivmodhi4            ; 4
        mov     r0, r1                  ; 1   the remainder, pinned
        br      ge, r2, #0, .pos        ; 3+1
        rsb     r0, r0, #0              ; 2
.pos:
        pop     r2, lr                  ; 6
        ret                             ; 1
