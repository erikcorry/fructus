/* stdio.h - output only, to the simulator's console.  */
#ifndef _STDIO_H
#define _STDIO_H

#include <stddef.h>
#include <stdarg.h>

#define EOF (-1)

typedef struct __file FILE;
extern FILE *stdin, *stdout, *stderr;

int putchar (int);
int puts (const char *);
int printf (const char *, ...);
int fprintf (FILE *, const char *, ...);
int sprintf (char *, const char *, ...);
int snprintf (char *, size_t, const char *, ...);
int vprintf (const char *, va_list);
int vfprintf (FILE *, const char *, va_list);
int vsprintf (char *, const char *, va_list);
int vsnprintf (char *, size_t, const char *, va_list);
int fputs (const char *, FILE *);
size_t fwrite (const void *, size_t, size_t, FILE *);
int fputc (int, FILE *);
int fflush (FILE *);

#endif
