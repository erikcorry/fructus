/* signal.h - for the Fructus builds of the SPEC92 stand-ins only.

   There are no signals.  Old programs include this to catch interrupts they
   will never get; one that calls signal() is a link error.  */

#ifndef _SIGNAL_H
#define _SIGNAL_H

#define SIGINT  2
#define SIGSEGV 11
#define SIGTERM 15
#define SIG_DFL ((void (*) (int)) 0)
#define SIG_IGN ((void (*) (int)) 1)
void (*signal (int, void (*) (int))) (int);

#endif
