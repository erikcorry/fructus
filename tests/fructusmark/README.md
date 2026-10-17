# FructusMark

One number for how fast Fructus runs real programs, so that a change to the
core, the instruction set or the compiler is judged by more than CoreMark
or one Smalltalk VM.

```sh
tests/fructusmark/run.sh        # the score, -Os -mmul: about two minutes
tests/fructusmark/run.sh -O2    # the -O2 score, of the four that fit
just fructusmark                # the same as the first
```

**The baseline is 100**: main on 2026-10-16, at the commit named in
`baseline-Os.txt` and `baseline-O2.txt`. A score is 100 times the geometric
mean of each entry's speedup over its baseline cycles, so 110 means ten per
cent faster on the mean. Every benchmark must pass its own output check,
or there is no score. The clock is taken to be 30 MHz for every build, so
the score counts cycles, and the seconds it prints are for scale. A core
that closes timing faster or slower than its predecessor is a separate
question.

## The entries

Each weighs the same in the mean.

| Entry | What | Baseline cycles, -Os -mmul | -O2 -mmul |
|-------|------|---------------------------:|----------:|
| coremark | EEMBC CoreMark 1.0, cycles per iteration | 1,069,948 | 879,272 |
| som | SOM++, the cut-down AWFY DeltaBlue and Richards: one entry, their geometric mean | 3,392,675 and 106,089,234 | doesn't fit |
| espresso | Berkeley espresso on four PLAs (tests/spec92) | 64,676,529 | doesn't fit |
| eqntott | eqntott on a priority encoder (tests/spec92) | 4,990,441 | 4,050,623 |
| compress | compress 4.0 (tests/spec92) | 26,000,953 | 24,305,446 |
| jpeg | IJG libjpeg decoding a photograph (tests/spec92) | 23,423,975 | 20,588,751 |

**CoreMark's run is reportable** by EEMBC's rules (`coremark.sh`): the
v1.01 sources byte for byte, `ITERATIONS=0` so that it calibrates itself to
ten seconds at 30 MHz whatever the build's speed (400 iterations at the
baseline), its CRCs correct, and the validation seeds' run correct too.
DeltaBlue and Richards are one entry so that one VM doesn't count twice.
The -O2 score has the four entries that fit in 64K at -O2. espresso is 59K
there, and SOM++ is 64K already at -Os.

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
tests/fructusmark/run.sh --baseline       # writes baseline-Os.txt
tests/fructusmark/run.sh -O2 --baseline   # writes baseline-O2.txt
```

Take one only when the programs themselves change. Moving the baseline
for a Fructus change would hide the change. The files record the commit
of both repositories.
