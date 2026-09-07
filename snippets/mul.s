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
;       mul_16              21       163        79        163
;       mul_16_x4           37       121        62        121
;       mul_16_fast        158       101        73        101
;       mul_16_fast_erik   132       114        62        114
;       mul_16_nib         276        98        67         98
;       mul_16_min           8       163        83         88
;
; THE FIRST THREE ROWS HAVE IDENTICAL FIRST AND LAST COLUMNS, and that is the
; whole argument for the fourth.  Their cost is a function of the MULTIPLIER
; alone - how wide the multiplicand is does not enter into it - so handing them
; a small number in the wrong register buys nothing at all.  mul_16_min is the
; only row where those two columns differ, because it is the only one that can
; decide which operand the multiplier is.
;
; THE PLAIN LOOP IS ALREADY GOOD, and it is worth saying why before improving
; on it.  It costs 10 cycles for a set bit and 11 for a clear one, and about
; 6.5 of that is the two branches.  The obvious loop -
;
;       .top:   brclear r1, #1, .skip
;               add     r0, r0, r5
;       .skip:  shl     r5, r5, #1
;               lsr     r1, r1, #1
;               br      ne, r1, #0, .top
;
; - has only one bit test but pays a separate loop-back branch, and comes to
; 12.5 cycles a bit.  Rotating the loop so the two conditional branches ARE the
; loop control is what buys the 2 cycles, and it is why unrolling has to give
; something back before it gains anything.
;
; UNROLLING IS WORTH ABOUT A QUARTER.  Four bits to a group amortises the
; counter shift and the loop branch over four bits instead of paying two
; branches for each, and costs 16 bytes.  Handling those four as two pairs
; rather than four singles - see below - is what takes it from a fifth to a
; quarter, and costs nothing at all.
;
; FULLY UNROLLING IS WORTH ABOUT A THIRD, and only above 7 bits.  It is the
; fastest thing here for a wide multiplier and the slowest for a narrow one,
; because its dispatch has to walk down to the top set bit.  158 bytes.
;
; AND THE BIGGEST SINGLE WIN IS NOT UNROLLING AT ALL.  All of these cost time
; per bit of the MULTIPLIER and nothing for its leading zeros, so which operand
; sits in r1 matters more than any of the above: 8 bytes of compare and swap
; take the last column from 163 to 88 on the plain loop, and 129 to 76 on the
; four-bit one.  It costs ~3 cycles when it does not help.
;
; AND IT PAYS FOR ITSELF TWICE, because it also removes the zero test.  Both
; loops used to open with `br eq, r0, #0` - three bytes and three cycles on
; every call, to save a hundred and sixty on the rare one where an operand is
; zero.  With the swap in front that test is dead: zero is the smallest value
; there is, so a zero operand is always the one that ends up as the multiplier,
; and a zero multiplier drops out of the bottom of the loop on the first pass
; without any help.  Removing it took three cycles off every column above.
;
; The only caller that loses is one that jumps straight to `mul_16` with a zero
; in r0 and something wide in r1 - 163 cycles rather than 4.  Through
; mul_16_min the same call is 26.
;
; WHICH TO USE.  mul_16_x4, with mul_16_min in front of it - 45 bytes together,
; never worst in any column, and it ties the best unrolled chain outright in
; the middle one.  mul_16 if space is the binding constraint.
;
; Neither fully unrolled version is easy to justify any more.  Between them
; they cost 132 or 158 bytes to beat 45 by at most 16%, and only on multipliers
; that use most of their sixteen bits; on eight-bit multipliers mul_16_x4 ties
; the better of them exactly.  They are here because the dispatch question is
; interesting, not because the answer is to use one.  mul_16_nib has the best
; steady state of any of them - 3.83 cycles a bit - and the worst prologue, so
; it wins on wide multipliers and loses to a 37-byte loop on narrow ones.  It
; is the one to look at if 276 bytes is affordable, and the one to widen to
; radix 256 if seven kilobytes is.
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
; jump in either.  It does mean a CLEAR bit costs one cycle more than a set
; one - 11 against 10 - because it reaches .clear through a taken branch while
; a set bit reaches .set through one and then falls through.

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
        br      ls, r1, r0, mul_16      ; 3   b is already the smaller
        mov     r5, r0                  ; 2
        mov     r0, r1                  ; 2
        mov     r1, r5                  ; 2   ... and fall through


