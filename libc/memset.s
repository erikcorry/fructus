; r0 = addr, r1 = size
bzero:
  ; Unfortunately because this has two args r2 is callee save so we can't tail call memset.
  push r2, lr
  mov r2, r1
  mov r1, #0
  callr memset
  pop lr, r2
  ret

; r0 = addr, r1 = byte, r2 = size, r5 = temp
; We use only the caller-save registers so there's no real stack activity.
memset:
  mov r5, sp       ; Save sp, cos things are about to get crazy.
  add sp, r0, r2   ; Point sp at the end.
  and r2, r2, #-32 ; Get the number of rounded down bytes.
  add r2, r0, r2   ; Get the boundary of the rounded down bytes.

  br eq, sp, r2, .slowdone
.slowloop:
  push8 r1
  br ne, sp, r2, .slowloop
.slowdone:

  ; Duplicate low byte - we don't need r2 any more now so we use it as temp.
  shl r2, r1, #8
  zext r1, r1
  or r1, r1, r2
  br .bottom

.top:
  push r1, r1, r1
  push r1, r1, r1
  push r1, r1, r1
  push r1, r1, r1
  push r1, r1, r1
  push r1
.bottom:
  bc ne, sp, r0, .top

  mov sp, r5  ; Restore sp
  ret
