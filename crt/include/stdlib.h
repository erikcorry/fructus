/* stdlib.h - the parts of the C library the simulator's libc provides.  */
#ifndef _STDLIB_H
#define _STDLIB_H

#include <stddef.h>

#define EXIT_SUCCESS 0
#define EXIT_FAILURE 1

void abort (void) __attribute__ ((noreturn));
void exit (int) __attribute__ ((noreturn));
void _exit (int) __attribute__ ((noreturn));

int abs (int);
long labs (long);
int atoi (const char *);
long atol (const char *);
long strtol (const char *, char **, int);
unsigned long strtoul (const char *, char **, int);

void *malloc (size_t);
void *calloc (size_t, size_t);
void *realloc (void *, size_t);
void free (void *);

void qsort (void *, size_t, size_t, int (*) (const void *, const void *));

#endif
