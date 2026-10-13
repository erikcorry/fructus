#!/bin/bash
# usage: [ST_EARLY=1] experiments/ib/mk.sh name [DEFINE ...]   (from the repo root)
# Makes build/ib/rtl-name: rtl/ with experiments/ib/cpu.sv, the defines first.
# ST_EARLY=1 also regenerates rtl-name's ucode.sv and classify.sv from a copy
# of tools/ with experiments/ib/st-early.patch applied: stores release
# dispatch a step early.
#   experiments/ib/mk.sh w3q IB_PRECL IB_1L
#   ST_EARLY=1 experiments/ib/mk.sh s1 IB_PRECL IB_1L
#   experiments/ib/mk.sh w4 'IBW_N 4'
set -e
n=$1; shift; d=build/ib/rtl-$n
rm -rf $d; mkdir -p build/ib; cp -r rtl $d
{ for x in "$@"; do echo "\`define $x"; done; cat experiments/ib/cpu.sv; } > $d/cpu.sv
if [ -n "$ST_EARLY" ]; then
    t=build/ib/tools-$n
    rm -rf $t; mkdir -p $t; cp -r tools isa $t/
    patch -s -d $t -p1 < experiments/ib/st-early.patch
    node $t/tools/gen-ucode.js > $d/ucode.sv
    node $t/tools/gen-classify.js > $d/classify.sv
fi
echo $d
