#!/bin/bash
# usage: experiments/ib/mk.sh name [DEFINE ...]   (from the repo root)
# Makes build/ib/rtl-name: rtl/ with experiments/ib/cpu.sv, the defines first.
#   experiments/ib/mk.sh w3q IB_PRECL IB_1L
#   experiments/ib/mk.sh w4 'IBW_N 4'
set -e
n=$1; shift; d=build/ib/rtl-$n
rm -rf $d; mkdir -p build/ib; cp -r rtl $d
{ for x in "$@"; do echo "\`define $x"; done; cat experiments/ib/cpu.sv; } > $d/cpu.sv
echo $d
