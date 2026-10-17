/* spec92.h - the in-memory stdio the SPECint92 stand-ins run on.

   Force-included ahead of every benchmark source (-include spec92.h).  The
   machine has no files and the C library no input side, so this takes over
   stdio's names - FILE, stdin, getc, fopen, fprintf and the rest - and points
   them at mio.c's streams: a read stream over one of the input files that
   embed.mjs compiled into the image, or a write stream to the console or to
   a buffer in memory.  The benchmark sources keep their own I/O calls.

   THE SAME HEADER BUILDS ON THE HOST, against glibc, and that build makes the
   reference output the simulator's run is checked against.  So nothing here
   may lean on either C library's FILE: the system <stdio.h> is included
   FIRST, its include guard then turns every later #include <stdio.h> in the
   sources into nothing, and the names are redefined after it.  */

#ifndef SPEC92_H
#define SPEC92_H

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>
#include <setjmp.h>
#include <stdarg.h>

/* One embedded input file; embed.mjs writes the table, ended by a null name. */
struct mio_file { const char *name; const unsigned char *data; unsigned size; };
extern const struct mio_file mio_files[];

typedef struct mio
{
  const unsigned char *rp, *rend;   /* reading: the next byte and the end */
  unsigned char *wp, *wend;         /* writing to memory: the next and the end */
  unsigned char *base;              /* writing to memory: where it started */
  int ungot;                        /* a byte pushed back, or -1 */
  unsigned char flags;
} MFILE;

#define MIO_READ    1
#define MIO_CONSOLE 2               /* writes go to the console */
#define MIO_MEMORY  4               /* writes go to wp..wend */
#define MIO_EOF     8
#define MIO_ERR    16
#define MIO_COMPARE 32              /* writes are checked against wp..wend */

extern MFILE *mio_stdin, *mio_stdout, *mio_stderr;

MFILE *mio_fopen (const char *, const char *);
MFILE *mio_freopen (const char *, const char *, MFILE *);
MFILE *mio_reader (const void *, unsigned);
MFILE *mio_writer (void *, unsigned);
MFILE *mio_checker (const void *, unsigned);
int mio_fclose (MFILE *);
int mio_getc (MFILE *);
int mio_ungetc (int, MFILE *);
char *mio_fgets (char *, int, MFILE *);
unsigned mio_fread (void *, unsigned, unsigned, MFILE *);
int mio_putc (int, MFILE *);
int mio_fputs (const char *, MFILE *);
int mio_puts (const char *);
unsigned mio_fwrite (const void *, unsigned, unsigned, MFILE *);
int mio_printf (const char *, ...);
int mio_fprintf (MFILE *, const char *, ...);
int mio_vfprintf (MFILE *, const char *, va_list);
int mio_fflush (MFILE *);
int mio_feof (MFILE *);
int mio_ferror (MFILE *);
unsigned mio_written (MFILE *);
int mio_read (int, void *, unsigned);
int mio_vfscanf (MFILE *, const char *, va_list);
int mio_fscanf (MFILE *, const char *, ...);
int mio_sscanf (const char *, const char *, ...);
void spec92_qsort (void *, size_t, size_t, int (*) (const void *, const void *));

/* mio.c itself wants the C library's names.  */
#ifndef SPEC92_NO_RENAMES

#undef FILE
#undef stdin
#undef stdout
#undef stderr
#undef getc
#undef getchar
#undef putc
#undef putchar
#undef feof
#undef ferror
#undef fileno
#undef clearerr

#define FILE MFILE
#define stdin mio_stdin
#define stdout mio_stdout
#define stderr mio_stderr
#define fopen mio_fopen
#define freopen mio_freopen
#define fclose mio_fclose
/* getc and putc are macros with a fast path into the buffer, as stdio's
   were in 1992: compress's inner loops are written for that.  The slow path
   is a call, for the end of the input, a pushed-back byte, the console and
   checking.  Like stdio's, they evaluate the stream more than once.  */
#define getc(f) ((f)->ungot < 0 && (f)->rp < (f)->rend \
		 ? *(f)->rp++ : mio_getc (f))
#define fgetc mio_getc
#define getchar() getc (mio_stdin)
#define ungetc mio_ungetc
#define fgets mio_fgets
#define fread mio_fread
#define putc(c, f) ((f)->wp < (f)->wend && !((f)->flags & MIO_COMPARE) \
		    ? (*(f)->wp++ = (c)) : mio_putc ((c), (f)))
#define fputc mio_putc
#define putchar(c) putc ((c), mio_stdout)
#define fputs mio_fputs
#define puts mio_puts
#define fwrite mio_fwrite
#define printf mio_printf
#define fprintf mio_fprintf
#define vfprintf mio_vfprintf
#define fflush mio_fflush
#define fscanf mio_fscanf
#define sscanf mio_sscanf
#define scanf(...) mio_fscanf (mio_stdin, __VA_ARGS__)
#define feof mio_feof
#define ferror mio_ferror
/* Unix's read, for a program that reads its standard input that way: file
   descriptor 0 is stdin, and there are no others.  */
#define read(fd, p, n) mio_read ((fd), (p), (n))
#define qsort spec92_qsort
#define clearerr(f) ((void) ((f)->flags &= ~(MIO_EOF | MIO_ERR)))

#endif
#endif