; ============================================================================
; mul_16 - shift and add, one bit at a time                          21 bytes
; ============================================================================
mul_16:
        shl     r5, r0, #1              ; 2   r5 = a << 1
        brset   r1, #1, .entry          ; 3   bit 0 set: r0 already holds a
        mov     r0, #0                  ; 1   otherwise start the sum at zero
        jmpr    .entry                  ; 2
.set:
        add     r0, r0, r5              ; 2
.clear:
        shl     r5, r5, #1              ; 2
.entry:
        lsr     r1, r1, #1              ; 2   LOGICAL: an arithmetic shift would
.end:                                   ;     never clear r1 and never end
        brset   r1, #1, .set            ; 3
        br      ne, r1, #0, .clear      ; 3
        ret                             ; 1


; ============================================================================
; mul_16_x4 - the same loop, four bits at a time                     37 bytes
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
; It trades one unconditional shift for one conditional add, and an add and a
; shift are both two bytes and two cycles - so the group is the same 14 bytes
; either way, and the saving is that the extra add is only paid when the bit is
; set.  Half a cycle a bit: 129 down to 121.
;
; TWO IS THE OPTIMUM, and not by a little.  Bit j of a group needs 2^j adds
; when it is set, so with a branch at 3 cycles falling through and 4 taken, a
; group of k bits costs
;
;       2 + sum(j < k) [ 4/2 + (3 + 2^(j+1))/2 ]  =  1 + 3.5k + 2^k
;
;       k = 1   6.500 cycles a bit        the shift-every-bit version
;       k = 2   6.000                     <- this loop
;       k = 3   6.500
;       k = 4   7.750
;
; The shift saved is one instruction however wide the group, and the adds grow
; geometrically, so k = 2 is where those cross.  A third bit would need four
; adds and give back everything the pairing won.

mul_16_x4:
        mov     r5, r0                  ; 2   r5 = a
        mov     r0, #0                  ; 1   acc = 0, in the pinned byte
.top:
        brclear r1, #0x0001, .s0        ; 3
        add     r0, r0, r5              ; 2   += a<<i
.s0:
        brclear r1, #0x0002, .s1        ; 3
        add     r0, r0, r5              ; 2   twice, because r5 has not moved
        add     r0, r0, r5              ; 2   ... and 2*(a<<i) is a<<(i+1)
.s1:
        shl     r5, r5, #2              ; 2   one shift for the pair
        brclear r1, #0x0004, .s2        ; 3
        add     r0, r0, r5              ; 2
.s2:
        brclear r1, #0x0008, .s3        ; 3
        add     r0, r0, r5              ; 2
        add     r0, r0, r5              ; 2
.s3:
        shl     r5, r5, #2              ; 2
        lsr     r1, r1, #4              ; 2
        br      ne, r1, #0, .top        ; 3
        ret                             ; 1

