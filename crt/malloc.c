/* malloc.c - a two-level allocator, sixteen bits wide.

   Copyright (c) 2016, the Dartino project authors.
   Copyright (C) 2019 Toitware ApS.
   BSD-licensed; see crt/LICENSE.dartino.

   This is cmpctmalloc, cut down to fit a machine whose pointers are two bytes
   and whose every byte of code is grudged.  The esp-idf scaffolding around it
   - locks, interrupt checks, thread-local allocation tags, the multi-heap
   wrappers, the statistics - is gone, along with the ifdefs that carried it:
   there is one heap, it is a static, and nothing here preempts anything.

   THE SHAPE OF IT.  A page is 256 bytes.  An allocation of more than 3/4 of a
   page comes straight from the page allocator, which hands out runs of whole
   pages; anything smaller is carved out of a page by the bucket allocator,
   which also gets its pages from there.  A page whose last small allocation
   is freed goes back to the page allocator whole, so the two layers lend
   memory to each other in both directions.

   WHAT SIXTEEN BITS CHANGED.  Allocations are rounded and aligned to two
   bytes rather than eight, so the smallest useful bucket is two bytes and the
   buckets start there.  Everything inside a page is within 256 bytes of
   everything else in it, so the header that upstream spends a whole 32-bit
   word on is TWO BYTES here: one byte to the next block and one byte back to
   the previous one.  Both are even, which leaves the low bit of each spare,
   and the low bit of the backward one says that this block is free.  The
   freelist links cannot be bytes, because a bucket's chain runs from page to
   page, so they are real 16-bit pointers - which is why a free block needs
   six bytes and no allocation is smaller than four.

   The heap lives in .bss and is correct when zeroed: an empty freelist is a
   null pointer, and page status 0 is PAGE_FREE.  There is no initialisation
   to call and no first-call test on the hot path.  The one thing that must be
   arranged is that the page array is 256-byte aligned, which is what makes a
   pointer's low byte tell page allocations apart from small ones.

   Every entry point loads the address of the heap and passes it down.  That
   is a deliberate choice of shape: reaching a global directly costs a 3-byte
   `mov' and a load EACH TIME, while a base register in r0 makes every field
   of it a one-instruction `ld rd, r0, #offset'.  */

#include <stddef.h>
#include <stdlib.h>
#include <string.h>

void abort (void) __attribute__ ((noreturn));

/* ---- the shape of the heap ---------------------------------------------- */

#define PAGE_SHIFT 8
#define PAGE_SIZE (1 << PAGE_SHIFT)

/* Eight kilobytes.  It costs nothing in the image - .bss is not loaded - but
   it is address space, so it is the one number to turn when a program wants
   more heap or a smaller machine wants less.  */
#define HEAP_PAGES 32

/* All individual memory areas in a page start with this.  SIZE is the
   distance to the next one and LEFT_SIZE the distance back to the previous
   one, both including the header itself and both always even.  Zero is not a
   possible distance, so the two ends of a page use it as a marker: size 0 is
   the sentinel that ends a page, left_size 0 the one that starts it.  */
typedef struct header
{
  unsigned char size;
  unsigned char left_size;	/* low bit set: THIS block is free */
} header_t;

/* A free block is a header plus its place in a bucket's chain.  The chain is
   doubly linked so that coalescing can unlink a neighbour without walking.  */
typedef struct free_block
{
  header_t header;
  struct free_block *next;
  struct free_block *prev;
} free_t;

/* SIX BYTES IS THE FLOOR FOR EVERY BLOCK, allocated or not.  A block has to
   become a free block one day, and a free block has to hold two links, so
   anything smaller could be handed out but never taken back: there would be
   nowhere to record it and no way to find it again or coalesce it.  So
   allocation rounds its payload up to MIN_PAYLOAD, and carving refuses to
   leave a remainder below sizeof (free_t) - the two places a block's size is
   decided, both measured from this one struct.  */
#define MIN_PAYLOAD (sizeof (free_t) - sizeof (header_t))

