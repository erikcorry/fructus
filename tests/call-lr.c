/* Calls through a pointer that aren't tail calls.  Returns 0, or the number
   of the check that failed.  Run by tests/run.sh through tools/fcc.

   `call ra' WRITES lr BEFORE IT JUMPS, so `call lr' goes to the instruction
   after it, and the function is never called.  The target of a call can be
   in any register but lr, which the "c" constraint of the call patterns
   says.  Before it, they took "r".

   invoke2() and invoke3() are the shape that went wrong, in SOM++'s
   VMSafeBinaryPrimitive::Invoke and VMSafeTernaryPrimitive::Invoke at -Os:
   the arguments come from the frame's stack and the routine from the
   primitive, and the frame has to survive the call.  With the arguments in
   r0 to r2 and the frame in the one register the callee keeps, lr was the
   register left for the routine, and the call returned at once with an
   argument in r0 as its result.  */

typedef int (*fn2) (int, int);
typedef int (*fn3) (int, int, int);

struct prim2 { int pad[3]; fn2 routine; };
struct prim3 { int pad[3]; fn3 routine; };
struct frame { int pad[8]; int *sp; };

static int __attribute__ ((noinline)) sub2 (int a, int b) { return a - b; }
static int __attribute__ ((noinline))
sub3 (int a, int b, int c)
{
  return a - b - c;
}

int __attribute__ ((noinline))
invoke2 (struct prim2 *p, struct frame *f)
{
  int result = p->routine (f->sp[-1], f->sp[0]);
  if (result != 0)
    {
      f->sp -= 1;
      *f->sp = result;
    }
  return 0;
}

int __attribute__ ((noinline))
invoke3 (struct prim3 *p, struct frame *f)
{
  int result = p->routine (f->sp[-2], f->sp[-1], f->sp[0]);
  if (result != 0)
    {
      f->sp -= 2;
      *f->sp = result;
    }
  return 0;
}

struct prim2 p2 = { { 0, 0, 0 }, sub2 };
struct prim3 p3 = { { 0, 0, 0 }, sub3 };
int stack[4];
struct frame f;

int
main (void)
{
  stack[0] = 100;
  stack[1] = 30;
  f.sp = &stack[1];
  invoke2 (&p2, &f);
  if (f.sp != &stack[0])
    return 1;
  if (stack[0] != 70)
    return 2;

  stack[0] = 100;
  stack[1] = 30;
  stack[2] = 5;
  f.sp = &stack[2];
  invoke3 (&p3, &f);
  if (f.sp != &stack[0])
    return 3;
  if (stack[0] != 65)
    return 4;
  return 0;
}
