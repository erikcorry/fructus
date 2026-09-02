; memcpy using sp for src and regular register for dest.
; len is divisible by 32 in this 52 byte inner loop.
; 3.625 cycles per byte
; sp: src
; r0: dst
; r2: limit of dst
; r1: #10
; r6: saved sp
; Uses all registers including r7 (sp) r5 (tmp) and r6 (lr)
; Cycle counts assume one cycle per instruction byte and one cycle per byte read or written.
top:
  pop r3, r4, r5     ; 8
  st r3 [r0, #0]     ; 4
  st r4 [r0, #2]     ; 4
  st r5 [r0, #4]     ; 4
  pop r3, r4, r5     ; 8
  st r3 [r0, #6]     ; 4
  st r4 [r0, #8]     ; 4
  add r0, r0, r1     ; 1  adds 10
  st r5 [r0, #0]     ; 4
  pop r3, r4, r5     ; 8
  st r3 [r0, #2]     ; 4
  st r4 [r0, #4]     ; 4
  st r5 [r0, #6]     ; 4
  pop r3, r4, r5     ; 8
  st r3 [r0, #8]     ; 4
  add r0, r0, r1     ; 1  adds 10
  st r4 [r0, #0]     ; 4
  st r5 [r0, #2]     ; 4
  pop r3, r4, r5     ; 8
  st r3 [r0, #4]     ; 4
  st r4 [r0, #6]     ; 4
  st r5 [r0, #8]     ; 4
  pop r3             ; 4
  add r0, r0, #2     ; 1
  st r3 [r0, #8]     ; 4
  add r0, r0, r1     ; 1 adds 10
  be ne, r0, r2, top ; 4
; 5x pop, st, st, st is 100 cycles for 30 bytes
; Other insns: 16