/* A page holds two sentinels and the rest is one free area.  */
#define PAGE_PAYLOAD (PAGE_SIZE - 2 * sizeof (header_t))

/* Above this an allocation gets whole pages of its own.  Three quarters of a
   page: what is left over below the line still buys a useful small block,
   what is left over above it would not.  */
#define SMALL_ALLOCATION_LIMIT 192

/* Buckets.  The first 16 are simply 2-spaced: 2, 4, 6, ... 32.  Above that
   they are logarithmic, 8 to each binary order of magnitude - every 4 up to
   64, every 8 up to 128, every 16 up to 256 - which is three more rows of
   eight.  A block in a bucket is at least the bucket's size, so allocating
   rounds up to a bucket and freeing rounds down to one, and then the first
   block of the first non-empty bucket at or above the request always fits
   with no chain to search.  */
#define NUMBER_OF_BUCKETS (15 + 3 * 8)

/* A bit per bucket, so that finding the first non-empty one at or above a
   given bucket is a mask and a `clz' rather than a walk.  */
#define BUCKET_WORDS ((NUMBER_OF_BUCKETS + 15) >> 4)

#define PAGE_FREE 0
#define PAGE_IN_USE 1		/* first page of a run */
#define PAGE_CONTINUED 2	/* a later page of one */

typedef struct heap
{
  free_t *free_lists[NUMBER_OF_BUCKETS];
  unsigned free_list_bits[BUCKET_WORDS];
  unsigned remaining;		/* bytes on the freelists, sentinels aside */
  /* One entry per page, and one more: a scan for the end of a run stops at
     anything that is not PAGE_CONTINUED, and the zero left there by .bss is
     not PAGE_CONTINUED.  */
  unsigned char pages[HEAP_PAGES + 1];
} heap_t;

static heap_t the_heap;

/* The alignment is load-bearing, not decoration: free () tells a page
   allocation from a small one by its low byte, which works because a small
   allocation's payload is at least four bytes into its page.  */
static unsigned char heap_memory[HEAP_PAGES * PAGE_SIZE]
  __attribute__ ((aligned (PAGE_SIZE)));

/* ---- headers ------------------------------------------------------------ */

#define IS_FREE(h) (((h)->left_size & 1) != 0)

static header_t *
right_header (header_t *header)
{
  return (header_t *) ((unsigned char *) header + header->size);
}

static header_t *
left_header (header_t *header)
{
  return (header_t *) ((unsigned char *) header - (header->left_size & ~1));
}

/* After a block's left neighbour has moved or grown.  */
static void
fix_left_size (header_t *right, header_t *new_left)
{
  right->left_size = ((unsigned char *) right - (unsigned char *) new_left)
		     | (right->left_size & 1);
}

/* ---- buckets ------------------------------------------------------------ */

/* Operates in sizes that do not include the header.  ADJUST and INCREMENT are
   what separate rounding up from rounding down; see the two callers.  */
static int
size_to_index_helper (unsigned size, unsigned *rounded_up_out,
		      int adjust, int increment)
{
  /* The 2-spaced buckets, up to 32.  Nothing smaller than a free block can
     ever be handed back, so that is the floor.  */
  if (size <= 32)
    {
      if (size < MIN_PAYLOAD)
	size = MIN_PAYLOAD;
      *rounded_up_out = size;
      return (size >> 1) - 1;
    }

  /* Going up to the next bucket would also step past a size that IS one, so
     the caller subtracts 2 first and the carry does the right thing on the
     round numbers.  */
  size += adjust;
  /* 32 is 1 << 5 and wants row 2, so that (size >> row) & 7 is the column
     within the row: clz (32) is 10 and 12 - 10 is 2.  */
  unsigned row = 12 - __builtin_clz (size);
  unsigned column = (size >> row) & 7;
  int row_column = (row << 3) | column;
  row_column += increment;
  *rounded_up_out = (8 + (row_column & 7)) << (row_column >> 3);
  /* Row 2 column 0 is size 32, which is also the last of the 2-spaced
     buckets, index 15: the two numberings meet there.  */
  return row_column - 1;
}

