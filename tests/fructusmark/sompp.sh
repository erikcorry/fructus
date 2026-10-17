#!/bin/bash
# =============================================================================
# sompp.sh - FructusMark's DeltaBlue and Richards, on SOM++
# =============================================================================
#
#   tests/fructusmark/sompp.sh [-Os|-O2] [-m...] [deltablue|richards ...]
#
# Prints a line for each, `name bytes cycles ok|FAIL', as spec92/run.sh's.
#
# THE VM AND THE BENCHMARKS ARE FROZEN on SOMpp's fructusmark branch, so that
# a score moves with Fructus - the core, the ISA, the compiler, the C library
# - and not with SOM++'s own performance work, which goes on its master.  A
# correctness fix goes on the branch, and the baseline is taken again.  The
# branch is read from $SOMPP (~/github/SOMpp) with git archive, not from its
# working tree: what is checked out there doesn't matter.
#
# The host SOM++ compiles the class library into the image, and is built
# once for each commit of the branch.  The Fructus side is built every run,
# because the compiler or the C library may have changed.
#
# Both are SOMpp's own Fructus build, MinSizeRel, at the level given (-Os by
# default, which is MinSizeRel's own); its CMakeLists.txt builds
# Interpreter.cpp at -O2 whatever it is.  -m options are added to every
# compile and link.  The programs are the cut-down AWFY runs, one inner
# iteration, Examples-fructus/AreWeFastYet/Run*.som 1.
#
# THE SOM HEAP IS 24K, 0x6000 bytes, at every level: the branch's
# fructus-som.ld takes __heap_size.  Left to itself the heap is all the
# program leaves, so -Os and -O2 would differ in it, and a compiler change
# could add a collection.  Fixed, the collections are the program's alone,
# and the code has 5K to grow before it no longer fits above the heap.
# =============================================================================
set -e
root=$(cd "$(dirname "$0")/../.." && pwd)
sompp=${SOMPP:-$HOME/github/SOMpp}
ref=${SOMPP_REF:-fructusmark}
out=$root/build/fructusmark/sompp
mflags=
opt=-Os
heap=0x6000
while [ $# -gt 0 ]; do
  case $1 in
    -O*) opt=$1; shift ;;
    -m*) mflags="$mflags $1"; shift ;;
    *) break ;;
  esac
done
names=${*:-deltablue richards}

commit=$(git -C "$sompp" rev-parse --verify "$ref^{commit}")
src=$out/src-$commit
host=$out/host-$commit
mkdir -p "$out"
# The source and the host SOM++ are shared by every run, and -Os and -O2 may
# be run at once: the first to get the lock makes them.
(
  flock 9
  if [ ! -f "$src/.complete" ]; then
    rm -rf "$out"/src-*
    mkdir -p "$src"
    git -C "$sompp" archive "$commit" | tar -x -C "$src"
    # core-lib is a submodule, which git archive leaves empty: its own
    # commit, from the branch's tree, out of the submodule's repository.
    lib=$(git -C "$sompp" rev-parse "$commit:core-lib")
    git -C "$sompp/core-lib" archive "$lib" | tar -x -C "$src/core-lib"
    touch "$src/.complete"
  fi
  if [ ! -x "$host/SOM++" ]; then
    rm -rf "$out"/host-*
    cmake -S "$src" -B "$host" -DCMAKE_BUILD_TYPE=Release >"$out/host-cmake.log" 2>&1 ||
      { cat "$out/host-cmake.log" >&2; exit 1; }
    cmake --build "$host" -j 8 --target SOM++ >"$out/host-build.log" 2>&1 ||
      { tail -30 "$out/host-build.log" >&2; exit 1; }
  fi
) 9>"$out/.lock"

ex=$src/Examples-fructus/AreWeFastYet
awfy=$src/Examples/AreWeFastYet
cp="$ex:$ex/Richards:$awfy:$awfy/Core:$awfy/Richards:$awfy/DeltaBlue:$src/Smalltalk-fructus:$src/Smalltalk"

for name in $names; do
  case $name in
    deltablue) prog=RunDeltaBlue.som want='DeltaBlue (CUT DOWN, NOT AWFY SIZE): ok' ;;
    richards) prog=RunRichards.som want='Richards (CUT DOWN, NOT AWFY SIZE): ok' ;;
    *) echo "sompp.sh: no benchmark $name" >&2; exit 1 ;;
  esac
  b=$out/$name$opt
  rm -rf "$b"
  if ! { cmake -S "$src" -B "$b" -DCMAKE_TOOLCHAIN_FILE="$src/cmake/fructus.cmake" \
           -DCMAKE_BUILD_TYPE=MinSizeRel -DCMAKE_CXX_FLAGS_MINSIZEREL="$opt -DNDEBUG" \
           -DCMAKE_CXX_FLAGS="$mflags" \
           -DCMAKE_EXE_LINKER_FLAGS="$mflags -Wl,--defsym=__heap_size=$heap" \
           -DFRUCTUS_HOST_SOM="$host/SOM++" -DFRUCTUS_CLASSPATH="$cp" \
           -DFRUCTUS_PROGRAM="$ex/$prog 1" &&
         cmake --build "$b" -j 8 --target SOM++; } >"$b.log" 2>&1; then
    tail -20 "$b.log" >&2
    echo "$name 0 0 FAIL"
    continue
  fi
  node "$root/tools/fcc-run.mjs" "$b/SOM++.bin" --max 4e9 --stats >"$b.out" 2>"$b.stats" || true
  cycles=$(sed -n 's/.* \([0-9][0-9]*\) cycles.*/\1/p' "$b.stats")
  size=$(stat -c %s "$b/SOM++.bin")
  ok=FAIL
  grep -qxF "$want" "$b.out" && ok=ok
  echo "$name $size ${cycles:-0} $ok"
done
