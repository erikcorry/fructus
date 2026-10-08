/* A 16K ROM at the top of the address space, RAM below it.
 *
 *   0x0000 - 0x0001   kept free: no object at address 0, which is NULL
 *   0x0002 - 0x01ff   zp_lo   .zplo, .zplo.bss      [rb, #-512..-1]
 *   0x0200 - 0x03ff   zp_hi   .zphi, .zphi.bss      [rb, #0..511]
 *   0x0400 - 0x04ff   the I/O page: guards, the CPU's, the GPU's; [cpu.io]
 *   0x0500 - top      the stack, growing down towards the I/O page
 *   top    - 0xbfff   .data and .bss
 *   0xc000 - 0xffcb   16K ROM, less the vector table
 *   0xffcc - 0xffff   the vectors, thirteen four-byte slots
 *
 * THE ZERO PAGE is reached as [rb, #zp(x)] with rb holding 0x200; see
 * ld/fructus-sim.ld.  Its initialised halves live in ROM like .data and are
 * copied by startup code: __zplo_rom, __zplo_ram and __zplo_size, and the
 * same for zp_hi.  Its .bss halves are NOLOAD and are cleared, if the
 * program cares, from __zplo_bss_start and __zplo_bss_size and the same for
 * zp_hi.  The top of the stack is __stack_top, 0x1000 unless defined with
 * --defsym.
 *
 * THE VECTORS ARE JUMP ADDRESSES, NOT POINTERS.  The processor puts one of
 * these in the pc and executes what it finds, so every slot holds a `jmp' -
 * three bytes of instruction with a fourth to spare.  See [cpu.vectors] in
 * isa/fructus.toml for the table and why it is shaped this way.
 *
 * SO THIS SCRIPT CANNOT FILL THEM IN, and that is the difference from the
 * 6502 layout this replaced.  `SHORT(_start)' emits a pointer, which a linker
 * can do; a jump is an instruction and has to be assembled.  The table
 * therefore arrives as a .vectors input section from the program, and all this
 * does is place it.  A program that supplies none gets a zero-filled slot,
 * which decodes as `brk' and traps - loudly, and not into arbitrary code.
 */

OUTPUT_FORMAT("elf32-fructus")
OUTPUT_ARCH(fructus)
ENTRY(_start)

MEMORY
{
  zplo (rw) : ORIGIN = 0x0002, LENGTH = 0x0200 - 2
  zphi (rw) : ORIGIN = 0x0200, LENGTH = 0x0200
  rom (rx)  : ORIGIN = 0xc000, LENGTH = 16K - 52
  vec (rx)  : ORIGIN = 0xffcc, LENGTH = 52
}

__zp_base   = 0x0200;
__io        = 0x0400;
__shadow_sp  = 0x0410;
__shadow_lr  = 0x0412;
__shadow_isp = 0x0414;
__display   = 0x0480;     /* the GPU's registers, crt/include/fructus/display.h */
__stack_top = DEFINED(__stack_top) ? __stack_top : 0x1000;

SECTIONS
{
  .text : {
    *(.text.startup) *(.text) *(.text.*)
    *(.rodata) *(.rodata.*)
  } > rom

  /* The zero page, initialised and not.  A region each, so an overflow is
     the linker's `region overflowed' and not a variable in the I/O page.  */
  .zplo : {
    __zplo_ram = .;
    *(.zplo) *(.zplo.[!b]*)
    __zplo_end = .;
  } > zplo AT> rom
  __zplo_rom  = LOADADDR(.zplo);
  __zplo_size = __zplo_end - __zplo_ram;
  .zplo.bss (NOLOAD) : {
    __zplo_bss_start = .;
    *(.zplo.bss) *(.zplo.bss.*)
    __zplo_bss_end = .;
  } > zplo
  __zplo_bss_size = __zplo_bss_end - __zplo_bss_start;

  .zphi : {
    __zphi_ram = .;
    *(.zphi) *(.zphi.[!b]*)
    __zphi_end = .;
  } > zphi AT> rom
  __zphi_rom  = LOADADDR(.zphi);
  __zphi_size = __zphi_end - __zphi_ram;
  .zphi.bss (NOLOAD) : {
    __zphi_bss_start = .;
    *(.zphi.bss) *(.zphi.bss.*)
    __zphi_bss_end = .;
  } > zphi
  __zphi_bss_size = __zphi_bss_end - __zphi_bss_start;

  /* Initialised data lives in ROM and is copied to RAM by startup code.
     __data_rom, __data_ram and __data_size are what that loop needs.  It
     goes above the stack, which grows down from __stack_top towards the
     I/O page.  */
  .data __stack_top : {
    __data_ram = .;
    *(.data) *(.data.*)
    __data_end = .;
  } AT> rom
  __data_rom  = LOADADDR(.data);
  __data_size = __data_end - __data_ram;

  .bss (NOLOAD) : {
    __bss_start = .;
    *(.bss) *(.bss.*) *(COMMON)
    __bss_end = .;
  }
  __bss_size = __bss_end - __bss_start;
  ASSERT(__bss_end <= 0xc000, "data and bss overflow RAM into the ROM")
  ASSERT(__stack_top >= 0x0500, "__stack_top is below the I/O page")

  /* KEEP, because nothing refers to this section and --gc-sections would
     otherwise drop the whole table on the floor.  */
  .vectors : { KEEP(*(.vectors)) } > vec
  /* Laid out upwards from 0xffcc, so a table a slot short would put every
     vector four bytes low - reset where brk belongs - and still link.  */
  ASSERT(SIZEOF(.vectors) == 0 || SIZEOF(.vectors) == 52,
         "the vector table is thirteen four-byte slots from 0xffcc")

  /DISCARD/ : { *(.comment) *(.note.*) }
}