static int
size_to_index_allocating (unsigned size, unsigned *rounded_up_out)
{
  return size_to_index_helper ((size + 1) & ~1, rounded_up_out, -2, 1);
}

static int
size_to_index_freeing (unsigned size)
{
  unsigned dummy;
  return size_to_index_helper (size, &dummy, 0, 0);
}

/* The first bucket at or above INDEX with anything in it, or -1.  The bits
   are numbered from the top of the word so that `clz' finds the lowest.  */
static int
find_nonempty_bucket (heap_t *heap, int index)
{
  unsigned mask = (1u << (15 - (index & 15))) - 1;
  mask = mask * 2 + 1;
  mask &= heap->free_list_bits[index >> 4];
  if (mask != 0)
    return (index & ~15) + __builtin_clz (mask);
  for (index = (index | 15) + 1; index < NUMBER_OF_BUCKETS; index += 16)
    {
      mask = heap->free_list_bits[index >> 4];
      if (mask != 0)
	return index + __builtin_clz (mask);
    }
  return -1;
}

/* ---- the page allocator ------------------------------------------------- */

/* First fit over a byte per page.  PAGES is never large - the whole heap is
   32 of them - so there is nothing cleverer worth its code.  */
static unsigned char *
page_alloc (heap_t *heap, unsigned pages)
{
  for (unsigned i = 0; i + pages <= HEAP_PAGES; i++)
    {
      if (heap->pages[i] != PAGE_FREE)
	continue;
      unsigned j;
      for (j = 1; j < pages; j++)
	if (heap->pages[i + j] != PAGE_FREE)
	  break;
      if (j < pages)
	{
	  i += j;		/* nothing starting before i + j can fit */
	  continue;
	}
      heap->pages[i] = PAGE_IN_USE;
      for (j = 1; j < pages; j++)
	heap->pages[i + j] = PAGE_CONTINUED;
      return heap_memory + (i << PAGE_SHIFT);
    }
  return NULL;
}

/* A run is freed whole; its length is written in the page array, so the
   caller does not have to remember it.  */
static void
page_free (heap_t *heap, void *address)
{
  unsigned page = ((unsigned char *) address - heap_memory) >> PAGE_SHIFT;
  if (page >= HEAP_PAGES || heap->pages[page] != PAGE_IN_USE)
    abort ();			/* not ours, or freed twice */
  heap->pages[page] = PAGE_FREE;
  while (heap->pages[++page] == PAGE_CONTINUED)
    heap->pages[page] = PAGE_FREE;
}

static unsigned
page_run_length (heap_t *heap, unsigned char *address)
{
  unsigned page = ((unsigned char *) address - heap_memory) >> PAGE_SHIFT;
  unsigned n = 1;
  while (heap->pages[page + n] == PAGE_CONTINUED)
    n++;
  return n;
}

/* ---- the bucket allocator ----------------------------------------------- */

static void
create_free_area (heap_t *heap, void *address, unsigned left_size,
		  unsigned size)
{
  free_t *free_area = address;
  free_area->header.size = size;
  free_area->header.left_size = left_size | 1;

  int index = size_to_index_freeing (size - sizeof (header_t));
  heap->free_list_bits[index >> 4] |= 1u << (15 - (index & 15));
  free_t *old_head = heap->free_lists[index];
  if (old_head != NULL)
    old_head->prev = free_area;
  free_area->next = old_head;
  free_area->prev = NULL;
  heap->free_lists[index] = free_area;
  heap->remaining += size;
}

static void
unlink_free (heap_t *heap, free_t *free_area, int bucket)
{
  heap->remaining -= free_area->header.size;
  free_t *next = free_area->next;
  free_t *prev = free_area->prev;
  if (heap->free_lists[bucket] == free_area)
    {
      heap->free_lists[bucket] = next;
      if (next == NULL)
	heap->free_list_bits[bucket >> 4] &= ~(1u << (15 - (bucket & 15)));
    }
  if (prev != NULL)
    prev->next = next;
  if (next != NULL)
    next->prev = prev;
}

