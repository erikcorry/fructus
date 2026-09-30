; ============================================================================
; mul.s - 16 x 16 -> 16 multiply, and what it costs to make it faster
; ============================================================================
;
;       uint16 mul_16(uint16 a, uint16 b)       a in r0, b in r1, result in r0
;
; Either we know it will not overflow or we do not care.  Two arguments, so
; under isa/abi.s r0 and r1 are caller saved and r5 is the assembler's scratch,
; also caller saved - which is exactly the three registers this needs, so there
; is no prologue and no epilogue anywhere in this file.
;
; THE PROCESSOR HAS A `mul` NOW - the low half of a 16x16 product from the
; UP5K's DSP, in four cycles; see isa/fructus.toml.  Everything here is for a
; part without a multiplier, which is what gcc assumes unless told otherwise.
;
; The column beside each instruction is its cycles on the pipeline - see the
; cost model under [cpu] in the spec - and a branch's is what it costs falling
; through, one cycle or two at an odd address; taken, it is four.
;
; THE FRONT DOOR IS mul_16_min, which swaps the operands so the smaller one is
; the multiplier and falls through into the loop.  Every routine here costs
; time per bit of the multiplier and nothing for its leading zeros, so that
; swap is worth more than anything else in the file - and it is also why none
; of them tests for a zero operand.  See below.
;
; ----------------------------------------------------------------------------
; MEASURED, by tests/sim-check.mjs, over 600 pairs from each distribution
; ----------------------------------------------------------------------------
;                        bytes   b 16-bit   b 8-bit   a 8-bit, b 16-bit
;       mul_16              21       112        56        112
;       mul_16_x4           32        87        46         87
;       mul_16_fast        158        70        48         70
;       mul_16_fast_erik   132        87        53         87
;       mul_16_nib         274        83        61         83
;       mul_16_min           8       111        60         60
;
; THE FIRST THREE ROWS HAVE IDENTICAL FIRST AND LAST COLUMNS, and that is the
; whole argument for the fourth.  Their cost is a function of the MULTIPLIER
; alone - how wide the multiplicand is does not enter into it - so handing them
; a small number in the wrong register buys nothing at all.  mul_16_min is the
; only row where those two columns differ, because it is the only one that can
; decide which operand the multiplier is.
;
; THE PLAIN LOOP IS ALREADY GOOD, and it is worth saying why before improving
; on it.  It costs 7 cycles a bit, set or clear, and 4 of that is the taken
; branch every bit ends in.  The obvious loop -
;
;       .top:   brclr   r1, #1, .skip
;               add     r0, r0, r5
;       .skip:  shl     r5, r5, #1
;               lsr     r1, r1, #1
;               br      ne, r1, #0, .top
;
; - has only one bit test but pays a separate loop-back branch, and comes to
; 9 cycles a bit, 8 set and 10 clear.  Rotating the loop so the two conditional
; branches ARE the loop control is what buys the 2 cycles, and it is why
; unrolling has to give something back before it gains anything.
;
; UNROLLING IS WORTH ABOUT A FIFTH.  Four bits to a group amortises the counter
; shift and the loop branch over four bits instead of paying a taken branch
; for each, and costs 11 bytes.  Handling those four as two pairs rather than
; four singles - see below - is part of that, and costs nothing at all.
;
; FULLY UNROLLING IS WORTH ABOUT A THIRD, on a wide multiplier.  It is the
; fastest thing here for one, and behind both loops for a narrow one, because
; its dispatch has to walk down to the top set bit.  158 bytes.
;
; AND THE BIGGEST SINGLE WIN IS NOT UNROLLING AT ALL.  All of these cost time
; per bit of the MULTIPLIER and nothing for its leading zeros, so which operand
; sits in r1 matters more than any of the above: 8 bytes of compare and swap
; take the last column from 112 to 60 on the plain loop, and would take the
; four-bit one from 87 to about 50 - its 8-bit column plus the swap.  It costs
; 4 cycles when it does not help.
;
; AND IT PAYS FOR ITSELF TWICE, because it also removes the zero test.  Both
; loops used to open with `br eq, r0, #0` - three bytes and a cycle on every
; call, to save a hundred on the rare one where an operand is zero.  With the
; swap in front that test is dead: zero is the smallest value there is, so a
; zero operand is always the one that ends up as the multiplier, and a zero
; multiplier drops out of the bottom of the loop on the first pass without any
; help.
;
; The only caller that loses is one that jumps straight to `mul_16` with a zero
; in r0 and something wide in r1 - 118 cycles rather than about 8.  Through
; mul_16_min the same call is 18.
;
; WHICH TO USE.  mul_16_x4, with mul_16_min in front of it - 40 bytes together,
; never worst in any column, and the best of all of them in the middle one.
; mul_16 if space is the binding constraint.
;
; mul_16_fast is the only other one worth its bytes: 158 of them, to beat
; mul_16_x4 by a fifth on multipliers that use most of their sixteen bits, and
; to lose to it on eight-bit ones.  The other two are here because the
; dispatch question is interesting, and on this core they are both beaten by
; mul_16_fast in every column.  mul_16_fast_erik's computed goto costs more
; than the scan it replaces, at every width - see below.  mul_16_nib still has
; the best steady state of any of them, 2.5 to 2.75 cycles a bit, and the
; worst prologue and exit, about forty cycles between them: its dispatch is a
; computed `ret', four cycles a nibble, and it saves and restores three
; registers.  Even a full-width multiplier, where all four nibbles do work,
; does not pay that back - 80 cycles against the chain's 62 on 0xffff.
; ============================================================================


; The plain algorithm with two things folded out of it.
;
; r0 IS BOTH THE MULTIPLICAND AND THE ACCUMULATOR.  If bit 0 of b is set then
; the first partial product is a, which is already in r0 - so the accumulator
; needs no initialisation at all and the first add never happens.  If bit 0 is
; clear the accumulator has to be zeroed, and `mov r0, #0` is one byte, which
; it was not when this file was written: the slot at 0x0b was spent on it
; because of this line.
;
; AND r5 STARTS AT a*2, not a, so the first shift is folded into the setup too.
; Between them these remove one add and one shift from the first iteration.
;
; THE LOOP IS ROTATED so that the two exits fall at the bottom, which is what
; lets a set bit and a clear bit take different paths without an unconditional
; jump in either.  Each takes exactly one branch: a set bit reaches .set
; through `brset`, a clear one falls through it and reaches .clear through
; `br` - and the add the clear bit skips pays for the fall-through, so both
; cost 7 cycles.

