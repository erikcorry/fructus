# SPECint92 stand-ins

CoreMark and SOM++ are two programs, and a compiler or ISA change tuned
against them can be tuned *to* them. SPEC's CINT92 suite was six real
programs of its day, chosen because they behaved differently from one
another. The suite itself is not open, but its programs mostly are. This
directory has four of them, or their nearest open relatives, running on
the simulator:

```sh
tests/spec92/run.sh                 # all four, at -Os, about a minute
tests/spec92/run.sh -mmul li        # one, with the multiplier
tests/spec92/run.sh -O2 compress    # -O2 where it fits
just spec92                         # the same as the first
```

| Benchmark | SPEC92 | What runs here | Bytes | Cycles, -Os | -Os -mmul |
|-----------|--------|----------------|------:|------------:|----------:|
| espresso | 008.espresso | Berkeley espresso 2.3 on four MCNC PLAs | 52,894 | 64,840,935 | 64,198,669 |
| li | 022.li | XLISP 2.0 on N-queens, boards 1 to 7 | 42,565 | 228,031,072 | 226,531,492 |
| eqntott | 023.eqntott | eqntott 9 on a 9-line priority encoder | 14,868 | 14,613,057 | 11,374,515 |
| compress | 026.compress | compress 4.0, 12-bit codes, 4 × 12K | 17,760 | 26,035,457 | 26,000,953 |

Bytes is the image's .text, .rodata and .data, embedded inputs included.
Cycles is the simulator's total for the whole run, from reset to `halt`,
printing included, as SPEC timed the whole process. At -O2, compress takes
24,307,238 cycles in 18,378 bytes and eqntott 9,132,299 in 17,183. The other
two do not fit at -O2 (below).

They are four different kinds of load, which is the point of having them:

- **espresso**: bit-set kernels over cubes (`massive_count`, `cofactor`,
  `essen_parts`, `elim_lowering`) and malloc/free, nearly a fifth of the
  cycles between them.
- **li**: an interpreter's dispatch (`evform`, `evpushargs`, `xleval`,
  variable lookup) and a mark-sweep collector, about 35%, on a heap that is
  mostly full.
- **eqntott**: qsort and its comparators, `cmppt` and `cmppth`, over
  arrays of 16-bit `short`s, plus a 32-bit hash. Its -Os build spends a
  quarter of its cycles in `__mulhi3`, `__mulsi3` and `__umulhisi3`: scaling
  indices into arrays of 14-byte structs, which -O2 does with shifts and
  adds.
- **compress**: a hash table of 32-bit `long`s probed by 20-bit keys, and
  bit packing.

## How a run is checked

`run.sh` builds each benchmark twice from the same sources: for the host
with the system's gcc, and for Fructus with `tools/fcc`. The host's output is
the reference. A Fructus run passes when its console output matches it byte
for byte, as SPEC compares a run's output with the expected output. None
prints a time, so a run's output is the same at any speed.

**The input is out of the compiler's sight.** Every input file is turned
into a C array by `embed.mjs`, in a translation unit of its own
(`build/spec92/NAME/files.c`), and the programs reach it only through the
`mio_files` table, at run time. Nothing is built with -flto, so gcc never
sees an input while compiling the code that processes it. `--gc-sections`
works after compilation and doesn't change that.

## The machine they run on

There are no files and the C library has no input side, so
`common/spec92.h` is forced in ahead of every source (`-include`). It
renames stdio (`FILE`, `fopen`, `getc`, `fscanf`, `fprintf`, `read` on
descriptor 0...) to `common/mio.c`'s streams. A read stream runs over an
embedded file. A write stream goes to the console or to memory, or checks
each byte against a buffer. `getc` and `putc` are macros with a fast path
into the buffer, as stdio's were in 1992. mio.c has no renames of its own,
and it also gives Fructus `atof`, `index` and `rindex`. scanf is a subset:
white space, literals, `%d %ld %u %s %c`.