static void
unlink_free_unknown_bucket (heap_t *heap, free_t *free_area)
{
  unlink_free (heap, free_area,
	       size_to_index_freeing (free_area->header.size
				      - sizeof (header_t)));
}

/* Take a page from the page allocator and lay it out for small allocations:
   a sentinel at each end and one free area between them.  */
static int
heap_grow (heap_t *heap)
{
  unsigned char *page = page_alloc (heap, 1);
  if (page == NULL)
    return 0;
  header_t *left = (header_t *) page;
  left->size = sizeof (header_t);
  left->left_size = 0;		/* the start of a page: do not coalesce left */
  header_t *right = (header_t *) (page + PAGE_SIZE - sizeof (header_t));
  right->size = 0;		/* the end of one: do not coalesce right */
  right->left_size = PAGE_PAYLOAD;
  create_free_area (heap, page + sizeof (header_t), sizeof (header_t),
		    PAGE_PAYLOAD);
  return 1;
}

/* Put a block back on a freelist, and give the page away if that emptied
   it.  SIZE and LEFT_SIZE are passed in because the caller has usually just
   coalesced and they are not in the header yet.  */
static void
free_memory (heap_t *heap, header_t *header, unsigned left_size,
	     unsigned size)
{
  create_free_area (heap, header, left_size, size);
  header_t *left = left_header (header);
  header_t *right = right_header (header);
  fix_left_size (right, header);
  /* Every page this allocator owns is laid out by heap_grow, so a free area
     between the two sentinels is the whole page.  */
  if (left->left_size == 0 && right->size == 0)
    {
      unlink_free_unknown_bucket (heap, (free_t *) header);
      page_free (heap, left);
    }
}

static void *
cmpct_alloc (heap_t *heap, unsigned size)
{
  unsigned rounded_up;
  int start_bucket = size_to_index_allocating (size, &rounded_up);
  rounded_up += sizeof (header_t);

  int bucket = find_nonempty_bucket (heap, start_bucket);
  if (bucket == -1)
    {
      if (!heap_grow (heap))
	return NULL;
      /* An allocation is always less than a page, so this cannot fail.  */
      bucket = find_nonempty_bucket (heap, start_bucket);
    }

  free_t *head = heap->free_lists[bucket];
  header_t *block = &head->header;
  unsigned block_size = block->size;
  unsigned rest = block_size - rounded_up;
  unlink_free (heap, head, bucket);

  /* The tail becomes a free block of its own, unless it is too small to hold
     the freelist links - a two- or four-byte remainder has nowhere to record
     itself, so carving one off would lose it for good - or so small relative
     to the allocation that leaving it attached is better than stranding it
     between two long-lived blocks where it will stop the page from ever
     coming free.  Either way the allocation absorbs it: rounding the block
     up is the only thing that can be done with a remainder that cannot be a
     block.  The buckets are 6% to 12% apart, so this rounds the waste up by
     at most another 3%.  */
  if (rest >= sizeof (free_t) && rest > (size >> 5))
    {
      header_t *right = right_header (block);
      header_t *tail = (header_t *) ((unsigned char *) block + rounded_up);
      create_free_area (heap, tail, rounded_up, rest);
      fix_left_size (right, tail);
      block_size = rounded_up;
    }

  block->size = block_size;
  block->left_size &= ~1;	/* no longer free */
  return block + 1;
}

/* ---- what the program calls --------------------------------------------- */

void *
malloc (size_t size)
{
  heap_t *heap = &the_heap;
  if (size > SMALL_ALLOCATION_LIMIT)
    {
      /* Rounding up would wrap for a size near 64K, and nothing that big can
	 be satisfied anyway.  */
      if (size > (size_t) HEAP_PAGES * PAGE_SIZE)
	return NULL;
      return page_alloc (heap, (size + PAGE_SIZE - 1) >> PAGE_SHIFT);
    }
  return cmpct_alloc (heap, size);
}

