/* libc.c - the C library for compiled programs on the simulator.

   Small and plain, in C: what a test program reaches for that libc/ does not
   already have in assembly.  memcpy, memmove, memset and bzero come from
   libc/, and exit and abort from crt0.s.

   Output goes to __console, a byte-wide port the simulator's runner prints.
   malloc and its family are in crt/malloc.c.  */

#include <stddef.h>
#include <stdarg.h>
#include <string.h>
#include <stdlib.h>
#include <stdio.h>

extern volatile unsigned char __console;

/* ---- memory and strings ------------------------------------------------ */

int
memcmp (const void *a, const void *b, size_t n)
{
  const unsigned char *p = a, *q = b;
  for (; n; n--, p++, q++)
    if (*p != *q)
      return *p - *q;
  return 0;
}

void *
memchr (const void *s, int c, size_t n)
{
  const unsigned char *p = s;
  for (; n; n--, p++)
    if (*p == (unsigned char) c)
      return (void *) p;
  return NULL;
}

/* strlen, strcmp and strncmp live in libc/strcmp.s.  They were here in C as
   well, and the assembly always won the link - tools/fcc adds the assembly
   objects from libc/ to the archive before this one - so the C copies were
   unreachable
   and only misleading.  Measured, cycles per byte of string against the C at
   -Os: strlen 4.25 against 13.00, strcmp 17 against 22, strncmp 20 against 23.
   strcat and strncat below call strlen, and now get the fast one.  */

char *
strcpy (char *d, const char *s)
{
  char *r = d;
  while ((*d++ = *s++))
    ;
  return r;
}

char *
strncpy (char *d, const char *s, size_t n)
{
  char *r = d;
  for (; n && *s; n--)
    *d++ = *s++;
  for (; n; n--)
    *d++ = 0;
  return r;
}

char *
strcat (char *d, const char *s)
{
  strcpy (d + strlen (d), s);
  return d;
}

char *
strncat (char *d, const char *s, size_t n)
{
  char *e = d + strlen (d);
  for (; n && *s; n--)
    *e++ = *s++;
  *e = 0;
  return d;
}

char *
strchr (const char *s, int c)
{
  for (;; s++)
    {
      if (*s == (char) c)
	return (char *) s;
      if (!*s)
	return NULL;
    }
}

char *
strrchr (const char *s, int c)
{
  const char *r = NULL;
  for (;; s++)
    {
      if (*s == (char) c)
	r = s;
      if (!*s)
	return (char *) r;
    }
}

char *
strstr (const char *h, const char *n)
{
  size_t len = strlen (n);
  for (; *h; h++)
    if (strncmp (h, n, len) == 0)
      return (char *) h;
  return len ? NULL : (char *) h;
}

/* ---- characters, ASCII only --------------------------------------------- */

int isdigit (int c) { return c >= '0' && c <= '9'; }
int islower (int c) { return c >= 'a' && c <= 'z'; }
int isupper (int c) { return c >= 'A' && c <= 'Z'; }
int isalpha (int c) { return islower (c) || isupper (c); }
int isalnum (int c) { return isalpha (c) || isdigit (c); }
int isxdigit (int c) { return isdigit (c) || ((c | 32) >= 'a' && (c | 32) <= 'f'); }
int isspace (int c) { return c == ' ' || (c >= '\t' && c <= '\r'); }
int isprint (int c) { return c >= ' ' && c < 127; }
int isgraph (int c) { return c > ' ' && c < 127; }
int iscntrl (int c) { return (c >= 0 && c < ' ') || c == 127; }
int ispunct (int c) { return isgraph (c) && !isalnum (c); }
int tolower (int c) { return isupper (c) ? c + 32 : c; }
int toupper (int c) { return islower (c) ? c - 32 : c; }

/* ---- numbers ------------------------------------------------------------ */

int abs (int x) { return x < 0 ? -x : x; }
long labs (long x) { return x < 0 ? -x : x; }

unsigned long
strtoul (const char *s, char **end, int base)
{
  unsigned long v = 0;
  while (*s == ' ' || *s == '\t')
    s++;
  if ((base == 0 || base == 16) && s[0] == '0' && (s[1] | 32) == 'x')
    s += 2, base = 16;
  else if (base == 0)
    base = s[0] == '0' ? 8 : 10;
  for (;; s++)
    {
      int d = *s >= '0' && *s <= '9' ? *s - '0'
	      : (*s | 32) >= 'a' && (*s | 32) <= 'z' ? (*s | 32) - 'a' + 10
	      : 99;
      if (d >= base)
	break;
      v = v * base + d;
    }
  if (end)
    *end = (char *) s;
  return v;
}

long
strtol (const char *s, char **end, int base)
{
  while (*s == ' ' || *s == '\t')
    s++;
  if (*s == '-')
    return -(long) strtoul (s + 1, end, base);
  if (*s == '+')
    s++;
  return strtoul (s, end, base);
}