; ============================================================================
; mul_16_min - a prologue: put the smaller operand in the multiplier  8 bytes
; ============================================================================
; A DIFFERENT AXIS FROM ANY OF THE UNROLLING, and the cheapest thing in this
; file.  Every routine below runs once per bit of b and not at all for its
; leading zeros, so the cost is set by which operand is the multiplier - and
; multiplication does not care which way round they are.
;
; EIGHT BYTES, NOT NINE, because the middle move of the three-way swap is
; `mov r0, r1` and that is one of the pinned one-byte encodings.  Rotating the
; swap the other way, through r0 rather than r5, would cost a byte more.
;
; IT ALSO SUBSUMES THE ZERO TEST both loops below used to carry.  Zero is the
; smallest value there is, so if either operand is zero this puts it in r1, and
; a zero multiplier falls out of the bottom of the loop on the first pass.
;
; It falls through into mul_16 rather than jumping to it, which is why it is
; here and not at the end of the file: from below the chain, mul_16 is more
; than 128 bytes back and the three-byte branch cannot reach it.
;
; Worth almost nothing on uniformly random 16-bit operands, where both sides
; are nearly always 16 bits wide.  Worth a great deal on the multiplies real
; programs do, where one side is a count or a small constant.

mul_16_min:
        br      ls, r1, r0, mul_16      ; 1   b is already the smaller
        mov     r5, r0                  ; 1
        mov     r0, r1                  ; 1
        mov     r1, r5                  ; 1   ... and fall through


; ============================================================================
; mul_16 - shift and add, one bit at a time                          21 bytes
; ============================================================================
mul_16:
        shl     r5, r0, #1              ; 1   r5 = a << 1
        brset   r1, #1, .entry          ; 1   bit 0 set: r0 already holds a
        mov     r0, #0                  ; 1   otherwise start the sum at zero
        jmpr    .entry                  ; 3
.set:
        add     r0, r0, r5              ; 1
.clear:
        shl     r5, r5, #1              ; 1
.entry:
        lsr     r1, r1, #1              ; 1   LOGICAL: an arithmetic shift would
.end:                                   ;     never clear r1 and never end
        brset   r1, #1, .set            ; 1
        br      ne, r1, #0, .clear      ; 2
        ret                             ; 4


; ============================================================================
; mul_16_x4 - the same loop, four bits at a time                     32 bytes
; ============================================================================
; The rotation above is what makes the plain loop cheap, and it is also what
; stops it getting cheaper: the two branches ARE the loop, so there is no
; separate loop-back to amortise.  Unrolling has to give that up and go back to
; an explicit mask per bit - which costs one branch per bit instead of two, and
; pays for a counter shift and a loop branch once per four bits.
;
; Testing bit i directly needs no shifting of b at all during the group, and
; every mask it wants is in immbit5, which holds 1<<n for all sixteen n.
;
; ----------------------------------------------------------------------------
; ONE SHIFT PER PAIR, NOT PER BIT
; ----------------------------------------------------------------------------
; The bits are handled two at a time against a multiplicand that does not move
; between them.  After testing bit i and adding r5 once, bit i+1 is tested
; against the SAME r5 - and its partial product is 2*(a<<i), which is r5 added
; twice.  Then one `shl r5, r5, #2` serves the pair.
;
; It trades one unconditional shift for one conditional add, and the saving is
; that the extra add is only paid when the bit is set.
;
; THE MULTIPLICAND LIVES IN r1 so that every one of those adds is the pinned
; one-byte encoding at 0x07.  That costs the multiplier its register - it moves
; to r5, which a two-argument function owns anyway - and one extra `mov` in the
; setup, which the pinned `mov r1, r0` gives back.  Six adds in the loop go from
; two bytes to one: 37 bytes to 32.  On the byte-serial core that was cycles
; too, 124 to 113; on this one an add is a cycle whatever its length, and it is
; bytes alone.
;
; TWO IS STILL THE OPTIMUM.  Bit j of a group needs 2^j adds when it is set, a
; cycle each, and its `brclr` costs one cycle falling through and four taken,
; so with the group's shift at one a group of k bits costs
;
;       1 + sum(j < k) [ 4/2 + (1 + 2^j)/2 ]  =  1 + 2.5k + (2^k - 1)/2
;
;       k = 1   4.000 cycles a bit        the shift-every-bit version
;       k = 2   3.750                     <- this loop
;       k = 3   4.000
;       k = 4   4.625
;
; - ignoring the cycle a three-byte `brclr` at an odd address adds when it
; falls through.  The adds grow geometrically and the shift saved is just one
; instruction, so two holds.

