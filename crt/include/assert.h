/* assert.h - a failed assertion aborts; there is nowhere to print it.  */
#undef assert
#ifdef NDEBUG
#define assert(e) ((void) 0)
#else
#ifdef __cplusplus
extern "C"
#endif
void abort (void) __attribute__ ((noreturn));
#define assert(e) ((e) ? (void) 0 : abort ())
#endif
