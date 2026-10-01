; ============================================================================
; memcpy.s - the same copy, five times, each one faster
; ============================================================================
;
;       memcpy(src, dst, count)      src in r0, dst in r1, count in r2
;
; ARGUMENT ORDER IS NOT C's.  C puts the destination first; this puts the
; source first, because `add r0, r0, #2` and `add r0, r0, r1` are the pinned
; one-byte forms and the source pointer is the one that moves in every single
; loop below.  A byte per iteration is worth more than matching a prototype
; nobody assembles against.
;
; REGISTERS.  Under isa/abi.s a three-argument function gets r0, r1, r2 as
; caller-saved arguments and r5 as caller-saved scratch, so these four are free
; to clobber.  r3, r4 and lr are callee-saved and only the last routine touches
; them - it saves them first.
;
; ----------------------------------------------------------------------------
; THE LADDER
; ----------------------------------------------------------------------------
; Every figure below is measured by tests/sim-check.mjs, not counted by hand,
; and the test fails if a rung gets slower or copies the wrong bytes.  See the
; cost model under [cpu] in the spec: an ALU instruction or a branch not taken
; is a cycle, whatever its length; a taken branch is four; and a memory
; instruction stops the pipeline while it makes its accesses, one a cycle -
; N + 3 cycles for a load of N accesses, N + 4 for a store.  An access is a
; byte, or a whole word at an even address: a word at an odd one is two.  So
; `ld8` is 4 and `st8` 5, `ld` 4 and `st` 5 at an even address and 5 and 6 at
; an odd one, and a word loaded and stored costs 9 cycles of which only 2 move
; it.  Every rung below is a story about moving more bytes per memory
; instruction.  The column beside each instruction is its cost at an even
; address.
;
;                                                     c/B even  c/B odd  at 256
;       memcpy                   byte at a time, counted    16.0000  16.0000  16.01
;       memcpy2                  word at a time, counted     8.0000   9.0000   8.02
;       memcpy3                  word at a time, no counter  7.5000   8.5000   7.54
;       memcpy4                  two words, no counter       6.0000   7.0000   6.04
;       memcpy_divisible_by_32   pop and push, sp the cursor 3.7500   4.7500   3.87
;
; The first two columns are the loop alone, recovered by differencing two
; lengths so that the setup cancels - with both buffers even, and with both
; odd; the third is a whole 256-byte call, even, setup included.  The last
; rung's odd figure is lower than the others' because its bookkeeping lives
; on the real stack, which stays even.
;
; For scale, a 6502 does 13 cycles/byte, or 10 with self-modifying code.  So the
; naive loop here is behind a decent 6502 loop, and the last rung is three and
; a half times faster than one.  Copying a byte costs two cycles nothing can
; remove, one to read it and one to write it - or one, a word at a time with
; both buffers even, so 1.00 is the floor there and 2.00 at an odd address.
;
; WHERE IT ENDS UP.  snippets/speed-of-light-memcpy-core.s reached 4.67, a byte
; a cycle, with pop and plain stores and no handover at all - and found that
; swapping sp between the pointers with `mov`s, a cycle each, and writing with
; push beat that.  It has not been measured with aligned words.
; ============================================================================


; ============================================================================
; 1.  byte at a time, counted                                     16.0000 c/B
; ============================================================================
; The obvious loop, and the baseline everything else is measured against.  Six
; instructions to move a single byte: 9 cycles for the load and the store, of
; which 2 move the byte, 3 for the counter and the pointers, and 4 for the
; taken branch - so 14 of the 16 cycles are the machine starting memory
; instructions and working out where to read next.

memcpy:
        br      eq, r2, #0, .done       ; a zero count must not wrap the counter
.top:
        ld8     r5, [r0]                ;                               4
        st8     r5, [r1]                ;                               5
        add     r0, r0, #1              ; one byte: the pinned form     1
        add     r1, r1, #1              ; two bytes: r1 is not pinned   1
        add     r2, r2, #-1             ;                               1
        br      ne, r2, #0, .top        ;                               4
.done:
        ret

; THE ZERO TEST IS NOT OPTIONAL.  The loop is do-while, so a count of 0 would
; decrement to 0xffff and copy 64K.  Every later rung pays the same three bytes
; for the same reason.


; ============================================================================
; 2.  word at a time, counted                        8.0000 c/B, 9.0000 odd
; ============================================================================
; Unaligned 16-bit access is legal, so the word loop needs no alignment
; preamble - it just runs, whatever the pointers are.  That is the single
; biggest reason this rung is nearly free to write.  At an odd address a word
; goes a byte at a time and costs a cycle more, load and store alike.
;
; Same six instructions, twice the data - 16 cycles an iteration, the same as
; the byte loop's, for two bytes instead of one; 18 at an odd address.  A
; memory instruction's three or four cycles of overhead are the same whichever
; width it is, so widening the access buys back half the loop.  The odd byte
; left over at the end is handled once, after the loop.

memcpy2:
        br      lo, r2, #2, .tail       ; fewer than two bytes: no loop at all
