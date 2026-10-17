#!/bin/bash
# =============================================================================
# run.sh - the SPECint92 stand-ins on the simulator
# =============================================================================
#
#   tests/spec92/run.sh [-v] [-O2|-Os|...] [-mmul|-m...] [benchmark ...]
#
# Builds each benchmark twice from the same sources: for the host with the
# system's gcc, which makes the reference output, and for Fructus with
# tools/fcc.  Runs the Fructus image on tools/fcc-run.mjs and passes it when
# its console output is the host's byte for byte, as SPEC's harness compares
# each run's output with the reference.  Prints the image's bytes and the
# run's cycles.  -v shows the output; the optimisation level is -Os unless
# one is given, and -m options, such as -mmul for the multiplier, go to every
# Fructus compile.  With no names it runs them all.
#
# THE SOURCES are the programs SPEC took, or their nearest open relatives;
# README.md says which, where from, and what was changed.  Each is compiled
# as the C it was written in, -std=gnu89, and with common/spec92.h forced in
# ahead of it, which gives it files over memory.  The harnesses and mio.c are
# ours, and modern C.
#
# THE DEFAULT LEVEL IS -Os, FructusMark's standard one.  Every benchmark also
# fits at -O2, with and without -mmul.
#
# THE CYCLES are the simulator's total from --stats: the whole run, start-up
# and printing included, as SPEC timed the whole process.
# =============================================================================
set -e
root=$(cd "$(dirname "$0")/../.." && pwd)
here=$root/tests/spec92
out=$root/build/spec92
verbose=
opt=-Os
mflags=
while [ $# -gt 0 ]; do
  case $1 in
    -v) verbose=1; shift ;;
    -O*) opt=$1; shift ;;
    -m*) mflags="$mflags $1"; shift ;;
    *) break ;;
  esac
done
all="espresso eqntott compress jpeg"
names=${*:-$all}

# Every function and object in a section of its own, and --gc-sections at the
# link, as an embedded build would: the linker keeps what the program reaches,
# which is how espresso fits at all, and keeps mio.c's scanf out of compress.
SECT="-ffunction-sections -fdata-sections"
OLD="-std=gnu89 -w -DSPEC92 -I$here/common -include $here/common/spec92.h"
NEW="-std=gnu11 -Wall -DSPEC92 -I$here/common -include $here/common/spec92.h"
# mio.c and the embedded files are the C library's side of spec92.h, and
# include it themselves without its renames.  Forced in, it would rename
# mio.c's own putchar to mio_putc - which calls putchar.
LIB="-std=gnu11 -Wall -DSPEC92 -I$here/common"