`common/qsort.c` is a median-of-three quicksort. crt/libc.c's qsort is an
insertion sort, which is fine for a test, but on eqntott it would measure
the libc rather than the CPU. Both builds use ours, because qsort isn't
stable, and equal keys have to come out in the same order on both or the
outputs differ. `common/include` has a `math.h` and `signal.h` for the
Fructus builds, declarations only, so a program that really calls `sqrt`
fails to link.

Each program gets its own memory layout, set by `ld/fructus-sim.ld`'s
`__stack_top` and `__heap_end`:

| | stack | heap | program from |
|-|------:|-----:|-------------:|
| espresso | 2K (648 bytes used) | 7.9K | 0x2c00 |
| li | 4K | 17K | 0x5800 |
| eqntott | 4K | 31.5K, the most malloc can have | 0x9000 |
| compress | 4K | 0.75K (its tables are .bss) | 0x1800 |

Everything is compiled with `-ffunction-sections -fdata-sections` and
linked with `--gc-sections`, as an embedded build would be. espresso and li
fit only because of it, and that is also why **espresso and li are always
-Os**: at -O2 their images are 60.7K and 51.6K, which leaves no room for
their heaps. A level given to `run.sh` applies to the other two. `-m`
options apply to all four.

## The programs

Every change to a program's own sources is under `#ifdef SPEC92`, unless
noted otherwise, so `diff` against upstream shows exactly what was done.
They are compiled as the C they were written in, `-std=gnu89`, with
warnings off. The harnesses are new C, written for this directory.

### compress: compress 4.0