mul_16_x4:
        mov     r5, r1                  ; 1   the multiplier vacates r1 ...
        mov     r1, r0                  ; 1   ... so the multiplicand can have it
        mov     r0, #0                  ; 1   acc = 0
.top:
        brclr   r5, #0x0001, .s0        ; 2
        add     r0, r0, r1              ; 1   += a<<i, in one byte
.s0:
        brclr   r5, #0x0002, .s1        ; 2
        add     r0, r0, r1              ; 1   twice, because r1 has not moved
        add     r0, r0, r1              ; 1   ... and 2*(a<<i) is a<<(i+1)
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
; mul_16_fast - unrolled the whole way, entered where the number starts
; ============================================================================
; MSB FIRST, which is the change that makes unrolling pay.  Working up from bit
; zero, a shorter multiplier has to be detected and jumped out of; working down
; from bit fifteen, it is entered LATE and the leading blocks are simply never
; executed.  The recurrence is
;
;       acc = acc * 2 + (bit ? a : 0)
;
; so each block is three instructions and exactly seven bytes:
;
;       shl     r0, r0, #1              double the accumulator
;       brclr   r1, #1<<k, .next        this bit clear: nothing to add
;       add     r0, r0, r5              set: add the multiplicand
;
; and a stays put in r5 the whole way, where the loop above has to keep
; shifting its copy.  That is the second saving and it is why there is no
; second scratch register in use.
;
; ----------------------------------------------------------------------------
; FINDING THE ENTRY POINT
; ----------------------------------------------------------------------------
; A computed goto is the obvious way in - clz gives the leading zero count and
; entry is base + clz*7 - and mul_16_fast_erik below does exactly that, in 29
; cycles flat.  THIS SECTION ORIGINALLY SAID 28 AND USED THAT TO DISMISS IT.
; The 28 was my arithmetic on a worse implementation than the one I was
; comparing against, and the two mistakes are both worth naming:
;
;   I reached for `callr` to get a PC-relative base - 3 bytes and 4 cycles -
;   plus an `add` to fold in the distance to the table, where a plain
;   `mov r5, #table` does the whole job in 3 bytes and 3 cycles.  I bought
;   position independence nobody had asked for.  Nobody ever did: `callr` has
;   since been removed from the ISA for exactly that reason.
;
;   And I zeroed the accumulator, 2 more cycles.  It does not need zeroing:
;   entering the chain at the block below the top set bit wants the accumulator
;   to hold exactly a, and r0 still does.  That is the trick immediately below
;   this paragraph - I had found it for the scan and not carried it across.
;
; So: 23, not 28, in 132 bytes rather than 158 - on the byte-serial core.  On
; the pipeline the same code costs more than its bytes: `push lr` and `pop lr`
; are memory instructions at six and five cycles, `clz` a two-step routine at
; four, and the jump into the chain goes through a register, at four.
;
; SO THE LINEAR SCAN OF brset WINS OUTRIGHT.  Sixteen tests, falling through
; until one hits: a cycle for each bit that is clear - two for the half of them
; that start at an odd address, since every one is three bytes - and four for
; the one that is set, so about 1.5c + 4 for c leading zeros.  The computed
; goto's prologue and its exit through `pop lr` cost more than that at every
; width, and they only meet at the bottom, where both are nearly all overhead:
;
;       b        clz    scan   computed
;       0xffff     0      62         82
;       0x0fff     4      54         68
;       0x03ff     6      50         61
;       0x00ff     8      46         54
;       0x000f    12      38         40
;       0            16      30         30
;
; On the byte-serial core the two crossed at c = 7, where an untaken `brset`
; cost three cycles; here it costs one or two, and the computed goto is only
; ever smaller.
;
; AND THE SCAN IS THE FIRST BLOCK'S TEST, not an extra one.  When it finds the
; top set bit at k, the accumulator should be exactly a - and r0 still holds a,
; because nothing has overwritten it yet.  So the scan jumps to block k-1 with
; the first partial product already in place, and the chain needs only fifteen
; blocks rather than sixteen.  The computed version gets the same thing free
; from the arithmetic: base + clz*7 IS the block below the top set bit.
mul_16_fast:
        mov     r5, r0                  ; 1   r5 = a, and r0 becomes the sum
        brset   r1, #0x8000, .b14    ; 2   top bit is 15: sum starts at a
        brset   r1, #0x4000, .b13    ; 1   top bit is 14: sum starts at a
        brset   r1, #0x2000, .b12    ; 2   top bit is 13: sum starts at a
        brset   r1, #0x1000, .b11    ; 1   top bit is 12: sum starts at a
        brset   r1, #0x0800, .b10    ; 2   top bit is 11: sum starts at a
        brset   r1, #0x0400, .b9     ; 1   top bit is 10: sum starts at a
        brset   r1, #0x0200, .b8     ; 2   top bit is 9: sum starts at a
        brset   r1, #0x0100, .b7     ; 1   top bit is 8: sum starts at a
        brset   r1, #0x0080, .b6     ; 2   top bit is 7: sum starts at a
        brset   r1, #0x0040, .b5     ; 1   top bit is 6: sum starts at a
        brset   r1, #0x0020, .b4     ; 2   top bit is 5: sum starts at a
        brset   r1, #0x0010, .b3     ; 1   top bit is 4: sum starts at a
        brset   r1, #0x0008, .b2     ; 2   top bit is 3: sum starts at a
        brset   r1, #0x0004, .b1     ; 1   top bit is 2: sum starts at a
        brset   r1, #0x0002, .b0     ; 2   top bit is 1: sum starts at a
        brset   r1, #0x0001, .short     ; 1   b == 1, and r0 is already a
        mov     r0, #0                  ; 1   b == 0
