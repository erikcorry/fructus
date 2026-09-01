; ============================================================================
; data.s - constants in ROM, and struct offsets
; ============================================================================
;
; Two things this pins down, both of which are silent when wrong.
;
; ENDIANNESS.  customasm's built-in `#d16` and `#d32` write the MOST significant
; byte first, whatever the target is.  `#d16 0x1234` assembles to 12 34, and
; `ld` on a little-endian machine reads that back as 0x3412 - no error, no
; warning, just a byte-swapped constant.  `dw` and `dd`, generated from the
; spec's own `endian`, are the ones to use.
;
; STRUCT OFFSETS.  customasm has no struct type, but its scoped constants are
; enough: a label followed by `.name = ...` definitions, referenced from
; anywhere as `label.name`.  Each field can be written in terms of the previous
; one, so inserting a field renumbers the rest and the size stays correct.
;
; POINTERS ARE TAGGED, so a field access subtracts the tag.  That is why the
; spec's displacements count bytes and are not scaled by the access width - the
; resulting offsets are ODD, and a scaled displacement could not express them.
; Both accesses below assemble to two bytes because 1 and 3 are in the imm3
; table {-1, 0, 1, 2, 3, 4, 6, 8}, which is what that table is for.
; ============================================================================

node:                                   ; a heap object's layout
.next  = 0
.value = .next  + 2
.kind  = .value + 2
.SIZE  = .kind  + 2

TAG    = 1                              ; heap pointers carry 1 in the low bit

obj:
    dw  0x1111                          ; node.next
    dw  0x2222                          ; node.value
    dw  0x3333                          ; node.kind
word:
    dw  0xbeef
long:
    dd  0x89abcdef                      ; a 32-bit value, as a register pair
                                        ; would be spilled: low half lower
text:
    #d  "hi"                            ; #d takes a whole string; #d8 wants
    #d8 0                               ; exactly one byte, so it cannot

data_test:
    mov  r1, #(obj + TAG)               ; a TAGGED pointer to obj
    ld r0, [r1, #node.value - TAG]    ; 2 - 1 = 1, a two-byte encoding
    ld r2, [r1, #node.kind  - TAG]    ; 4 - 1 = 3, likewise
    mov  r1, #word
    ld r3, [r1, #0]                   ; 0xbeef, not 0xefbe
    mov  r1, #long
    ld r4, [r1, #2]                   ; the HIGH half, at the HIGHER address
    ld r5, [r1, #0]                   ; the low half.  Loaded last, because
                                        ; r5 is the assembler's scratch and any
                                        ; long immediate above would destroy it
data_done:
