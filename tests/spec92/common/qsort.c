/* qsort.c - the benchmarks' qsort, as spec92.h renames it.

   The machines SPEC92 ran on had a quicksort in their C libraries, and
   eqntott spends most of its time in one.  crt/libc.c's is an insertion sort
   - enough for a test, and quadratic - so the benchmarks bring this one, and
   both builds use it: qsort is not stable, and the host has to put equal keys
   in the same order as Fructus or the reference output would differ.

   Quicksort on the median of three, insertion sort below eight elements, and
   recursion only into the smaller half, so the stack is O(log n).  */

#include <stddef.h>

static void
swap (char *a, char *b, size_t size)
{
  while (size--)
    {
      char t = *a;
      *a++ = *b;
      *b++ = t;
    }
}

void
spec92_qsort (void *base, size_t n, size_t size,
	      int (*cmp) (const void *, const void *))
{
  char *b = base;
  while (n >= 8)
    {
      char *lo = b, *mid = b + (n / 2) * size, *hi = b + (n - 1) * size;
      /* Order lo, mid and hi, which leaves the median in mid and a sentinel
	 at each end for the scans below.  */
      if (cmp (mid, lo) < 0)
	swap (mid, lo, size);
      if (cmp (hi, mid) < 0)
	{
	  swap (hi, mid, size);
	  if (cmp (mid, lo) < 0)
	    swap (mid, lo, size);
	}
      swap (mid, lo + size, size);	/* the pivot, out of the way */
      char *p = lo + size, *i = p, *j = hi;
      for (;;)
	{
	  do i += size; while (cmp (i, p) < 0);
	  do j -= size; while (cmp (j, p) > 0);
	  if (i >= j)
	    break;
	  swap (i, j, size);
	}
      swap (p, j, size);
      size_t left = (j - b) / size, right = n - left - 1;
      if (left < right)
	{
	  spec92_qsort (b, left, size, cmp);
	  b = j + size;
	  n = right;
	}
      else
	{
	  spec92_qsort (j + size, right, size, cmp);
	  n = left;
	}
    }
  for (size_t i = 1; i < n; i++)
    for (char *p = b + i * size; p > b && cmp (p - size, p) > 0; p -= size)
      swap (p - size, p, size);
}
