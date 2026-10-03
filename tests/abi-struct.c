/* Callees for the struct-passing check.  The caller is tests/abi-struct.s,
   written by hand, because compiled code calling compiled code agrees with
   itself whatever convention it uses.

   isa/abi.s: a struct is decomposed into its fields and each field is
   assigned independently, so a field of any size up to 16 bits takes a whole
   register - and the limit is four REGISTERS, not eight bytes.  */

/* The layout, isa/abi.s "data layout": chars aligned to one, everything
   wider to two, fields in declaration order and padded to their alignment,
   and the size rounded to the struct's.  */
struct gap { char a; int b; char c; };
struct tight { int b; char a; char c; };
struct bytes3 { char a, b, c; };
struct with_long { char a; long b; };
_Static_assert (sizeof (struct gap) == 6, "char, int, char is six bytes");
_Static_assert (__builtin_offsetof (struct gap, b) == 2, "int after a char at 2");
_Static_assert (__builtin_offsetof (struct gap, c) == 4, "then a char at 4");
_Static_assert (sizeof (struct tight) == 4, "int, char, char packs into four");
_Static_assert (sizeof (struct bytes3) == 3 && _Alignof (struct bytes3) == 1,
		"chars alone are byte aligned and unpadded");
_Static_assert (_Alignof (long) == 2 && __builtin_offsetof (struct with_long, b) == 2,
		"a long is aligned to two, never four");
_Static_assert (_Alignof (int) == 2 && _Alignof (void *) == 2
		&& _Alignof (float) == 2 && _Alignof (long long) == 2,
		"every wider type is aligned to two");

struct two_chars { char a, b; };
struct pair { int a, b; };
struct mixed { int a; long b; };
struct fat { char *p; unsigned tag; };
struct five { char a, b, c, d, e; };
struct three { int a, b, c; };
struct four_chars { char a, b, c, d; };

/* Two fields, so two registers - one byte each, but a register apiece.  */
int
take2c (struct two_chars s)
{
  return s.a * 100 + s.b;
}

int
takepair (struct pair s)
{
  return s.a * 100 + s.b;
}

/* Three registers: the long takes two of them, low half first.  */
long
takemixed (struct mixed s)
{
  return s.a + s.b;
}

/* The example in isa/abi.s, which it says should be an add and a ret.  */
struct fat
fat_bump (struct fat f)
{
  f.p += 2;
  return f;
}

/* Returned in registers, since two fields fit in four.  */
struct pair
make_pair (int a, int b)
{
  struct pair s;
  s.a = a;
  s.b = b;
  return s;
}

/* Three arguments fill r0, r1 and r2, leaving one register - and a struct is
   one value for the no-splitting rule, so both its fields go on the stack
   and r3 goes unused.  */
int
no_room (int a, int b, int c, struct pair s)
{
  return a + b + c + s.a * 10 + s.b * 100;
}

/* Five fields is five registers, which is more than there are, so the whole
   thing goes on the stack - even though it is five bytes.  */
int
takefive (struct five s)
{
  return s.a + s.b + s.c + s.d + s.e;
}

/* Three fields come back in r0, r1 and r2, and four chars in r0-r3, so the
   return reaches r2 and r3 and neither function may preserve them for its
   caller.  They take no arguments, which is the case that went wrong: the
   return was counted by its mode - none for a six-byte struct, two for four
   chars - so the functions believed r2 and r3 callee saved, used them as
   scratch at -O0, and restored the caller's values over the fields.  The
   copy through a second local is what gets them used as scratch.  */
struct three
make_three (void)
{
  struct three s = { 176, 52, 31 };
  struct three t;
  t = s;
  return t;
}

struct four_chars
make_four (void)
{
  struct four_chars s = { 1, 2, 3, 4 };
  struct four_chars t;
  t = s;
  return t;
}

/* Four ints fill r0-r3, so the char goes on the stack in a word slot, value
   in the low byte, and the int after it is at an even offset.  The caller
   leaves garbage in the slot's high byte, which must not be looked at.  */
int
byte_on_stack (int a, int b, int c, int d, char e, int f)
{
  return a + b + c + d + e * 100 + f * 1000;
}
