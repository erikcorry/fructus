/* math.h - for the Fructus builds of the SPEC92 stand-ins only.

   The C library has no libm.  Old programs include this whether or not they
   use it, so it declares the usual functions and defines none: one that is
   really called is a link error, not a quiet wrong answer.  */

#ifndef _MATH_H
#define _MATH_H

double sqrt (double), sin (double), cos (double), tan (double), atan (double);
double exp (double), log (double), log10 (double), pow (double, double);
double floor (double), ceil (double), fabs (double), fmod (double, double);

#endif
