; ============================================================================
; speed-of-light-memcpy-core.s - how fast can this machine copy memory?
; ============================================================================
;
; The trick is that `pop` moves three registers in one two-byte instruction, so
; the SOURCE pointer costs almost nothing to read through - if you are willing
; to point sp at it.  The destination is written with ordinary stores.
;
; Entry, for both cores below:
;
;       sp  source, and it advances                 lr  the real sp, saved
;       r0  destination, and it advances            r3  data
;       r1  10, the destination bump                r4  data
;       r2  destination limit                       r5  data
;
; INTERRUPTS MUST HAVE THEIR OWN STACK POINTER while this runs.  sp is a data
; pointer here, and anything that pushed to it would land in the middle of the
; source buffer.  That is a real constraint on the machine, not a detail of the
; routine - it is the price of the whole technique.
;
; ----------------------------------------------------------------------------
; THE COST MODEL
; ----------------------------------------------------------------------------
; The bus is 6502-like: one cycle per byte, carrying instruction fetch and data
; alike.  So an instruction costs the bytes it occupies plus the bytes it moves,
; and tools/sim.js counts both - every figure here is measured, not counted by
; hand.
;
; Copying a byte costs two bus cycles that no instruction set can avoid: one to
; read it and one to write it.  Everything above 2.000 is instruction fetch, and
; that is the only thing a better loop can attack.
;
;       2.000   bus: one read and one write per byte           IRREDUCIBLE
;       1.000   store fetch: 2 instruction bytes per 2 stored
;       0.333   pop fetch: 2 instruction bytes per 6 read
;       0.100   pointer bump: 1 byte per 5 stores
;       -----
;       3.433   the floor for this instruction mix, plus the branch
;
; The store is what costs: two bytes of instruction to move two bytes of data.
; Nothing in the ISA writes more than one register to memory per instruction
; except `push`, and push and pop cannot both use sp at once.  Swapping sp
; between source and destination costs four `mov`s per switch, which is exactly
; break-even against just storing - so 1.000 stands.
;
; WHY FIVE STORES PER BUMP.  A store reaches [r0, #imm3], and imm3 holds
; { -1, 0, 1, 2, 3, 4, 6, 8 }.  The offsets have to be two apart, and the
; longest run of those in the table is 0, 2, 4, 6, 8 - five of them.  Then r0
; has to move, and `add r0, r0, r1` is one byte only because r0 and r1 are the
; registers the one-byte abbreviation at 0x07 pins.
;
; ----------------------------------------------------------------------------
; MEASURED
; ----------------------------------------------------------------------------
;   erik   32 bytes/iteration   51 bytes   3.5938 cycles/byte
;   mine   60 bytes/iteration   89 bytes   3.4833 cycles/byte
;
; For scale: a 6502 does 13 cycles/byte, or 10 with self-modifying code.
;
; 3.4833 is the best available under a 90-byte core.  Searching every loop
; length and every stores-per-bump count that fits, N = 60 with five stores per
; bump wins; N = 48, 54 and 58 all tie at 3.5000 behind it.  The next step up,
; N = 66, needs 98 bytes.
; ============================================================================


; ============================================================================
; erik - 32 bytes per iteration, 51 bytes, 3.5938 cycles/byte
; ============================================================================
; Correct, and the sp lands exactly on src + n.  What holds it back is that 32
; bytes is 16 words, which is not a multiple of three - so the last `pop` moves
; a single register and spends two instruction bytes to fetch two data bytes,
; the same rate as a store.

erik:
  pop r3, r4, r5
  st r3, [r0, #0]
  st r4, [r0, #2]
  st r5, [r0, #4]
  pop r3, r4, r5
  st r3, [r0, #6]
  st r4, [r0, #8]
  add r0, r0, r1
  st r5, [r0, #0]
  pop r3, r4, r5
  st r3, [r0, #2]
  st r4, [r0, #4]
  st r5, [r0, #6]
  pop r3, r4, r5
  st r3, [r0, #8]
  add r0, r0, r1
  st r4, [r0, #0]
  st r5, [r0, #2]
  pop r3, r4, r5
  st r3, [r0, #4]
  st r4, [r0, #6]
  st r5, [r0, #8]
  pop r3
  add r0, r0, #2
  st r3, [r0, #8]
  add r0, r0, r1
  br ne, r0, r2, erik
erik_end:


; ============================================================================
; 60 bytes per iteration, 89 bytes, 3.4833 cycles/byte
; ============================================================================
; Sixty is the smallest length that makes both counts come out whole: it is a
; multiple of six, so every `pop` moves three registers, and a multiple of ten,
; so every pointer bump is followed by exactly five stores.  Nothing in the loop
; is a partial anything.
;
; That is the entire improvement.  The instruction mix is identical to erik`s;
; it just stops wasting the ends.

memcpy_core:
  pop r3, r4, r5
  st r3, [r0, #0]
  st r4, [r0, #2]
  st r5, [r0, #4]
  pop r3, r4, r5
  st r3, [r0, #6]
  st r4, [r0, #8]
  add r0, r0, r1
  st r5, [r0, #0]
  pop r3, r4, r5
  st r3, [r0, #2]
  st r4, [r0, #4]
  st r5, [r0, #6]
  pop r3, r4, r5
  st r3, [r0, #8]
  add r0, r0, r1
  st r4, [r0, #0]
  st r5, [r0, #2]
  pop r3, r4, r5
  st r3, [r0, #4]
  st r4, [r0, #6]
  st r5, [r0, #8]
  add r0, r0, r1
  pop r3, r4, r5
  st r3, [r0, #0]
  st r4, [r0, #2]
  st r5, [r0, #4]
  pop r3, r4, r5
  st r3, [r0, #6]
  st r4, [r0, #8]
  add r0, r0, r1
  st r5, [r0, #0]
  pop r3, r4, r5
  st r3, [r0, #2]
  st r4, [r0, #4]
  st r5, [r0, #6]
  pop r3, r4, r5
  st r3, [r0, #8]
  add r0, r0, r1
  st r4, [r0, #0]
  st r5, [r0, #2]
  pop r3, r4, r5
  st r3, [r0, #4]
  st r4, [r0, #6]
  st r5, [r0, #8]
  add r0, r0, r1
  br ne, r0, r2, memcpy_core
memcpy_core_end:
