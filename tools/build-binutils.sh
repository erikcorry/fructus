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
# THE TARGET FILES ARE ON A BRANCH IN THE SUBMODULE, not patches applied here:
# vendor/binutils-gdb's `fructus' branch carries bfd/{cpu,elf32}-fructus.c,
# gas/config/tc-fructus.[ch], the generated opcodes/fructus-{opc,asm}.c and the
# mechanical target lists.  `npm run binutils' regenerates the generated half.
#
# WHY THE FLAGS.  gdb and the simulator are not built because nothing here
# needs them and they roughly triple the build.  MAKEINFO=true is because
# makeinfo is usually absent and a missing manual should not fail a toolchain
# build.  `all-binutils' is NOT used: ar, windres and dlltool want bison and
# flex to regenerate parsers that modern binutils no longer ships, and objdump
# and readelf need neither - so they are named directly.
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
