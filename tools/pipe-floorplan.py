# =============================================================================
# pipe-floorplan.py - a floorplan for tools/pipe-top.sv, the pipelined experiment
# =============================================================================
#
#   node tools/speed.mjs --pipe --floorplan
#
# THE SPRAM, PINNED.  Left to itself the placer puts the processor's SPRAM in
# either bottom corner, seed by seed, and dispatch and decode - whose paths
# start at its data out - settle wherever it lands.  PIPE_SPRAM in the
# environment names the BEL; the default is the bottom left, X0/Y0/spram_1.
# The pairs are X0/Y0/spram_1 and _2 at the left, X25/Y0/spram_3 and _4 at the
# right.
#
# AND, IF PIPE_FP="x0,y0,x1,y1" IS GIVEN, THE ALU STAGE IN THAT RECTANGLE: its
# flops, the register file, and the logic between them, which yosys names
# after `so`, the observation register the ALU's result feeds.  MEASURED, that
# does not help - see rtl/pipe/cpu.sv's header - so it is off unless asked for.
# =============================================================================

import os

spram = os.environ.get("PIPE_SPRAM", "X0/Y0/spram_1")
fp = os.environ.get("PIPE_FP")
if fp:
    x0, y0, x1, y1 = (int(v) for v in fp.split(","))
    ctx.createRectangularRegion("alu", x0, y0, x1, y1)

ALU = ("so", "u.R", "u.e_", "u.a.")

for name, cell in ctx.cells:
    if name == "ram_RAM":
        cell.setAttr("BEL", spram)
    elif fp and cell.type == "ICESTORM_LC" and name.startswith(ALU):
        ctx.constrainCellToRegion(name, "alu")
