/* setjmp.h - five words: r2, r3, r4, sp and lr.  See libc/setjmp.s.  */
#ifndef _SETJMP_H
#define _SETJMP_H

typedef unsigned int jmp_buf[5];

int setjmp (jmp_buf) __attribute__ ((returns_twice));
void longjmp (jmp_buf, int) __attribute__ ((noreturn));

#endif
