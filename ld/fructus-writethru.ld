/* The board, for a program that draws in WRITETHRU and never reads the
 * frame buffer back: 64K of RAM, every byte of it in the flash image.
 *
 *   0x0000 - 0x0002   `jmp _start': the CPU starts at 0 once spiboot.sv has
 *                     copied the image in
 *   0x0003 - 0x01ff   zp_lo   .zplo                 [rb, #-512..-1]
 *   0x0200 - 0x03ff   zp_hi   .zphi                 [rb, #0..511]
 *   0x0400 - 0x04ff   the I/O page, [cpu.io]
 *   0x0500 - top      the stack, growing down towards the I/O page
 *   top    - 0x7fff   .data and .bss: EVERYTHING THE PROGRAM WRITES
 *   0x8000 - 0xffcb   .font, then code and constants: read only; then
 *                     .upper, written only in DISPLAY_CPU
 *   0xffcc - 0xffff   the vectors, thirteen four-byte slots
 *
 * WRITETHRU SENDS EVERY STORE ABOVE 0x8000 TO THE BUFFER NOT SHOWN, and not
 * to the processor's own ram_hi, while its loads and fetches there are still
 * its own (tools/fpga-system.sv).  So the top half holds what is only read -
 * code, .rodata, the vectors - and its addresses double as the buffer's: a
 * store to 0xf000 is the line tables', and never touches the code there.
 * Everything written lives below 0x8000, and the ASSERT says so.  The stack
 * is ordinary loads and stores, so it is below too.
 *
 * THE WHOLE 64K IS THE IMAGE.  spiboot.sv loads every byte from the flash and
 * then starts the CPU at 0, so .data is in place with no copy loop, and
 * objcopy -O binary, which fills the gaps between loaded sections with zeros,
 * puts zeros at .bss: the .reset jump at 0 and the vectors at 0xffcc make the
 * file the full 64K.  No startup code clears anything.
 *
 * THE FONT IS AT ITS OWN ADDRESS IN THE BUFFER.  .font starts at __font,
 * so after setting the `font' register to __font, putting the font into the
 * buffer is a loop of
 *
 *     p[i] = p[i];
 *
 * reading the processor's copy and storing to the buffer's, same address.
 * A program without a font has an empty .font and loses nothing; one whose
 * font must sit elsewhere in the buffer says -Wl,--defsym=__font=0x....
 * teletext/font.cc is 19,456 bytes, to 0xcc00 at the default.
 *
 * STATIC CONSTRUCTORS ARE NOT RUN: crt/crt0.s calls main directly.  So any
 * .init_array or .ctors is a link error here rather than an object that
 * quietly stays zero.  Make such objects constexpr.
 *
 * THE VECTORS ARE JUMPS and come from the program as a .vectors section, as
 * in ld/fructus-rom16k.ld.  The interrupt line - the UART's and the USB
 * port's requests and the pin's - enters at brk, 0xfff8.
 */

OUTPUT_FORMAT("elf32-fructus")
OUTPUT_ARCH(fructus)
ENTRY(_start)

__zp_base    = 0x0200;
__io         = 0x0400;
__shadow_sp  = 0x0410;
__shadow_lr  = 0x0412;
__shadow_isp = 0x0414;
__console    = 0x0420;     /* the UART's data, crt/include/fructus/uart.h */
__uart_status  = 0x0422;
__cycles     = 0x0424;     /* crt/include/fructus/cycles.h */
__uart_divisor = 0x0428;
__usb_data     = 0x0430;   /* the USB port's, crt/include/fructus/usb.h */
__usb_status   = 0x0432;
__usb_ctrl     = 0x0434;
__display    = 0x0480;     /* the GPU's registers, crt/include/fructus/display.h */
__stack_top  = DEFINED(__stack_top) ? __stack_top : 0x1000;
__font       = DEFINED(__font) ? __font : 0x8000;

SECTIONS
{
  .reset 0 : { KEEP(*(.reset)) }

  .zplo . : { *(.zplo) *(.zplo.*) }
  ASSERT(. <= 0x0200, "zp_lo overflows into zp_hi (0x0200)")

  .zphi 0x0200 : { *(.zphi) *(.zphi.*) }
  ASSERT(. <= 0x0400, "zp_hi overflows into the I/O page (0x0400)")

  ASSERT(__stack_top >= 0x0500, "__stack_top is below the I/O page")

  /* The location counter, not the section's address: an empty .data is
     dropped, and .bss would then follow zp_hi.  */
  . = __stack_top;
  .data : { *(.data) *(.data.*) }

  .bss : {
    __bss_start = .;
    *(.bss) *(.bss.*) *(COMMON)
    __bss_end = .;
  }
  ASSERT(__bss_end <= 0x8000, "data and bss reach 0x8000, where WRITETHRU's stores go to the frame buffer")

  .font __font : { KEEP(*(.font)) }
  ASSERT(__font >= 0x8000 && __font % 2 == 0, "__font is not an even address in the top half")

  .text : {
    *(.text.startup) *(.text) *(.text.*)
  }
  .rodata : { *(.rodata) *(.rodata.*) }

  /* KEEP, or --gc-sections drops what nothing refers to and the ASSERT
     sees an empty section.  */
  .init_array : {
    KEEP(*(.init_array)) KEEP(*(.init_array.*)) KEEP(*(.ctors)) KEEP(*(.ctors.*))
  }
  ASSERT(SIZEOF(.init_array) == 0, "a static constructor, which crt0 would never run: make the object constexpr")

  /* What the program writes only in DISPLAY_CPU, when stores above 0x8000
     are its own: in the image as zeros, like .bss.  */
  .upper (NOLOAD) : { *(.upper) *(.upper.*) }
  ASSERT(. <= 0xffcc, "code, constants and .upper run into the vectors at 0xffcc")

  /* KEEP, because nothing refers to the table and --gc-sections would drop it. */
  .vectors 0xffcc : { KEEP(*(.vectors)) }
  /* Required, not zero-filled as in ld/fructus-rom16k.ld: spiboot.sv loads
     all 64K, and an image ending short of 0xffcc would leave the vectors
     whatever the flash held there.  */
  ASSERT(SIZEOF(.vectors) == 52,
         "the vector table is thirteen four-byte slots from 0xffcc, and the image needs it")

  /DISCARD/ : { *(.comment) *(.note.*) *(.eh_frame) *(.eh_frame_hdr) }
}
