/* harness.c - 026.compress's stand-in: compress 4.0 in memory.

   SPEC's run compressed a file and decompressed the result.  This does the
   same with spec92.h's streams in place of the files: compress() reads the
   embedded input and writes into zbuf, then decompress() reads zbuf back and
   writes into a checker that compares every byte with the input, so neither
   the decompressed text nor a second copy of the input needs any memory.
   ITERATIONS rounds of both, then the sizes and a checksum of zbuf - which
   the host's build has to print identically.

   12-BIT CODES, compress's own setting for the PDP-11 and the PC/XT, because
   that is what a 16-bit machine can hold: htab is 5003 longs and codetab 5003
   shorts, 30K together, where 16 bits would want 400K.  The hash still works
   on 32-bit values, (c << 12) + ent, as it did on those machines.  */

#ifndef ITERATIONS
#define ITERATIONS 4
#endif

#ifndef ZMAX
#define ZMAX 8192
#endif

extern int maxbits, block_compress, nomagic, zcat_flg, quiet, exit_stat;
extern int maxmaxcode, hsize;
extern char magic_header[];
int compress (), decompress ();

static unsigned char zbuf[ZMAX];

static unsigned
crc16 (const unsigned char *p, unsigned n)
{
  unsigned crc = 0xffff;
  while (n--)
    {
      crc ^= *p++;
      for (int k = 0; k < 8; k++)
	crc = crc & 1 ? (crc >> 1) ^ 0xa001 : crc >> 1;
    }
  return crc & 0xffff;
}

int
main (void)
{
  const struct mio_file *in = &mio_files[0];
  unsigned zsize = 0, bad = 0;

  zcat_flg = 1;
  quiet = 1;
  for (int i = 0; i < ITERATIONS; i++)
    {
      /* What main() sets up for compressing stdin to stdout.  */
      maxbits = BITS;
      maxmaxcode = 1 << maxbits;
      block_compress = 0x80;
      stdin = mio_reader (in->data, in->size);
      stdout = mio_writer (zbuf, sizeof zbuf);
      compress ();
      if (ferror (stdout))
	bad++;
      zsize = mio_written (stdout);
      fclose (stdin);
      fclose (stdout);

      /* And what it does before decompressing: the 3-byte header.  */
      stdin = mio_reader (zbuf, zsize);
      if (getchar () != (magic_header[0] & 0xff)
	  || getchar () != (magic_header[1] & 0xff))
	bad++;
      maxbits = getchar ();
      block_compress = maxbits & 0x80;
      maxbits &= 0x1f;
      maxmaxcode = 1 << maxbits;
      stdout = mio_checker (in->data, in->size);
      decompress ();
      if (ferror (stdout) || mio_written (stdout) != in->size)
	bad++;
      fclose (stdin);
      fclose (stdout);
    }
  stdout = mio_stderr;
  printf ("%s: %u bytes, compressed to %u, crc %04x, %d rounds, %s\n",
	  in->name, in->size, zsize, crc16 (zbuf, zsize), ITERATIONS,
	  bad ? "FAILED" : "ok");
  return bad != 0;
}
