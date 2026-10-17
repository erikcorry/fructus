/* harness.c - 132.ijpeg's stand-in: IJG's libjpeg 6b decoding image.jpg.

   SPEC95's ijpeg was IJG's library compressing and decompressing images in
   memory.  This decodes the embedded image.jpg, a 78x91 colour photograph,
   with the library's defaults: the accurate integer IDCT, fancy upsampling
   of the 2x2 subsampled chroma, and YCbCr to RGB.  Every row it gives back
   goes into a Fletcher checksum, and the dimensions and the checksum are
   printed once at the end, so the host build must decode every pixel
   identically.  ITERATIONS decodes in all, each from the start of the file.

   FLETCHER, NOT A CRC: a CRC done a bit at a time over the 48K of pixels
   took a third of the run, and that is this harness, not libjpeg.  Two sums
   cost two additions a byte and still see the order of the bytes.  They are
   uint16_t, so they wrap at 2^16 on the host as they do here.  */

#include <stdio.h>
#include <stdint.h>
#include "jpeglib.h"

#ifndef ITERATIONS
#define ITERATIONS 5
#endif

static uint16_t sum1, sum2;

static void
fletcher (const unsigned char *p, unsigned n)
{
  while (n--)
    {
      sum1 += *p++;
      sum2 += sum1;
    }
}

int
main (void)
{
  struct jpeg_decompress_struct cinfo;
  struct jpeg_error_mgr jerr;
  unsigned w = 0, h = 0, comps = 0;

  cinfo.err = jpeg_std_error (&jerr);
  jpeg_create_decompress (&cinfo);
  for (int i = 0; i < ITERATIONS; i++)
    {
      FILE *f = fopen ("image.jpg", "r");
      if (!f)
	{
	  fprintf (stderr, "jpeg: no image.jpg\n");
	  return 1;
	}
      jpeg_stdio_src (&cinfo, f);
      jpeg_read_header (&cinfo, TRUE);
      jpeg_start_decompress (&cinfo);
      w = cinfo.output_width;
      h = cinfo.output_height;
      comps = cinfo.output_components;
      JSAMPARRAY row = (*cinfo.mem->alloc_sarray)
	((j_common_ptr) &cinfo, JPOOL_IMAGE, w * comps, 1);
      while (cinfo.output_scanline < h)
	{
	  jpeg_read_scanlines (&cinfo, row, 1);
	  fletcher (row[0], w * comps);
	}
      jpeg_finish_decompress (&cinfo);
      fclose (f);
    }
  jpeg_destroy_decompress (&cinfo);
  printf ("image.jpg: %ux%u, %u components, %d decodes, fletcher %04x%04x\n",
	  w, h, comps, ITERATIONS, (unsigned) sum2, (unsigned) sum1);
  return 0;
}
