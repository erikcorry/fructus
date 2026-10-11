/* The simulator: 64K of RAM.
 *
 *   0x0000 - 0x0002   `jmp _start': the CPU starts at 0
 *   0x0003 - 0x01ff   zp_lo   .zplo, .zplo.bss      [rb, #-512..-1]
 *   0x0200 - 0x03ff   zp_hi   .zphi, .zphi.bss      [rb, #0..511]
 *   0x0400 - 0x04ff   the I/O page, [cpu.io]; 0x0420 is the console,
 *                     0x0424 the cycle counter
 *   0x0500 - 0x14ff   the stack, 4K, growing down towards the I/O page
 *   0x1500 - 0x7fff   the heap, crt/malloc.c's: 107 pages of 256 bytes
 *   0x8000 - 0xffff   code, then data, loaded as one flat image
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
 * THE HEAP IS WHAT IS LEFT BELOW THE PROGRAM, from the top of the stack up:
 * __heap_start, __heap_end and __heap_pages, its size in 256-byte pages,
 * which crt/malloc.c reads as the address of a symbol.  Its start must be a
 * page boundary, because malloc tells a page allocation from a small one by
 * its low byte.  `-Wl,--defsym=__stack_top=0x2000' buys a bigger stack out
 * of the heap; nothing else moves.  malloc's own bookkeeping is a static in
 * zp_lo.  The heap is not in the image and needs no clearing - malloc writes
 * every header it reads.
 *
 * THE PROGRAM STARTS AT __heap_end and has everything above it: 32K at the
 * default 0x8000.  The default gives way to any other definition, like a
 * weak symbol, so a program that needs 40K and can live with 75 pages of
 * heap says so in its own source:
 *
 *     asm (".globl __heap_end\n.set __heap_end, 0x6000");
 *
 * or `-Wl,--defsym=__heap_end=0x6000' says it on the command line.  It must
 * be an absolute value, not a label: the program is placed by it.  .bss is
 * not in the image; the simulator's memory starts zeroed.
 */

OUTPUT_FORMAT("elf32-fructus")
OUTPUT_ARCH(fructus)
ENTRY(_start)

__zp_base    = 0x0200;
__io         = 0x0400;
__shadow_sp  = 0x0410;
__shadow_lr  = 0x0412;
__shadow_isp = 0x0414;
__console    = 0x0420;
__cycles     = 0x0424;
__display    = 0x0480;    /* the GPU's registers, crt/include/fructus/display.h */
__stack_top  = DEFINED(__stack_top) ? __stack_top : 0x1500;
__heap_start = __stack_top;
__heap_end   = DEFINED(__heap_end) ? __heap_end : 0x8000;
__heap_pages = (__heap_end - __heap_start) / 256;

SECTIONS
{
  .reset 0 : { KEEP(*(.reset)) }

  .zplo . : { *(.zplo) *(.zplo.*) }
  ASSERT(. <= 0x0200, "zp_lo overflows into zp_hi (0x0200)")

  .zphi 0x0200 : { *(.zphi) *(.zphi.*) }
  ASSERT(. <= 0x0400, "zp_hi overflows into the I/O page (0x0400)")

  ASSERT(__stack_top >= 0x0500, "__stack_top is below the I/O page")
  ASSERT(__heap_start % 256 == 0, "__stack_top, where the heap starts, is not a 256-byte page boundary")
  ASSERT(__heap_start < __heap_end, "__stack_top leaves no heap below __heap_end")
  ASSERT(__heap_pages <= 123, "the heap has more pages than crt/malloc.c's table")

  .text __heap_end : {
    *(.text.startup) *(.text) *(.text.*)
  }

  .rodata : { *(.rodata) *(.rodata.*) }
  .data   : { *(.data) *(.data.*) }

  .bss (NOLOAD) : {
    __bss_start = .;
    *(.bss) *(.bss.*) *(COMMON)
    __bss_end = .;
  }
  ASSERT(. <= 0x10000, "the program does not fit between __heap_end and 0xffff")

  /DISCARD/ : { *(.comment) *(.note.*) }
}
