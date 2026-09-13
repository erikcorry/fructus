/* crt/malloc.c, checked against the three things an allocator must never do:
   hand out the same byte twice, lose memory that was given back, and make a
   block too small to be given back at all.

   None of them needs a reference implementation.  Overlap shows up because
   every live block is filled with a byte of its own and read back before it
   is freed, so a second block sharing any of it changes the first.  Loss
   shows up because malloc_free_bytes () is exact: free everything and it is
   back to what it said at the start, or a page went missing.  And the
   six-byte floor shows up in the same number, because the exact drop says
   what a request really cost.

   main returns 0, or the number of the first check that failed.  */

#include <stdlib.h>
#include <string.h>

#define SLOTS 16
#define MAX_PAGES 64

static char *slot[SLOTS];
static unsigned len[SLOTS];
static unsigned char mark[SLOTS];
static char *page[MAX_PAGES];

/* A 16-bit xorshift, so that the sequence is the same on every run and a
   failure can be looked at again.  */
static unsigned seed = 12345;

static unsigned
rnd (void)
{
  seed ^= seed << 7;
  seed ^= seed >> 9;
  seed ^= seed << 8;
  return seed;
}

static int
intact (unsigned k)
{
  for (unsigned i = 0; i < len[k]; i++)
    if ((unsigned char) slot[k][i] != mark[k])
      return 0;
  return 1;
}

/* GCC KNOWS WHAT MALLOC AND FREE MEAN.  At -O2 it deletes a malloc and its
   free when the block between them is never touched, which is allowed -
   nothing in the standard can tell the difference - and which is most of the
   blocks in the section below, because what that section measures is the
   SIZE of a block and not its contents.  Storing the pointer somewhere
   volatile makes it escape, so the call has to happen.  (Nothing else here
   needs this: every other block is written and read back.)  */
static void *volatile sink;

static char *
keep (char *p)
{
  sink = p;
  return p;
}

