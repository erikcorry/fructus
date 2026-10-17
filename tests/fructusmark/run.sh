#!/bin/bash
# =============================================================================
# run.sh - FructusMark: one number for how fast Fructus runs real programs
# =============================================================================
#
#   tests/fructusmark/run.sh             the score: -Os -mmul, the standard
#   tests/fructusmark/run.sh -O2         the same programs at -O2
#   tests/fructusmark/run.sh --no-mul    without the multiply and reciprocal
#   tests/fructusmark/run.sh --baseline  ... and make this run the baseline
#   tests/fructusmark/run.sh -j 4        four benchmarks at once, not eight
#
# THE SCORE IS 100 FOR THE BASELINE, -Os -mmul on main (baseline.txt says
# which commit), and a geometric mean of how much faster each benchmark is than
# its baseline: 110 is ten per cent faster on the mean.  -O2 and --no-mul are
# scored against the same baseline, so -O2 is above 100 and --no-mul below.
# Every benchmark has to pass its own output check, or there is no score.
#
# THE BENCHMARKS RUN AT ONCE, -j of them, eight by default.  The score is
# cycles counted by the simulator, not time, so they can't slow each other
# down in it.  Each level and -m set builds in a directory of its own, so
# two whole runs can go at once as well.
#
# THE ENTRIES, each weighing the same:
#
#   coremark   EEMBC CoreMark 1.0, a reportable run: ten seconds at 30 MHz
#   som        SOM++, the geometric mean of the cut-down DeltaBlue and
#              Richards, so that two programs on one VM count once
#   espresso   Berkeley espresso, the SPEC92 stand-ins (tests/spec92)
#   eqntott    eqntott, ditto
#   compress   compress 4.0, ditto
#   jpeg       IJG libjpeg 6b decoding a photograph, SPEC95's ijpeg
#
# WHAT MOVES IT is Fructus: the core and its timing (tools/sim.js), the
# instruction set, the compiler, the C library.  What doesn't is the
# programs: SOM++ is built from SOMpp's fructusmark branch, not its master,
# and the rest are in this repository.  The clock is taken to be 30 MHz for
# every build, so the score is in cycles; the seconds are shown for scale.
# =============================================================================
set -e
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
opt=-Os
arch=-mmul
write=
jobs=8
while [ $# -gt 0 ]; do
  case $1 in
    -O*) opt=$1 ;;
    --no-mul) arch="" ;;
    --baseline) write=1 ;;
    -j) jobs=$2; shift ;;
    -j*) jobs=${1#-j} ;;
    *) echo "usage: tests/fructusmark/run.sh [-O2] [--no-mul] [--baseline] [-j N]" >&2; exit 2 ;;
  esac
  shift
done
base=$here/baseline.txt
out=$root/build/fructusmark
run=$out/run$opt$arch
rm -rf "$run"
mkdir -p "$run"
res=$run/results.txt

# bench NAME: its line, name bytes cycles ok|FAIL, in $run/NAME; the rest
# of what it prints in $run/NAME.log.  The spec92 table has a flags column
# of its own, and a failure's diff after FAIL, so its line is taken from the
# end once the result is cut off.
bench () {
  case $1 in
    coremark) "$here/coremark.sh" $opt $arch ;;
    deltablue|richards) "$here/sompp.sh" $opt $arch $1 ;;
    *) bash "$root/tests/spec92/run.sh" $opt $arch $1 |
         awk 'NR > 1 { ok = $NF == "ok"; sub(/ +(ok|FAIL.*)$/, "")
                       print $1, $(NF-1), $NF, ok ? "ok" : "FAIL" }' ;;
  esac > "$run/$1" 2> "$run/$1.log" || true
  grep -q "^$1 " "$run/$1" || echo "$1 0 0 FAIL" > "$run/$1"
}

# The longest first, so that -j 4 doesn't leave one running alone at the end.
for b in coremark richards espresso compress jpeg deltablue eqntott; do
  while [ "$(jobs -rp | wc -l)" -ge "$jobs" ]; do wait -n || true; done
  bench $b &
done
wait
for b in coremark deltablue richards espresso eqntott compress jpeg; do
  cat "$run/$b"
  [ -s "$run/$b.log" ] && grep -q ' FAIL$' "$run/$b" && cat "$run/$b.log" >&2
done > "$res"

if [ -n "$write" ]; then
  if grep -qv ' ok$' "$res"; then
    echo "run.sh: a benchmark failed; no baseline" >&2; cat "$res" >&2; exit 1
  fi
  { echo "# FructusMark baseline, $opt $arch: name bytes cycles"
    echo "# $(git -C "$root" log -1 --format='%h %cs') $(git -C "$root" status --porcelain --untracked-files=no | grep -q . && echo '(modified)')"
    echo "# SOMpp fructusmark $(git -C "${SOMPP:-$HOME/github/SOMpp}" rev-parse --short fructusmark 2>/dev/null)"
    awk '{ print $1, $2, $3 }' "$res"; } > "$run/baseline.txt"
  # Moved in afterwards: written in place, the file is already changed when
  # git status looks, and every baseline would say it was modified.
  mv "$run/baseline.txt" "$base"
  echo "wrote $base"
fi

# A first line that is not a result, so that an absent baseline is still a
# first file for awk: FNR == NR would otherwise take the results for it.
base_in=$run/base-in.txt
{ echo "# baseline"; [ -f "$base" ] && cat "$base"; } > "$base_in"
awk -v opt="$opt" -v arch="$arch" '
  FNR == NR { if ($1 !~ /^#/) base[$1] = $3; next }
  {
    name[++n] = $1; bytes[$1] = $2; cyc[$1] = $3; ok[$1] = $4
    if ($4 != "ok" || !base[$1]) bad = 1
  }
  END {
    printf "FructusMark %s%s, 30 MHz\n\n", opt, arch ? " " arch : ""
    printf "%-10s %7s %13s %9s %8s  %s\n", "", "Bytes", "Cycles", "Seconds", "Ratio", ""
    for (i = 1; i <= n; i++) {
      b = name[i]
      r = base[b] && cyc[b] ? base[b] / cyc[b] : 0
      printf "%-10s %7d %13d %9.3f %8.4f  %s\n", b, bytes[b], cyc[b], cyc[b] / 30e6, r, ok[b]
      ratio[b] = r
    }
    if (bad) { print "\nno score: a benchmark failed or has no baseline"; exit 1 }
    # DeltaBlue and Richards are one entry, their own geometric mean.
    logs = 0; k = 0
    for (b in ratio) {
      if (b == "deltablue" || b == "richards") continue
      logs += log(ratio[b]); k++
    }
    if ("deltablue" in ratio && "richards" in ratio) {
      logs += (log(ratio["deltablue"]) + log(ratio["richards"])) / 2
      k++
    }
    if (k == 6) {
      printf "\nFructusMark %s%s: %.1f  (%d entries)\n", opt, arch ? " " arch : "", 100 * exp(logs / k), k
    }
  }' "$base_in" "$res"
