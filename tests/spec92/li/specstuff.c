/* specstuff.c - XLISP's operating system layer for SPEC92's li.

   In place of the distribution's msstuff.c, whose terminal is MS-DOS's BIOS.
   Here the terminal is spec92.h's stdin, which is empty, and stdout: the
   files on the command line are loaded, and the read-eval-print loop then
   meets the end of its input and exits.  Files open through spec92.h's
   fopen, which finds the embedded ones.  No line editing, no control keys,
   nothing echoed: there is nobody typing.  */

#include "xlisp.h"

extern FILE *tfp;

static long rseed = 1L;

osinit (banner)
  char *banner;
{
  printf ("%s\n", banner);
}

osfinish ()
{
}

oserror (msg)
  char *msg;
{
  printf ("error: %s\n", msg);
}

/* osrand - msstuff.c's, from Dr. Dobb's Journal, November 1985, page 91 */
int
osrand (n)
  int n;
{
  long k1;

  if (rseed == 0L)
    rseed = 1L;
  k1 = rseed / 127773L;
  if ((rseed = 16807L * (rseed - k1 * 127773L) - k1 * 2836L) < 0L)
    rseed += 2147483647L;
  return ((int) (rseed % (long) n));
}

FILE *osaopen (name, mode) char *name, *mode; { return fopen (name, mode); }
FILE *osbopen (name, mode) char *name, *mode; { return fopen (name, mode); }
int osclose (fp) FILE *fp; { return fclose (fp); }
int osagetc (fp) FILE *fp; { return getc (fp); }
int osaputc (ch, fp) int ch; FILE *fp; { return putc (ch, fp); }
int osbgetc (fp) FILE *fp; { return getc (fp); }
int osbputc (ch, fp) int ch; FILE *fp; { return putc (ch, fp); }

int
ostgetc ()
{
  return getc (stdin);
}

ostputc (ch)
  int ch;
{
  putchar (ch);
  if (tfp)
    osaputc (ch, tfp);
}

osflush ()
{
}

oscheck ()
{
}

/* osdefs.h and osptrs.h name these two: SYSTEM and GET-KEY, which have
   nothing to do here.  */
LVAL xsystem () { return NIL; }
LVAL xgetkey () { return NIL; }

/* xlmath.c's sin, sqrt and the rest: there is no floating point, and the
   builtins that reached them are left out of xlftab.c's table.  */
FLOTYPE
nomath ()
{
  xlfail ("no floating point");
  return 0;
}

/* ossymbols - enter os specific symbols: there are none */
ossymbols ()
{
}