.short:
        ret                             ; 4
.b14:     shl     r0, r0, #1              ; 1
        brclr   r1, #0x4000, .b13   ; 2
        add     r0, r0, r5              ; 1
.b13:     shl     r0, r0, #1              ; 1
        brclr   r1, #0x2000, .b12   ; 1
        add     r0, r0, r5              ; 1
.b12:     shl     r0, r0, #1              ; 1
        brclr   r1, #0x1000, .b11   ; 2
        add     r0, r0, r5              ; 1
.b11:     shl     r0, r0, #1              ; 1
        brclr   r1, #0x0800, .b10   ; 1
        add     r0, r0, r5              ; 1
.b10:     shl     r0, r0, #1              ; 1
        brclr   r1, #0x0400, .b9    ; 2
        add     r0, r0, r5              ; 1
.b9:      shl     r0, r0, #1              ; 1
        brclr   r1, #0x0200, .b8    ; 1
        add     r0, r0, r5              ; 1
.b8:      shl     r0, r0, #1              ; 1
        brclr   r1, #0x0100, .b7    ; 2
        add     r0, r0, r5              ; 1
.b7:      shl     r0, r0, #1              ; 1
        brclr   r1, #0x0080, .b6    ; 1
        add     r0, r0, r5              ; 1
.b6:      shl     r0, r0, #1              ; 1
        brclr   r1, #0x0040, .b5    ; 2
        add     r0, r0, r5              ; 1
.b5:      shl     r0, r0, #1              ; 1
        brclr   r1, #0x0020, .b4    ; 1
        add     r0, r0, r5              ; 1
.b4:      shl     r0, r0, #1              ; 1
        brclr   r1, #0x0010, .b3    ; 2
        add     r0, r0, r5              ; 1
.b3:      shl     r0, r0, #1              ; 1
        brclr   r1, #0x0008, .b2    ; 1
        add     r0, r0, r5              ; 1
.b2:      shl     r0, r0, #1              ; 1
        brclr   r1, #0x0004, .b1    ; 2
        add     r0, r0, r5              ; 1
.b1:      shl     r0, r0, #1              ; 1
        brclr   r1, #0x0002, .b0    ; 1
        add     r0, r0, r5              ; 1
.b0:      shl     r0, r0, #1              ; 1
        brclr   r1, #0x0001, .done  ; 2
        add     r0, r0, r5              ; 1
.done:
        ret                             ; 4

; THE PAIRING TRICK DOES NOT COME HERE, and the reason is the dispatch.  This
; chain doubles the ACCUMULATOR rather than the multiplicand, so the same
; rearrangement applies in principle - one `shl r0, r0, #2` for two bits, with
; the higher one adding twice.  But the scan needs to enter at any bit, and
; half of those entries would land in the middle of a pair, after its shift had
; been skipped.  Each would need a stub of its own to make up the missing
; double, which costs more than the half cycle a bit it would save.
;
; So the pairing is worth having in the loop, where entry is always at the top,
; and not in the chain, where it never is.
;
; TWO EXITS, ONE BYTE EACH.  .short is for b of 0 or 1, which never reach the
; chain; .done is where the chain runs out.  Giving the chain its own `ret`
; rather than jumping back to the first one costs a byte and saves a branch on
; every single call - and the first draft of this routine, which assumed the
; chain could fall into the earlier `ret`, ran off the end of itself instead.


