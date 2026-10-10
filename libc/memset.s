; ============================================================================
; libc/memset.s - memset and bzero
; ============================================================================
;
;       void *memset(void *s, int c, size_t n)      r0 = s, r1 = c, r2 = n
;       void  bzero (void *s, size_t n)             r0 = s, r1 = n
;
; Both return with r0 untouched, so memset's return value costs nothing.
;
; THE TRICK IS THAT `stm` WRITES THREE REGISTERS IN ONE INSTRUCTION and steps
; its pointer, r5, itself.  memset never reads, so there is no second pointer
; to maintain and no load to pay for.  sp is never touched, so an interrupt
; in the middle of a fill is harmless.
;
; ----------------------------------------------------------------------------
; MEASURED, by tests/libc-check.mjs
; ----------------------------------------------------------------------------
;       fill loop       1.5625 cycles/byte  16 bytes an iteration, even or odd
;       tail            1.5000 cycles/byte  up to 15 bytes, straight-line
;       sizes           bzero 12 bytes, memset 56, 68 together
;
; An odd buffer runs the loop at the even rate because one byte stored first
; makes the pointer even; without it every stm would go a byte at a time, at
; 2.06 cycles a byte.  The floor is 0.50 - one cycle to write each aligned
; word.  A stm stops the pipeline for four cycles beyond its accesses -
; 0.75 a byte over three of them and 16 bytes - and the add and the taken
; branch are the other 0.31.
; ============================================================================


; ============================================================================
; bzero                                                             12 bytes
; ============================================================================
; THE SAVE IS THE ARITY-DEPENDENT ABI BITING, and it is worth understanding
; rather than removing.  bzero takes two arguments, so under isa/abi.s r2 is not
; an argument to it and is therefore CALLEE saved - bzero's caller is entitled
; to find r2 intact.  memset takes three, so r2 is an argument to memset and is
; caller saved there, and memset duly destroys it.
;
; So the obvious tail call is wrong: `mov r2, r1; mov r1, #0; jmpr memset` would
; return with r2 clobbered and break bzero's own contract.  Four bytes of save
; and restore are the price of the arity difference, and no cheaper arrangement
; exists - r2 has to survive a call that is entitled to destroy it.

bzero:
        push    r2, lr                  ; r2 is callee saved HERE and not in memset
        mov     r2, r1                  ; the length moves up one place
        mov     r1, #0                  ; ... and the fill byte takes its slot
        call    memset
        pop     lr, r2
        ret


; ============================================================================
; memset
; ============================================================================
; ONE BYTE TO MAKE THE POINTER EVEN, then a 16-byte loop of stm, then what is
; left - 0 to 15 bytes - by its bits: 8, 4, 2 and 1.  stm stores through r5 and
; steps it, so r5 becomes the cursor and r0, the return value, is never
; touched.  The fill word goes in r1, where c arrived.  r5 is the assembler's
; scratch, and tests/run.sh's --noat assembly of libc proves nothing here
; expands through it.

memset:
        movhi   r1, r1, r1              ; r1 = c:c - (unsigned char)c, twice
        mov     r5, r0                  ; stm's pointer; r0 stays the result
        brclr   r5, #1, .aligned        ; already even
        br      eq, r2, #0, .done       ; nothing to fill
        st8     r1, [r5]                ; one byte makes the pointer even
        add     r5, r5, #1
        add     r2, r2, #-1
.aligned:
        brclr   r2, #0xfff0, .tail      ; fewer than 16
.loop:
        stm     r1, r1, r1              ; +0  .. +5
        stm     r1, r1, r1              ; +6  .. +11
        stm     r1, r1                  ; +12 .. +15
        add     r2, r2, #-16
        brset   r2, #0xfff0, .loop      ; 16 or more left
.tail:
        brclr   r2, #8, .lt8
        stm     r1, r1
        stm     r1, r1
.lt8:
        brclr   r2, #4, .lt4
        stm     r1, r1
.lt4:
        brclr   r2, #3, .done           ; a multiple of four, the common case
        brclr   r2, #2, .lt2
        stm     r1
.lt2:
        brclr   r2, #1, .done
        st8     r1, [r5]
.done:
        ret
