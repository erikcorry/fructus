/* string.h - the parts of the C library the simulator's libc provides.  */
#ifndef _STRING_H
#define _STRING_H

#include <stddef.h>

void *memcpy (void *, const void *, size_t);
void *memmove (void *, const void *, size_t);
void *memset (void *, int, size_t);
int memcmp (const void *, const void *, size_t);
void *memchr (const void *, int, size_t);
void bzero (void *, size_t);

size_t strlen (const char *);
int strcmp (const char *, const char *);
int strncmp (const char *, const char *, size_t);
char *strcpy (char *, const char *);
char *strncpy (char *, const char *, size_t);
char *strcat (char *, const char *);
char *strncat (char *, const char *, size_t);
char *strchr (const char *, int);
char *strrchr (const char *, int);
char *strstr (const char *, const char *);

#endif
