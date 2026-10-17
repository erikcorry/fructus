# SPEC stand-ins

Four programs from SPEC's integer suites, or their nearest open relatives,
running on the simulator. Each is checked against the host's output. Three
are from CINT92 and one from CINT95. They are four of FructusMark's six
entries (`tests/fructusmark`), and they run on their own too:

```sh
tests/spec92/run.sh                 # all four, at -Os
tests/spec92/run.sh -mmul jpeg      # one, with the multiplier
tests/spec92/run.sh -O2 compress    # -O2, for the three that fit
just spec92                         # the same as the first
```

| Benchmark | SPEC | What runs here | Bytes | -Os -mmul | -O2 -mmul |
|-----------|------|----------------|------:|----------:|----------:|
| espresso | 008.espresso | Berkeley espresso 2.3 on four MCNC PLAs | 50,125 | 64,676,529 | doesn't fit |
| eqntott | 023.eqntott | eqntott 9.0 on an 8-line priority encoder | 14,605 | 4,990,441 | 4,050,623 |
| compress | 026.compress | compress 4.0, 12-bit codes, 4 × 12K | 17,726 | 26,000,953 | 24,305,446 |
| jpeg | 132.ijpeg | IJG libjpeg 6b decoding a 78×91 photograph, 5 times | 33,737 | 23,423,975 | 20,588,751 |

Bytes is the image's .text, .rodata and .data at -Os -mmul, embedded inputs
included. Cycles is the simulator's total for the whole run, from reset to
`halt`, printing included, as SPEC timed the whole process.

They are four different kinds of work:

- **espresso**: bit-set kernels over cubes (`massive_count`, `cofactor`,
  `essen_parts`, `elim_lowering`), and malloc/free, nearly a fifth of the
  cycles between them.
- **eqntott**: qsort and its comparators, `cmppt` and `cmppth`, over arrays
  of 16-bit `short`s, plus a 32-bit hash. Without -mmul a fifth of its -Os
  cycles are `__mulhi3` and `__umulhisi3`, scaling indices into arrays of
  14-byte structs, which -O2 does with shifts and adds.
- **compress**: a hash table of 32-bit `long`s probed by 20-bit keys, and
  bit packing.
- **jpeg**: the integer IDCT (a quarter of the cycles), YCbCr to RGB,
  Huffman decoding and upsampling: multiplies, shifts and table lookups.

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
renames stdio (`FILE`, `fopen`, `getc`, `fread`, `fscanf`, `fprintf`, `read`
on descriptor 0...) to `common/mio.c`'s streams. A read stream runs over an
embedded file. A write stream goes to the console or to memory, or checks
each byte against a buffer. `getc` and `putc` are macros with a fast path
into the buffer, as stdio's were in 1992. scanf is a subset: white space,
literals, `%d %ld %u %s %c`. mio.c has no renames of its own, and it also
gives Fructus BSD's `index` and `rindex`.

`common/qsort.c` is a median-of-three quicksort. crt/libc.c's qsort is an
insertion sort, which is fine for a test, but on eqntott it would measure
the libc rather than the CPU. Both builds use ours, because qsort isn't
stable, and equal keys have to come out in the same order on both or the
outputs differ. `common/include` has a `math.h` and `signal.h` for the
Fructus builds, declarations only, so a program that really calls `sqrt`
fails to link.

Everything is compiled with `-ffunction-sections -fdata-sections` and
linked with `--gc-sections`, as an embedded build would be.

### Room to grow

Each program has its own memory layout, set by `ld/fructus-sim.ld`'s
`__stack_top` and `__heap_end`. **Each has room on both sides**, so a
compiler whose code is a few per cent bigger, or a C library whose heap is
a little hungrier, doesn't stop it linking or running. The heap a program
needs is set by its data, which a compiler change can't alter; its code
size can change with any commit. So the room leans towards code:

| | stack | heap | needs at least | program from | code room |
|-|------:|-----:|---------------:|-------------:|----------:|
| espresso | 1K (648 bytes used) | 8.75K | 7.75K | 0x2c00 | 3.0K |
| eqntott | 4K (878 used) | 24.75K | 16.75K | 0x7800 | 12.9K |
| compress | 4K (118 used) | none: its tables are .bss | | 0x1600 | 3.8K |
| jpeg | 2K (1,240 used) | 22.25K | 21.75K | 0x6600 | 5.5K; at -O2 2.8K, 0.9K without -mmul |

Code room is how far the program could grow before it no longer fits
above its `__heap_end`, measured at -Os -mmul. The heap minimums come from
sweeping `__heap_end` a page at a time. **Espresso is always -Os**: at -O2
it is 59K, which leaves too little of the 64K for its heap and stack. A
level given to `run.sh` applies to the other three, and `-m` options apply
to all four.

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
used here as BSD-licensed, as the packager does; see `eqntott/COPYING`.
`y.tab.c` is his pre-generated parser. Changed: the static tables, sized
for 64K (`NINPUTS` 32, `NOUTPUTS` 32, `NPTERMS` 2048: `pts[]` alone was
128K); the chunks of terms and nodes, 64 and 128 at a time rather than 1024
(14K + 28K at once, otherwise); `preprocess()`, which forked `/lib/cpp` and
now opens the embedded file; `putSpla`, which piped through sort(1) and is a
stub; and `version.c`'s config.h.

