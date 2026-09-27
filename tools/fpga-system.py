# =============================================================================
# fpga-system.py - the floorplan for tools/fpga-system.sv
# =============================================================================
#
#   nextpnr-ice40 --up5k --package sg48 --json top.json --pre-place tools/fpga-system.py
#
# The UP5K's four SPRAMs are two pairs at opposite bottom corners of the die.
# The processor's pair goes on the left with the processor and the glue that
# chooses between them; the frame buffers go on the right with the display.
#
# LEFT TO ITSELF THE PLACER SPLITS THEM BADLY.  It put the processor's read
# mux and byte select halfway between the pairs, or the processor itself near
# the frame buffers, and the processor's read-to-address path then crossed
# the die twice a cycle: about 11 ns of logic and 32 of wire.  Pinned, the
# whole system places at 27.82 MHz against 26.17 unpinned, medians of eight
# seeds, and the slowest seed moves from 25.37 to 27.20.  An earlier version
# of the system, unpinned, had a seed at 24.63, below the pixel clock.
#
# The regions overlap by two columns, so neither side is squeezed at the seam.
# =============================================================================

SPLIT = 13
ctx.createRectangularRegion("cpu", 0, 0, SPLIT, 31)
ctx.createRectangularRegion("vid", SPLIT - 2, 0, 25, 31)

BELS = {"ram_lo_RAM": "X0/Y0/spram_1", "ram_hi_RAM": "X0/Y0/spram_2",
        "fba_RAM": "X25/Y0/spram_3", "fbb_RAM": "X25/Y0/spram_4"}

# The processor, and the top level's cells that sit between it and its own
# two SPRAMs: the byte and bank selects, blit mode's late path, the write
# enables, and the observation shift register.
GLUE = ("u.", "lowbyte", "src", "ram_", "hi", "lo_", "lb", "late", "we", "wdata",
        "so", "irq", "rst", "dout")

for name, cell in ctx.cells:
    if name in BELS:
        cell.setAttr("BEL", BELS[name])
    elif cell.type != "ICESTORM_LC":
        continue
    elif name.startswith("vid."):
        ctx.constrainCellToRegion(name, "vid")
    elif name.startswith(GLUE):
        ctx.constrainCellToRegion(name, "cpu")
