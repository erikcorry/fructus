#!/bin/sh
# =============================================================================
# build-binutils.sh - build a fructus-elf assembler and disassembler
# =============================================================================
#
#   sh tools/build-binutils.sh
#
# Produces build/binutils/gas/as-new and build/binutils/binutils/{objdump,readelf}.
# tests/dis-check.mjs looks for exactly those and skips itself if they are
# absent, so the suite is green on a machine that has never run this.
#
# The target files live on the `fructus' branch of vendor/binutils-gdb, which
# carries bfd/{cpu,elf32}-fructus.c, gas/config/tc-fructus.[ch], the generated
# opcodes/fructus-{opc,asm}.c and the mechanical target lists.
# `npm run binutils' regenerates the generated half.
#
# The flags: gdb and the simulator roughly triple the build and nothing here
# needs them.  MAKEINFO=true stands in for a makeinfo that is usually absent.
# objdump and readelf are named directly rather than building all-binutils,
# because ar, windres and dlltool want bison and flex to regenerate parsers
# that modern binutils no longer ships.
# =============================================================================
set -e
cd "$(dirname "$0")/.."
root=$(pwd)

[ -f vendor/binutils-gdb/configure ] || {
    echo "vendor/binutils-gdb is not checked out: git submodule update --init"
    exit 1
}

mkdir -p build/binutils
cd build/binutils

[ -f Makefile ] || "$root/vendor/binutils-gdb/configure" \
    --target=fructus-elf \
    --disable-gdb --disable-sim --disable-gprof --disable-gprofng \
    --disable-libdecnumber --disable-readline --disable-libctf \
    --disable-nls --disable-werror --disable-gold

make -j"$(nproc)" MAKEINFO=true all-gas all-opcodes
make MAKEINFO=true configure-binutils
make -C binutils -j"$(nproc)" MAKEINFO=true objdump readelf

echo
echo "built:  build/binutils/gas/as-new"
echo "        build/binutils/binutils/objdump"
echo "        build/binutils/binutils/readelf"