mul_16_fast_erik:
        push lr
        clz lr, r1  ; Gets 0-16 inclusive
        shl r5, lr, #3  ; Times 8
        sub lr, r5, lr  ; Times 7 because each part below is 7 bytes.
        mov r5, #.branch_table
        add lr, lr, r5
        mov r5, r0
        ret       ; jmp lr
.branch_table:
        shl     r0, r0, #1              ; 1
        brclr   r1, #0x4000, .b13   ; 2
        add     r0, r0, r5              ; 1
.b13:
        shl     r0, r0, #1              ; 1
        brclr   r1, #0x2000, .b12   ; 1
        add     r0, r0, r5              ; 1
.b12:
        shl     r0, r0, #1              ; 1
        brclr   r1, #0x1000, .b11   ; 2
        add     r0, r0, r5              ; 1
.b11:
        shl     r0, r0, #1              ; 1
        brclr   r1, #0x0800, .b10   ; 1
        add     r0, r0, r5              ; 1
.b10:
        shl     r0, r0, #1              ; 1
        brclr   r1, #0x0400, .b9    ; 2
        add     r0, r0, r5              ; 1
.b9:
        shl     r0, r0, #1              ; 1
        brclr   r1, #0x0200, .b8    ; 1
        add     r0, r0, r5              ; 1
.b8:
        shl     r0, r0, #1              ; 1
        brclr   r1, #0x0100, .b7    ; 2
        add     r0, r0, r5              ; 1
.b7:
        shl     r0, r0, #1              ; 1
        brclr   r1, #0x0080, .b6    ; 1
        add     r0, r0, r5              ; 1
.b6:
        shl     r0, r0, #1              ; 1
        brclr   r1, #0x0040, .b5    ; 2
        add     r0, r0, r5              ; 1
.b5:
        shl     r0, r0, #1              ; 1
        brclr   r1, #0x0020, .b4    ; 1
        add     r0, r0, r5              ; 1
.b4:
        shl     r0, r0, #1              ; 1
        brclr   r1, #0x0010, .b3    ; 2
        add     r0, r0, r5              ; 1
.b3:
        shl     r0, r0, #1              ; 1
        brclr   r1, #0x0008, .b2    ; 1
        add     r0, r0, r5              ; 1
.b2:
        shl     r0, r0, #1              ; 1
        brclr   r1, #0x0004, .b1    ; 2
        add     r0, r0, r5              ; 1
.b1:
        shl     r0, r0, #1              ; 1
        brclr   r1, #0x0002, .b0    ; 1
        add     r0, r0, r5              ; 1
.b0:
        shl     r0, r0, #1              ; 1
        brclr   r1, #0x0001, .done  ; 2
        add     r0, r0, r5              ; 1
.done:                                  ; table + 7*15, reached when b == 1
        pop     lr                      ; 5
        ret                             ; 4

; b == 0 IS THE ONE CASE THE ARITHMETIC DOES NOT COVER.  clz(0) is 16, so the
; entry lands on table + 7*16 - one slot past the end of a fifteen-block chain,
; which is four bytes past this `ret`.  Rather than pay three bytes and a cycle
; on every call to test for it, the slot is given something to land on:
; four bytes of nothing, then the answer.
;
; The two assertions below are what make that safe.  They pin the chain to
; fifteen seven-byte blocks and the zero slot to the sixteenth, so any edit
; that changes a block's size fails to assemble instead of jumping into the
; middle of an instruction.

        #res    4
.zero:                                  ; table + 7*16, reached when b == 0
        mov     r0, #0                  ; 1
        pop     lr                      ; 5
        ret                             ; 4

#assert mul_16_fast_erik.done - mul_16_fast_erik.branch_table == 7 * 15
#assert mul_16_fast_erik.zero - mul_16_fast_erik.branch_table == 7 * 16





