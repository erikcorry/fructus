; A ROM that puts a word on the Microtan screen and stops.
;
; The board is described in tools/microtan.js: a 32x16 character display at
; 0x0200, written directly, and a keyboard port at 0x0001.  The linker script
; ld/fructus-rom16k.ld puts this at 0xc000 and the vector table at 0xffd0.

	.text
	.globl _start
_start:
	mov	r6, #0xbfff		; stack at the top of RAM
	mov	r1, #0x0200		; the top left of the screen
	mov	r2, #msg
.Lcopy:
	ld8	r0, [r2, #0]
	brclear	r0, #0x00ff, .Ldone	; the string ends at a zero byte
	st8	r0, [r1, #0]
	add	r1, r1, #1
	add	r2, r2, #1
	jmpr	.Lcopy
.Ldone:
	halt

msg:	.ascii	"fructus"
	.byte	0


; ============================================================================
; The vectors
; ============================================================================
; Twelve four-byte slots at 0xffd0, which ld/fructus-rom16k.ld places.  The
; processor JUMPS to a vector rather than reading a pointer out of it, so each
; slot holds a real `jmp' - three bytes, with a fourth to spare.
;
; THEY ARE IN ADDRESS ORDER, LOW TO HIGH, which reads backwards from the table
; in isa/fructus.toml.  A linker lays a section out ascending, so irq0 is first
; and reset is last; getting that order wrong would put reset where an
; interrupt line belongs and the mistake would look like a dead board.
;
; NOTHING HERE HANDLES AN EXCEPTION, so every slot restarts the machine.  That
; is the same choice the 6502 layout made for its unused vectors, and for the
; same reason: landing in whatever the ROM happened to end with is worse.

	.section .vectors,"ax"
	jmp	_start		; 0xffd0  irq0
	.byte	0
	jmp	_start		; 0xffd4  irq1
	.byte	0
	jmp	_start		; 0xffd8  irq2
	.byte	0
	jmp	_start		; 0xffdc  irq3
	.byte	0
	jmp	_start		; 0xffe0  irq4
	.byte	0
	jmp	_start		; 0xffe4  irq5
	.byte	0
	jmp	_start		; 0xffe8  irq6
	.byte	0
	jmp	_start		; 0xffec  irq7
	.byte	0
	jmp	_start		; 0xfff0  nmi
	.byte	0
	jmp	_start		; 0xfff4  illegal instruction
	.byte	0
	jmp	_start		; 0xfff8  brk, and the hardware interrupt line
	.byte	0
	jmp	_start		; 0xfffc  reset
	.byte	0
