/* fructus/spi.h - the SPI port, and the flash on it.

   An option of the system's, rtl/spi.sv, built with FRUCTUS_SPI; [cpu.io]
   in isa/fructus.toml has the register map, and rtl/spi.sv's header the
   whole of how it behaves.  tools/fcc-run.mjs has the port too, with
   --flash FILE behind its flash select.

   A BYTE IS EIGHT CYCLES on the wire, at the system's clock, mode 0.  A store
   to __spi_data sends one and keeps the byte the device sends meanwhile; a
   load of it reads FRUCTUS_SPI_BUSY and that byte, through fructus/io.h's
   window.  With FRUCTUS_SPI_STREAM in the control register a load that
   finds the port idle sends 0xff too, so a block is read a load a byte:
   fructus_spi_read.

   THE FLASH IS ON ITS OWN PINS, which rtl/spiboot.sv has only while it boots;
   the header's two devices share its clock and data lines, each with a chip
   select of its own.  A write to __spi_ctrl ends any byte under way.

   The functions keep the mode's late bit set only while they load the data
   register, as fructus_io_load does, and so may be called with any mode, but
   not from an interrupt handler while another call is under way.  */
#ifndef _FRUCTUS_SPI_H
#define _FRUCTUS_SPI_H

#include <stdint.h>
#include <fructus/io.h>

#ifdef __cplusplus
extern "C" {
#endif

extern volatile uint16_t __spi_data;
extern volatile uint16_t __spi_ctrl;

/* __spi_data, loaded: the byte received, and whether one is on the wire.  */
#define FRUCTUS_SPI_BUSY    0x8000

/* __spi_ctrl: the chip selects, 1 to select, and streaming.  */
#define FRUCTUS_SPI_FLASH   0x01      /* the flash's */
#define FRUCTUS_SPI_CS0     0x02      /* the header's, pin 38 */
#define FRUCTUS_SPI_CS1     0x04      /* the header's, pin 11 */
#define FRUCTUS_SPI_STREAM  0x08      /* a load that finds the port idle sends 0xff */

/* Select the devices in `sel', FRUCTUS_SPI_FLASH and so on, or 0 for none.
   Deselecting is how a command to the flash ends.  */
static inline void
fructus_spi_select (unsigned sel)
{
  __spi_ctrl = sel;
}

/* Send `byte' and return the one the device sent meanwhile.  STREAM must be
   clear.  */
static inline uint8_t
fructus_spi_xfer (uint8_t byte)
{
  uint16_t v, m, a;
  __asm__ volatile ("mov\t%2, #0x480\n\t"
                    "ld\t%1, [%2]\n\t"      /* the mode, from its copy */
                    "or\t%0, %1, #8\n\t"
                    "st\t%0, [%2]\n\t"
                    "st8\t%4, [%3]\n\t"     /* sent */
                    "nop\n"
                    "1:\tld\t%0, [%3]\n\t"  /* the third instruction on */
                    "br\tlt, %0, #0, 1b\n\t"
                    "st\t%1, [%2]"
                    : "=&r" (v), "=&r" (m), "=&r" (a)
                    : "r" (&__spi_data), "r" (byte)
                    : "memory");
  return (uint8_t) v;
}

/* Receive n bytes into buf from the devices in `sel', sending 0xff: a load
   and a store a byte, about ten cycles.  Leaves `sel' selected.  */
static inline void
fructus_spi_read (unsigned sel, void *buf, uint16_t n)
{
  uint8_t *p = (uint8_t *) buf, *e = p + n;
  uint16_t v, m, a;
  if (n == 0)
    return;
  __spi_ctrl = sel | FRUCTUS_SPI_STREAM;
  __asm__ volatile ("mov\t%3, #0x480\n\t"
                    "ld\t%2, [%3]\n\t"
                    "or\t%0, %2, #8\n\t"
                    "st\t%0, [%3]\n\t"
                    "mov\t%0, #0xff\n\t"
                    "st8\t%0, [%5]\n"       /* the first byte, by a store */
                    "1:\tld\t%0, [%5]\n\t"  /* each later one, by this load */
                    "br\tlt, %0, #0, 1b\n\t"
                    "st8\t%0, [%1]\n\t"
                    "add\t%1, %1, #1\n\t"
                    "br\tne, %1, %4, 1b\n\t"
                    "st\t%2, [%3]"
                    : "=&r" (v), "+r" (p), "=&r" (m), "=&r" (a)
                    : "r" (e), "r" (&__spi_data)
                    : "memory");
  __spi_ctrl = sel;                     /* and ends the byte the last load began */
}

/* --- the flash, a W25Q32JV or anything that speaks its commands --------------- */

#define FRUCTUS_FLASH_SIZE   0x400000ul       /* 4 MB */
#define FRUCTUS_FLASH_SECTOR 0x1000           /* erased at a time */
#define FRUCTUS_FLASH_PAGE   0x100            /* programmed at a time */

/* A command and its 24-bit address, with the flash selected.  */
static inline void
fructus_flash_command (uint8_t cmd, uint32_t addr)
{
  fructus_spi_select (FRUCTUS_SPI_FLASH);
  fructus_spi_xfer (cmd);
  fructus_spi_xfer ((uint8_t) (addr >> 16));
  fructus_spi_xfer ((uint8_t) (addr >> 8));
  fructus_spi_xfer ((uint8_t) addr);
}

/* Read n bytes at addr into buf.  */
static inline void
fructus_flash_read (uint32_t addr, void *buf, uint16_t n)
{
  fructus_flash_command (0x03, addr);
  fructus_spi_read (FRUCTUS_SPI_FLASH, buf, n);
  fructus_spi_select (0);
}

/* The JEDEC ID, manufacturer first: 0xef4016 for a W25Q32JV.  */
static inline uint32_t
fructus_flash_id (void)
{
  uint32_t id;
  fructus_spi_select (FRUCTUS_SPI_FLASH);
  fructus_spi_xfer (0x9f);
  id = (uint32_t) fructus_spi_xfer (0xff) << 16;
  id |= (uint16_t) fructus_spi_xfer (0xff) << 8;
  id |= fructus_spi_xfer (0xff);
  fructus_spi_select (0);
  return id;
}

/* Wait while the flash is erasing or programming: status register 1's
   BUSY.  */
static inline void
fructus_flash_wait (void)
{
  fructus_spi_select (FRUCTUS_SPI_FLASH);
  fructus_spi_xfer (0x05);
  while (fructus_spi_xfer (0xff) & 1)
    ;
  fructus_spi_select (0);
}

static inline void
fructus_flash_write_enable (void)
{
  fructus_spi_select (FRUCTUS_SPI_FLASH);
  fructus_spi_xfer (0x06);
  fructus_spi_select (0);
}

/* Erase the 4 KB sector holding addr to 0xff, and wait.  */
static inline void
fructus_flash_erase_sector (uint32_t addr)
{
  fructus_flash_write_enable ();
  fructus_flash_command (0x20, addr);
  fructus_spi_select (0);
  fructus_flash_wait ();
}

/* Program n bytes from buf at addr, and wait.  Programming only clears bits,
   so the bytes must have been erased; and the n bytes must lie in one
   256-byte page, as past its end the flash wraps to the page's start.  */
static inline void
fructus_flash_program (uint32_t addr, const void *buf, uint16_t n)
{
  const uint8_t *p = (const uint8_t *) buf;
  fructus_flash_write_enable ();
  fructus_flash_command (0x02, addr);
  while (n--)
    fructus_spi_xfer (*p++);
  fructus_spi_select (0);
  fructus_flash_wait ();
}

#ifdef __cplusplus
}
#endif

#endif
