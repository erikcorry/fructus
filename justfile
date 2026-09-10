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

# Remove the toolchain build tree.  The installed copy is left alone.
clean-tools:
    rm -rf {{build}}

# Print what the built assembler makes of a source file.
disassemble file:
    @{{build}}/gas/as-new -o build/_j.o {{file}}
    @{{build}}/binutils/objdump -d build/_j.o

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
generate: generate-ruledefs generate-rtl generate-tool-sources

# Run the whole suite.  Skips the toolchain checks if it is not built.
test:
    @sh tests/run.sh

# Run the suite against the toolchain too.
test-all: build-tools test

# The opcode map, as HTML.
map:
    @npm run --silent map
