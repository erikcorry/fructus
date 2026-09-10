; A ROM that puts a word on the Microtan screen and stops.
;
; The board is described in tools/microtan.js: a 32x16 character display at
; 0x0200, written directly, and a keyboard port at 0x0001.  The linker script
; ld/fructus-rom16k.ld puts this at 0xc000 and the reset vector at 0xfffc.

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
