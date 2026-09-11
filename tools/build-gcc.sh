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
[ -f Makefile ] || "$root/vendor/gcc/configure" \
    --target=fructus-elf --prefix="$HOME/fructus-tools" \
    --enable-languages=c --disable-nls --disable-shared --disable-threads \
    --disable-libssp --disable-libquadmath --disable-libgomp --disable-libatomic \
    --without-headers --with-newlib --disable-multilib --disable-werror \
    --with-as=$BU/gas/as-new --with-ld=$BU/ld/ld-new

make -j"$(nproc)" all-gcc
PATH=$root/build/cross-bin:$PATH make -j"$(nproc)" all-target-libgcc

echo
echo "built:  build/gcc/gcc/xgcc, cc1"
echo "        build/gcc/fructus-elf/libgcc/libgcc.a"
echo "try:    tools/fcc -O2 prog.c -o prog && node tools/fcc-run.mjs prog.bin"