; Four bits cost 4 branches, up to 4 adds, 4 shifts, a counter shift and a loop
; branch - against eight branches and the rest for the same four bits above.


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
;       brclear r1, #1<<k, .next        this bit clear: nothing to add
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
; entry is base + clz*7 - and mul_16_fast_erik below does exactly that, in 23
; cycles flat.  THIS SECTION ORIGINALLY SAID 28 AND USED THAT TO DISMISS IT.
; The 28 was my arithmetic on a worse implementation than the one I was
; comparing against, and the two mistakes are both worth naming:
;
;   I reached for `callr` to get a PC-relative base - 3 bytes and 4 cycles -
;   plus an `add` to fold in the distance to the table, where a plain
;   `mov r5, #table` does the whole job in 3 bytes and 3 cycles.  I bought
;   position independence nobody had asked for.
;
;   And I zeroed the accumulator, 2 more cycles.  It does not need zeroing:
;   entering the chain at the block below the top set bit wants the accumulator
;   to hold exactly a, and r0 still does.  That is the trick immediately below
;   this paragraph - I had found it for the scan and not carried it across.
;
; So: 23, not 28, in 132 bytes rather than 158.
;
; A LINEAR SCAN OF brset IS STILL CHEAPER WHERE IT MATTERS, but by much less
; than that comparison claimed.  Sixteen tests, falling through until one hits:
; 3 cycles for each bit that is clear and 4 for the one that is set, so 3c + 4
; for c leading zeros, against a flat 23.  They cross at c = 5, not c = 8:
;
;       b        clz    scan   computed
;       0xffff     0     112        128
;       0x0fff     4      96        100
;       0x03ff     6      88         86
;       0x00ff     8      80         72
;       0x000f    12      64         44
;       0            16      52         24
;
; c is 0 half the time and 1 a quarter of the time on uniformly random input,
; so the scan still wins there - 101 against 114.  On anything narrower the
; computed goto wins, and it wins by a great deal at the bottom.  Which is the
; better dispatch depends entirely on what the multipliers look like, and the
; computed one is smaller either way.
;
; AND THE SCAN IS THE FIRST BLOCK'S TEST, not an extra one.  When it finds the
; top set bit at k, the accumulator should be exactly a - and r0 still holds a,
; because nothing has overwritten it yet.  So the scan jumps to block k-1 with
; the first partial product already in place, and the chain needs only fifteen
; blocks rather than sixteen.  The computed version gets the same thing free
; from the arithmetic: base + clz*7 IS the block below the top set bit.
mul_16_fast:
        mov     r5, r0                  ; 2   r5 = a, and r0 becomes the sum
        brset   r1, #0x8000, .b14    ; 3   top bit is 15: sum starts at a
        brset   r1, #0x4000, .b13    ; 3   top bit is 14: sum starts at a
        brset   r1, #0x2000, .b12    ; 3   top bit is 13: sum starts at a
        brset   r1, #0x1000, .b11    ; 3   top bit is 12: sum starts at a
        brset   r1, #0x0800, .b10    ; 3   top bit is 11: sum starts at a
        brset   r1, #0x0400, .b9     ; 3   top bit is 10: sum starts at a
        brset   r1, #0x0200, .b8     ; 3   top bit is 9: sum starts at a
        brset   r1, #0x0100, .b7     ; 3   top bit is 8: sum starts at a
        brset   r1, #0x0080, .b6     ; 3   top bit is 7: sum starts at a
        brset   r1, #0x0040, .b5     ; 3   top bit is 6: sum starts at a
        brset   r1, #0x0020, .b4     ; 3   top bit is 5: sum starts at a
        brset   r1, #0x0010, .b3     ; 3   top bit is 4: sum starts at a
        brset   r1, #0x0008, .b2     ; 3   top bit is 3: sum starts at a
        brset   r1, #0x0004, .b1     ; 3   top bit is 2: sum starts at a
        brset   r1, #0x0002, .b0     ; 3   top bit is 1: sum starts at a
        brset   r1, #0x0001, .short     ; 3   b == 1, and r0 is already a
        mov     r0, #0                  ; 2   b == 0
.short:
        ret                             ; 1
.b14:     shl     r0, r0, #1              ; 2
        brclear r1, #0x4000, .b13   ; 3
        add     r0, r0, r5              ; 2
.b13:     shl     r0, r0, #1              ; 2
        brclear r1, #0x2000, .b12   ; 3
        add     r0, r0, r5              ; 2
.b12:     shl     r0, r0, #1              ; 2
        brclear r1, #0x1000, .b11   ; 3
        add     r0, r0, r5              ; 2
.b11:     shl     r0, r0, #1              ; 2
        brclear r1, #0x0800, .b10   ; 3
        add     r0, r0, r5              ; 2
.b10:     shl     r0, r0, #1              ; 2
        brclear r1, #0x0400, .b9    ; 3
        add     r0, r0, r5              ; 2
.b9:      shl     r0, r0, #1              ; 2
        brclear r1, #0x0200, .b8    ; 3
        add     r0, r0, r5              ; 2
.b8:      shl     r0, r0, #1              ; 2
        brclear r1, #0x0100, .b7    ; 3
        add     r0, r0, r5              ; 2
.b7:      shl     r0, r0, #1              ; 2
        brclear r1, #0x0080, .b6    ; 3
        add     r0, r0, r5              ; 2
.b6:      shl     r0, r0, #1              ; 2
        brclear r1, #0x0040, .b5    ; 3
        add     r0, r0, r5              ; 2
.b5:      shl     r0, r0, #1              ; 2
        brclear r1, #0x0020, .b4    ; 3
        add     r0, r0, r5              ; 2
.b4:      shl     r0, r0, #1              ; 2
        brclear r1, #0x0010, .b3    ; 3
        add     r0, r0, r5              ; 2
