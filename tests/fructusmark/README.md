# FructusMark

One number for how fast Fructus runs real programs, so that a change to the
core, the instruction set or the compiler is judged by more than CoreMark
or one Smalltalk VM.

```sh
tests/fructusmark/run.sh                # the score, -Os -mmul: a minute and a half
tests/fructusmark/run.sh -O2            # the same programs at -O2
tests/fructusmark/run.sh --no-mul       # on a core without mul and the reciprocal
tests/fructusmark/run.sh -O2 --no-mul   # both
just fructusmark                        # the same as the first
```

**The baseline is 100**: -Os -mmul on main, 2026-10-17, at the commit
named in `baseline.txt`. A score is 100 times the geometric mean of each
entry's speedup over its baseline cycles, so 110 means ten per cent faster
on the mean. There is one baseline. -O2 and --no-mul are scored against it
too, so they show what the level and the multiplier are worth. Every
benchmark must pass its own output check, or there is no score. The clock
is taken to be 30 MHz for every build, so the score counts cycles, and the
seconds it prints are for scale. A core that closes timing faster or
slower than its predecessor is a separate question.

**The benchmarks run at once**, eight by default (`-j 4` for four). The
score counts the simulator's cycles, not time, so they can't slow each
other down in it. Each level and -m set builds in a directory of its own,
so the four permutations can run at once too.

## The scores at the baseline

| | -mmul | without |
|-|------:|--------:|
| -Os | **100.0** | 74.9 |
| -O2 | 112.8 | 93.4 |

## The entries

Each weighs the same in the mean. Cycles at the baseline:

| Entry | What | -Os -mmul | -Os | -O2 -mmul | -O2 |
|-------|------|----------:|----:|----------:|----:|
| coremark | EEMBC CoreMark 1.0, cycles per iteration | 1,069,948 | 2,164,027 | 879,272 | 1,947,716 |
| som | SOM++'s cut-down AWFY DeltaBlue | 3,439,706 | 3,435,012 | 3,229,124 | 3,230,020 |
| | and Richards: one entry, their geometric mean | 107,386,905 | 107,235,415 | 95,440,097 | 95,387,695 |
| espresso | Berkeley espresso on five PLAs, three times (tests/spec92) | 52,631,835 | 53,702,623 | 51,145,649 | 52,367,150 |
| eqntott | eqntott on a priority encoder (tests/spec92) | 4,990,441 | 6,340,128 | 4,050,623 | 4,025,678 |
| compress | compress 4.0 (tests/spec92) | 26,000,953 | 26,035,457 | 24,305,446 | 24,307,238 |
| jpeg | IJG libjpeg decoding a photograph (tests/spec92) | 23,424,279 | 50,706,714 | 20,589,055 | 28,198,406 |

**CoreMark's run is reportable** by EEMBC's rules (`coremark.sh`): the
v1.01 sources byte for byte, `ITERATIONS=0` so that it calibrates itself to
ten seconds at 30 MHz whatever the build's speed (400 iterations at the
baseline), its CRCs correct, and the validation seeds' run correct too.
DeltaBlue and Richards are one entry so that one VM doesn't count twice.
SOM++'s heap is a fixed 24K at every level (`sompp.sh`), so -Os and -O2
collect garbage the same number of times.

The multiplier is worth most to CoreMark and jpeg: CoreMark's matrix
kernel, and jpeg's IDCT, whose 24 constant multiplies a block are calls to
`__mulhisi3` at -Os without it. At -O2 gcc writes those as shifts and adds,
which is why jpeg without -mmul is 0.46 at -Os and 0.83 at -O2. SOM++ barely
multiplies, and is a hair faster without.

## What moves the score, and what doesn't

**In scope**: the core and its timing (`tools/sim.js` and the RTL it
mirrors), new instructions, the compiler, the C library and libgcc.
Those are what FructusMark exists to measure.

**Out of scope**: the programs. The four C programs are in this repository,
frozen. SOM++ is built from SOMpp's `fructusmark` branch, not its master
(`sompp.sh`, via `git archive` of `$SOMPP`, `~/github/SOMpp` by default), so
SOM++'s own performance work, such as a hand-written interpreter, doesn't
reach the score; it is tracked on the SOMpp side. A correctness fix may go
on the branch, and then the baseline is taken again.

Each program has room to grow in its memory layout (tests/spec92/README.md,
"Room to grow"), so a compiler that writes a few per cent more code still
gets a score.

## A new baseline

```sh
tests/fructusmark/run.sh --baseline   # writes baseline.txt, -Os -mmul
```

Take one only when the programs themselves change. Moving the baseline
for a Fructus change would hide the change. The file records the commit
of both repositories.