int atoi (const char *s) { return strtol (s, NULL, 10); }
long atol (const char *s) { return strtol (s, NULL, 10); }

/* ---- qsort: insertion sort, which is enough for a test ------------------ */

void
qsort (void *base, size_t n, size_t size,
       int (*cmp) (const void *, const void *))
{
  char *b = base;
  for (size_t i = 1; i < n; i++)
    for (size_t j = i; j > 0 && cmp (b + (j - 1) * size, b + j * size) > 0; j--)
      for (size_t k = 0; k < size; k++)
	{
	  char t = b[(j - 1) * size + k];
	  b[(j - 1) * size + k] = b[j * size + k];
	  b[j * size + k] = t;
	}
}

/* ---- output ------------------------------------------------------------- */

FILE *stdin, *stdout, *stderr;

int
putchar (int c)
{
  __console = c;
  return (unsigned char) c;
}

int fputc (int c, FILE *f) { (void) f; return putchar (c); }
int fflush (FILE *f) { (void) f; return 0; }

int
fputs (const char *s, FILE *f)
{
  (void) f;
  while (*s)
    putchar (*s++);
  return 0;
}

size_t
fwrite (const void *p, size_t size, size_t n, FILE *f)
{
  const char *s = p;
  (void) f;
  for (size_t i = 0; i < size * n; i++)
    putchar (s[i]);
  return n;
}

int
puts (const char *s)
{
  fputs (s, stdout);
  putchar ('\n');
  return 0;
}

/* ---- decimal, without dividing ------------------------------------------ */

/* snippets/digits3.s: three ASCII digits of a number under 1000, with no
   divide at all - 41n is n/100 in fixed point, and each digit falls out of
   the top four bits.  */
extern void digits3 (unsigned, char *);

/* The digits of V, written backwards from END, and at least WIDTH of them
   with leading zeros - which is what a fraction needs.  Returns the first
   digit written.

   NOTHING HERE DIVIDES.  1000 is 1024 - 24, so 1024q = 1000q + 24q and a
   divmod by 1000 needs no multiply wider than a pair of shifts; three digits
   then come out of digits3 at once.  Normalising everything to 32 bits costs
   the small values nothing, because the loop only runs while the value is
   1024 or more, and it saves a second copy of all of this for 16-bit ones.  */
static char *
dec (unsigned long v, char *end, int width)
{
  char *start = end;

  while (v >= 1000)
    {
      unsigned long q = 0, d = v;
      while (d >= 1024)
	{
	  unsigned m = d & 1023;
	  d >>= 10;			/* divide by 1024 */
	  q += d;
	  d = (d << 4) + (d << 3) + m;	/* 24d, and 1000q + d is still v */
	}
      if (d >= 1000)
	q++, d -= 1000;
      end -= 3;
      digits3 ((unsigned) d, end);	/* a full three digits, zeros and all */
      v = q;
    }

  /* The top chunk is under 1000 and its leading zeros are not wanted.  */
  unsigned w = v;
  char top[3];
  digits3 (w, top);
  for (int k = 2, first = w >= 100 ? 0 : w >= 10 ? 1 : 2; k >= first; k--)
    *--end = top[k];

  while (start - end < width)
    *--end = '0';
  return end;
}

/* A sink that either prints or fills a buffer, so one formatter serves
   printf and snprintf alike.  */
struct sink { char *buf; size_t left; int count; };

static void
emit (struct sink *s, char c)
{
  s->count++;
  if (!s->buf)
    putchar (c);
  else if (s->left > 1)
    *s->buf++ = c, s->left--;
}

