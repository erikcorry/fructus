/* mio.c - the streams behind spec92.h.

   Compiled WITHOUT spec92.h's renames, so that putchar and vsnprintf here are
   the C library's own: the console is the simulator's UART, or the host's
   stdout when the reference output is being made.

   A stream is a static, not malloc's: there are at most a handful open at a
   time, and on a 64K machine the heap belongs to the benchmark.  */

#define SPEC92_NO_RENAMES
#include "spec92.h"

#define NSTREAMS 6

static MFILE console = { 0, 0, 0, 0, 0, -1, MIO_CONSOLE };
static MFILE empty = { 0, 0, 0, 0, 0, -1, MIO_READ };
static MFILE streams[NSTREAMS];

MFILE *mio_stdin = &empty, *mio_stdout = &console, *mio_stderr = &console;

static MFILE *
slot (void)
{
  for (int i = 0; i < NSTREAMS; i++)
    if (!streams[i].flags)
      return &streams[i];
  return 0;
}

MFILE *
mio_reader (const void *p, unsigned n)
{
  MFILE *f = slot ();
  if (!f)
    return 0;
  f->rp = p;
  f->rend = f->rp + n;
  f->ungot = -1;
  f->flags = MIO_READ;
  return f;
}

MFILE *
mio_writer (void *p, unsigned n)
{
  MFILE *f = slot ();
  if (!f)
    return 0;
  f->base = f->wp = p;
  f->wend = f->wp + n;
  f->flags = MIO_MEMORY;
  return f;
}

/* A writer that stores nothing: each byte is compared with the next of p,
   and any difference, or a byte past its end, is an error.  It checks a
   program's output against what it should be without a buffer for either.  */
MFILE *
mio_checker (const void *p, unsigned n)
{
  MFILE *f = mio_writer ((void *) p, n);
  if (f)
    f->flags |= MIO_COMPARE;
  return f;
}

/* Reading finds the name among the embedded files.  Writing anything goes to
   the console: the benchmarks' output is checked as one stream, as SPEC
   compares a run's output files.  */
MFILE *
mio_fopen (const char *name, const char *mode)
{
  if (*mode != 'r')
    return &console;
  for (const struct mio_file *e = mio_files; e->name; e++)
    if (!strcmp (e->name, name))
      return mio_reader (e->data, e->size);
  return 0;
}

int
mio_fclose (MFILE *f)
{
  if (f >= streams && f < streams + NSTREAMS)
    f->flags = 0;
  return 0;
}

MFILE *
mio_freopen (const char *name, const char *mode, MFILE *old)
{
  mio_fclose (old);
  return mio_fopen (name, mode);
}

int
mio_getc (MFILE *f)
{
  if (f->ungot >= 0)
    {
      int c = f->ungot;
      f->ungot = -1;
      return c;
    }
  if (f->rp < f->rend)
    return *f->rp++;
  f->flags |= MIO_EOF;
  return EOF;
}

int
mio_ungetc (int c, MFILE *f)
{
  if (c == EOF)
    return EOF;
  f->ungot = (unsigned char) c;
  f->flags &= ~MIO_EOF;
  return c;
}

char *
mio_fgets (char *s, int n, MFILE *f)
{
  char *p = s;
  while (n > 1)
    {
      int c = mio_getc (f);
      if (c == EOF)
	break;
      *p++ = c;
      n--;
      if (c == '\n')
	break;
    }
  if (p == s)
    return 0;
  *p = 0;
  return s;
}

unsigned
mio_fread (void *p, unsigned size, unsigned n, MFILE *f)
{
  unsigned char *d = p;
  unsigned i, k;
  for (i = 0; i < n; i++)
    for (k = 0; k < size; k++)
      {
	int c = mio_getc (f);
	if (c == EOF)
	  return i;
	*d++ = c;
      }
  return n;
}

int
mio_putc (int c, MFILE *f)
{
  if (f->flags & MIO_MEMORY)
    {
      if (f->wp == f->wend)
	{
	  f->flags |= MIO_ERR;
	  return EOF;
	}
      if (!(f->flags & MIO_COMPARE))
	*f->wp = c;
      else if (*f->wp != (unsigned char) c)
	f->flags |= MIO_ERR;
      f->wp++;
    }
  else
    putchar (c);
  return (unsigned char) c;
}

int
mio_fputs (const char *s, MFILE *f)
{
  while (*s)
    mio_putc (*s++, f);
  return 0;
}

int
mio_puts (const char *s)
{
  mio_fputs (s, mio_stdout);
  return mio_putc ('\n', mio_stdout);
}

unsigned
mio_fwrite (const void *p, unsigned size, unsigned n, MFILE *f)
{
  const unsigned char *s = p;
  for (unsigned i = 0; i < size * n; i++)
    mio_putc (s[i], f);
  return n;
}

int
mio_vfprintf (MFILE *f, const char *fmt, va_list ap)
{
  if (!(f->flags & MIO_MEMORY))
    return vprintf (fmt, ap);
  char buf[160];
  int n = vsnprintf (buf, sizeof buf, fmt, ap);
  mio_fputs (buf, f);
  return n;
}

int
mio_fprintf (MFILE *f, const char *fmt, ...)
{
  va_list ap;
  va_start (ap, fmt);
  int n = mio_vfprintf (f, fmt, ap);
  va_end (ap);
  return n;
}

