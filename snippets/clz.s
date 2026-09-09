; ============================================================================
; clz.s - count leading zeros, in software
; ============================================================================
;
;       int clz(uint16_t x)     r0 = x, returns 0..16 in r0
;
; Two versions of the same shape: three `brclear` tests narrow the answer to a
; nibble, then the nibble is resolved either by a table (clz) or by four more
; bit tests (clz2).  Written to price the TENTATIVE `clz` opcode against the
; ~45 logic cells the hardware version measures at.
;
; r0, r1 and r5 are all caller saved always, so this needs no prologue.  r5 is
; also the assembler's scratch, so nothing here may need an immediate
; expansion - tests/run.sh assembles snippets against the --noat ruledef, which
; is what keeps that honest rather than remembered.
; ============================================================================

; The three masks are all in immask5 - 0xff00, 0xf000 and 0xfff0 - so each test
; is one two-byte instruction with no constant to build first.  That is what
; the mask column bought.

clztable:
        #d8 4                           ; 0000
        #d8 3                           ; 0001
        #d8 2                           ; 0010
        #d8 2                           ; 0011
        #d8 1                           ; 0100
        #d8 1                           ; 0101
        #d8 1                           ; 0110
        #d8 1                           ; 0111
        #d8 0, 0, 0, 0, 0, 0, 0, 0      ; 1000 .. 1111

; --- table version ---------------------------------------------------------
clz:
        brclear r0, #0xff00, .b8        ; high byte empty: answer is 8..16
        brclear r0, #0xf000, .b4        ; top nibble empty: answer is 4..7
        mov     r1, #0                  ; answer is 0..3
        lsr     r0, r0, #12
.epilog:
        and     r0, r0, #15
        mov     r5, #clztable
        add     r5, r5, r0
        ld8     r0, [r5, #0]
        add     r0, r0, r1
        ret
.b4:
        lsr     r0, r0, #8              ; the `and` above drops the top nibble
        mov     r1, #4
        jmpr    .epilog
.b8:
        brclear r0, #0xfff0, .b12       ; answer is 12..16
        lsr     r0, r0, #4              ; answer is 8..11
        mov     r1, #8
        jmpr    .epilog
.b12:
        mov     r1, #12
        jmpr    .epilog

; --- no-table version ------------------------------------------------------
; The same narrowing, then four `brset` tests instead of a load.  No table, no
; r5, and no `and`: each path shifts its nibble down to bits 3..0 and the bits
; above it are known zero, so testing bit 3 downwards is exact.
clz2:
        brclear r0, #0xff00, .b8
        brclear r0, #0xf000, .b4
        mov     r1, #0
        lsr     r0, r0, #12
.epilog:
        brset   r0, #8, .done
        add     r1, r1, #1
        brset   r0, #4, .done
        add     r1, r1, #1
        brset   r0, #2, .done
        add     r1, r1, #1
        brset   r0, #1, .done
        add     r1, r1, #1
.done:
        mov     r0, r1
        ret
.b4:
        lsr     r0, r0, #8
        mov     r1, #4
        jmpr    .epilog
.b8:
        brclear r0, #0xfff0, .b12
        lsr     r0, r0, #4
        mov     r1, #8
        jmpr    .epilog
.b12:
        mov     r1, #12
        jmpr    .epilog

; --- undefined at zero -----------------------------------------------------
; gcc's __builtin_clz leaves clz(0) undefined, and the fp routines special-case
; zero anyway, so this asks what the guarantee is worth.  The answer turns out
; to be almost nothing - see the measurement in the header.
clz_nz:
        brclear r0, #0xff00, .b8
        brclear r0, #0xf000, .b4
        mov     r1, #0
        lsr     r0, r0, #12
.epilog:
        mov     r5, #clztable
        add     r5, r5, r0
        ld8     r0, [r5, #0]
        add     r0, r0, r1
        ret
.b4:
        lsr     r0, r0, #8
        mov     r1, #4
        jmpr    .epilog
.b8:
        brclear r0, #0xfff0, .b12
        lsr     r0, r0, #4
        mov     r1, #8
        jmpr    .epilog
.b12:
        mov     r1, #12
        jmpr    .epilog

; --- one byte-wide table ---------------------------------------------------
; 256 bytes of table instead of 16, and one test instead of three.
bigtable:
        #d8 8, 7, 6, 6, 5, 5, 5, 5, 4, 4, 4, 4, 4, 4, 4, 4
        #d8 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3
        #d8 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2
        #d8 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2
        #d8 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1
        #d8 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1
        #d8 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1
        #d8 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1
        #d8 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0
        #d8 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0
        #d8 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0
        #d8 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0
        #d8 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0
        #d8 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0
        #d8 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0
        #d8 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0
clz_big:
        mov     r5, #bigtable
        brclear r0, #0xff00, .low
        lsr     r0, r0, #8
        add     r5, r5, r0
        ld8     r0, [r5, #0]
        ret
.low:
        add     r5, r5, r0
        ld8     r0, [r5, #0]
        add     r0, r0, #8
        ret
