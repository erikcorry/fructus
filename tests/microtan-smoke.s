; ============================================================================
; microtan-smoke.s - the smallest ROM that proves the board works
; ============================================================================
;
; NOT A MONITOR.  This exercises the three pieces of hardware and nothing else:
; the machine starts where it should, the keyboard handshake works, and bytes
; written into the screen region appear.  It echoes what you type and wraps at
; the bottom.
;
; STOPS ON CTRL-A, and the reason it is ctrl-A rather than escape is worth a
; line.  The single-register branch compares against the condimm5 table, whose
; constants are -1, 0, 1, 2, 3, 4, 6 and 8 - so `eq #1` is a three-byte
; instruction with no register behind it, and `eq #27` would need a register
; loaded first.  A sentinel that happens to be in the table is free.
; ============================================================================

#bankdef rom
{
    #addr 0xfc00
    #size 0x400
    #outp 0
    #fill
}

SCREEN     = 0x200                      ; 1 << 9,  so `mov` reaches it in two
SCREEN_END = 0x400                      ; 1 << 10, likewise - both immbit5
KEY        = 1                          ; the keyboard port
STOP       = 1                          ; ctrl-A

start:
        mov     r2, #0                  ; a zero register: absolute addressing
        mov     r3, #0                  ; what we write back to the key port
        mov     r1, #SCREEN             ; the cursor
        mov     r4, #SCREEN_END
poll:
        ld8     r0, [r2, #KEY]          ; the interrupt left a character here
        br      eq, r0, #0, poll        ; ... or it did not
        st8     r3, [r2, #KEY]          ; release the port for the next key
        br      eq, r0, #STOP, done
        st8     r0, [r1, #0]            ; echo it to the screen
        add     r1, r1, #1              ; advance the cursor
        br      lo, r1, r4, poll        ; still on screen?
        mov     r1, #SCREEN             ; no: wrap to the top
        jmpr    poll
done:
        halt

; The reset entry.  Three bytes to the top of memory, and `jmp` is three bytes.
#addr 0xfffd
        jmp     start
