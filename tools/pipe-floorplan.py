# =============================================================================
# pipe-floorplan.py - a floorplan for tools/pipe-top.sv, the pipelined experiment
# =============================================================================
#
#   node tools/speed.mjs --pipe --floorplan
#
# THE ALU STAGE IN ONE RECTANGLE.  Its flops, the register file, and the logic
# between them - which yosys names after `so`, the observation register the
# ALU's result feeds in tools/pipe-top.sv - are confined to a region, so that
# the placer cannot spread the one path that sets the clock across the die.
# The processor's SPRAM is pinned at the bottom left, and dispatch and decode
# are left free to settle between it and the region.
#
# The region is PIPE_FP="x0,y0,x1,y1" in the environment, for trying shapes
# from tools/speed.mjs without editing this file; the default is the one
# rtl/pipe/cpu.sv's header quotes.  MEASURED, it does not help - see there.
# =============================================================================

import os

x0, y0, x1, y1 = (int(v) for v in os.environ.get("PIPE_FP", "1,1,12,12").split(","))
ctx.createRectangularRegion("alu", x0, y0, x1, y1)

ALU = ("so", "u.R", "u.e_", "u.a.")

for name, cell in ctx.cells:
    if name == "ram_RAM":
        cell.setAttr("BEL", "X0/Y0/spram_1")
    elif cell.type == "ICESTORM_LC" and name.startswith(ALU):
        ctx.constrainCellToRegion(name, "alu")