; ============================================================================
; mul_16_nib - a nibble at a time, through a table of sixteen blocks
; ============================================================================
; Mask four bits of the multiplier into a block offset, add the table base and
; jump.  Each block adds k times the multiplicand for its own k, advances to
; the next nibble, and jumps straight to the next block - there is no loop, and
; every block carries its own copy of that tail.
;
; THE MULTIPLICAND LIVES IN r1, which is what the whole routine is built round.
; `add r0, r0, r1` is the pinned one-byte encoding at 0x07, so a block that
; wants k times the multiplicand can just add it k times - no scratch register,
; no shifting anything into place first.
;
; A BLOCK MAY SHIFT r1 AND THE TAIL SHIFTS LESS TO MATCH.  The nibble step is
; `r1 <<= 4`; a block that has already shifted it by two only needs two more.
; So the shift is borrowed rather than spent, and multiplying by 8 costs one
; shift and one add whose shift the tail was going to do anyway.  It may not
; exceed four - coming back down with `lsr` would drop bits off the top that
; the next nibble still needs.
;
; k = 14 AND k = 15 BORROW ALL FOUR and pay nothing for the shift: subtract the
; multiplicand once or twice, shift it up by four, add it back.  Their tails
; have no shift instruction at all, which is how a nibble of 15 - the most work
; there is to do - comes out cheaper than a nibble of 11.
;
; AND THE MASK KEEPS ITS REGISTER.  With no scratch needed, r5 is free for
; 0xf0, so the tail's `and` is the two-byte three-register form.  The routine
; still has only three long-lived values - base, multiplier, mask - so it is
; still one `push`.
;
; THE CHAINS ARE A SHORTEST-PATH SEARCH over (accumulator, how far r1 has been
; shifted), weighted by bytes and charging each block for the tail shift it
; leaves behind.  Every one of the sixteen then fits its block with its tail,
; so nothing jumps anywhere.  Bytes were cycles on the byte-serial core; on the
; pipeline it is instructions that cost, and a search weighted by them might
; come out differently.
;
; ----------------------------------------------------------------------------
; HOW IT GOT HERE - measured on the byte-serial core, where a cycle was a byte
; ----------------------------------------------------------------------------
;                                       bytes  cycles  a nibble  work  the rest
;       lr as temp, with a loop           279     123    25.75    6.00    19.75
;       no loop, mask in a register       276     102    16.25    6.00    10.25
;       r1 as temp, chains re-searched    276      98    16.25    4.56    10.75
;       r1 as the MULTIPLICAND            274      89    12.75    5.75     7.00
;
; The last step reads worse in the work column and is the largest gain of the
; four, because the columns are not comparable: the earlier versions paid a
; separate `shl r5, r5, #4` in every tail and this one does not - the block
; borrows that shift and the tail finishes what is left.  Counting it where it
; belongs, work went from 6.56 to 5.75 and the tail from 10 to 7.
;
; AND IT COST NOTHING TO GET THE MASK REGISTER BACK.  An earlier note here said
; the mask could not have one without a fourth push, because base, multiplier,
; multiplicand and mask are four long-lived values and only r5 is free.  That
; was true of a design with a separate scratch.  With the multiplicand IN the
; scratch's place there are three - base, multiplier, mask - r5 takes the mask,
; and it is still one `push`.  The register was not unaffordable; it was being
; spent on a temporary that did not need to exist.
;
; ----------------------------------------------------------------------------
; AND THE RADIX
; ----------------------------------------------------------------------------
; On the pipeline, measured: a nibble of 15 costs ten cycles, and a random one
; about 10.75 - 2.7 cycles a bit, where the plain loop is 7 and the unrolled
; chain about 4.  The block's adds and shifts are a cycle each whatever their
; length, and the dispatch, a computed `ret', is four.
;
; The first version of this came to 6.50 cycles a bit, on the byte-serial core,
; and was pointless beside a shift-and-add loop at 6.00.
;
; IT WAS THE FASTEST ROUTINE HERE AND IS NOT ANY MORE.  Its steady state is
; still the best, but it is bracketed by about forty cycles that no other
; routine pays: a three-register `push` and `pop` at ten and nine, the setup,
; the first dispatch, and the exit.  The chain's rounds are dearer and it has
; no such bracket, so even a full-width multiplier, where all four nibbles do
; work, goes to the chain - 80 cycles against 62 on 0xffff - and a uniformly
; random one 83 against 70.  On an 8-bit multiplier mul_16_x4 beats it 46
; against 61, in 32 bytes rather than 274.

mul_16_nib:
        push    lr, r2, r3              ; 10  three for the price of two
        mov     r3, r1                  ; 1   the multiplier vacates r1 first
        mov     r1, r0                  ; 1   ... and the multiplicand takes it
        mov     r0, #0                  ; 1   acc = 0
        mov     r2, #.table             ; 2
        mov     r5, #0xf0               ; 1   the mask, in a register again
        shl     lr, r3, #4              ; 1   nibble 0 has to be scaled by hand
        and     lr, lr, r5              ; 1
        add     lr, lr, r2              ; 1
        ret                             ; 4
.done:
        pop     r3, r2, lr              ; 9
        ret                             ; 4

; --- the table: sixteen blocks on a sixteen-byte stride ---------------------
.table:
.k0:
        br      eq, r3, #0, .done       ; 1   the whole routine's exit test
        and     lr, r3, r5              ; 1   next nibble, already times 16
        lsr     r3, r3, #4              ; 1
        shl     r1, r1, #4              ; 1   the rest of the nibble step
        add     lr, lr, r2              ; 1
        ret                             ; 4
        #res    16 - ($ - .k0)
.k1:   
        add     r0, r0, r1
        and     lr, r3, r5              ; 1   next nibble, already times 16
        lsr     r3, r3, #4              ; 1
        shl     r1, r1, #4              ; 1   the rest of the nibble step
        add     lr, lr, r2              ; 1
        ret                             ; 4
        #res    16 - ($ - .k1)
.k2:   
        add     r0, r0, r1
        add     r0, r0, r1
        and     lr, r3, r5              ; 1   next nibble, already times 16
        lsr     r3, r3, #4              ; 1
        shl     r1, r1, #4              ; 1   the rest of the nibble step
        add     lr, lr, r2              ; 1
        ret                             ; 4
        #res    16 - ($ - .k2)
.k3:   
        add     r0, r0, r1
        add     r0, r0, r1
        add     r0, r0, r1
        and     lr, r3, r5              ; 1   next nibble, already times 16
        lsr     r3, r3, #4              ; 1
        shl     r1, r1, #4              ; 1   the rest of the nibble step
        add     lr, lr, r2              ; 1
        ret                             ; 4
        #res    16 - ($ - .k3)
.k4:   
        shl     r1, r1, #2
        add     r0, r0, r1
        and     lr, r3, r5              ; 1   next nibble, already times 16
        lsr     r3, r3, #4              ; 1
        shl     r1, r1, #2              ; 1   the rest of the nibble step
        add     lr, lr, r2              ; 1
        ret                             ; 4
        #res    16 - ($ - .k4)
.k5:   
        add     r0, r0, r1
        shl     r1, r1, #2
        add     r0, r0, r1
        and     lr, r3, r5              ; 1   next nibble, already times 16
        lsr     r3, r3, #4              ; 1
        shl     r1, r1, #2              ; 1   the rest of the nibble step
        add     lr, lr, r2              ; 1
        ret                             ; 4
        #res    16 - ($ - .k5)
.k6:   
        shl     r1, r1, #1
        add     r0, r0, r1
        add     r0, r0, r1
        add     r0, r0, r1
        and     lr, r3, r5              ; 1   next nibble, already times 16
        lsr     r3, r3, #4              ; 1
        shl     r1, r1, #3              ; 1   the rest of the nibble step
        add     lr, lr, r2              ; 1
        ret                             ; 4
        #res    16 - ($ - .k6)
.k7:   
        rsb     r0, r1, r0
        shl     r1, r1, #3
        add     r0, r0, r1
        and     lr, r3, r5              ; 1   next nibble, already times 16
        lsr     r3, r3, #4              ; 1
        shl     r1, r1, #1              ; 1   the rest of the nibble step
        add     lr, lr, r2              ; 1
        ret                             ; 4
        #res    16 - ($ - .k7)
.k8:   
        shl     r1, r1, #3
        add     r0, r0, r1
        and     lr, r3, r5              ; 1   next nibble, already times 16
        lsr     r3, r3, #4              ; 1
        shl     r1, r1, #1              ; 1   the rest of the nibble step
        add     lr, lr, r2              ; 1
        ret                             ; 4
        #res    16 - ($ - .k8)
.k9:   
        add     r0, r0, r1
        shl     r1, r1, #3
        add     r0, r0, r1
        and     lr, r3, r5              ; 1   next nibble, already times 16
        lsr     r3, r3, #4              ; 1
        shl     r1, r1, #1              ; 1   the rest of the nibble step
        add     lr, lr, r2              ; 1
        ret                             ; 4
        #res    16 - ($ - .k9)
.k10:  
        add     r0, r0, r1
        add     r0, r0, r1
        shl     r1, r1, #3
        add     r0, r0, r1
        and     lr, r3, r5              ; 1   next nibble, already times 16
        lsr     r3, r3, #4              ; 1
        shl     r1, r1, #1              ; 1   the rest of the nibble step
        add     lr, lr, r2              ; 1
        ret                             ; 4
        #res    16 - ($ - .k10)
.k11:  
        add     r0, r0, r1
        add     r0, r0, r1
        add     r0, r0, r1
        shl     r1, r1, #3
        add     r0, r0, r1
        and     lr, r3, r5              ; 1   next nibble, already times 16
        lsr     r3, r3, #4              ; 1
        shl     r1, r1, #1              ; 1   the rest of the nibble step
        add     lr, lr, r2              ; 1
        ret                             ; 4
        #res    16 - ($ - .k11)
.k12:  
        shl     r1, r1, #2
        add     r0, r0, r1
        add     r0, r0, r1
        add     r0, r0, r1
        and     lr, r3, r5              ; 1   next nibble, already times 16
        lsr     r3, r3, #4              ; 1
        shl     r1, r1, #2              ; 1   the rest of the nibble step
        add     lr, lr, r2              ; 1
        ret                             ; 4
        #res    16 - ($ - .k12)
.k13:  
        add     r0, r0, r1
        shl     r1, r1, #2
        add     r0, r0, r1
        add     r0, r0, r1
        add     r0, r0, r1
        and     lr, r3, r5              ; 1   next nibble, already times 16
        lsr     r3, r3, #4              ; 1
        shl     r1, r1, #2              ; 1   the rest of the nibble step
        add     lr, lr, r2              ; 1
        ret                             ; 4
        #res    16 - ($ - .k13)
.k14:  
        rsb     r0, r1, r0
        rsb     r0, r1, r0
        shl     r1, r1, #4
        add     r0, r0, r1
        and     lr, r3, r5              ; 1   next nibble, already times 16
        lsr     r3, r3, #4              ; 1
        add     lr, lr, r2              ; 1
        ret                             ; 4
        #res    16 - ($ - .k14)
.k15:  
        rsb     r0, r1, r0
        shl     r1, r1, #4
        add     r0, r0, r1
        and     lr, r3, r5              ; 1   next nibble, already times 16
        lsr     r3, r3, #4              ; 1
        add     lr, lr, r2              ; 1
        ret                             ; 4
        #res    16 - ($ - .k15)

#assert mul_16_nib.k1  - mul_16_nib.table == 16
#assert mul_16_nib.k15 - mul_16_nib.table == 15 * 16


; ============================================================================
; mul_16_16_32 - unsigned 16 x 16 -> 32                              52 bytes
; ============================================================================
; a in r0, b in r1; result low in r0, high in r1.  Meant as a building block
; for wider multiplies, so it follows the ABI and touches nothing else.
;
;       r0  accumulator low, and a on the way in     r2  multiplicand high
;       r1  multiplier, then the result high         r3  accumulator high
;       lr  multiplicand low                         r5  scratch
;
; Shift and add with both sides widened: the accumulator is r3:r0 and the
; multiplicand r2:lr, both 32 bits, and the multiplier shifts down out of r1.
;
; Two things carried over from mul_16.  The smaller operand becomes the
; multiplier, so the loop runs over as few bits as it can - worth about half
; the time on lopsided operands.  And r0 doubles as a and as the accumulator's
; low half: if bit 0 of the multiplier is set the first partial product is
; already sitting in r0, and its high half is zero because a is 16 bits.
;
; ----------------------------------------------------------------------------
; THE CARRY TEST IS SAFE WHEN THE ADDEND IS ZERO, which is worth stating
; because it is the trap add32.s warns about and the addend really does reach
; zero here: the multiplicand is a << i, so a = 0x8000 leaves nothing in the
; low half after one step, and every set bit of b above bit 0 then adds zero.
;
;       br      hs, r0, lr, .clear      ; sum >= addend means no carry
;
; With lr = 0 the sum is unchanged and `sum < 0` is never true, so it reports
; no carry - which is right, because adding zero cannot carry.  The form that
; breaks is the negation, `A >= -B`: negating zero gives zero and it reports a
; carry on every add.  65541 multiplies with a chosen to zero the low half
; agree.
;
; ----------------------------------------------------------------------------
; TWO THINGS THE FIRST DRAFT PAID FOR AND DID NOT NEED
; ----------------------------------------------------------------------------
;       first draft   53 bytes   355 cycles      on the byte-serial core
;       this          52 bytes   316 cycles      on the byte-serial core
;       this          52 bytes   208 cycles      on the pipeline
;
; THE LOOP IS ROTATED, as in mul_16: the two conditional branches at the bottom
; ARE the loop control, so there is no `jmpr` back to the top and no separate
; `br eq, r1, #0` to test for the end - a taken branch a bit fewer, four cycles.
;
; AND THE CARRY BETWEEN THE MULTIPLICAND'S HALVES IS BRANCHLESS.  The bit
; leaving the low half is `lsr r5, lr, #15` - 15 is in the shift3 table, so
; that is a two-byte three-register form - and it is simply `or`ed into the
; high half after it shifts.  Four instructions, four cycles, no branch, where
; testing bit 15 and conditionally setting bit 0 would be three instructions
; and a branch taken half the time - four and a half.

