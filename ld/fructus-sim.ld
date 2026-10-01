/* The simulator: 64K of RAM.
 *
 *   0x0000 - 0x0002   `jmp _start': the CPU starts at 0
 *   0x0003 - 0x01ff   zp_lo   .zplo, .zplo.bss      [rb, #-512..-1]
 *   0x0200 - 0x03ff   zp_hi   .zphi, .zphi.bss      [rb, #0..511]
 *   0x0400 - 0x04ff   the I/O page; 0x0400 is the console
 *   0x0500 - top      the stack, growing down towards the I/O page
 *   top    - 0xffff   code, then data, loaded as one flat image
 *
 * THE ZERO PAGE is reached as [rb, #zp(x)] with rb holding 0x200, the
 * R_FRUCTUS_ZP10 relocation; see isa/fructus.toml.  A program chooses its
 * half with gas's .zplo and .zphi, or gcc's zp and zp ("hi") attributes, and
 * one that wants zp_hi for something else of its own simply never uses it.
 * Each half is an output section placed at a fixed address, so the halves
 * never spill into each other or into the I/O page: an overflow is the
 * ASSERT's link error, not a quietly misplaced variable.
 *
 * THE JUMP AT 0 is crt/crt0.s's .reset section.  It keeps the CPU's reset
 * address and the runners' `pc = 0', and doubles as the guard that keeps
 * every object off address 0, where its address would compare equal to a
 * null pointer.
 *
 * The .bss halves go into the image with the data, as zeros: the simulator
 * loads it from 0 whatever, so keeping them out of it would save nothing.
 *
 * THE TOP OF THE STACK is the loader's to choose: the program is linked at
 * __stack_top, so `-Wl,--defsym=__stack_top=0x4000' buys a bigger stack with
 * address space the program no longer has.  .bss is not in the image; the
 * simulator's memory starts zeroed.
 */

OUTPUT_FORMAT("elf32-fructus")
OUTPUT_ARCH(fructus)
ENTRY(_start)

__zp_base    = 0x0200;
__io         = 0x0400;
__console    = 0x0400;
__stack_top  = DEFINED(__stack_top) ? __stack_top : 0x2000;

SECTIONS
{
  .reset 0 : { KEEP(*(.reset)) }

  .zplo . : { *(.zplo) *(.zplo.*) }
  ASSERT(. <= 0x0200, "zp_lo overflows into zp_hi (0x0200)")

  .zphi 0x0200 : { *(.zphi) *(.zphi.*) }
  ASSERT(. <= 0x0400, "zp_hi overflows into the I/O page (0x0400)")

  ASSERT(__stack_top >= 0x0500, "__stack_top is below the I/O page")

  .text __stack_top : {
    *(.text.startup) *(.text) *(.text.*)
  }

  .rodata : { *(.rodata) *(.rodata.*) }
  .data   : { *(.data) *(.data.*) }

  .bss (NOLOAD) : {
    __bss_start = .;
    *(.bss) *(.bss.*) *(COMMON)
    __bss_end = .;
  }

  /DISCARD/ : { *(.comment) *(.note.*) }
}
