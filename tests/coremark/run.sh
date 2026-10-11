#!/bin/sh
# =============================================================================
# run.sh - CoreMark on the simulator
# =============================================================================
#
#   tests/coremark/run.sh [-v] [iterations]
#
# Builds CoreMark at -Os and -O2, each with and without -mmul, runs each on
# tools/fcc-run.mjs and prints its size, cycles per iteration, CoreMark/MHz
# and CoreMark at 30 MHz.  -v prints each run's EEMBC report as well.  The
# cycles are the I/O page's counter, which tests/cpu-check.mjs holds to
# rtl/cpu.sv's, so the figure is the hardware's, not an estimate.
#
# THE CLOCK IS 30 MHz, CLOCK_HZ in core_portme.h: the processor's on the
# iCE40 without the VGA frame buffers.  With them it runs at the 25.175 MHz
# pixel clock, 16% fewer CoreMarks.
#
# THE ITERATIONS ARE EEMBC'S CALIBRATION by default, which runs for ten
# seconds at CLOCK_HZ - what EEMBC asks of a reportable run - and so takes a
# minute or two of simulation for each build.  A count given here is used
# instead; a short one makes the same figure to two or three places, and
# EEMBC's report then fails it for the time alone.
#
# WHAT MAKES A RESULT REPORTABLE, by EEMBC's run rules in README.md: the
# sources other than core_portme.* unmodified, which coremark.md5 checks as
# upstream's `make check' does; the performance run validated, ten seconds
# and its CRCs, or the row is marked FAIL; and the validation seeds,
# 0x3415,0x3415,0x66, giving their known CRCs too, which a short run of each
# build checks - its time does not count - and marks BADVAL if they do not.
#
# Size is the image's .text, .rodata and .data: the whole program, printf and
# the libgcc helpers included, as NEO430's "executable size" is.
#
# The sources are EEMBC's CoreMark v1.01, commit e053570 of
# github.com/eembc/coremark, byte for byte; coremark.md5 is that version's,
# from 9b9264a, before upstream's 2020 reformatting changed every file's sum.
# core_portme.[ch] are ours.
# =============================================================================
set -e
root=$(cd "$(dirname "$0")/../.." && pwd)
verbose=
[ "$1" = -v ] && { verbose=1; shift; }
iter=${1:-0}
out=$root/build/coremark
mkdir -p "$out"
src=$root/tests/coremark
(cd "$src" && md5sum --quiet -c coremark.md5) ||
  { echo "run.sh: the sources differ from CoreMark v1.01; not reportable" >&2; exit 1; }

printf '%-22s %6s %12s %13s %9s\n' Configuration Bytes Cycles/iter CoreMark/MHz CoreMark
for opt in -Os -O2; do
  for mul in -mno-mul -mmul; do
    name=cm$opt$mul
    "$root/tools/fcc" $opt $mul -DITERATIONS="$iter" \
      -DCOMPILER_FLAGS="\"$opt $mul\"" -Wno-format \
      "$src"/core_*.c -o "$out/$name"
    node "$root/tools/fcc-run.mjs" "$out/$name.bin" --max 2e9 > "$out/$name.txt"
    [ -n "$verbose" ] && cat "$out/$name.txt"
    size=0
    for hex in $("$root/build/binutils/binutils/readelf" -SW "$out/$name" | awk '
        { sub(/^ *\[ *[0-9]+\] */, "") }
        $1 == ".text" || $1 == ".rodata" || $1 == ".data" { print $5 }'); do
      size=$((size + 0x$hex))
    done
    ok=FAIL
    grep -q 'Correct operation validated' "$out/$name.txt" && ok=
    "$root/tools/fcc" $opt $mul -DITERATIONS=3 -DVALIDATION_RUN=1 -Wno-format \
      "$src"/core_*.c -o "$out/$name-val"
    node "$root/tools/fcc-run.mjs" "$out/$name-val.bin" --max 1e9 > "$out/$name-val.txt"
    grep -q -e 'ERROR! [a-z]* crc' -e 'Cannot validate' "$out/$name-val.txt" &&
      ok="$ok BADVAL"
    awk -v cfg="fructus $opt $mul" -v size="$size" -v ok="$ok" '
      /^Total ticks/ { t = $NF } /^Iterations  / { n = $NF }
      END { printf "%-22s %6d %12d %13.3f %9.2f %s\n", cfg, size, t / n,
                   n * 1e6 / t, n * 30e6 / t, ok }' "$out/$name.txt"
  done
done