SPEC's input, `int_pri_3.eqn`, was never published. `eqntott/gen-pri.mjs N`
writes one of the same kind: an interrupt priority encoder with N requests
and N enables, whose "no higher request" terms expand by De Morgan into
2^(N-1-i) product terms each. The run is N = 8: 16 inputs, 4 outputs, 134
product terms. N = 9 also runs, but needs every page malloc can have, so
it has no room at all. `harness.c` runs eqntott's own `main` with
`-.iolpte`.

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
PLA, the CPU clock (`ptime` is 0), and the CPU-time limit.

Two changes for a 16-bit machine:

- The Fructus build is `-DBPI=16`, espresso's own setting for a 16-bit
  `int`. The default packs an index into the top half of a set's first word,
  which a 16-bit `int` doesn't have. The host stays at 32, and the outputs
  agree.
- `mincov.c`'s two heuristics, the column weights `select_column` maximises
  and a sparsity it only reports, are `float` rather than `double`, on both
  builds. libgcc's soft float is half the size of its soft double. That's
  1.6K of the 64K, and the outputs still agree.

SPEC's inputs, bca, cps, ti and tial, are 22K to 89K of text each. These are
rd53, misex1, sao2 and 5xp1 from espresso's own MCNC examples (`tlex/`),
in `espresso/pla/`. 5xp1 and sao2 are most of the work, and the heap.

### jpeg: IJG libjpeg 6b

This software is based in part on the work of the Independent JPEG Group:
release 6b of 27-Mar-1998, from [ijg.org](https://www.ijg.org/files/),
copyright (C) 1991-1998 Thomas G. Lane. Its README, which carries the
licence, is in `jpeg/README`, unaltered. It is the decompression half, which
is what SPEC95's ijpeg spent most of its time in. The files below were
changed, as IJG's licence asks to be said:

- `jconfig.h` is new, written for this directory from `jconfig.doc`. It sets
  `SHORTxLCONST_32`, which IJG's `jdct.h` gives for 16-bit compilers ("known
  to work with Microsoft C 6.0"): the IDCT's multiplies become a 16-bit
  value times a constant, a 16×16→32 multiply. It also sets `NO_GETENV`,
  and, for Fructus alone, `MAX_ALLOC_CHUNK`. The host computes the same
  products.
- `jmorecfg.h`, under SPEC92: baseline sequential JPEG through the accurate
  integer IDCT, libjpeg's default, and none of the options a program would
  have to ask for: no fast or floating-point IDCT, no scaled output, no
  progressive or multi-scan files, no block smoothing, no merged upsampling
  and no colour quantisation. The seven files those leave empty
  (`jidctfst.c`, `jidctflt.c`, `jidctred.c`, `jdphuff.c`, `jdmerge.c`,
  `jquant1.c` and `jquant2.c`) are left out, as are the compressor's files
  and cjpeg and djpeg.
- `jmemmgr.c`, under SPEC92: the first and later pools are 200/1000 and
  0/500 bytes rather than 1600/16000 and 0/5000, which IJG's comment invites
  tuning. A 16K first pool left the large buffers no room.
- `jdatasrc.c`, under SPEC92: a 512-byte input buffer, not 4K.

`harness.c` decodes `image.jpg` five times with libjpeg's defaults and keeps
a Fletcher checksum of every row it gets back. A bit-at-a-time CRC took a
third of the run, which would have measured the harness. The dimensions and
the checksum are printed at the end.

`image.jpg` is [Fruit Platter- Seasonal Fruits](https://commons.wikimedia.org/wiki/File:Fruit_Platter-_Seasonal_Fruits.jpg)
by روتانا (Rotana), 2 September 2024,
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Changed: decoded
at 1/2 scale by IJG's djpeg, reduced by averaging 6×6 blocks to 78×91, and
re-encoded by IJG's cjpeg at quality 75, which also drops the original's
EXIF data. `jpeg/image.txt` says the same beside the file.

## What isn't here

- **085.gcc**, for the obvious reason.
- **072.sc**, the spreadsheet. [sc 7.16](https://github.com/n-t-roff/sc)
  is 18,500 lines to espresso's 14,000, which only fits at -Os after
  trimming. Every cell is a `double`, so soft double runs through all of
  it, it needs libm and printf's `%f`, which the C library doesn't have,
  and its screen is curses. It doesn't fit in 64K.
- **022.li**, XLISP. It ran, as XLISP 2.0, but only with 2 bytes of the 64K
  to spare and no node segment to spare, so that a page less heap failed
  and a few bytes more code didn't link. As a bytecode-less Lisp
  interpreter with a collector, it also measured much of what SOM++ does.
  And XLISP 2.0's licence is "unrestricted non-commercial use". It was
  dropped; it is in this directory's history at 412be5c.
