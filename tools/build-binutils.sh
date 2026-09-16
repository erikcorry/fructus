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
# IT ALSO INSTALLS, into $FRUCTUS_TOOLS - $HOME/fructus-tools by default, which
# is the prefix tools/build-gcc.sh configures gcc with.  Nothing in the repo
# reads that copy: every build here uses build/binutils directly and the
# compiler resolves `as' out of the build tree.  It is the copy on a PATH, and
# that is exactly why it has to be refreshed - an objdump from before an ISA
# change does not fail, it disassembles today's bytes against yesterday's
# opcode map and reports something plausible and wrong.  Set FRUCTUS_TOOLS=none
# to skip it.
#
# The flags: gdb and the simulator roughly triple the build and nothing here
# needs them.  MAKEINFO=true stands in for a makeinfo that is usually absent.
# objdump, readelf and objcopy are named directly rather than building
# all-binutils, because ar, windres and dlltool want bison and flex to
# regenerate parsers that modern binutils no longer ships.
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

make -j"$(nproc)" MAKEINFO=true all-gas all-opcodes all-ld
make MAKEINFO=true configure-binutils
make -C binutils -j"$(nproc)" MAKEINFO=true objdump readelf objcopy

echo
echo "built:  build/binutils/gas/as-new"
echo "        build/binutils/ld/ld-new"
echo "        build/binutils/binutils/{objdump,readelf,objcopy}"

# --- and install, so the copy on the PATH is never a version behind ----------
# The layout mirrors what binutils' own `make install' leaves: the programs
# under their fructus-elf- names, and the target-side `as' that gcc's -B path
# names, hard linked to the one in bin.
tools=${FRUCTUS_TOOLS:-$HOME/fructus-tools}
if [ "$tools" = none ]; then
    echo
    echo "not installed: FRUCTUS_TOOLS=none"
else
    mkdir -p "$tools/bin" "$tools/fructus-elf/bin"
    cp -f "$root/build/binutils/gas/as-new"          "$tools/bin/fructus-elf-as"
    cp -f "$root/build/binutils/ld/ld-new"           "$tools/bin/fructus-elf-ld"
    cp -f "$root/build/binutils/binutils/objdump"    "$tools/bin/fructus-elf-objdump"
    cp -f "$root/build/binutils/binutils/readelf"    "$tools/bin/fructus-elf-readelf"
    cp -f "$root/build/binutils/binutils/objcopy"    "$tools/bin/fructus-elf-objcopy"
    ln -f "$tools/bin/fructus-elf-as" "$tools/fructus-elf/bin/as"
    echo
    echo "installed into $tools:"
    echo "        bin/fructus-elf-{as,ld,objdump,readelf,objcopy}"
    echo "        fructus-elf/bin/as"
fi