int
vsnprintf (char *buf, size_t size, const char *fmt, va_list ap)
{
  struct sink s = { buf, size, 0 };

  for (; *fmt; fmt++)
    {
      if (*fmt != '%')
	{
	  emit (&s, *fmt);
	  continue;
	}
      int zero = 0, left = 0, width = 0, lng = 0, prec = -1;
      fmt++;
      for (;; fmt++)
	if (*fmt == '0')
	  zero = 1;
	else if (*fmt == '-')
	  left = 1;
	else if (*fmt == ' ' || *fmt == '+' || *fmt == '#')
	  ;
	else
	  break;
      if (*fmt == '*')
	width = va_arg (ap, int), fmt++;
      while (*fmt >= '0' && *fmt <= '9')
	width = width * 10 + *fmt++ - '0';
      if (*fmt == '.')
	{
	  fmt++;
	  prec = 0;
	  if (*fmt == '*')
	    prec = va_arg (ap, int), fmt++;
	  while (*fmt >= '0' && *fmt <= '9')
	    prec = prec * 10 + *fmt++ - '0';
	}
      while (*fmt == 'l' || *fmt == 'h' || *fmt == 'z')
	lng += *fmt++ == 'l';

      char tmp[24], *p = tmp + sizeof tmp;
      const char *str = p;
      int neg = 0, shift = 0;
      *--p = 0;
      switch (*fmt)
	{
	case 'd': case 'i':
	  {
	    long v = lng ? va_arg (ap, long) : va_arg (ap, int);
	    if (v < 0)
	      neg = 1, v = -v;
	    p = dec (v, p, 0);
	    if (neg)
	      *--p = '-';
	    str = p;
	    break;
	  }
	case 'u':
	  str = p = dec (lng ? va_arg (ap, unsigned long)
			     : va_arg (ap, unsigned int), p, 0);
	  break;
	/* Eight and sixteen are shifts and masks, so these never divide
	   either, and the digits come out one at a time.  */
	case 'o':
	  shift = 3;
	  /* fall through */
	case 'x': case 'X': case 'p':
	  {
	    unsigned long u = lng ? va_arg (ap, unsigned long)
				  : va_arg (ap, unsigned int);
	    if (!shift)
	      shift = 4;
	    do
	      *--p = "0123456789abcdef"[(unsigned) u & ((1u << shift) - 1)];
	    while (u >>= shift);
	    str = p;
	    break;
	  }
	case 'c':
	  *--p = va_arg (ap, int);
	  str = p;
	  break;
	/* THERE IS NO %f, %g OR %e, AND LEAVING THEM OUT IS WORTH 6188 BYTES.
	   They fall through to `default' as "?" like any other unknown
	   conversion.  MEASURED, a program whose entire body is
	   printf ("%d\n", 42): 7764 bytes when this case existed, 1576 without
	   it.  Eighty per cent of that program was a conversion nothing called.

	   WHAT WENT WITH IT was the whole soft-double library - __adddf3,
	   __subdf3, __muldf3, __fixdfsi, __fixunsdfsi, __floatunsidf, __gedf2
	   and __ltdf2 - because the old code did its arithmetic in `double'
	   however fixed-point the output looked.

	   --gc-sections COULD NOT HAVE SAVED IT.  That drops unused SECTIONS,
	   and this was a `case' inside vsnprintf, so every program that printed
	   an integer linked all eight routines in order to reach code it never
	   executed.  A feature nobody calls is free only when the linker can
	   see that nobody calls it.

	   AND IT WAS NEVER THIS MACHINE'S FLOAT ANYWAY.  What fructus works in
	   is the BBC Micro's five-byte format - an 8-bit biased exponent and a
	   32-bit mantissa, see snippets/fpadd.s - which shares no code and no
	   layout with IEEE double.  If printing a float is ever wanted here, it
	   wants that format, and it wants to cost what that format costs.  */
	case 's':
	  str = va_arg (ap, const char *);
	  if (!str)
	    str = "(null)";
	  break;
	case '%':
	  str = "%";
	  break;
	default:
	  str = "?";
	  break;
	}
      int len = strlen (str);
      /* A zero-padded negative number keeps its sign in front of the zeros:
	 "%05d" of -42 is -0042, not 00-42.  */
      if (!left && zero && *str == '-')
	{
	  emit (&s, *str++);
	  len--, width--;
	}
      if (!left)
	for (; width > len; width--)
	  emit (&s, zero ? '0' : ' ');
      while (*str)
	emit (&s, *str++);
      for (; width > len; width--)
	emit (&s, ' ');
    }
  if (buf && size)
    *s.buf = 0;
  return s.count;
}

/* 32767 AND NOT 65535, because that is the largest object this target can
   have: ptrdiff_t is signed 16 bits, so no conforming pointer difference
   reaches further and gcc says so with -Wformat-truncation.  vsprintf has no
   bound of its own, and the widest one it can honestly claim is the widest a
   buffer could be.  emit() reads this as a capacity INCLUDING the terminator,
   which is why it stops at `left > 1'.  */
int vsprintf (char *b, const char *f, va_list ap) { return vsnprintf (b, 32767, f, ap); }
int vprintf (const char *f, va_list ap) { return vsnprintf (NULL, 0, f, ap); }
int vfprintf (FILE *o, const char *f, va_list ap) { (void) o; return vprintf (f, ap); }

int
printf (const char *f, ...)
{
  va_list ap;
  va_start (ap, f);
  int n = vprintf (f, ap);
  va_end (ap);
  return n;
}

int
fprintf (FILE *o, const char *f, ...)
{
  va_list ap;
  (void) o;
  va_start (ap, f);
  int n = vprintf (f, ap);
  va_end (ap);
  return n;
}

int
sprintf (char *b, const char *f, ...)
{
  va_list ap;
  va_start (ap, f);
  int n = vsprintf (b, f, ap);
  va_end (ap);
  return n;
}

int
snprintf (char *b, size_t size, const char *f, ...)
{
  va_list ap;
  va_start (ap, f);
  int n = vsnprintf (b, size, f, ap);
  va_end (ap);
  return n;
}
