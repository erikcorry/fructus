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
for src in snippets/*.s libc/*.s libgcc/*.s isa/abi.s tests/stress.s tests/longimm.s tests/data.s tests/branch-cost.s; do
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

# --- libc/strcmp.s at every alignment, against C's definition ----------------
if node tests/string-check.mjs; then :; else fail=1; fi

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

# --- the RTL, against the spec's own value tables ----------------------------
# Every generated file under rtl/ is regenerated here before it is checked: a
# committed copy that has drifted from the spec fails rather than being tested
# in place.  The vectors come from the TOML too, by a path that shares no code
# with the generators.  rtl/cpu.sv and rtl/alu.sv are written by hand, and
# take the few facts about the instruction set they need from rtl/isa.svh.
mkdir -p rtl
for f in immgen.sv lhs.sv dest.sv cond.sv compare.sv classify.sv ucode.sv recip.sv isa.svh; do
    node "tools/gen-${f%.*}.js" > "build/_$f"
    if cmp -s "build/_$f" "rtl/$f"; then
        printf 'ok    rtl/%s is up to date with isa/fructus.toml\n' "$f"
    else
        printf 'FAIL  rtl/%s is stale - run `npm run rtl`\n' "$f"; fail=1
    fi
    rm -f "build/_$f"
done
if node tests/rtl-check.mjs; then :; else fail=1; fi
if node tests/cpu-check.mjs; then :; else fail=1; fi
if node tests/blit-check.mjs; then :; else fail=1; fi
if node tests/boot-check.mjs; then :; else fail=1; fi
# The same three with rtl/'s don't-cares filled - zeros, ones, random bits - as
# synthesis may fill them: an x that something reads after all passes as x.
if node tests/dontcare-check.mjs; then :; else fail=1; fi
if node tests/background-check.mjs; then :; else fail=1; fi
if node tests/foreground-check.mjs; then :; else fail=1; fi
if node tests/video-check.mjs; then :; else fail=1; fi
# tools/gpu.js, the simulator's display around tools/display.js; skips
# without the compiler.
if node tests/display-check.mjs; then :; else fail=1; fi

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
# Both are generated, like the opcode table.  fructus-isa.h is the list of
# constants the compiler may print, and a stale one lets the compiler emit an
# immediate gas refuses.  lib1funcs.S is libgcc/lib1funcs.s with the ELF
# paperwork the GCC tree needs added to it - a .globl and a section per
# routine, so that --gc-sections can drop what a program does not call.
if [ -d vendor/gcc/gcc/config/fructus ]; then
    node tools/gen-gcc.js > build/_isa.h
    if cmp -s build/_isa.h vendor/gcc/gcc/config/fructus/fructus-isa.h; then
        printf 'ok    gcc config/fructus/fructus-isa.h is up to date with isa/fructus.toml\n'
    else
        printf 'FAIL  gcc config/fructus/fructus-isa.h is stale - run `npm run gcc`\n'; fail=1
    fi
    rm -f build/_isa.h
    node tools/gen-lib1funcs.js > build/_lib1.S
    if cmp -s build/_lib1.S vendor/gcc/libgcc/config/fructus/lib1funcs.S; then
        printf 'ok    gcc libgcc/config/fructus/lib1funcs.S is up to date with libgcc/lib1funcs.s\n'
    else
        printf 'FAIL  gcc libgcc/config/fructus/lib1funcs.S is stale - run `npm run gcc`\n'; fail=1
    fi
    rm -f build/_lib1.S
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

    # --- -mmul, and only -mmul, uses the multiplier -------------------------
    # A part without a DSP has no mul, so the compiler must not emit one
    # unless asked; asked, the products must be right.  tests/mul.c checks
    # products of every width and divisions by constants against shift and
    # add, and each mode tests something different - mul and mulhu or mulhs
    # inline, the `_mul' helpers, reciprocals, or libgcc's shift-and-add.
    if tools/fcc -O2 -S tests/mul.c -o - 2>/dev/null | grep -q -E '^[[:space:]]mul(h[su])?[[:space:]]'; then
        printf 'FAIL  the compiler emits mul, mulhu or mulhs without -mmul\n'; fail=1
    else
        printf 'ok    no mul, mulhu or mulhs without -mmul\n'
    fi
    for o in -O2 -Os "-O2 -mmul" "-Os -mmul"; do
        if tools/fcc $o tests/mul.c -o build/_mul 2>build/_err \
           && node tools/fcc-run.mjs build/_mul.bin; then
            printf 'ok    products and constant divisions are right at %s\n' "$o"
        else
            printf 'FAIL  products or constant divisions at %s (%s wrong)\n' "$o" "$?"
            head -10 build/_err; fail=1
        fi
    done
    # Linked without -mmul, nothing of libgcc's may reach the multiplier either.
    tools/fcc -O2 tests/mul.c -o build/_mul 2>/dev/null
    if fructus-elf-objdump -d build/_mul 2>/dev/null | grep -q -E '[[:space:]]mul(h[su])?[[:space:]]'; then
        printf 'FAIL  a program built without -mmul links code that uses the multiplier\n'; fail=1
    else
        printf 'ok    nothing linked without -mmul uses the multiplier\n'
    fi
    rm -f build/_mul build/_mul.bin

    # --- the zero page --------------------------------------------------------
    # tests/zp.c puts variables in both halves with the zp attribute and
    # tests/zp.s reads them through R_FRUCTUS_ZP10 by hand.  Every -mzp-base
    # mode must agree on the answers; auto must use the base somewhere and
    # never nowhere.  Then the two things that must fail: a zp_hi that runs
    # into the I/O page is a link error, and a symbol written into an imm10
    # field without zp() is refused rather than taken as an address.
    for o in -O2 -Os -O0 '-O2 -mzp-base=always' '-O2 -mzp-base=never'; do
        if tools/fcc $o tests/zp.c tests/zp.s -o build/_zp 2>build/_err \
           && node tools/fcc-run.mjs build/_zp.bin; then
            printf 'ok    zero page variables at %s\n' "$o"
        else
            printf 'FAIL  zero page variables at %s (check %s)\n' "$o" "$?"
            head -10 build/_err; fail=1
        fi
    done
    if tools/fcc -Os -S tests/zp.c -o - 2>/dev/null | grep -q '#zp(' \
       && ! tools/fcc -Os -mzp-base=never -S tests/zp.c -o - 2>/dev/null | grep -q 'zp('; then
        printf 'ok    -mzp-base=auto reaches the zero page through the base, =never does not\n'
    else
        printf 'FAIL  -mzp-base: auto never uses the base, or never does\n'; fail=1
    fi
    printf '\t.zphi\n\t.skip 0x201\n' > build/_zpbig.s
    # --no-gc-sections: nothing refers to the blob, and it would be dropped.
    if tools/fcc tests/zp.c tests/zp.s build/_zpbig.s -Wl,--no-gc-sections -o build/_zp 2>build/_err; then
        printf 'FAIL  a zp_hi of 0x201 bytes linked\n'; fail=1
    elif grep -q 'zp_hi overflows' build/_err; then
        printf 'ok    a zp_hi that reaches the I/O page is a link error\n'
    else
        printf 'FAIL  an oversized zp_hi failed, but not as an overflow\n'; head -5 build/_err; fail=1
    fi
    printf '\tld r0, [r1, #x]\nx:\t.2byte 0\n' > build/_zpbare.s
    if build/cross-bin/fructus-elf-as -o build/_zpbare.o build/_zpbare.s 2>/dev/null; then
        printf 'FAIL  gas took a bare symbol as an imm10 displacement\n'; fail=1
    else
        printf 'ok    gas takes a symbol in imm10 only through zp()\n'
    fi
    rm -f build/_zp build/_zp.bin build/_zpbig.s build/_zpbare.s build/_zpbare.o

    # --- tagged pointers ------------------------------------------------------
    # tests/tag1.s writes `.short tag1(sym)' against tests/tag1.c's objects, in
    # an aligned table and at odd addresses in a byte stream, and loads two with
    # `mov rd, #tag1(sym)'; R_FRUCTUS_16_TAG1 must place each address plus one.
    # Then the things that must fail: a tag on an odd address is a link error,
    # on an odd constant gas's, and a tagged jump or call target is refused.
    for o in -O2 -O0; do
        if tools/fcc $o tests/tag1.c tests/tag1.s -o build/_tag 2>build/_err \
           && node tools/fcc-run.mjs build/_tag.bin; then
            printf 'ok    tagged pointers at %s\n' "$o"
        else
            printf 'FAIL  tagged pointers at %s (check %s)\n' "$o" "$?"
            head -10 build/_err; fail=1
        fi
    done
    printf '\t.section .rodata\n\t.globl table, stream\ntable:\nstream:\n\t.short tag1(o1 + 1)\n' \
        > build/_tagodd.s
    if tools/fcc tests/tag1.c build/_tagodd.s -o build/_tag 2>build/_err; then
        printf 'FAIL  a tagged pointer to an odd address linked\n'; fail=1
    elif grep -q 'tagged pointer to an odd address' build/_err; then
        printf 'ok    a tagged pointer to an odd address is a link error\n'
    else
        printf 'FAIL  a tagged pointer to an odd address failed, but not for that\n'
        head -5 build/_err; fail=1
    fi
    for bad in '.short tag1(0x1001)' 'mov r0, #tag1(0x1001)' 'jmp tag1(x)' 'call tag1(x)'; do
        printf '\t%s\nx:\tret\n' "$bad" > build/_tagodd.s
        if build/cross-bin/fructus-elf-as -o build/_tagodd.o build/_tagodd.s 2>/dev/null; then
            printf 'FAIL  gas took `%s'"'"'\n' "$bad"; fail=1
        else
            printf 'ok    gas refuses `%s'"'"'\n' "$bad"
        fi
    done
    rm -f build/_tag build/_tag.bin build/_tagodd.s build/_tagodd.o

    # --- a program moves the boundary between the heap and itself -----------
    # tests/heap-end.s defines __heap_end, which ld/fructus-sim.ld's default
    # gives way to: the program goes at 0x6000 and malloc must get exactly the
    # 75 pages below it, which tests/malloc.c checks against __heap_pages.
    if tools/fcc -O2 tests/malloc.c tests/heap-end.s -o build/_heap 2>build/_err \
       && node tools/fcc-run.mjs build/_heap.bin \
       && build/cross-bin/fructus-elf-readelf -s build/_heap | grep -q ' 00006000 .* _start$'; then
        printf 'ok    a program'"'"'s own __heap_end moves it to 0x6000, with 75 pages of heap\n'
    else
        printf 'FAIL  a program'"'"'s own __heap_end did not move it\n'; head -5 build/_err; fail=1
    fi
    rm -f build/_heap build/_heap.bin

    # --- gas pads code with nop, not brk ------------------------------------
    # gas's default fill for a .p2align in code is 0x00, which is brk, so a
    # loop that -falign-loops padded and the program fell into trapped.
    # tc-fructus.h sets NOP_OPCODE from include/opcode/fructus.h, which
    # tools/gen-opcodes.js writes from the spec's nop.  Both halves: the
    # padding bytes, and a padded program that runs.
    printf '\t.text\n\tret\n\t.p2align 2\n\tret\n' > build/_pad.s
    if build/cross-bin/fructus-elf-as build/_pad.s -o build/_pad.o 2>build/_err \
       && [ "$(build/cross-bin/fructus-elf-objdump -d build/_pad.o | grep -c 'nop$')" = 3 ] \
       && tools/fcc -O2 -mmul -falign-loops=2 tests/mul.c -o build/_al 2>>build/_err \
       && node tools/fcc-run.mjs build/_al.bin; then
        printf 'ok    gas pads code with nop, and -falign-loops code runs\n'
    else
        printf 'FAIL  gas pads code with something other than nop\n'
        head -10 build/_err; fail=1
    fi
    rm -f build/_pad.s build/_pad.o build/_al build/_al.bin

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

    # --- a tail call through a pointer keeps its target ---------------------
    # The epilogue runs between loading the target and the jump, and pops the
    # callee-saved registers, so the target has to be staged in r5 - which a
    # frame over 511 bytes must then not use to unwind itself.  tests/sibcall.c
    # has both shapes.  -Os as well, because that is where it went wrong.
    for o in -O2 -Os -O0; do
        if tools/fcc $o tests/sibcall.c -o build/_sc 2>build/_err \
           && node tools/fcc-run.mjs build/_sc.bin; then
            printf 'ok    indirect tail calls keep their target at %s\n' "$o"
        else
            printf 'FAIL  an indirect tail call loses its target at %s (check %s)\n' "$o" "$?"
            head -10 build/_err; fail=1
        fi
    done
    rm -f build/_sc build/_sc.bin

    # --- a call through a pointer is not a call through lr ------------------
    # `call ra' writes lr before it jumps, so `call lr' goes to the next
    # instruction.  tests/call-lr.c has the shape that put the target in lr,
    # at -Os, from SOM++.
    for o in -O2 -Os -O0; do
        if tools/fcc $o tests/call-lr.c -o build/_cl 2>build/_err \
           && node tools/fcc-run.mjs build/_cl.bin; then
            printf 'ok    calls through a pointer reach their target at %s\n' "$o"
        else
            printf 'FAIL  a call through a pointer misses its target at %s (check %s)\n' "$o" "$?"
            head -10 build/_err; fail=1
        fi
    done
    rm -f build/_cl build/_cl.bin

    # --- a masked shift count may lose its mask -----------------------------
    # fructus.h says SHIFT_COUNT_TRUNCATED, so GCC may drop the `& 15', `& 31'
    # or `& 63' on a count and rely on the shift reading only those bits.
    # tests/shift-trunc.c tries int, long and long long with every count up
    # to 127: the 16-bit instruction, the helpers, and at -O2 the 32-bit
    # shift GCC expands inline.
    for o in -O2 -Os -O0; do
        if tools/fcc $o tests/shift-trunc.c -o build/_st 2>build/_err \
           && node tools/fcc-run.mjs build/_st.bin; then
            printf 'ok    masked shift counts at %s\n' "$o"
        else
            printf 'FAIL  a masked shift count goes wrong at %s (check %s)\n' "$o" "$?"
            head -10 build/_err; fail=1
        fi
    done
    rm -f build/_st build/_st.bin

    # --- 32-bit division, against its own identity --------------------------
    # tests/div32.c needs no reference implementation: a quotient and
    # remainder are right exactly when a == q * b + r and r < b, and the
    # multiply that checks it shares no code with the division.  With -mmul
    # the divisions are lib1funcs.s's `_mul' routines instead of the C.
    for o in -O2 -O0 "-O2 -mmul"; do
        if tools/fcc $o tests/div32.c -o build/_d32 2>build/_err \
           && node tools/fcc-run.mjs build/_d32.bin; then
            printf 'ok    32-bit division at %s\n' "$o"
        else
            printf 'FAIL  32-bit division at %s (check %s)\n' "$o" "$?"
            head -10 build/_err; fail=1
        fi
    done
    rm -f build/_d32 build/_d32.bin

    # --- 64-bit division, the same way ---------------------------------------
    # tests/div64.c reaches each path of libgcc's hand-written __udivmoddi4,
    # and with -mmul checks __udivmoddi4_mul's with __muldi3_mul's products.
    for o in -O2 -O0 "-O2 -mmul"; do
        if tools/fcc $o tests/div64.c -o build/_d64 2>build/_err \
           && node tools/fcc-run.mjs build/_d64.bin; then
            printf 'ok    64-bit division at %s\n' "$o"
        else
            printf 'FAIL  64-bit division at %s (check %s)\n' "$o" "$?"
            head -10 build/_err; fail=1
        fi
    done
    rm -f build/_d64 build/_d64.bin

    # --- clrsb and the overflow builtins ------------------------------------
    # tests/overflow.c: clrsbhi2's branch, complement and clz on every 16-bit
    # value, and addv/subv/negv - br vs, or a comparison against a constant -
    # against the same sums done in 32 bits.
    for o in -O2 -Os -O0; do
        if tools/fcc $o tests/overflow.c -o build/_ov 2>build/_err \
           && node tools/fcc-run.mjs build/_ov.bin; then
            printf 'ok    clrsb and int overflow at %s\n' "$o"
        else
            printf 'FAIL  clrsb and int overflow at %s (check %s)\n' "$o" "$?"
            head -10 build/_err; fail=1
        fi
    done
    rm -f build/_ov build/_ov.bin

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

    # --- the I/O page: the console, and the stack guard ---------------------
    # tests/stack-guard.c prints a line and then recurses for ever, so passing
    # is the line on stdout and fcc-run's exit 124: the top guard trapped.
    for o in -O2 -O0; do
        if tools/fcc $o tests/stack-guard.c -o build/_sg 2>build/_err; then
            st=0; out=$(node tools/fcc-run.mjs build/_sg.bin 2>build/_err) || st=$?
        else
            out=; st=x
        fi
        if [ "$st" = 124 ] && [ "$out" = descending ]; then
            printf 'ok    a recursion with no bottom traps in the stack guard at %s\n' "$o"
        else
            printf 'FAIL  stack guard at %s (exit %s, printed "%s")\n' "$o" "$st" "$out"
            head -10 build/_err; fail=1
        fi
    done
    rm -f build/_sg build/_sg.bin
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

rm -f build/_t.asm build/_err
exit $fail