int
mio_printf (const char *fmt, ...)
{
  va_list ap;
  va_start (ap, fmt);
  int n = mio_vfprintf (mio_stdout, fmt, ap);
  va_end (ap);
  return n;
}

/* scanf, as much of it as old programs use: white space, literal
   characters, %d %ld %u %lu %s %c and %%.  The value is the number of
   conversions made, or EOF if the input ended before the first, as the C
   standard says.  It works on the host too, so both builds read alike.  */
int
mio_vfscanf (MFILE *f, const char *fmt, va_list ap)
{
  int n = 0, c;
  for (; *fmt; fmt++)
    {
      if (*fmt == ' ' || (*fmt >= '\t' && *fmt <= '\r'))
	{
	  while ((c = mio_getc (f)) != EOF && (c == ' ' || (c >= '\t' && c <= '\r')))
	    ;
	  mio_ungetc (c, f);
	  continue;
	}
      if (*fmt != '%' || fmt[1] == '%')
	{
	  if (*fmt == '%')
	    fmt++;
	  if ((c = mio_getc (f)) != (unsigned char) *fmt)
	    {
	      mio_ungetc (c, f);
	      return c == EOF && !n ? EOF : n;
	    }
	  continue;
	}
      int lng = 0;
      if (*++fmt == 'l')
	lng = 1, fmt++;
      if (*fmt == 'c')
	{
	  if ((c = mio_getc (f)) == EOF)
	    return n ? n : EOF;
	  *va_arg (ap, char *) = c;
	  n++;
	  continue;
	}
      while ((c = mio_getc (f)) != EOF && (c == ' ' || (c >= '\t' && c <= '\r')))
	;
      if (c == EOF)
	return n ? n : EOF;
      if (*fmt == 's')
	{
	  char *d = va_arg (ap, char *);
	  do
	    *d++ = c;
	  while ((c = mio_getc (f)) != EOF && !(c == ' ' || (c >= '\t' && c <= '\r')));
	  mio_ungetc (c, f);
	  *d = 0;
	  n++;
	  continue;
	}
      if (*fmt != 'd' && *fmt != 'u')
	return n;
      int neg = 0, any = 0;
      unsigned long v = 0;
      if (c == '-' || c == '+')
	neg = c == '-', c = mio_getc (f);
      for (; c >= '0' && c <= '9'; c = mio_getc (f))
	v = v * 10 + (c - '0'), any = 1;
      mio_ungetc (c, f);
      if (!any)
	return n;
      if (neg)
	v = -v;
      if (lng)
	*va_arg (ap, long *) = v;
      else
	*va_arg (ap, int *) = v;
      n++;
    }
  return n;
}

int
mio_fscanf (MFILE *f, const char *fmt, ...)
{
  va_list ap;
  va_start (ap, fmt);
  int n = mio_vfscanf (f, fmt, ap);
  va_end (ap);
  return n;
}

int
mio_sscanf (const char *s, const char *fmt, ...)
{
  MFILE *f = mio_reader (s, strlen (s));
  if (!f)
    return EOF;
  va_list ap;
  va_start (ap, fmt);
  int n = mio_vfscanf (f, fmt, ap);
  va_end (ap);
  mio_fclose (f);
  return n;
}

int
mio_read (int fd, void *p, unsigned n)
{
  return fd ? -1 : (int) mio_fread (p, 1, n, mio_stdin);
}

int mio_fflush (MFILE *f) { (void) f; return 0; }
int mio_feof (MFILE *f) { return (f->flags & MIO_EOF) != 0; }
int mio_ferror (MFILE *f) { return (f->flags & MIO_ERR) != 0; }
unsigned mio_written (MFILE *f) { return f->wp - f->base; }

#ifdef __fructus__
/* BSD's names for strchr and strrchr, which old code declares for itself as
   char *index (); - so they have to be functions, not macros.  glibc has
   them already.  */
char *index (const char *s, int c) { return strchr (s, c); }
char *rindex (const char *s, int c) { return strrchr (s, c); }
#endif

#ifdef __fructus__
/* atof, for readers that meet a decimal point.  Digit by digit, and in
   float, which is li's FLOTYPE: double would bring libgcc's soft double, 4K
   of it, for nothing.  Not correctly rounded; no benchmark prints a float.  */
double
atof (const char *s)
{
  float v = 0, scale = 1;
  int neg = 0, e = 0, eneg = 0;
  while (*s == ' ' || *s == '\t')
    s++;
  if (*s == '-' || *s == '+')
    neg = *s++ == '-';
  for (; *s >= '0' && *s <= '9'; s++)
    v = v * 10 + (*s - '0');
  if (*s == '.')
    for (s++; *s >= '0' && *s <= '9'; s++)
      v += (*s - '0') * (scale /= 10);
  if (*s == 'e' || *s == 'E')
    {
      s++;
      if (*s == '-' || *s == '+')
	eneg = *s++ == '-';
      for (; *s >= '0' && *s <= '9'; s++)
	e = e * 10 + (*s - '0');
    }
  while (e--)
    v = eneg ? v / 10 : v * 10;
  return neg ? -v : v;
}
#endif
