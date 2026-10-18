# =============================================================================
# fpga-system.py - the floorplan for tools/fpga-system.sv
# =============================================================================
#
#   nextpnr-ice40 --up5k --package sg48 --json top.json --pre-place tools/fpga-system.py
#
# The UP5K's four SPRAMs are two pairs at opposite bottom corners of the die.
# The processor's pair goes on the left, and the frame buffers on the right;
# the placer puts the processor and the display beside them.
#
# THERE WERE REGIONS TOO, one for the processor and its glue and one for the
# display, because left to itself the placer split them badly: the
# processor's read-to-address path crossed the die twice a cycle, and the
# system placed at 26.17 MHz against 27.82 pinned.  The processor's region
# had to widen twice as it grew, and at 4709 cells no longer placed.  What
# pulled the processor across was the system's logic decoded from the
# processor's address - its write enables and the I/O registers' read - which
# nextpnr timed through the fetch's arms of the address mux.  Decoded from
# the processor's flops instead, the regions buy nothing: with them 29.63 MHz
# (28.0 .. 30.6), with the SPRAMs alone 29.47 (28.5 .. 30.7), with nothing
# pinned 29.21 (27.7 .. 30.4), medians of sixteen.
# =============================================================================

BELS = {"ram_lo_RAM": "X0/Y0/spram_1", "ram_hi_RAM": "X0/Y0/spram_2",
        "fba_RAM": "X25/Y0/spram_3", "fbb_RAM": "X25/Y0/spram_4"}

for name, cell in ctx.cells:
    if name in BELS:
        cell.setAttr("BEL", BELS[name])
