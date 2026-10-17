/* jconfig.h - for the SPEC92 stand-ins' jpeg, on the host and on Fructus.

   Written for this directory, from IJG's jconfig.doc: an ANSI compiler with
   the usual headers.  The same for both builds, so that they compute alike,
   except where only a 16-bit machine needs telling.  */

#define HAVE_PROTOTYPES
#define HAVE_UNSIGNED_CHAR
#define HAVE_UNSIGNED_SHORT
#undef CHAR_IS_UNSIGNED
#define HAVE_STDDEF_H
#define HAVE_STDLIB_H
#undef NEED_BSD_STRINGS
#undef NEED_SYS_TYPES_H
#undef NEED_FAR_POINTERS
#undef NEED_SHORT_EXTERNAL_NAMES
#undef INCOMPLETE_TYPES_BROKEN

#ifdef JPEG_INTERNALS
#undef RIGHT_SHIFT_IS_UNSIGNED

/* The integer DCTs' multiplies as a 16-bit value by a constant: what IJG
   says to do for a 16-bit int (jdct.h: "known to work with Microsoft C
   6.0"), and the shape of a 16x16->32 multiply.  IJG keeps the values in 16
   bits, so it computes the same everywhere, and the host does it too.  */
#define SHORTxLCONST_32

/* No environment to read JPEGMEM from (jmemmgr.c).  */
#define NO_GETENV
#endif

#ifdef __fructus__
/* size_t is 16 bits, and crt/malloc.c's heap is 31K at most.  */
#define MAX_ALLOC_CHUNK 30000L
#endif