.top:
        ld      r5, [r0]                ;                               4
        st      r5, [r1]                ;                               5
        add     r0, r0, #2              ; one byte: also pinned         1
        add     r1, r1, #2              ;                               1
        add     r2, r2, #-2             ;                               1
        br      hs, r2, #2, .top        ; at least two left             4
.tail:
        br      eq, r2, #0, .done       ; 0 or 1 bytes remain
        ld8     r5, [r0]
        st8     r5, [r1]
.done:
        ret

; `lo` and `hs` are the unsigned pair, and 2 is in the condimm5 table, so both
; tests are three bytes with no register loaded first.  Signed `lt` here would
; be a bug waiting for a count above 32767.


; ============================================================================
; 3.  word at a time, no counter                     7.5000 c/B, 8.5000 odd
; ============================================================================
; The counter is redundant: the source pointer already knows how far it has
; gone.  Turn count into a source LIMIT once, and the loop loses an instruction
; - `add r2, r2, #-2` disappears and the branch compares r0 against r2 instead
; of against zero.  One cycle per word - 8.00 down to 7.50 - bought with one
; instruction of setup.
;
; The cost is that an odd count no longer falls out of the loop; it has to be
; peeled off the FRONT, because the limit test is what ends the loop and it can
; only stop on an even boundary.  And peeling a byte off the front moves both
; pointers to the other parity: even buffers with an odd count run the loop at
; the odd figure.

memcpy3:
        brclr   r2, #1, .even           ; count even?  one instruction, no ALU
        ld8     r5, [r0]
        st8     r5, [r1]
        add     r0, r0, #1
        add     r1, r1, #1
        add     r2, r2, #-1
.even:
        br      eq, r2, #0, .done
        add     r2, r0, r2              ; r2 = src limit, and count is gone
.top:
        ld      r5, [r0]                ;                               4
        st      r5, [r1]                ;                               5
        add     r0, r0, #2              ;                               1
        add     r1, r1, #2              ;                               1
        br      lo, r0, r2, .top        ;                               4
.done:
        ret

; `brclr r2, #1` tests bit 0 in one three-byte instruction and touches no
; register.  The mask is an immbit5, which holds single bits and their
; complements - so #1 is fine and #3 would be rejected, which matters in the
; next rung.


; ============================================================================
; 4.  two words per iteration, no counter            6.0000 c/B, 7.0000 odd
; ============================================================================
; Unrolling once amortises the loop tail - one branch and one pair of pointer
; bumps now serve four bytes instead of two - and the second word rides on the
; offset field for free, since `[r0, #2]` is the same two bytes as `[r0]`.
;
; The head is a loop rather than a straight run because the alignment condition
; is `count & 3`, and brclr cannot express a two-bit mask: immbit5 holds
; single bits and their complements, nothing else.  So this rung pays an `and`
; and re-tests, which is why the setup is uglier than rung 3's.  As in rung 3,
; each byte peeled flips both pointers' parity.

memcpy4:
        and     r5, r2, #3              ; 3 is in imm3, so two bytes
        br      eq, r5, #0, .even
.odd:
        ld8     r5, [r0]                ; strip bytes until count is a multiple
        st8     r5, [r1]                ; of four
        add     r0, r0, #1
        add     r1, r1, #1
        add     r2, r2, #-1
        jmpr    memcpy4                 ; re-test: at most three trips
.even:
        br      eq, r2, #0, .done
        add     r2, r0, r2              ; r2 = src limit
