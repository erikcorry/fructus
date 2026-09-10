/* A 16K ROM at the top of the address space, RAM below it.
 *
 *   0x0000 - 0xbfff   48K RAM
 *   0xc000 - 0xfff9   16K ROM, less the six bytes of vectors
 *   0xfffa - 0xffff   the vectors
 *
 * The vector layout is the 6502's, which is what the microtan hardware
 * expects: three little-endian 16-bit addresses the CPU jumps to.
 *
 *   0xfffa  NMI
 *   0xfffc  RESET
 *   0xfffe  IRQ / BRK
 *
 * A program supplies _start.  It may also supply __nmi and __irq; where it
 * does not, those vectors point at _start too, so a stray interrupt restarts
 * the machine rather than jumping into whatever the ROM happened to end with.
 */

OUTPUT_FORMAT("elf32-fructus")
OUTPUT_ARCH(fructus)
ENTRY(_start)

MEMORY
{
  ram (rwx) : ORIGIN = 0x0000, LENGTH = 48K
  rom (rx)  : ORIGIN = 0xc000, LENGTH = 16K - 6
  vec (r)   : ORIGIN = 0xfffa, LENGTH = 6
}

SECTIONS
{
  .text : {
    *(.text.startup) *(.text) *(.text.*)
    *(.rodata) *(.rodata.*)
  } > rom

  /* Initialised data lives in ROM and is copied to RAM by startup code.
     __data_rom, __data_ram and __data_size are what that loop needs.  */
  .data : {
    __data_ram = .;
    *(.data) *(.data.*)
    __data_end = .;
  } > ram AT> rom
  __data_rom  = LOADADDR(.data);
  __data_size = __data_end - __data_ram;

  .bss (NOLOAD) : {
    __bss_start = .;
    *(.bss) *(.bss.*) *(COMMON)
    __bss_end = .;
  } > ram
  __bss_size = __bss_end - __bss_start;

  .vectors : {
    SHORT(DEFINED(__nmi) ? __nmi : _start);   /* 0xfffa */
    SHORT(_start);                            /* 0xfffc */
    SHORT(DEFINED(__irq) ? __irq : _start);   /* 0xfffe */
  } > vec

  /* The stack grows down from the top of RAM.  */
  __stack_top = ORIGIN(ram) + LENGTH(ram);

  /DISCARD/ : { *(.comment) *(.note.*) }
}
