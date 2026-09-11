/* The simulator: 64K of RAM and nothing else.
 *
 *   0x0000 - 0xfeff   code, data and stack, loaded as one flat image
 *   0xff00            the console: a byte written here is printed
 *
 * The CPU starts at 0, so _start - crt/crt0.s's .text.startup - is linked
 * first.  .bss is not in the image; the simulator's memory starts zeroed.
 */

OUTPUT_FORMAT("elf32-fructus")
OUTPUT_ARCH(fructus)
ENTRY(_start)

MEMORY
{
  ram (rwx) : ORIGIN = 0x0000, LENGTH = 0xff00
}

SECTIONS
{
  .text : {
    *(.text.startup) *(.text) *(.text.*)
  } > ram

  .rodata : { *(.rodata) *(.rodata.*) } > ram
  .data   : { *(.data) *(.data.*) } > ram

  .bss (NOLOAD) : {
    __bss_start = .;
    *(.bss) *(.bss.*) *(COMMON)
    __bss_end = .;
  } > ram

  __console = 0xff00;
  __stack_top = 0xff00;

  /DISCARD/ : { *(.comment) *(.note.*) }
}