.top:
        ld      r5, [r0]                ;                               4
        st      r5, [r1]                ;                               5
        ld      r5, [r0, #2]            ;                               4
        st      r5, [r1, #2]            ;                               5
        add     r0, r0, #4              ; two bytes: 4 is not pinned    1
        add     r1, r1, #4              ;                               1
        br      lo, r0, r2, .top        ;                               4
.done:
        ret

; NOTE WHAT UNROLLING STOPS BUYING.  Every word costs a load and a store, 9
; cycles even, and the loop around them 6: rung 3 spends 15 cycles to move 2
; bytes, this spends 24 to move 4, a third word would spend 33 to move 6 and a
; fourth 42 to move 8.  That is 7.50, 6.00, 5.50, 5.25 cycles/byte - each step
; recovers less than half of what the last one did, and all of it converges on
; the 4.50 a load-store pair costs, only 1.00 of which is the data.  Getting
; below that needs a different instruction, not a longer loop.  Next rung.


; ============================================================================
; 5.  pop and push, with sp as the cursor            3.7500 c/B, 4.7500 odd
; ============================================================================
; `pop rA, rB, rC` reads six bytes in 6 cycles, and `push` writes six in 7 -
; 9 and 10 at an odd address.  Nothing else in the machine moves more than one
; register per instruction, and a word through `ld` and `st` costs 9.  Both of them are hardwired to sp - so to use them for a copy,
; sp has to BE the pointer, first the source and then the destination.
;
; INTERRUPTS MUST HAVE THEIR OWN STACK POINTER while this runs.  sp spends the
; whole loop pointing into the buffers, and anything that pushed to it would
; land in the middle of the copy.  That is a real constraint on the machine.
;
; THE COUNT MUST BE A NON-ZERO MULTIPLE OF 32.  A general memcpy would peel the
; remainder first with rung 4 and call this for the bulk.
;
; ----------------------------------------------------------------------------
; The register squeeze, which is what shapes the whole routine:
;
;       r0-r5   the six data registers - a pop triple twice over
;       sp      whichever pointer is being walked right now
;       lr      the base of a three-word block holding src, dst and limit
;
; There is no eighth register, so the pointer that is NOT in sp has to live in
; memory, and lr has to point at it.  The block sits on the real stack, pushed
; by the prologue, which is why lr is saved before anything else.
;
; PUSH RUNS BACKWARDS, so the destination is biased twelve bytes high and the
; register lists are reversed: `push r5, r4, r3` writes r3 lowest.  Pop leaves
; sp advanced for free; push leaves it at the START of what it wrote, which is
; why each handover adds a constant to get back to the next block's bias.

memcpy_divisible_by_32:
        push    lr, r4, r3              ; callee saves, on the REAL stack
        add     r1, r1, #12             ; bias the destination
        add     r2, r0, r2              ; count becomes a source limit
        push    r2, r1, r0              ; [sp]=src  [sp+2]=dst+12  [sp+4]=limit
        mov     lr, sp                  ; lr is the only pointer left
        ld      sp, [lr]                ; sp = src, and the real stack is gone
.top:
        pop     r0, r1, r2              ; src +0  .. +5                 6
        pop     r3, r4, r5              ; src +6  .. +11                6
        ld      sp, [lr, #2]            ; sp = dst + 12                 4
        push    r5, r4, r3              ; dst +6  .. +11                7
        push    r2, r1, r0              ; dst +0  .. +5,  sp = dst      7
        ld      sp, [lr]                ;                               4
        add     sp, sp, #12             ; sp = src + 12                 1
        pop     r0, r1, r2              ; src +12 .. +17                6
        pop     r3, r4, r5              ; src +18 .. +23                6
        ld      sp, [lr, #2]            ;                               4
        add     sp, sp, #12             ; sp = dst + 24                 1
        push    r5, r4, r3              ; dst +18 .. +23                7
        push    r2, r1, r0              ; dst +12 .. +17                7
        ld      sp, [lr]                ;                               4
        add     sp, sp, #24             ; sp = src + 24, three bytes    1
        pop     r0, r1                  ; src +24 .. +27                5
        pop     r2, r3                  ; src +28 .. +31                5
        mov     r4, sp                  ; r4 = src + 32, the next src   1
        ld      sp, [lr, #2]            ;                               4
        add     sp, sp, #20             ; three bytes at an odd address 2
        push    r3, r2                  ; dst +28 .. +31                6
        push    r1, r0                  ; dst +24 .. +27, sp = dst+24   6
        ld      r5, [lr, #4]            ; the limit                     4
        st      r4, [lr]                ; write the source back         5
        add     sp, sp, #20             ; sp = (dst+32) + 12, the bias  1
        st      sp, [lr, #2]            ; write the destination back    5
        mov     sp, r4                  ; sp = src again                1
        br      ne, r5, r4, .top        ;                               4
        add     sp, lr, #6              ; drop the three-word block
        pop     r3, r4, lr              ; and the real stack is back
        ret

; WHERE THE 120 CYCLES GO, with both buffers even.  The pops and pushes are 74
; of them and move all 32 bytes: 2.31 per byte, of which 1.00 is the read and
; the write, a word at a time, that no machine can avoid and 1.31 is what each
; of the twelve pays to start - three cycles a pop and four a push.  The
; other 46 - 1.44 per byte - is pointer juggling: five `ld sp` handovers at
; four cycles each, the limit load, the two write-backs at five, the
; constants that undo push's backwards walk, and the branch.  At an odd
; address the pops and pushes take 106, a byte a cycle, and the juggling -
; on the even stack - is the same 46.  A third of this routine is spent deciding where sp is pointing, and
; most of that is the pointers living in memory, because there is no register
; to keep them in.
;
; WHY 32 AND NOT 12.  Twelve bytes - one pop-triple each way - is the smallest
; block that works, and it would cost the same 20 cycles of bookkeeping at the
; bottom of the loop: the limit load, the two write-backs, the two `mov`s that
; shuttle the source through r4, and the branch.  That is 20 over 12 bytes, 1.67
; per byte, against 20 over 32, or 0.63.  Better by a cycle per byte, for the
; cost of writing the block out twice more.  Bigger would be
; better again, until the branch runs out of reach - which at 65 bytes of loop
; body is not far off.
;
; AND WHY IT IS STILL NOT THE FLOOR.  speed-of-light-memcpy-core.s keeps both
; pointers in registers.  With sp on the source for the whole copy and the
; writes through ordinary stores it reached 4.6667 when every access was a
; byte; swapping sp between the two with `mov`s, a cycle each, and writing with
; push, 4.03.  Those figures predate aligned words and have not been measured
; again.
