/*
 *
 *	Copyright (C) 1981, Regents of the University of California
 *
 *	All rights reserved
 *
 */

#include <stdio.h>
#ifndef SPEC92
#include "config.h"
#else
#define PACKAGE_STRING "eqntott 9.0"
#endif

void version(void)
{
  fprintf (stderr, PACKAGE_STRING "\n");
  return;
}