.b3:      shl     r0, r0, #1              ; 2
        brclear r1, #0x0008, .b2    ; 3
        add     r0, r0, r5              ; 2
.b2:      shl     r0, r0, #1              ; 2
        brclear r1, #0x0004, .b1    ; 3
        add     r0, r0, r5              ; 2
.b1:      shl     r0, r0, #1              ; 2
        brclear r1, #0x0002, .b0    ; 3
        add     r0, r0, r5              ; 2
.b0:      shl     r0, r0, #1              ; 2
        brclear r1, #0x0001, .done  ; 3
        add     r0, r0, r5              ; 2
.done:
        ret                             ; 1

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
        shl     r0, r0, #1              ; 2
        brclear r1, #0x4000, .b13   ; 3
        add     r0, r0, r5              ; 2
.b13:
        shl     r0, r0, #1              ; 2
        brclear r1, #0x2000, .b12   ; 3
        add     r0, r0, r5              ; 2
.b12:
        shl     r0, r0, #1              ; 2
        brclear r1, #0x1000, .b11   ; 3
        add     r0, r0, r5              ; 2
.b11:
        shl     r0, r0, #1              ; 2
        brclear r1, #0x0800, .b10   ; 3
        add     r0, r0, r5              ; 2
.b10:
        shl     r0, r0, #1              ; 2
        brclear r1, #0x0400, .b9    ; 3
        add     r0, r0, r5              ; 2
.b9:
        shl     r0, r0, #1              ; 2
        brclear r1, #0x0200, .b8    ; 3
        add     r0, r0, r5              ; 2
.b8:
        shl     r0, r0, #1              ; 2
        brclear r1, #0x0100, .b7    ; 3
        add     r0, r0, r5              ; 2
.b7:
        shl     r0, r0, #1              ; 2
        brclear r1, #0x0080, .b6    ; 3
        add     r0, r0, r5              ; 2
.b6:
        shl     r0, r0, #1              ; 2
        brclear r1, #0x0040, .b5    ; 3
        add     r0, r0, r5              ; 2
.b5:
        shl     r0, r0, #1              ; 2
        brclear r1, #0x0020, .b4    ; 3
        add     r0, r0, r5              ; 2
.b4:
        shl     r0, r0, #1              ; 2
        brclear r1, #0x0010, .b3    ; 3
        add     r0, r0, r5              ; 2
.b3:
        shl     r0, r0, #1              ; 2
        brclear r1, #0x0008, .b2    ; 3
        add     r0, r0, r5              ; 2
.b2:
        shl     r0, r0, #1              ; 2
        brclear r1, #0x0004, .b1    ; 3
        add     r0, r0, r5              ; 2
.b1:
        shl     r0, r0, #1              ; 2
        brclear r1, #0x0002, .b0    ; 3
        add     r0, r0, r5              ; 2
.b0:
        shl     r0, r0, #1              ; 2
        brclear r1, #0x0001, .done  ; 3
        add     r0, r0, r5              ; 2
.done:                                  ; table + 7*15, reached when b == 1
        pop     lr                      ; 4
        ret                             ; 1

; b == 0 IS THE ONE CASE THE ARITHMETIC DOES NOT COVER.  clz(0) is 16, so the
; entry lands on table + 7*16 - one slot past the end of a fifteen-block chain,
; which is four bytes past this `ret`.  Rather than pay three bytes and three
; cycles on every call to test for it, the slot is given something to land on:
; four bytes of nothing, then the answer.
;
; The two assertions below are what make that safe.  They pin the chain to
; fifteen seven-byte blocks and the zero slot to the sixteenth, so any edit
; that changes a block's size fails to assemble instead of jumping into the
; middle of an instruction.

        #res    4
.zero:                                  ; table + 7*16, reached when b == 0
        mov     r0, #0                  ; 1
        pop     lr                      ; 4
        ret                             ; 1

#assert mul_16_fast_erik.done - mul_16_fast_erik.branch_table == 7 * 15
#assert mul_16_fast_erik.zero - mul_16_fast_erik.branch_table == 7 * 16




