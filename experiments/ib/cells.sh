#!/bin/bash
# usage (from the repo root): experiments/ib/cells.sh rtldir name -> LUT4 count and packed LC for the plain core
R=$1; d=build/ib/cells-$2; rm -rf $d; mkdir -p $d
yosys -q -p "read_verilog -sv $R/cpu.sv $R/classify.sv $R/alu.sv $R/ucode.sv $R/lhs.sv $R/dest.sv $R/immgen.sv $R/cond.sv $R/compare.sv $R/recip.sv tools/fpga-top.sv; synth_ice40 -top top -json $d/top.json; tee -q -o $d/top.stat stat" >/dev/null 2>&1
nextpnr-ice40 --up5k --package sg48 --pcf-allow-unconstrained --json $d/top.json --pack-only > $d/pack.log 2>&1
echo "$2 LUT4 $(awk '$1=="SB_LUT4"{v=$2} END{print v}' $d/top.stat) LC $(grep -oE 'ICESTORM_LC: +[0-9]+' $d/pack.log | head -1 | grep -oE '[0-9]+$')"