# Each benchmark sets: src (its own sources, old C), harness (ours, new C),
# files (name=path pairs for embed.mjs), flags (for both builds), oflags (for
# src alone), fflags (for src, Fructus alone), ldflags
# (Fructus only: where the program starts, and so how much heap is left).
config () {
  src= harness= files= flags= oflags= fflags= ldflags=
  case $1 in
    compress)
      src="$here/compress/compress.c"
      harness="$here/compress/harness.c"
      files="compress.c=$here/compress/input.txt"
      flags="-DBITS=12"
      ldflags="-Wl,--defsym=__heap_end=0x1600" ;;
    eqntott)
      src=$(ls "$here"/eqntott/*.c | grep -v harness.c)
      harness="$here/eqntott/harness.c"
      mkdir -p "$d"
      node "$here/eqntott/gen-pri.mjs" "${PRI:-8}" > "$d/pri.eqn"
      files="pri.eqn=$d/pri.eqn"
      oflags="-Dmain=eqntott_main"
      ldflags="-Wl,--defsym=__heap_end=0x7800" ;;
    espresso)
      src=$(ls "$here"/espresso/*.c | grep -v harness.c)
      harness="$here/espresso/harness.c"
      files=
      for f in "$here"/espresso/pla/*.pla; do files="$files $(basename "$f")=$f"; done
      fflags="-DBPI=16"	# espresso's own setting for a 16-bit int
      ldflags="-Wl,--defsym=__stack_top=${ESP_STACK_TOP:-0x0900} -Wl,--defsym=__heap_end=${ESP_HEAP_END:-0x2000}" ;;
    jpeg)
      src=$(ls "$here"/jpeg/*.c | grep -v harness.c)
      harness="$here/jpeg/harness.c"
      files="image.jpg=$here/jpeg/image.jpg"
      flags="-I$here/jpeg"
      ldflags="-Wl,--defsym=__stack_top=${JPEG_STACK_TOP:-0x0d00} -Wl,--defsym=__heap_end=${JPEG_HEAP_END:-0x6600}" ;;
    *) echo "run.sh: no benchmark $1" >&2; exit 1 ;;
  esac
}

# compile CC FLAGS DIR SOURCES...: objects into DIR, their names on stdout.
compile () {
  local cc=$1 cf=$2 dir=$3; shift 3
  local s o
  for s in "$@"; do
    o=$dir/$(basename "${s%.c}").o
    $cc $cf -c "$s" -o "$o" >&2 || { echo "run.sh: $s does not compile" >&2; exit 1; }
    echo "$o"
  done
}

printf '%-10s %-10s %6s %12s  %s\n' Benchmark Flags Bytes Cycles Result
for b in $names; do
  # A directory for each build, so that every level and -m set can run at once.
  m=${mflags// /}
  d=$out/$b$opt$m
  config "$b"
  mkdir -p "$d/host" "$d/fructus"
  node "$here/embed.mjs" "$d/files.c" $files

  # mio.c and qsort.c go in an archive, so a program links what it uses.
  hobj=$(compile gcc "-O2 $SECT $OLD $flags $oflags" "$d/host" $src
         compile gcc "-O2 $SECT $NEW $flags" "$d/host" $harness
         compile gcc "-O2 $SECT $LIB $flags" "$d/host" "$d/files.c")
  [ -n "$hobj" ] || exit 1
  hlib=$(compile gcc "-O2 $SECT $LIB $flags" "$d/host" "$here/common/mio.c" "$here/common/qsort.c")
  rm -f "$d/host/libspec92.a"; ar rcs "$d/host/libspec92.a" $hlib
  gcc $hobj "$d/host/libspec92.a" -Wl,--gc-sections -o "$d/host/prog" -lm
  "$d/host/prog" > "$d/expected" || true

  fobj=$(compile "$root/tools/fcc" "$opt $mflags $SECT $OLD -I$here/common/include $flags $oflags $fflags" "$d/fructus" $src
         compile "$root/tools/fcc" "$opt $mflags $SECT $NEW -I$here/common/include $flags $fflags" "$d/fructus" $harness
         compile "$root/tools/fcc" "$opt $mflags $SECT $LIB $flags" "$d/fructus" "$d/files.c")
  [ -n "$fobj" ] || exit 1
  flib=$(compile "$root/tools/fcc" "$opt $mflags $SECT $LIB $flags" "$d/fructus" "$here/common/mio.c" "$here/common/qsort.c")
  rm -f "$d/fructus/libspec92.a"; "$root/build/binutils/binutils/ar" rcs "$d/fructus/libspec92.a" $flib
  "$root/tools/fcc" $fobj "$d/fructus/libspec92.a" -Wl,--gc-sections $ldflags -o "$d/prog"
  node "$root/tools/fcc-run.mjs" "$d/prog.bin" --max 4e9 --stats \
    > "$d/output" 2> "$d/stats" || true

  # --stats goes to stderr; the console is all that is compared.
  [ -n "$verbose" ] && cat "$d/output"
  size=0
  for hex in $("$root/build/binutils/binutils/readelf" -SW "$d/prog" | awk '
      { sub(/^ *\[ *[0-9]+\] */, "") }
      $1 == ".text" || $1 == ".rodata" || $1 == ".data" { print $5 }'); do
    size=$((size + 0x$hex))
  done
  cycles=$(sed -n 's/.* \([0-9][0-9]*\) cycles.*/\1/p' "$d/stats")
  if cmp -s "$d/expected" "$d/output"; then ok=ok; else ok="FAIL (diff $d/expected $d/output)"; fi
  printf '%-10s %-10s %6d %12s  %s\n' "$b" "$opt$mflags" "$size" "${cycles:-?}" "$ok"
done
