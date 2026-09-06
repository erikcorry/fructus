; uint16 * uint16 -> unint16
; We either know it won't overflow or we don't care.
; Follows calling convention.
; 21 or 24 bytes.
mul_16:
  br eq, r0, #0, .done              ; 3 (optional)
mul_16_we_know_r0_is_non_zero:
  ; r5 is the lhs and we initialize it with r0 * 2 to save a dynamic instruction.
  shl r5, r0, #1  ; r5 = lhs        ; 2
  ; If the low bit of r1 is 1 then the accumulator in r0 already has the first addition.
  brset r1, #1, .entry              ; 3
  ; Otherwise, zero the accumulator.
  mov r0, #0  ; Accumulator         ; 1
  ; Skip most of the first iteration.
  jmpr .entry                       ; 2
.set
  add r0, r5                        ; 2
.clear:
  shl r5, #1                        ; 2
.entry:
  asr r1, #1                        ; 2
.end:
  brset r1, #1, .set                ; 3
  br ne, r1, #0, .clear             ; 3
.done
  ret                               ; 4
