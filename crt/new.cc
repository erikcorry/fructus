// ============================================================================
// crt/new.cc - operator new, operator delete, __cxa_pure_virtual
// ============================================================================
//
// THESE EXIST TO KEEP libsupc++ OUT OF THE LINK, and not because the library
// lacks them.  libsupc++.a defines every one of these already.  The trouble is
// that it was built WITH exceptions - it is a host-built library and nothing
// told it otherwise - so its operator new throws std::bad_alloc when malloc
// returns null.  The archive member that defines _Znwj therefore references
// __cxa_throw, which references _Unwind_RaiseException, which does not exist
// on this target.  Asking for `new' used to fail the link with a page of
// undefined unwinder symbols.
//
// -fno-exceptions ON THE PROGRAM CANNOT HELP.  It governs the code the
// compiler emits from THIS source, not code compiled into a library long ago.
//
// NOR CAN --gc-sections, AND THAT IS THE INSTRUCTIVE PART.  A linker extracts
// an archive member in order to resolve an UNDEFINED symbol, and that decision
// is made during symbol resolution - before garbage collection runs and
// regardless of -ffunction-sections.  By the time anything could be collected,
// eh_throw.o is already in the link and its undefined references are already
// errors.
//
// SO WE DEFINE THEM FIRST.  A symbol that is already defined is never sought
// in an archive, so new_op.o, del_op.o and pure.o are never extracted and the
// exception machinery is never reached.  This is the ordinary arrangement on a
// freestanding target; it is roughly what an ESP-IDF build ends up with.
//
// FAILURE IS abort() AND NOT A THROW, because there is nothing to throw to.
// crt/crt0.s's abort halts with 134, which is what a shell reports for
// SIGABRT, so tools/fcc-run.mjs exits 134 and a test runner can tell it from
// an ordinary non-zero return.
//
// SIZED DELETE IS NOT OPTIONAL.  C++14 onwards emits calls to
// `operator delete (void *, size_t)' wherever the size is known at the call
// site, so a program that never mentions it still references it.  Leaving it
// out would pull del_ops.o back out of the archive and undo the whole point.
//
// THE NOTHROW FORMS ARE HERE FOR THE SAME REASON.  `new (std::nothrow) T' is
// rare, but libsupc++'s version of it CATCHES the bad_alloc it would otherwise
// propagate, so that member reaches even deeper into the exception runtime
// than the throwing one.  Defining it costs four instructions and forecloses
// the problem.  std::nothrow_t is declared here rather than included from
// <new>: only the mangled name matters for resolution, and this file then
// depends on no header at all.
// ============================================================================

typedef __SIZE_TYPE__ size_t;

extern "C" void *malloc (size_t);
extern "C" void  free (void *);
extern "C" void  abort (void);

namespace std { struct nothrow_t { }; }

// --- allocation -------------------------------------------------------------
// One implementation, four spellings.  The array forms are identical to the
// scalar ones: the compiler has already folded the element count and any
// cookie into the byte count it asks for.

static void *alloc (size_t n)
{
  void *p = malloc (n ? n : 1);        // new of size 0 must return a unique
  if (!p)                              // pointer, not null
    abort ();
  return p;
}

void *operator new      (size_t n) { return alloc (n); }
void *operator new[]    (size_t n) { return alloc (n); }

void *operator new      (size_t n, const std::nothrow_t &) { return malloc (n ? n : 1); }
void *operator new[]    (size_t n, const std::nothrow_t &) { return malloc (n ? n : 1); }

// --- deallocation -----------------------------------------------------------
// free() already ignores a null pointer, which is what delete of null requires.
// The sized forms discard the size: crt/malloc.c keeps its own header, so the
// compiler's figure tells it nothing it does not already know.

void operator delete    (void *p)                  noexcept { free (p); }
void operator delete[]  (void *p)                  noexcept { free (p); }
void operator delete    (void *p, size_t)          noexcept { free (p); }
void operator delete[]  (void *p, size_t)          noexcept { free (p); }
void operator delete    (void *p, const std::nothrow_t &) noexcept { free (p); }
void operator delete[]  (void *p, const std::nothrow_t &) noexcept { free (p); }

// --- the pure virtual trap --------------------------------------------------
// The compiler puts this in the vtable slot of every pure virtual, so any
// abstract class references it whether or not the situation can arise.  It is
// reached only by calling a pure virtual during construction or destruction of
// the base, which is undefined behaviour - so stopping is the whole job.
//
// libsupc++'s version routes through std::terminate and the terminate handler,
// which is another path into the exception runtime; this one is a halt.

extern "C" void __cxa_pure_virtual (void) { abort (); }
