# FPGA toolchain

Everything needed to synthesise, simulate and program an iCE40 — all open
source, all in Debian, no vendor account and no licence.

## Install

```sh
sudo apt-get install -y yosys nextpnr-ice40 fpga-icestorm iverilog verilator gtkwave
```

That is the whole thing. Known good on Debian 13 (trixie), x86-64:

| package | version | what it does |
|---|---|---|
| `yosys` | 0.52 | synthesis: Verilog → gates |
| `nextpnr-ice40` | 0.7 | place and route, timing analysis |
| `fpga-icestorm` | 2025-02 | `icepack` (bitstream), `icetime`, `iceprog` (flash it) |
| `iverilog` | 12.0 | event simulation — plain Verilog testbenches |
| `verilator` | 5.032 | fast simulation, and a strict linter |
| `gtkwave` | 3.3.121 | waveform viewer |

Add `nextpnr-ecp5` if a bigger part is ever wanted; same flow, different
`--device` flag.

## What is *not* packaged

**SymbiYosys (`sby`)**, the formal verification driver — a Python program that
drives yosys and an SMT solver. `z3` and `yices2` are packaged, so only `sby`
itself has to come from upstream. Either clone
`github.com/YosysHQ/sby` and `make install`, or take the whole
[oss-cad-suite](https://github.com/YosysHQ/oss-cad-suite-build) bundle, which
carries current builds of everything above plus `sby`, `ghdl` and every
`nextpnr` family in one tarball. The bundle is a couple of gigabytes and needs
no root; the apt packages are lighter and `apt upgrade` keeps them current.

## Check it works

```sh
yosys -V && nextpnr-ice40 --version && iverilog -V | head -1 && verilator --version
```

And end to end, from a module to a real bitstream:

```sh
yosys -q -p 'read_verilog -sv rtl/*.sv; synth_ice40 -top top -json build/top.json'
nextpnr-ice40 --up5k --package sg48 --json build/top.json --asc build/top.asc --pcf rtl/top.pcf
icepack build/top.asc build/top.bin
```

`nextpnr` prints device utilisation and a maximum clock frequency, which is
the number to watch as the CPU grows.

## Two things that catch you out

**A module is not a chip.** Synthesising a component with all its ports
exposed asks for one package pin per port, and `nextpnr` refuses:

```
ERROR: Unable to find a placement location for cell 'd_in[7]$sb_io'
```

The SG48 package has far fewer pins than a register file has signals. For an
area estimate either read the cell count out of `yosys` directly, or wrap the
module in a `top` with only real pins. `--pcf-allow-unconstrained` lets
`nextpnr` place a design with no pin constraints file, which is what you want
for measuring and not for programming.

**iCE40 has no LUT RAM.** Xilinx parts let a LUT become a small memory, and
register files are often built that way. iCE40 cannot, and its block RAM reads
a cycle late — so an 8 x 16 register file with asynchronous reads is
flip-flops and multiplexers, and nothing else will do. Measured: 128 `SB_DFFE`
and 200 `SB_LUT4`, 340 logic cells, 6% of a UP5K, 99 MHz.

## The parts

The iCE40 UP5K (`--up5k --package sg48`) has 5280 LUT4s, 30 EBRs of 4 Kbit
each — initialised from the bitstream — and 4 SPRAMs of 256 Kbit each,
organised 16K x 16 and *not* initialised. Two SPRAMs ganged are exactly 64 KB,
which is the whole Fructus address space with `addr[0]` selecting the byte.