`compress/compress.c` is 4.3BSD's `usr/src/ucb/compress/compress.c`,
`$Header: compress.c,v 4.0 85/07/30` (sccsid 5.9, Berkeley 5/11/86), from
[unix-history-repo](https://github.com/dspinellis/unix-history-repo),
branch BSD-4_3. It is the authors' public-domain code, and the version SPEC
took. Fenced off: `main`, `copystat`, the signal catchers, `rindex`, and
the file and signal headers. `writeerr` prints and exits.

`compress/harness.c` does what `main` does around `compress()` and
`decompress()`. It compresses the input into an 8K buffer, decompresses it
through a checker that compares each byte with the input, four times, and
prints the sizes and a CRC of the compressed data. **BITS is 12**, which is
compress's own setting for the PDP-11 and PC/XT: 5003 longs and 5003 shorts,
30K, where 16 bits would want 400K. The input, `input.txt`, is the first 12K
of compress.c itself, as distributed. SPEC's was a larger text file.

### eqntott: eqntott 9.0

From [marlls1989/eqntott](https://github.com/marlls1989/eqntott), a mirror
of code.google.com/p/eqntott: its packager's autoconf release of the 1981
Berkeley code SPEC used, (C) Regents of the University of California. It is
used here as BSD-licensed, as the packager does; see `eqntott/COPYING`. `y.tab.c` is his pre-generated
parser. Changed: the static tables, sized for 64K (`NINPUTS` 32,
`NOUTPUTS` 32, `NPTERMS` 2048: `pts[]` alone was 128K); the chunks of terms
and nodes, 64 and 128 at a time rather than 1024 (14K + 28K at once,
otherwise); `preprocess()`, which forked `/lib/cpp` and now opens the
embedded file; `putSpla`, which piped through sort(1) and is a stub;
and `version.c`'s config.h.

SPEC's input, `int_pri_3.eqn`, was never published. `eqntott/gen-pri.mjs N`
writes one of the same kind: an interrupt priority encoder with N requests
and N enables, whose "no higher request" terms expand by De Morgan into
2^(N-1-i) product terms each. The run is N = 9: 18 inputs, 5 outputs, 263
product terms. N = 10 runs out of heap. `harness.c` runs eqntott's own
`main` with `-.iolpte`.

### espresso: espresso 2.3

From [classabbyamp/espresso-logic](https://github.com/classabbyamp/espresso-logic),
a C99 port of the 1989 Berkeley Oct Tools 3.0 code, whose licence allows
derivatives that keep its notice (`espresso/COPYING`). `main.c` and `main.h`
are left out: main's option table reaches every mode espresso has, exact
minimisation and signatures included. `harness.c` does instead what main
does by default (`-Despresso`): main's defaults for the globals, getPLA's
`read_pla`, then minimise, verify against the original, print, and what
`-Dmany` does between files. Fenced off: `.phase`, `.pair` and the symbolic
variables (an input that has them is a `fatal` error, not a silent
difference), `-strong`'s `super_gasp`, every output format but the plain
PLA, the CPU clock (`ptime` is 0), and the CPU-time limit. The Fructus build
is `-DBPI=16`, espresso's own setting for a 16-bit `int`: the default packs
an index into the top half of a set's first word, which a 16-bit `int`
does not have. The host stays at 32, and the outputs agree.

SPEC's inputs, bca, cps, ti and tial, are 22K to 89K of text each. These are
rd53, misex1, sao2 and 5xp1 from espresso's own MCNC examples (`tlex/`),
in `espresso/pla/`.

### li: XLISP 2.0

David Betz's XLISP 2.0 (1988), from the Computer History Museum's
[Software Preservation Group](https://softwarepreservation.computerhistory.org/LISP/xlisp/)
archive (`xlisp-2_0.zip`, `source/xlispsrc`), with the file names in lower
case and the MS-DOS line ends and ^Z stripped. Its notice says "Permission
is granted for unrestricted non-commercial use". This is a benchmark, but
anyone redistributing the directory for anything else should know that.
SPEC92's li was an XLISP, and 2.0 is the oldest whose source is easy to
find.

`specstuff.c` replaces the MS-DOS `msstuff.c`: the terminal is the empty
stdin and the console, and there are no control keys. XLISP's own `main`
loads `queens.lsp` and then meets the end of its input. The 64K
configuration, in `xlisp.h`, `xldmem.h`, `xlftab.c` and `xlinit.c`:

- **No floating point.** `FLOTYPE` is `long`, so libgcc's soft float
  (4K) stays out, and a node is 6 bytes where `double` made it 10. The
  reader uses `atol`. SIN and the rest are left out (below).
  `xlmath.c`'s literals are written `(FLOTYPE)0` and `(FLOTYPE)1`, which is
  not under `SPEC92` but means the same thing in XLISP's own
  configurations.
- **A subset of the builtins.** Every builtin is a symbol made at start-up,
  about 45 bytes of heap each, 13K for all of them, and their code is more
  than the rest of XLISP. 131 are kept. The rest (strings and characters,
  files and streams, objects, the debugger, trace, four- and three-deep
  `c...r` but CADDR, `SUBST`, the `MAPL` family, `DELETE` and the
  `-IF` family, `FLET`/`LABELS`, `GCD`...) are `xnotimp` in the table,
  get no symbol, and their code is dropped by `--gc-sections`. The object
  system isn't initialised. The evaluator, reader, printer and collector
  are whole.
- **Smaller caches and stacks**, each a whole number of crt/malloc.c's
  256-byte pages: 212 nodes a segment, fixnums -16 to 127 and characters
  0 to 127 ready-made, an evaluation stack of 384 and an argument stack of
  512 (the 8×8 board reaches 221 and 397).
- `LOCAL` isn't `static`: these sources call LOCAL functions before
  declaring them, which modern GCC refuses to resolve to a static. One
  name, `flatsize`, then clashes, and xlpp.c's is renamed.

`queens.lsp` counts the solutions on every board from 1×1 to 7×7. About
1,120 of the heap's 1,332 nodes stay live after start-up, so the collector
runs every 60 to 250 conses: as it would have on a 64K machine. 8×8 also
runs and passes, but takes 1.13 billion cycles.

## What isn't here

- **085.gcc**, for the obvious reason.
- **072.sc**, the spreadsheet. [sc 7.16](https://github.com/n-t-roff/sc)
  is 18,500 lines to espresso's 14,000, which only fit at 53K after
  trimming. Every cell is a `double`, so soft double runs through all of
  it, it needs libm and printf's `%f`, which the C library doesn't have,
  and its screen is curses. It doesn't fit in 64K.
