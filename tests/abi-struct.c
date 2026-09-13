/* Callees for the struct-passing check.  The caller is tests/abi-struct.s,
   written by hand, because compiled code calling compiled code agrees with
   itself whatever convention it uses.

   isa/abi.s: a struct is decomposed into its fields and each field is
   assigned independently, so a field of any size up to 16 bits takes a whole
   register - and the limit is four REGISTERS, not eight bytes.  */

struct two_chars { char a, b; };
struct pair { int a, b; };
struct mixed { int a; long b; };
struct fat { char *p; unsigned tag; };
struct five { char a, b, c, d, e; };

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

/* Three registers: the long takes two of them, high half first.  */
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
