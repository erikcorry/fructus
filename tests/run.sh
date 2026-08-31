#!/bin/sh
# Regenerate the customasm ruledefs and assemble everything against them.
#
# Needs the customasm binary:  cargo install customasm
# or a release build from https://github.com/hlorenzi/customasm/releases
# Point $CUSTOMASM at it if it is not on the PATH.
set -e
cd "$(dirname "$0")/.."

CA=${CUSTOMASM:-customasm}
command -v "$CA" >/dev/null 2>&1 || { echo "customasm not found; set \$CUSTOMASM"; exit 1; }

mkdir -p build
node tools/gen-customasm.js        > build/fructus.asm
node tools/gen-customasm.js --noat > build/fructus-noat.asm

fail=0

# --- everything must assemble in r5 mode ------------------------------------
for src in snippets/*.s isa/abi.s tests/stress.s tests/longimm.s tests/data.s; do
    cat build/fructus.asm "$src" > build/_t.asm
    if "$CA" -q -o /dev/null build/_t.asm 2>build/_err; then
        printf 'ok    %s\n' "$src"
    else
        printf 'FAIL  %s\n' "$src"; sed 's/\x1b\[[0-9;]*m//g' build/_err | head -20; fail=1
    fi
done

# --- bytes -> text -> bytes, against the decoder ------------------------------
# The decoder is a second reading of the same `encoding` strings, sharing no
# code with the generator below the point where both parse the TOML.  If they
# disagree about a field, the re-assembled bytes differ.
if node tests/roundtrip.mjs snippets/*.s isa/abi.s tests/stress.s tests/longimm.s; then :; else fail=1; fi

# --- the snippets, actually executed -----------------------------------------
if node tests/sim-check.mjs; then :; else fail=1; fi

# --- snippet arithmetic, which assembling cannot check -----------------------
for t in tests/fpadd-check.mjs tests/fpsub-check.mjs; do
    if out=$(node "$t" 2>&1) && ! printf '%s' "$out" | grep -q MISMATCH; then
        printf 'ok    %s\n%s\n' "$t" "$out"
    else
        printf 'FAIL  %s\n%s\n' "$t" "$out"; fail=1
    fi
done

# --- compiler mode drops the scratch, so the cases that need it must fail ----
# Exactly three: the two where the destination is also the source, and the
# store, which has no destination to borrow.
cat build/fructus-noat.asm tests/longimm.s > build/_t.asm
n=$("$CA" -q -o /dev/null build/_t.asm 2>&1 | sed 's/\x1b\[[0-9;]*m//g' \
    | grep -c '^error: failed to resolve instruction' || true)
if [ "$n" = 3 ]; then
    printf 'ok    tests/longimm.s --noat rejects %s instructions, as expected\n' "$n"
else
    printf 'FAIL  tests/longimm.s --noat rejected %s instructions, expected 3\n' "$n"; fail=1
fi

rm -f build/_t.asm build/_err
exit $fail
