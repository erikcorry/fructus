/* A 16K ROM at the top of the address space, RAM below it.
 *
 *   0x0000 - 0xbfff   48K RAM
 *   0xc000 - 0xffcf   16K ROM, less the vector table
 *   0xffd0 - 0xffff   the vectors, twelve four-byte slots
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
  ram (rwx) : ORIGIN = 0x0000, LENGTH = 48K
  rom (rx)  : ORIGIN = 0xc000, LENGTH = 16K - 48
  vec (rx)  : ORIGIN = 0xffd0, LENGTH = 48
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

  /* KEEP, because nothing refers to this section and --gc-sections would
     otherwise drop the whole table on the floor.  */
  .vectors : { KEEP(*(.vectors)) } > vec

  /* The stack grows down from the top of RAM.  */
  __stack_top = ORIGIN(ram) + LENGTH(ram);

  /DISCARD/ : { *(.comment) *(.note.*) }
}
