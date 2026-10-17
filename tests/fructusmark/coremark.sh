#!/bin/bash
# =============================================================================
# coremark.sh - FructusMark's CoreMark: one reportable run
# =============================================================================
#
#   tests/fructusmark/coremark.sh [-Os|-O2] [-m...]
#
# Prints `coremark bytes cycles ok|FAIL', where cycles is cycles per
# iteration, the figure CoreMark/MHz is the inverse of.
#
# THE RUN IS ONE EEMBC WOULD ACCEPT, as tests/coremark/run.sh's are: the
# sources byte for byte v1.01 (coremark.md5), ITERATIONS=0 so that CoreMark
# calibrates itself to ten seconds at CLOCK_HZ, 30 MHz, whatever the build's
# speed, its CRCs correct, and a separate run on the validation seeds giving
# theirs.  A faster build runs more iterations, and still ten seconds.
# =============================================================================
set -e
root=$(cd "$(dirname "$0")/../.." && pwd)
src=$root/tests/coremark
out=$root/build/fructusmark/coremark
opt=-Os
mflags=
for a in "$@"; do
  case $a in
    -O*) opt=$a ;;
    *) mflags="$mflags $a" ;;
  esac
done
mkdir -p "$out"
(cd "$src" && md5sum --quiet -c coremark.md5) ||
  { echo "coremark.sh: the sources differ from CoreMark v1.01" >&2; echo "coremark 0 0 FAIL"; exit 0; }

flags="$opt$mflags"
"$root/tools/fcc" $flags -DITERATIONS=0 -DCOMPILER_FLAGS="\"$flags\"" -Wno-format \
  "$src"/core_*.c -o "$out/cm"
node "$root/tools/fcc-run.mjs" "$out/cm.bin" --max 4e9 > "$out/cm.txt"
"$root/tools/fcc" $flags -DITERATIONS=3 -DVALIDATION_RUN=1 -Wno-format \
  "$src"/core_*.c -o "$out/cm-val"
node "$root/tools/fcc-run.mjs" "$out/cm-val.bin" --max 1e9 > "$out/cm-val.txt"

# Size as tests/coremark/run.sh counts it: .text, .rodata and .data.
size=0
for hex in $("$root/build/binutils/binutils/readelf" -SW "$out/cm" | awk '
    { sub(/^ *\[ *[0-9]+\] */, "") }
    $1 == ".text" || $1 == ".rodata" || $1 == ".data" { print $5 }'); do
  size=$((size + 0x$hex))
done
ok=ok
grep -q 'Correct operation validated' "$out/cm.txt" || ok=FAIL
grep -q -e 'ERROR! [a-z]* crc' -e 'Cannot validate' "$out/cm-val.txt" && ok=FAIL
awk -v size="$size" -v ok="$ok" '
  /^Total ticks/ { t = $NF } /^Iterations  / { n = $NF }
  END { printf "coremark %d %d %s\n", size, n ? int(t / n + 0.5) : 0, ok }' "$out/cm.txt"
