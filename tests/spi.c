/* tests/spi.c - the SPI port and the flash, for tests/spi-check.mjs.

   Run twice: on tools/fcc-run.mjs's model, tools/spi.js and tools/flash.js,
   and on tools/fpga-system.sv built with FRUCTUS_SPI behind a test bench's
   flash.  Both start with byte a of the flash being PATTERN (a).  Every
   result goes to OUT, which the check compares between the two machines as
   well as against what is wanted here; main returns the first check that
   failed, or 0, and stores it at OUT[0] too.  */
#include <stdint.h>
#include <fructus/spi.h>

#define OUT ((volatile uint16_t *) 0x7e00)
#define PATTERN(a) ((uint8_t) ((a) * 7 + ((a) >> 8)))

static uint8_t buf[300];

/* After a store of 0x5a, a load k instructions later - nops between - in the
   late window, with nothing selected: its busy bit.  */
#define PROBE(k, nops)                                                  \
  static uint16_t probe##k (void)                                       \
  {                                                                     \
    uint16_t v, m, a;                                                   \
    __asm__ volatile ("mov\t%2, #0x480\n\t"                             \
                      "ld\t%1, [%2]\n\t"                                \
                      "or\t%0, %1, #8\n\t"                              \
                      "st\t%0, [%2]\n\t"                                \
                      "nop\n\t"                                         \
                      "nop\n\t"                                         \
                      "mov\t%0, #0x5a\n\t"                              \
                      "st8\t%0, [%3]\n\t"                               \
                      nops                                              \
                      "ld\t%0, [%3]\n"                                  \
                      "1:\tld\t%2, [%3]\n\t"  /* until idle */          \
                      "br\tlt, %2, #0, 1b\n\t"                          \
                      "mov\t%2, #0x480\n\t"                             \
                      "st\t%1, [%2]"                                    \
                      : "=&r" (v), "=&r" (m), "=&r" (a)                 \
                      : "r" (&__spi_data)                               \
                      : "memory");                                      \
    return v;                                                           \
  }
#define N1 "nop\n\t"
PROBE (0, "")
PROBE (1, N1)
PROBE (2, N1 N1)
PROBE (3, N1 N1 N1)
PROBE (4, N1 N1 N1 N1)
PROBE (5, N1 N1 N1 N1 N1)
PROBE (6, N1 N1 N1 N1 N1 N1)
PROBE (7, N1 N1 N1 N1 N1 N1 N1)
PROBE (8, N1 N1 N1 N1 N1 N1 N1 N1)
PROBE (9, N1 N1 N1 N1 N1 N1 N1 N1 N1)

static int
run (void)
{
  uint16_t i;
  uint32_t id;
  static const uint8_t prog[12] = { 0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc,
                                    0xde, 0xf0, 0x0f, 0x1e, 0x2d, 0x3c };

  fructus_spi_select (0);
  OUT[1] = probe0 ();  OUT[2] = probe1 ();  OUT[3] = probe2 ();
  OUT[4] = probe3 ();  OUT[5] = probe4 ();  OUT[6] = probe5 ();
  OUT[7] = probe6 ();  OUT[8] = probe7 ();  OUT[9] = probe8 ();
  OUT[10] = probe9 ();
  /* 2: busy right after the store, and idle once the byte is out.  */
  if (!(OUT[1] & FRUCTUS_SPI_BUSY) || (OUT[10] & FRUCTUS_SPI_BUSY))
    return 2;

  /* 3: the JEDEC ID.  */
  id = fructus_flash_id ();
  OUT[11] = (uint16_t) (id >> 8);
  OUT[12] = (uint16_t) id;
  if (id != 0xef4016ul)
    return 3;

  /* 4: 300 bytes from the chooser's directory, crossing a page.  */
  fructus_flash_read (0x1100f0ul, buf, sizeof buf);
  for (i = 0; i < sizeof buf; i++)
    if (buf[i] != PATTERN (0x1100f0ul + i))
      {
        OUT[13] = i;
        return 4;
      }

  /* 5: erase the last sector, program 12 bytes across a page's end in two
     commands, and read them back with the bytes either side.  */
  fructus_flash_erase_sector (0x3ff000ul);
  fructus_flash_program (0x3ff0faul, prog, 6);
  fructus_flash_program (0x3ff100ul, prog + 6, 6);
  fructus_flash_read (0x3ff0f8ul, buf, 16);
  for (i = 0; i < 16; i++)
    OUT[16 + i] = buf[i];
  if (buf[0] != 0xff || buf[1] != 0xff || buf[14] != 0xff || buf[15] != 0xff)
    return 5;
  for (i = 0; i < 12; i++)
    if (buf[2 + i] != prog[i])
      return 5;

  /* 6: programming only clears bits.  */
  {
    static const uint8_t ones[1] = { 0xf0 };
    fructus_flash_program (0x3ff0faul, ones, 1);
    fructus_flash_read (0x3ff0faul, buf, 1);
    OUT[32] = buf[0];
    if (buf[0] != (0x12 & 0xf0))
      return 6;
  }

  /* 7: nothing on the header: 0xff, streamed.  */
  fructus_spi_read (FRUCTUS_SPI_CS0, buf, 8);
  fructus_spi_select (0);
  for (i = 0; i < 8; i++)
    if (buf[i] != 0xff)
      return 7;

  /* 8: a write to the control register ends the byte under way.  */
  __spi_data = 0x33;
  fructus_spi_select (0);
  OUT[33] = fructus_io_load (&__spi_data);
  if (OUT[33] & FRUCTUS_SPI_BUSY)
    return 8;

  return 0;
}

int
main (void)
{
  int r = run ();
  OUT[0] = r;
  return r;
}