; ============================================================================
; mul_16_nib - a nibble at a time, through a table of sixteen blocks
; ============================================================================
; Mask four bits of the multiplier into a block offset, add the table base and
; jump.  Each block adds k times the multiplicand for its own k, then advances
; to the next nibble and jumps straight to the next block - there is no loop.
;
; THE NIBBLE IS TAKEN ALREADY SCALED.  `and lr, r3, #0xf0` reads bits 4 to 7 -
; the nibble AFTER the one being processed - and those bits are already that
; nibble times sixteen, which is exactly the block offset.  Doing it before
; `lsr r3, r3, #4` rather than after removes the scaling shift completely.
;
; THERE IS NO LOOP.  The tail IS the dispatch: it computes the next block's
; address and `ret`s to it, so blocks chain directly into one another.
;
; AND THE TERMINATION TEST LIVES IN BLOCK ZERO.  The chain ends when the
; shifted multiplier reaches zero - and if it does, the nibble just read from
; bits 4 to 7 was zero too, so the last dispatch is always to block 0.  That is
; the only block that has to ask, and it asks once a call, not once a nibble.
;
; ----------------------------------------------------------------------------
; THE TEMP IS r1, WHICH IS WHAT THE BLOCKS ARE BUILT AROUND
; ----------------------------------------------------------------------------
; `add r0, r0, r1` is the pinned one-byte encoding at 0x07, and it is the
; instruction these blocks are made of - 24 of the 48 in the table.  Putting
; the temp anywhere else makes every one of them two bytes.
;
; That costs the multiplier its register: it moves to r3, and the 0xf0 mask
; loses its own and becomes an immediate, one byte and one cycle dearer in the
; tail.  Worth it several times over.
;
; GIVING THE MASK ITS REGISTER BACK COSTS MORE THAN THE BYTE IT SAVES, and the
; reason is not the swap - moving the multiplier to r5 instead of r3 costs the
; same one `mov` either way.  It is that the mask would be a FOURTH long-lived
; value, and there is only one free register to put one of them in:
;
;       r0   accumulator     pinned by `add r0, r0, r1`
;       r1   temp            pinned by the same
;       lr   the block address, rebuilt every nibble and destroyed by `ret`
;       ---
;       base, multiplier, multiplicand        three that must live somewhere
;       + mask, if it gets a register         four
;
; A two-argument function owns r0, r1 and r5 outright, so r5 houses exactly one
; of them however they are shuffled and the rest are callee-saved.  Three saved
; registers is one `push` instruction; four is two, and the second costs four
; cycles going in and four coming out.
;
; The mask register does buy something real - a nine-byte tail, which lets all
; sixteen blocks inline it instead of thirteen - and it is still not enough:
;
;                                        bytes   b 16-bit   b 8-bit
;       mask in r3, multiplier in r4       283      101.1      73.7
;       mask as an immediate               276       98.0      67.1
;
; Differencing a four-nibble call against a two-nibble one separates the two
; effects exactly:
;
;                                   per nibble   prologue + epilogue
;       mask in r3, 16/16 inline          14.0                  47.0
;       mask immediate, 13/16 inline      15.0                  37.0
;
; So the register is worth ONE cycle a nibble - the shorter `and` and the three
; extra inlined tails together - and costs TEN once.  Four nibbles cannot repay
; it and two are twice as far from repaying it, which is why the gap widens
; from 6 cycles to 8 as the multiplier gets narrower.  A radix-256 table, where
; a round is eight bits, would repay it and then some; at radix 16 it does not.
;
; THE WAY TO AFFORD IT IS TO DROP THE BASE, not to shuffle the others.  With
; the table at address zero, `and lr, r3, r2` with r2 = 0xf0 IS the block
; address: the mask gets its register, `add lr, lr, r2` disappears, the tail
; falls to seven bytes, and there are still only three long-lived values so it
; is still one push.  Two cycles a nibble and a byte, for free.
;
; That is a decision about the machine's memory map rather than about this
; routine - 256 bytes of jump table at address 0 is a large thing to spend -
; so it is a note here and not a change.
;
; AND ADDING THE TEMP BEATS SHIFTING IT, up to a point.  Three copies of 2a is
; 6a for three one-byte adds; shifting to 4a and adding again costs the same
; three instructions but four bytes.  So k = 3, 6, 11, 12 and 13 all set the
; temp once and add it repeatedly.  Past three copies the shift wins again -
; four adds cost four where a shift and an add cost three - which is why k = 8
; shifts and k = 6 does not.
;
; The chains are a shortest-path search over (accumulator, log of the temp)
; weighted by BYTES, not a hand-derived table, because the one-byte add makes
; the arithmetic unobvious: 4.56 cycles a nibble against 6.00 when the temp was
; lr and every add cost two.
;
; `push lr, r2, r3` costs the same eight cycles as pushing two separately and
; two bytes fewer, so the third saved register is free.
;
; ----------------------------------------------------------------------------
; WHERE THE CYCLES WENT
; ----------------------------------------------------------------------------
;                                     bytes  cycles  a nibble   work  overhead
;       lr as temp, with a loop         279     123    25.75    6.00     19.75
;       no loop, mask in a register     276     102    16.25    6.00     10.25
;       r1 as temp, chains re-searched  276      98    16.25    4.56     10.75
;
; Two separate things, and the second only became worth doing because of the
; first: cutting the overhead in half made the blocks the majority of the cost,
; and moving the temp into r1 then cut those by a quarter.
;
; AND THE RADIX ARGUMENT MOVES WITH IT.  A table has to amortise its dispatch,
; so halving the dispatch halves how wide the table must be to pay for itself:
;
;       radix   work a round   + overhead   cycles a bit   table
;           2   a branch a bit                      6.00   none
;          16       4.56           15.31            3.83   256 B
;         256       8.95           19.70            2.46   ~7 KB
;
; The first version of this came to 6.50 cycles a bit and was pointless beside
; a shift-and-add loop at 6.00.  It is 3.83 now, and radix 256 would be 2.46
; for about seven kilobytes.
;
; IT IS THE FASTEST HERE ON A 16-BIT MULTIPLIER - 98 against mul_16_fast's 101
; - and still loses on an 8-bit one, 67 against mul_16_x4's 62.  Thirty-three
; cycles of prologue want four nibbles to amortise and two do not give it
; enough.  That is the shape of the whole routine: the best steady state in the
; file behind the most expensive way in.

