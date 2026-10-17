#!/bin/bash
# =============================================================================
# run.sh - FructusMark: one number for how fast Fructus runs real programs
# =============================================================================
#
#   tests/fructusmark/run.sh             the score, -Os -mmul
#   tests/fructusmark/run.sh -O2         the score with -O2 -mmul
#   tests/fructusmark/run.sh --baseline  ... and make this run the baseline
#
# THE SCORE IS 100 FOR THE BASELINE, main on 2026-10-16 (baseline-Os.txt says
# which commit), and a geometric mean of how much faster each benchmark is than
# its baseline: 110 is ten per cent faster on the mean.  Every benchmark has to
# pass its own output check, or there is no score.
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
for a in "$@"; do
  case $a in
    -O*) opt=$a ;;
    --no-mul) arch="" ;;
    --baseline) write=1 ;;
    *) echo "usage: tests/fructusmark/run.sh [-O2] [--no-mul] [--baseline]" >&2; exit 2 ;;
  esac
done
base=$here/baseline.txt
out=$root/build/fructusmark
mkdir -p "$out"
res=$out/results.txt

# Each line: name bytes cycles ok|FAIL.  The spec92 table has a flags column
# of its own, so its lines are taken from the end.
{
  "$here/coremark.sh" -O${opt#-O} $arch
  "$here/sompp.sh" $opt $arch
  names="espresso eqntott compress jpeg"
  bash "$root/tests/spec92/run.sh" $opt $arch $names |
    awk 'NR > 1 { print $1, $(NF-2), $(NF-1), $NF }'
} > "$res"

if [ -n "$write" ]; then
  if grep -qv ' ok$' "$res"; then
    echo "run.sh: a benchmark failed; no baseline" >&2; cat "$res" >&2; exit 1
  fi
  { echo "# FructusMark baseline, $opt $arch: name bytes cycles"
    echo "# $(git -C "$root" log -1 --format='%h %cs') $(git -C "$root" status --porcelain --untracked-files=no | grep -q . && echo '(modified)')"
    echo "# SOMpp fructusmark $(git -C "${SOMPP:-$HOME/github/SOMpp}" rev-parse --short fructusmark 2>/dev/null)"
    awk '{ print $1, $2, $3 }' "$res"; } > "$base"
  echo "wrote $base"
fi

# A first line that is not a result, so that an absent baseline is still a
# first file for awk: FNR == NR would otherwise take the results for it.
base_in=$out/base-in.txt
{ echo "# baseline"; [ -f "$base" ] && cat "$base"; } > "$base_in"
awk -v opt="$opt" -v arch="$arch" '
  FNR == NR { if ($1 !~ /^#/) base[$1] = $3; next }
  {
    name[++n] = $1; bytes[$1] = $2; cyc[$1] = $3; ok[$1] = $4
    if ($4 != "ok" || !base[$1]) bad = 1
  }
  END {
    printf "FructusMark %s %s, 30 MHz\n\n", opt, arch
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
      printf "\nFructusMark %s: %.1f  (%d entries)\n", opt, 100 * exp(logs / k), k
    }
  }' "$base_in" "$res"
