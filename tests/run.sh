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

# --- the spec's own invariants ----------------------------------------------
# `npm run check` and `npm test` used to be separate commands, so a spec that
# failed its own invariants could still pass the whole suite - which happened:
# an illustrative line in a comment was read as an opcode-map claim, check.js
# said so, and the suite stayed green because nothing here ran it.
#
# It runs FIRST because everything below is generated from the file it
# validates: the ruledefs, the RTL, the opcode map.  Checking the generated
# artifacts while the source is invalid tests the wrong thing.
if out=$(node tools/check.js 2>&1); then
    printf 'ok    isa/fructus.toml: %s\n' "$(printf '%s' "$out" | grep -E '^[0-9]+ forms')"
else
    printf 'FAIL  isa/fructus.toml does not satisfy its own invariants\n'
    printf '%s\n' "$out" | grep -A 20 '^FAIL'
    fail=1
fi

# --- everything must assemble in r5 mode ------------------------------------
for src in snippets/*.s libc/*.s libgcc/*.s isa/abi.s tests/stress.s tests/longimm.s tests/data.s tests/branch-cost.s tests/microtan-smoke.s; do
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
# snippets/clz.s and tests/data.s are excluded because they contain DATA: this
# test decodes linearly from byte 0 and requires the whole file to tile as
# instructions, which a lookup table cannot.  clz.s passed for a while by
# accident - every byte of its two tables happened to be a valid opcode - and
# stopped the moment a row moved and 0x08 became free.  That is the test being
# right, not the file being wrong.
if node tests/roundtrip.mjs $(ls snippets/*.s | grep -v clz) libc/*.s libgcc/*.s isa/abi.s tests/stress.s tests/longimm.s tests/branch-cost.s; then :; else fail=1; fi

# --- and binutils' disassembler against ours, operand by operand -------------
# A THIRD reading of the encoding: hand-written C over the generated tables,
# against the JavaScript that walks the TOML.  It compares the printed operands
# and not just the mnemonic and length, which is the distinction that matters -
# the earlier structure-only check passed for weeks while every eight-bit
# displacement was read from the wrong byte.  Skips itself when the toolchain
# is not built; see tools/build-binutils.sh.
if node tests/dis-check.mjs $(ls snippets/*.s | grep -v clz) libc/*.s libgcc/*.s isa/abi.s tests/stress.s tests/longimm.s tests/branch-cost.s; then :; else fail=1; fi

# --- and gas against customasm, byte for byte --------------------------------
# The two assemblers choose encodings by different mechanisms - customasm ranks
# rules by size and iterates, gas walks a shortest-first table and relaxes jmpr
# - so identical output is evidence that both readings of the spec agree.
# Files needing the assembler scratch are skipped; gas has no long-immediate
# expansion.
if node tests/gas-check.mjs $(ls snippets/*.s | grep -v clz) libc/*.s libgcc/*.s isa/abi.s tests/stress.s tests/longimm.s tests/branch-cost.s; then :; else fail=1; fi

# --- the snippets, actually executed -----------------------------------------
if node tests/sim-check.mjs; then :; else fail=1; fi

# --- libc, against a reference rather than a second copy of the algorithm ----
if node tests/libc-check.mjs; then :; else fail=1; fi

# --- nothing may need the assembler scratch ----------------------------------
# THE RULE IS: DO NOT KEEP ANYTHING IN r5 THAT HAS TO SURVIVE.  r5 is a normal
# caller-saved register and also the one the assembler borrows when an
# immediate does not fit its instruction, so an expansion anywhere between a
# write and its last read destroys the value with no diagnostic at all.
#
# Reasoning about that instruction by instruction does not scale - whether a
# given `lsr r5, lr, #14` expands depends on which forms exist for that
# mnemonic, which is not something a reader should have to know.  So the rule
# is enforced instead of remembered: the --noat ruledef omits every rule that
# borrows the scratch, and a file that assembles against it cannot contain an
# expansion, so r5 in that file is an ordinary register.
#
# isa/abi.s is the one exception and is checked separately below, because it
# demonstrates the clobber on purpose.
for src in libc/*.s snippets/*.s libgcc/*.s; do
    cat build/fructus-noat.asm "$src" > build/_t.asm
    if "$CA" -q -o /dev/null build/_t.asm 2>build/_err; then
        printf 'ok    %s needs no assembler scratch\n' "$src"
    else
        printf 'FAIL  %s needs the assembler scratch, so r5 is not safe to keep anything in\n' "$src"
        sed 's/\x1b\[[0-9;]*m//g' build/_err | head -10; fail=1
    fi
done

# --- libgcc, against plain arithmetic ----------------------------------------
if node tests/libgcc-check.mjs; then :; else fail=1; fi

# --- the Microtan board: reset, ROM window, keyboard, display ----------------
if node tests/microtan-check.mjs; then :; else fail=1; fi

# --- the RTL, against the spec's own value tables ----------------------------
# rtl/immgen.sv is generated from isa/fructus.toml, so it is regenerated here
# before it is checked: a committed copy that has drifted from the spec fails
# rather than being tested in place.  The vectors come from the TOML too, by a
# path that shares no code with the generator.
mkdir -p rtl
for f in immgen rhs unary; do
    node "tools/gen-$f.js" > "build/_$f.sv"
    if cmp -s "build/_$f.sv" "rtl/$f.sv"; then
        printf 'ok    rtl/%s.sv is up to date with isa/fructus.toml\n' "$f"
    else
        printf 'FAIL  rtl/%s.sv is stale - run `npm run rtl`\n' "$f"; fail=1
    fi
    rm -f "build/_$f.sv"
done
if node tests/rtl-check.mjs; then :; else fail=1; fi

# --- the binutils opcode table, if the submodule is checked out --------------
# opcodes/ is what gas and the disassembler SHARE, so a stale table would make
# the assembler and the ISA disagree silently.  Skipped rather than failed when
# the submodule is absent, which is the normal state for a plain clone.
if [ -d vendor/binutils-gdb/opcodes ]; then
    for f in "include/opcode/fructus.h:--header" "opcodes/fructus-opc.c:--table"; do
        path=${f%%:*}; flag=${f##*:}
        node tools/gen-opcodes.js "$flag" > build/_opc.tmp
        if cmp -s build/_opc.tmp "vendor/binutils-gdb/$path"; then
            printf 'ok    binutils %s is up to date with isa/fructus.toml\n' "$path"
        else
            printf 'FAIL  binutils %s is stale - run `npm run binutils`\n' "$path"; fail=1
        fi
        rm -f build/_opc.tmp
    done
else
    printf 'skip  vendor/binutils-gdb not checked out, opcode table not checked\n'
fi

# --- the GCC port's copies of things this repository owns --------------------
# fructus-isa.h is generated, like the opcode table: it is the list of
# constants the compiler may print, and a stale one lets the compiler emit an
# immediate gas refuses.  lib1funcs.S is a copy, because libgcc has to build
# from inside the GCC tree; the copy has to stay byte for byte the tested one.
if [ -d vendor/gcc/gcc/config/fructus ]; then
    node tools/gen-gcc.js > build/_isa.h
    if cmp -s build/_isa.h vendor/gcc/gcc/config/fructus/fructus-isa.h; then
        printf 'ok    gcc config/fructus/fructus-isa.h is up to date with isa/fructus.toml\n'
    else
        printf 'FAIL  gcc config/fructus/fructus-isa.h is stale - run `npm run gcc`\n'; fail=1
    fi
    rm -f build/_isa.h
    if cmp -s libgcc/lib1funcs.s vendor/gcc/libgcc/config/fructus/lib1funcs.S; then
        printf 'ok    gcc libgcc/config/fructus/lib1funcs.S is libgcc/lib1funcs.s\n'
    else
        printf 'FAIL  gcc libgcc/config/fructus/lib1funcs.S differs from libgcc/lib1funcs.s\n'; fail=1
    fi
else
    printf 'skip  vendor/gcc has no fructus port checked out, its copies not checked\n'
fi

# --- the compiler keeps the sliding convention ------------------------------
# Compiled code calling compiled code agrees with itself whatever the
# convention, so the torture suite cannot see a wrong one.  tests/abi-caller.s
# is written by hand: it puts sentinels in r2, r3 and r4, calls compiled
# functions of each arity, and checks exactly the registers isa/abi.s says the
# callee keeps.  Skipped when the compiler is not built; see tools/fcc.
if [ -x build/gcc/gcc/xgcc ] && [ -x build/cross-bin/fructus-elf-as ]; then
    for o in -O2 -O0; do
        if tools/fcc $o tests/abi-caller.s tests/abi-callee.c -o build/_abi 2>build/_err \
           && node tools/fcc-run.mjs build/_abi.bin; then
            printf 'ok    compiled callees keep the sliding convention at %s\n' "$o"
        else
            printf 'FAIL  compiled callees break the sliding convention at %s (check %s)\n' "$o" "$?"
            head -10 build/_err; fail=1
        fi
    done
    rm -f build/_abi build/_abi.bin

    # --- and decomposes structs into their fields ---------------------------
    # A field of any size takes a whole register, so the limit is four
    # REGISTERS rather than eight bytes - and a struct whose fields do not all
    # fit goes on the stack as a unit.  tests/abi-struct.s puts the fields
    # where isa/abi.s says and checks what comes back.
    for o in -O2 -O0; do
        if tools/fcc $o tests/abi-struct.s tests/abi-struct.c -o build/_as 2>build/_err \
           && node tools/fcc-run.mjs build/_as.bin; then
            printf 'ok    structs are passed by their fields at %s\n' "$o"
        else
            printf 'FAIL  structs are not passed by their fields at %s (check %s)\n' "$o" "$?"
            head -10 build/_err; fail=1
        fi
    done
    rm -f build/_as build/_as.bin

    # --- setjmp and longjmp, which no epilogue unwinds ----------------------
    # tests/setjmp.c sets three locals before the setjmp and checks them after
    # a longjmp from twenty frames down, so it fails if libc/setjmp.s restores
    # the wrong registers or loses sp.
    for o in -O2 -O0; do
        if tools/fcc $o tests/setjmp.c -o build/_sj 2>build/_err \
           && node tools/fcc-run.mjs build/_sj.bin; then
            printf 'ok    setjmp and longjmp at %s\n' "$o"
        else
            printf 'FAIL  setjmp and longjmp at %s (check %s)\n' "$o" "$?"
            head -10 build/_err; fail=1
        fi
    done
    rm -f build/_sj build/_sj.bin

    # --- 32-bit division, against its own identity --------------------------
    # tests/div32.c needs no reference implementation: a quotient and
    # remainder are right exactly when a == q * b + r and r < b, and the
    # multiply that checks it shares no code with the division.
    for o in -O2 -O0; do
        if tools/fcc $o tests/div32.c -o build/_d32 2>build/_err \
           && node tools/fcc-run.mjs build/_d32.bin; then
            printf 'ok    32-bit division at %s\n' "$o"
        else
            printf 'FAIL  32-bit division at %s (check %s)\n' "$o" "$?"
            head -10 build/_err; fail=1
        fi
    done
    rm -f build/_d32 build/_d32.bin

    # --- the heap, against the two things it must never do ------------------
    # crt/malloc.c is cmpctmalloc cut down to two-byte headers and 256-byte
    # pages.  tests/malloc.c needs no reference allocator: every live block is
    # filled with a byte of its own and read back, so an overlap changes a
    # neighbour, and malloc_free_bytes () is exact, so a page that goes
    # missing is a number that does not match.
    for o in -O2 -O0; do
        if tools/fcc $o tests/malloc.c -o build/_mal 2>build/_err \
           && node tools/fcc-run.mjs build/_mal.bin; then
            printf 'ok    malloc hands out no byte twice and loses none at %s\n' "$o"
        else
            printf 'FAIL  malloc at %s (check %s)\n' "$o" "$?"
            head -10 build/_err; fail=1
        fi
    done
    rm -f build/_mal build/_mal.bin
else
    printf 'skip  the compiler is not built, the sliding convention not checked\n'
fi

# --- snippet arithmetic, which assembling cannot check -----------------------
for t in tests/fpadd-check.mjs tests/fpsub-check.mjs; do
    if out=$(node "$t" 2>&1) && ! printf '%s' "$out" | grep -q MISMATCH; then
        printf 'ok    %s\n%s\n' "$t" "$out"
    else
        printf 'FAIL  %s\n%s\n' "$t" "$out"; fail=1
    fi
done

# --- isa/abi.s expands exactly once, on purpose ------------------------------
# It shows what a frame larger than 512 bytes costs, and the third line of that
# example is the expansion that clobbers r5 - which is the whole point of the
# paragraph around it.  Pinning the count keeps that one deliberate and stops a
# second, accidental one hiding behind it.
cat build/fructus-noat.asm isa/abi.s > build/_t.asm
n=$("$CA" -q -o /dev/null build/_t.asm 2>&1 | sed 's/\x1b\[[0-9;]*m//g' \
    | grep -c '^error: failed to resolve instruction' || true)
if [ "$n" = 1 ]; then
    printf 'ok    isa/abi.s needs the scratch exactly once, as documented\n'
else
    printf 'FAIL  isa/abi.s needs the scratch %s times, expected 1\n' "$n"; fail=1
fi

# --- compiler mode drops the scratch, so the cases that need it must fail ----
# Exactly four: the three where the destination is also the source, and the
# store, which has no destination to borrow.
cat build/fructus-noat.asm tests/longimm.s > build/_t.asm
n=$("$CA" -q -o /dev/null build/_t.asm 2>&1 | sed 's/\x1b\[[0-9;]*m//g' \
    | grep -c '^error: failed to resolve instruction' || true)
if [ "$n" = 4 ]; then
    printf 'ok    tests/longimm.s --noat rejects %s instructions, as expected\n' "$n"
else
    printf 'FAIL  tests/longimm.s --noat rejected %s instructions, expected 4\n' "$n"; fail=1
fi

rm -f build/_t.asm build/_err build/_immgen.sv build/_rhs.sv build/_unary.sv
exit $fail