mul_16_16_32:
        br      ls, r1, r0, .smallest   ; 1   b is already the smaller
        mov     r5, r0                  ; 1
        mov     r0, r1                  ; 1   pinned
        mov     r1, r5                  ; 1   ... and fall through
.smallest:
        push    r2, r3, lr              ; 10
        lsr     r2, r0, #15             ; 1   multiplicand high = a >> 15
        shl     lr, r0, #1              ; 1   multiplicand low  = a << 1
        mov     r3, #0                  ; 1   accumulator high
        brset   r1, #1, .entry          ; 1   bit 0 set: r0 is already the sum
        mov     r0, #0                  ; 1   otherwise start it at zero
        jmpr    .entry                  ; 3
.set:
        add     r0, r0, lr              ; 1
        add     r3, r3, r2              ; 1
        br      hs, r0, lr, .clear      ; 1   sum >= addend means no carry
        add     r3, r3, #1              ; 1
.clear:
        lsr     r5, lr, #15             ; 1   the bit about to leave the low half
        shl     r2, r2, #1              ; 1
        or      r2, r2, r5              ; 1
        shl     lr, lr, #1              ; 1
.entry:
        lsr     r1, r1, #1              ; 1   LOGICAL, or the loop never ends
.end:
        brset   r1, #1, .set            ; 2
        br      ne, r1, #0, .clear      ; 1
.done:
        mov     r1, r3                  ; 1
        pop     lr, r3, r2              ; 9   push order reversed
        ret                             ; 4

; THE MULTIPLICAND IS PRE-SHIFTED BY ONE at entry, for the same reason mul_16
; pre-shifts its copy: bit 0 of the multiplier has already been accounted for,
; so the first pass through .clear would otherwise shift one time too few.
; r2 = a >> 15 and lr = a << 1 are the two halves of a << 1.
