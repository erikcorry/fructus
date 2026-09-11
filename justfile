# Fructus: spec -> generated sources -> toolchain.
#
# isa/fructus.toml is the source of truth.  Everything under rtl/, the customasm
# ruledefs, and four files in vendor/binutils-gdb are generated from it, so the
# generate-* recipes come before the ones that build.

prefix := env('HOME') / 'fructus-tools'
target := 'fructus-elf'
build  := justfile_directory() / 'build/binutils'

# List the recipes.
default:
    @just --list --unsorted

# ------------------------------------------------------------------- system --

# Install the apt packages the toolchain and the tests need.
install-deps:
    @sudo apt-get install -y build-essential bison flex m4 texinfo \
        libgmp-dev libmpfr-dev libmpc-dev iverilog yosys nextpnr-ice40
    @echo
    @echo "bison, flex and m4 generate ld's and binutils' parsers, which are not"
    @echo "shipped pre-generated; texinfo supplies makeinfo for the manuals;"
    @echo "GMP, MPFR and MPC are what GCC does its constant arithmetic with;"
    @echo "iverilog, yosys and nextpnr-ice40 are for the rtl/ checks."
    @echo
    @echo "Not from apt: node (nvm here), and customasm (cargo install customasm)."

# ---------------------------------------------------------------- toolchain --

# Regenerate the binutils sources that come from isa/fructus.toml.
generate-tool-sources:
    @npm run --silent binutils

# Configure and build gas, objdump and readelf for fructus-elf.
build-tools: generate-tool-sources
    @sh tools/build-binutils.sh

# Install the toolchain into $HOME/fructus-tools, or prefix=... .
install-tools: build-tools
    @# gas has its own install rule, which renames as-new to {{target}}-as and
    @# also drops a copy in {{prefix}}/{{target}}/bin, where a cross gcc looks
    @# for its assembler before consulting PATH.
    @make -C {{build}}/gas install prefix={{prefix}} >/dev/null
    @# objdump and readelf are copied rather than installed: binutils/Makefile
    @# has `install: $(BUILT_SOURCES)', whose built sources are the bison and
    @# flex outputs for ar, windres and dlltool.  These two link statically
    @# against the in-tree libbfd and libopcodes, so a copy is complete.
    @mkdir -p {{prefix}}/bin
    @install -m 755 {{build}}/binutils/objdump {{prefix}}/bin/{{target}}-objdump
    @install -m 755 {{build}}/binutils/readelf {{prefix}}/bin/{{target}}-readelf
    @echo "installed into {{prefix}}/bin:"
    @ls {{prefix}}/bin
    @echo
    @echo 'export PATH={{prefix}}/bin:$PATH'

# Link sources into a flat 16K ROM image the emulator can load.
rom *sources='rom/hello.s': build-tools
    #!/usr/bin/env bash
    set -e
    mkdir -p build/rom
    objs=""
    for src in {{sources}}; do
        obj="build/rom/$(basename "$src" .s).o"
        {{build}}/gas/as-new -o "$obj" "$src"
        objs="$objs $obj"
    done
    {{build}}/ld/ld-new -T ld/fructus-rom16k.ld -o build/rom/image.elf $objs
    # 0xff is what an unprogrammed EPROM reads as, and pad-to fixes the size at
    # 16K whatever the program leaves unused.
    {{build}}/binutils/objcopy -O binary --gap-fill 0xff --pad-to 0x10000 \
        build/rom/image.elf build/fructus.rom
    text=$({{build}}/binutils/readelf -S build/rom/image.elf \
           | sed -n 's/.*\.text  *PROGBITS  *[0-9a-f]*  *[0-9a-f]*  *\([0-9a-f]*\).*/\1/p')
    lo=$(od -A n -t x1 -j 16380 -N 1 build/fructus.rom | tr -d ' ')
    hi=$(od -A n -t x1 -j 16381 -N 1 build/fructus.rom | tr -d ' ')
    echo "build/fructus.rom: 16384 bytes, $((16#$text)) in .text"
    echo "reset vector at 0xfffc: 0x$hi$lo"

# Run a ROM image on the microtan board.
run-rom rom='build/fructus.rom' *args:
    @node tools/microtan.js {{rom}} {{args}}

# Remove the toolchain build tree.  The installed copy is left alone.
clean-tools:
    rm -rf {{build}}

# Print what the built assembler makes of a source file.
disassemble file:
    @{{build}}/gas/as-new -o build/_j.o {{file}}
    @{{build}}/binutils/objdump -d build/_j.o

# ----------------------------------------------------------------- compiler --

# Regenerate the GCC port's immediate tables from isa/fructus.toml.
generate-gcc-sources:
    @npm run --silent gcc

# Configure and build the C compiler and libgcc.  Needs build-tools first.
build-gcc: generate-gcc-sources
    @sh tools/build-gcc.sh

# Compile a C file for the simulator and run it; the exit status is main's.
run-c file *flags='-O2':
    @tools/fcc {{flags}} {{file}} -o build/_c
    @node tools/fcc-run.mjs build/_c.bin --stats

# GCC's C execute torture tests on the simulator, e.g. `just torture -O2 pr'.
torture *args='-O2':
    @node tools/torture.mjs {{args}}

# ------------------------------------------------------------------ the spec --

# Check isa/fructus.toml against its own invariants.
check:
    @npm run --silent check

# Regenerate the customasm ruledefs.
generate-ruledefs:
    @npm run --silent gen

# Regenerate rtl/ from the spec.
generate-rtl:
    @npm run --silent rtl

# Everything the spec generates.
generate: generate-ruledefs generate-rtl generate-tool-sources generate-gcc-sources

# Run the whole suite.  Skips the toolchain checks if it is not built.
test:
    @sh tests/run.sh

# Run the suite against the toolchain too.
test-all: build-tools test

# The opcode map, as HTML.
map:
    @npm run --silent map