mul_16_nib:
        push    lr, r2, r3              ; 8   three for the price of two
        mov     r2, #.table             ; 3
        mov     r3, r1                  ; 2   the multiplier vacates r1
        mov     r5, r0                  ; 2   r5 = a
        mov     r0, #0                  ; 1   acc = 0
        shl     lr, r3, #4              ; 2   nibble 0 has to be scaled by hand
        and     lr, lr, #0xf0           ; 3
        add     lr, lr, r2              ; 2
        ret                             ; 1
.done:
        pop     r3, r2, lr              ; 8   and back in the same order
        ret                             ; 1

; --- the table: sixteen blocks on a sixteen-byte stride ---------------------
; A block with room for the ten-byte tail keeps its own copy and saves the jump
; back; the three that have not end with `jmpr .next`, which is block 0's copy.

.table:
.k0:
        br      eq, r3, #0, .done       ; 3   the whole routine's exit test
.next:
        and     lr, r3, #0xf0   ; the NEXT nibble, already times 16
        lsr     r3, r3, #4      ; 
        shl     r5, r5, #4      ; 
        add     lr, lr, r2      ; 
        ret                     ; straight into the next block
        #res    16 - ($ - .k0)
.k1:   
        add     r0, r0, r5
        and     lr, r3, #0xf0   ; the NEXT nibble, already times 16
        lsr     r3, r3, #4      ; 
        shl     r5, r5, #4      ; 
        add     lr, lr, r2      ; 
        ret                     ; straight into the next block
        #res    16 - ($ - .k1)
.k2:   
        shl     r1, r5, #1
        add     r0, r0, r1
        and     lr, r3, #0xf0   ; the NEXT nibble, already times 16
        lsr     r3, r3, #4      ; 
        shl     r5, r5, #4      ; 
        add     lr, lr, r2      ; 
        ret                     ; straight into the next block
        #res    16 - ($ - .k2)
.k3:   
        shl     r1, r5, #0
        add     r0, r0, r1
        add     r0, r0, r1
        add     r0, r0, r1
        and     lr, r3, #0xf0   ; the NEXT nibble, already times 16
        lsr     r3, r3, #4      ; 
        shl     r5, r5, #4      ; 
        add     lr, lr, r2      ; 
        ret                     ; straight into the next block
        #res    16 - ($ - .k3)