int
main (void)
{
  size_t start = malloc_free_bytes ();

  /* ---- one small allocation, and the page it came from given back ------- */
  char *p = malloc (10);
  if (!p)
    return 1;
  memset (p, 0x5a, 10);
  free (p);
  if (malloc_free_bytes () != start)
    return 2;

  /* The same size asked for again comes back to the same place: the page was
     returned to the page allocator whole and fetched again.  */
  char *q = malloc (10);
  free (q);
  if (q != p)
    return 3;

  /* ---- a big one goes to the page allocator ---------------------------- */
  char *big = malloc (200);
  if (!big || ((unsigned) big & 255) != 0)
    return 4;
  char *big2 = malloc (300);
  if (!big2 || ((unsigned) big2 & 255) != 0)
    return 5;
  /* 300 bytes is two pages, so nothing else may start inside them.  */
  if (big2 >= big && big2 < big + 256)
    return 6;
  memset (big, 1, 200);
  memset (big2, 2, 300);
  for (unsigned i = 0; i < 200; i++)
    if (big[i] != 1)
      return 7;
  free (big);
  free (big2);
  if (malloc_free_bytes () != start)
    return 8;

  /* ---- calloc zeroes, realloc keeps what was there ---------------------- */
  char *z = calloc (20, 3);
  if (!z)
    return 9;
  for (unsigned i = 0; i < 60; i++)
    if (z[i] != 0)
      return 10;
  free (z);

  /* The two ends of realloc: with no block it is malloc, with no size it is
     free.  Both go through the same path as everything else.  */
  char *fromnull = realloc (NULL, 12);
  if (!fromnull)
    return 11;
  memset (fromnull, 0x77, 12);
  if (realloc (fromnull, 0) != NULL)
    return 12;
  if (malloc_free_bytes () != start)
    return 13;				/* realloc to nothing must free */

  char *r = malloc (30);
  memset (r, 0x33, 30);
  char *grown = realloc (r, 100);	/* too big to stay: moves and copies */
  if (!grown)
    return 14;
  for (unsigned i = 0; i < 30; i++)
    if (grown[i] != 0x33)
      return 15;
  /* Shrinking is nothing at all: the block is already big enough, so the
     same pointer comes back, uncopied and unsplit.  */
  if (realloc (grown, 8) != grown)
    return 16;
  for (unsigned i = 0; i < 8; i++)
    if (grown[i] != 0x33)
      return 17;
  free (grown);
  if (malloc_free_bytes () != start)
    return 18;

  /* ---- the six-byte floor -----------------------------------------------
     A block has to be able to become a free block, and a free block holds
     two links, so nothing smaller than six bytes - four of payload and the
     header - may ever exist.  There are two ways to make one: ask for less,
     or carve a larger free area so as to leave less behind.  Both are
     watched here through the exact drop in the free total, which is the
     whole block and not just what was asked for.

     The first allocation opens a page, which also costs the two sentinels,
     so the measuring starts after that.  */
  char *anchor = keep (malloc (4));
  size_t f = malloc_free_bytes ();

  char *t1 = keep (malloc (1));		/* rounded up to four of payload */
  if (malloc_free_bytes () != f - 6)
    return 19;
  char *t2 = keep (malloc (2));
  if (malloc_free_bytes () != f - 12)
    return 20;
  char *t3 = keep (malloc (4));
  if (malloc_free_bytes () != f - 18)
    return 21;

  /* Now three blocks with allocated neighbours on both sides, so that each
     becomes a hole of exactly its own size when freed.  */
  char *t4 = keep (malloc (8));		/* ten bytes */
  char *t5 = keep (malloc (6));		/* eight */
  char *t6 = keep (malloc (4));		/* six, a wall to the right of t5 */
  if (malloc_free_bytes () != f - 42)
    return 22;

  /* A ten-byte hole asked for four: the remainder would be four bytes, which
     could never be freed, so the allocation must swallow the lot.  */
  free (t4);
  size_t before = malloc_free_bytes ();
  char *g = keep (malloc (4));
  if (g != t4)
    return 23;				/* the hole was not even reused */
  if (malloc_free_bytes () != before - 10)
    return 24;				/* carved, and four bytes are lost */

  /* And an eight-byte hole, where the remainder would be two.  */
  free (t5);
  before = malloc_free_bytes ();
  char *h = keep (malloc (4));
  if (h != t5)
    return 25;
  if (malloc_free_bytes () != before - 8)
    return 26;

  free (anchor);
  free (t1);
  free (t2);
  free (t3);
  free (g);
  free (h);
  free (t6);
  if (malloc_free_bytes () != start)
    return 27;

  /* ---- churn ------------------------------------------------------------
     Sixteen live blocks, replaced one at a time in a random order, mostly
     small but one in sixteen large enough to take a page of its own - which
     is what makes the two allocators take memory from each other.  Sixteen
     of the largest would be more than half the heap, so this also runs the
     heap close enough to full to coalesce rather than always grow.  */
  for (unsigned round = 0; round < 1200; round++)
    {
      unsigned k = rnd () & (SLOTS - 1);
      if (slot[k])
	{
	  if (!intact (k))
	    return 28;
	  free (slot[k]);
	  slot[k] = NULL;
	}
      /* Every bucket row wants a turn: 1 to 128 covers the 2-spaced buckets
	 and the first two logarithmic rows, 129 to 192 the last row, and
	 above that is the page allocator.  */
      unsigned bits = rnd ();
      unsigned n = (bits & 15) == 0 ? 193 + ((bits >> 8) & 63)
		   : (bits & 15) == 1 ? 129 + ((bits >> 8) & 63)
				      : 1 + ((bits >> 4) & 127);
      char *block = malloc (n);
      if (!block)
	return 29;
      if ((unsigned) block & 1)
	return 30;			/* allocations are 2-byte aligned */
      slot[k] = block;
      len[k] = n;
      mark[k] = (unsigned char) (k * 17 + round);
      memset (block, mark[k], n);
    }
  for (unsigned k = 0; k < SLOTS; k++)
    if (slot[k])
      {
	if (!intact (k))
	  return 31;
	free (slot[k]);
	slot[k] = NULL;
      }
  if (malloc_free_bytes () != start)
    return 32;

  /* ---- and all of it, until there is none left -------------------------- */
  unsigned n = 0;
  char *big3;
  while ((big3 = malloc (200)) != NULL)
    {
      if (((unsigned) big3 & 255) != 0)
	return 33;
      if (n == MAX_PAGES)
	return 34;			/* more pages than the heap has */
      page[n++] = big3;
      memset (big3, n, 200);
    }
  if (n == 0)
    return 35;
  for (unsigned i = 0; i < n; i++)
    for (unsigned j = 0; j < 200; j++)
      if ((unsigned char) page[i][j] != i + 1)
	return 36;
  for (unsigned i = 0; i < n; i++)
    free (page[i]);
  if (malloc_free_bytes () != start)
    return 37;

  return 0;
}
