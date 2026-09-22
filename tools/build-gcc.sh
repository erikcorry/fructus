#!/bin/sh
# =============================================================================
# build-gcc.sh - build a fructus-elf C compiler and its libgcc
# =============================================================================
#
#   sh tools/build-gcc.sh
#
# Needs tools/build-binutils.sh to have run first: the compiler is configured
# against build/binutils' gas and ld, and libgcc is archived with its ar.
# Produces build/gcc/gcc/xgcc and cc1, and
# build/gcc/fructus-elf/libgcc/libgcc.a, which is what tools/fcc uses.
#
# The port lives on the `fructus' branch of vendor/gcc: gcc/config/fructus,
# gcc/common/config/fructus, libgcc/config/fructus, and a line each in
# config.sub, gcc/config.gcc and libgcc/config.host.
# config/fructus/fructus-isa.h is generated - `npm run gcc'.
#
# build/cross-bin holds the binutils under their fructus-elf- names, which is
# what the libgcc build looks for on the PATH.
#
# The host needs GMP, MPFR and MPC headers: libgmp-dev libmpfr-dev libmpc-dev.
# =============================================================================
set -e
cd "$(dirname "$0")/.."
root=$(pwd)
BU=$root/build/binutils

[ -x $BU/gas/as-new ] || { echo "build binutils first: sh tools/build-binutils.sh"; exit 1; }
[ -f vendor/gcc/gcc/config/fructus/fructus.cc ] || {
    echo "vendor/gcc has no fructus port: check out its fructus branch"; exit 1; }

# ar, ranlib and nm are not in build-binutils.sh's list; libgcc needs them.
make -C $BU MAKEINFO=true configure-binutils >/dev/null
make -C $BU/binutils -j"$(nproc)" MAKEINFO=true ar ranlib nm-new >/dev/null

mkdir -p build/cross-bin
for t in as:gas/as-new ld:ld/ld-new ar:binutils/ar ranlib:binutils/ranlib \
         nm:binutils/nm-new objdump:binutils/objdump objcopy:binutils/objcopy \
         readelf:binutils/readelf; do
    ln -sf ../binutils/${t#*:} build/cross-bin/fructus-elf-${t%%:*}
done

mkdir -p build/gcc
cd build/gcc
# C AND C++, IN THE EMBEDDED SUBSET.  --disable-hosted-libstdcxx builds the
# FREESTANDING library, which is what --without-headers allows: <type_traits>,
# <limits>, <initializer_list>, <new>, <utility> and libsupc++'s runtime, but
# no <vector> and no <string>.
#
# libsupc++ IS THE PART THAT MATTERS.  It supplies operator new and delete on
# top of malloc, and __cxa_pure_virtual, so `new' and virtual dispatch link
# without hand-written stubs.  With -fno-exceptions - which tools/fcc passes -
# its allocation failure path calls abort() instead of throwing, and crt0.s
# has an abort.
#
# STATIC CONSTRUCTORS ARE NOT RUN, DELIBERATELY.  crt/crt0.s calls main
# directly and neither linker script collects .init_array, so a global object
# with a constructor comes up zero-filled out of .bss rather than constructed.
# It fails SILENTLY, which is worth knowing before writing one.
CFG="--target=fructus-elf --prefix=$HOME/fructus-tools \
--enable-languages=c,c++ --disable-nls --disable-shared --disable-threads \
--disable-libssp --disable-libquadmath --disable-libgomp --disable-libatomic \
--disable-hosted-libstdcxx --without-headers --with-newlib --disable-multilib \
--disable-werror --with-as=$BU/gas/as-new --with-ld=$BU/ld/ld-new"

# THE GUARD COMPARES THE FLAGS AND NOT MERELY THE MAKEFILE'S EXISTENCE.  It
# used to be `[ -f Makefile ] || configure', which means that changing
# --enable-languages does NOTHING AT ALL: configure never reruns and the new
# language is silently absent from a tree that builds cleanly.  That is the
# same shape as every other staleness trap in this repository - a check that
# compares the wrong thing - and it is the one that bites hardest here,
# because the symptom is a missing compiler rather than an error.
#
# A mismatch STOPS rather than reconfiguring, because GCC wants a clean build
# directory and reconfiguring in place produces stranger failures than it
# solves.
if [ -f Makefile ] && [ "$(cat .cfgflags 2>/dev/null)" != "$CFG" ]; then
    echo "build/gcc was configured with different flags:"
    echo "  had:  $(cat .cfgflags 2>/dev/null)"
    echo "  want: $CFG"
    echo
    echo "GCC will not pick these up in place.  Run:  rm -rf build/gcc"
    exit 1
fi
[ -f Makefile ] || { "$root/vendor/gcc/configure" $CFG && printf '%s' "$CFG" > .cfgflags; }

make -j"$(nproc)" all-gcc
PATH=$root/build/cross-bin:$PATH make -j"$(nproc)" all-target-libgcc
PATH=$root/build/cross-bin:$PATH make -j"$(nproc)" all-target-libstdc++-v3

echo
echo "built:  build/gcc/gcc/xgcc, cc1, xg++, cc1plus"
echo "        build/gcc/fructus-elf/libgcc/libgcc.a"
echo "        build/gcc/fructus-elf/libstdc++-v3/libsupc++/.libs/libsupc++.a"
echo "try:    tools/fcc -O2 prog.c -o prog && node tools/fcc-run.mjs prog.bin"