.k4:   
        shl     r1, r5, #2
        add     r0, r0, r1
        and     lr, r3, #0xf0   ; the NEXT nibble, already times 16
        lsr     r3, r3, #4      ; 
        shl     r5, r5, #4      ; 
        add     lr, lr, r2      ; 
        ret                     ; straight into the next block
        #res    16 - ($ - .k4)
.k5:   
        shl     r1, r5, #2
        add     r0, r0, r1
        add     r0, r0, r5
        and     lr, r3, #0xf0   ; the NEXT nibble, already times 16
        lsr     r3, r3, #4      ; 
        shl     r5, r5, #4      ; 
        add     lr, lr, r2      ; 
        ret                     ; straight into the next block
        #res    16 - ($ - .k5)
.k6:   
        shl     r1, r5, #1
        add     r0, r0, r1
        add     r0, r0, r1
        add     r0, r0, r1
        and     lr, r3, #0xf0   ; the NEXT nibble, already times 16
        lsr     r3, r3, #4      ; 
        shl     r5, r5, #4      ; 
        add     lr, lr, r2      ; 
        ret                     ; straight into the next block
        #res    16 - ($ - .k6)
.k7:   
        shl     r1, r5, #3
        add     r0, r0, r1
        rsb     r0, r5, r0
        and     lr, r3, #0xf0   ; the NEXT nibble, already times 16
        lsr     r3, r3, #4      ; 
        shl     r5, r5, #4      ; 
        add     lr, lr, r2      ; 
        ret                     ; straight into the next block
        #res    16 - ($ - .k7)
.k8:   
        shl     r1, r5, #3
        add     r0, r0, r1
        and     lr, r3, #0xf0   ; the NEXT nibble, already times 16
        lsr     r3, r3, #4      ; 
        shl     r5, r5, #4      ; 
        add     lr, lr, r2      ; 
        ret                     ; straight into the next block
        #res    16 - ($ - .k8)
.k9:   
        shl     r1, r5, #3
        add     r0, r0, r1
        add     r0, r0, r5
        and     lr, r3, #0xf0   ; the NEXT nibble, already times 16
        lsr     r3, r3, #4      ; 
        shl     r5, r5, #4      ; 
        add     lr, lr, r2      ; 
        ret                     ; straight into the next block
        #res    16 - ($ - .k9)
.k10:  
        shl     r1, r5, #3
        add     r0, r0, r1
        shl     r1, r5, #1
        add     r0, r0, r1
        and     lr, r3, #0xf0   ; the NEXT nibble, already times 16
        lsr     r3, r3, #4      ; 
        shl     r5, r5, #4      ; 
        add     lr, lr, r2      ; 
        ret                     ; straight into the next block
        #res    16 - ($ - .k10)
.k11:  
        shl     r1, r5, #2
        add     r0, r0, r1
        add     r0, r0, r1
        add     r0, r0, r1
        rsb     r0, r5, r0
        jmpr    .next                   ; no room for the tail
        #res    16 - ($ - .k11)
.k12:  
        shl     r1, r5, #2
        add     r0, r0, r1
        add     r0, r0, r1
        add     r0, r0, r1
        and     lr, r3, #0xf0   ; the NEXT nibble, already times 16
        lsr     r3, r3, #4      ; 
        shl     r5, r5, #4      ; 
        add     lr, lr, r2      ; 
        ret                     ; straight into the next block
        #res    16 - ($ - .k12)
.k13:  
        shl     r1, r5, #2
        add     r0, r0, r1
        add     r0, r0, r1
        add     r0, r0, r1
        add     r0, r0, r5
        jmpr    .next                   ; no room for the tail
        #res    16 - ($ - .k13)
.k14:  
        shl     r1, r5, #4
        add     r0, r0, r1
        shl     r1, r5, #1
        rsb     r0, r1, r0
        jmpr    .next                   ; no room for the tail
        #res    16 - ($ - .k14)
.k15:  
        shl     r1, r5, #4
        add     r0, r0, r1
        rsb     r0, r5, r0
        and     lr, r3, #0xf0   ; the NEXT nibble, already times 16
        lsr     r3, r3, #4      ; 
        shl     r5, r5, #4      ; 
        add     lr, lr, r2      ; 
        ret                     ; straight into the next block
        #res    16 - ($ - .k15)

#assert mul_16_nib.k1  - mul_16_nib.table == 16
#assert mul_16_nib.k15 - mul_16_nib.table == 15 * 16