/* The usable size of an allocation, which is at least what was asked for.  */
static size_t
allocation_size (heap_t *heap, void *p)
{
  if (((unsigned) p & (PAGE_SIZE - 1)) == 0)
    return page_run_length (heap, p) << PAGE_SHIFT;
  return ((header_t *) p)[-1].size - sizeof (header_t);
}

void
free (void *p)
{
  if (p == NULL)
    return;
  heap_t *heap = &the_heap;
  /* A small allocation's payload is four bytes into its page at least, so a
     page-aligned pointer is a page allocation and nothing else.  */
  if (((unsigned) p & (PAGE_SIZE - 1)) == 0)
    {
      page_free (heap, p);
      return;
    }

  header_t *header = (header_t *) p - 1;
  if (IS_FREE (header))
    abort ();			/* double free */
  unsigned size = header->size;
  header_t *left = left_header (header);
  header_t *right = right_header (header);

  if (IS_FREE (left))
    {
      /* Leave the free mark behind in what is about to become the middle of
	 a larger free area, so that freeing this pointer again still
	 finds it.  */
      header->left_size |= 1;
      unlink_free_unknown_bucket (heap, (free_t *) left);
      if (IS_FREE (right))
	{
	  unlink_free_unknown_bucket (heap, (free_t *) right);
	  free_memory (heap, left, left->left_size,
		       left->size + size + right->size);
	}
      else
	free_memory (heap, left, left->left_size, left->size + size);
    }
  else if (IS_FREE (right))
    {
      unlink_free_unknown_bucket (heap, (free_t *) right);
      free_memory (heap, header, header->left_size, size + right->size);
    }
  else
    free_memory (heap, header, header->left_size, size);
}

void *
calloc (size_t n, size_t size)
{
  /* The product is computed wide, because two sizes that each fit in a word
     can multiply to something that does not.  */
  unsigned long total = (unsigned long) n * size;
  if (total > 0xffffu)
    return NULL;
  void *p = malloc ((size_t) total);
  if (p != NULL)
    memset (p, 0, (size_t) total);
  return p;
}

/* A block that is already big enough is handed straight back - which covers
   every shrink, and every grow that fits in what the buckets rounded up.
   Anything else is a fresh block and a copy.

   Neither end of the block is negotiated with its neighbours: a free area
   just past it is never annexed, and a shrink never splits one off.  Both
   would mean carving and coalescing here, for a case a program with room to
   spare does not need - and after bucket rounding a shrink usually has
   nowhere to put the remainder anyway.  */
void *
realloc (void *p, size_t size)
{
  if (size == 0)
    {
      free (p);
      return NULL;
    }
  /* realloc (NULL, n) is malloc (n): there is nothing to keep, so nothing
     fits, and the path below does it.  Spelling it this way rather than an
     early return of malloc (size) keeps the call in one place.  */
  size_t had = p == NULL ? 0 : allocation_size (&the_heap, p);
  if (had >= size)
    return p;
  /* Only the growing path copies, and it copies all there was: had < size.
     A failed malloc leaves the old block alone, as it must.  */
  void *fresh = malloc (size);
  if (fresh != NULL && p != NULL)
    {
      memcpy (fresh, p, had);
      free (p);
    }
  return fresh;
}

/* Everything not handed out: the freelists, plus the pages nobody holds.
   For tests - a heap that has had everything freed reports exactly what it
   did at the start, so a leak or a lost page shows up as a number.  */
size_t
malloc_free_bytes (void)
{
  heap_t *heap = &the_heap;
  size_t free_pages = 0;
  for (unsigned i = 0; i < HEAP_PAGES; i++)
    if (heap->pages[i] == PAGE_FREE)
      free_pages++;
  return heap->remaining + (free_pages << PAGE_SHIFT);
}
