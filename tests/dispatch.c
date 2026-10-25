/* Dispatch bytes, for tests/dispatch.s: R_FRUCTUS_8_DISPATCH places the byte
   B whose handler, at 0x10000 - 16 * B, is the symbol, which run.sh puts at
   the two ends of the handlers' range, 0xf010 and 0xfff0.  main returns 0,
   or the number of the first check that failed.  */

extern const unsigned char stream[];

int
main (void)
{
  if (stream[0] != 0x42)
    return 1;
  if (stream[1] != 0xff)		/* 0xf010 */
    return 2;
  if (stream[2] != 0x01)		/* 0xfff0 */
    return 3;
  if (stream[3] != 0xfd)		/* 0xf030 */
    return 4;
  if (stream[4] != 0x05)		/* 0xffb0, done by gas */
    return 5;
  return 0;
}
