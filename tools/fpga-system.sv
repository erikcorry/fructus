// =============================================================================
// fpga-system.sv - the processor, its 64 KB, the display and its frame buffers
// =============================================================================
//
// NOT YET THE DESIGN'S TOP LEVEL; a measuring and testing one, like
// tools/fpga-top.sv, but with everything the part will hold.  Written by hand.
// It needs rtl/*.sv built with FRUCTUS_BLIT defined, rtl/video/*.sv, and the
// floorplan in tools/fpga-system.py; tests/blit-check.mjs simulates it.
//
// FOUR SPRAMs.  ram_lo and ram_hi are the processor's 64 KB, split on address
// bit 15.  fb0 and fb1 are the frame buffers: whichever `show` names serves the
// display, and the other - the BACK buffer - is the processor's in blit mode.
//
// THE MEMORY MAP.  The processor sees its own 64 KB, always, for instruction
// fetch.  Its data accesses do too, except in BLIT MODE, when the top 32 KB of
// data - loads and stores, not fetches - is the back buffer instead:
//
//     0x0000 - 0x7eff   ram_lo
//     0x7f00 - 0x7fff   the registers, written through into ram_lo as well
//     0x8000 - 0xffff   ram_hi; in blit mode, data is the back buffer
//
// So a program in blit mode keeps its code anywhere, and its data, its
// constants and its stack below 0x8000 - the stack because compiled code
// reaches its frame with ordinary loads and stores.  pop alone is exempt: it
// keeps its ordinary routine, and so reads the processor's own memory at any
// address, and a frame pushed above 0x8000 before blit mode was set still
// pops correctly inside it.  A push there in blit mode would not land.
//
// THE REGISTERS ARE WRITTEN THROUGH INTO ram_lo, so a register reads back as
// what was last written to it - a register block with no read path of its own,
// which is what keeps its address decode off the memory's write enable.  A
// register whose value the hardware changes, a status register, would need a
// read path; there is none yet.
//
// EVERY WRITE TO THE REGISTERS AND THE FRAME BUFFERS LANDS A CYCLE LATE, out of
// flops (`addr_w`, `wdata_w`, `we_w`), so nothing combinational joins the
// processor's address to anything but its own two SPRAMs.  That was worth 3.9
// MHz in the whole system; see spram-timing.md.
//
// BLIT MODE'S LOADS COME BACK A CYCLE LATE - ld, ld8 and ldm, whose routines
// in rtl/ucode.sv say so - on the processor's `mem_late`: the
// back buffer is addressed from `addr_w`, so its word is there two edges after
// the address, and a word from ram_lo is held a cycle to arrive with it.
// Which one, and which byte, are flops too.  rtl/cpu.sv's own header has why
// that byte goes to a port of its own.
//
// THE MODE BIT is bit 1 of 0x7f41 and `show` is bit 0.  Changing it needs no
// padding: the register is written a cycle after the store's last byte, and a
// following load's first address, where its routine is chosen, is at least
// three cycles after that byte.
// It stays set through an interrupt; a handler that touches memory above
// 0x8000 saves, clears and restores it itself.
// =============================================================================

module top (input logic clk, input logic din, input logic irq, output wire dout,
            output logic hsync_n, vsync_n, output logic [2:0] red, green, blue);

    logic rst_q, rst;
    always_ff @(posedge clk) begin rst_q <= din; rst <= rst_q; end
    logic irq_q, irq_s;
    always_ff @(posedge clk) begin irq_q <= irq; irq_s <= irq_q; end

    wire [15:0] addr; wire [7:0] wdata; wire we;
    wire [3:0] mask = addr[0] ? 4'b1100 : 4'b0011;
    wire hi = addr[15];

    logic show = 1'b0, blit = 1'b0;

    // --- the processor's own 64 KB ----------------------------------------------
    wire [15:0] lo_word, hi_word;
    SB_SPRAM256KA ram_lo (.ADDRESS(addr[14:1]), .DATAIN({wdata, wdata}),
                          .MASKWREN(we && !hi ? mask : 4'h0), .WREN(we && !hi),
                          .CHIPSELECT(1'b1), .CLOCK(clk), .STANDBY(1'b0),
                          .SLEEP(1'b0), .POWEROFF(1'b1), .DATAOUT(lo_word));
    SB_SPRAM256KA ram_hi (.ADDRESS(addr[14:1]), .DATAIN({wdata, wdata}),
                          .MASKWREN(we && hi && !blit ? mask : 4'h0), .WREN(we && hi && !blit),
                          .CHIPSELECT(1'b1), .CLOCK(clk), .STANDBY(1'b0),
                          .SLEEP(1'b0), .POWEROFF(1'b1), .DATAOUT(hi_word));

    // The byte and the SPRAM a read came from are chosen a cycle later, with
    // the data.
    logic lowbyte, src;
    always_ff @(posedge clk) begin lowbyte <= ~addr[0]; src <= hi; end
    wire [15:0] word  = src ? hi_word : lo_word;
    wire [7:0]  rdata = lowbyte ? word[7:0] : word[15:8];

    // --- blit mode's late reads ---------------------------------------------------
    wire [15:0] fb_cpu_word;
    logic hi1, hi2, lb1, lb2;
    logic [15:0] lo_hold;
    always_ff @(posedge clk) begin
        hi1 <= hi;         hi2 <= hi1;
        lb1 <= ~addr[0];   lb2 <= lb1;
        lo_hold <= lo_word;
    end
    wire [15:0] late_word = hi2 ? fb_cpu_word : lo_hold;
    wire [7:0]  late      = lb2 ? late_word[7:0] : late_word[15:8];

    wire halted, trapped; wire [15:0] result;
    cpu u (.clk(clk), .rst(rst), .mem_addr(addr), .mem_rdata(rdata),
           .mem_wdata(wdata), .mem_we(we), .blit(blit), .mem_late(late),
           .irq(irq_s), .halted(halted), .trapped(trapped), .result(result));
    logic [15:0] so;
    always_ff @(posedge clk) so <= rst ? result : {so[14:0], 1'b0};
    assign dout = so[15] ^ halted ^ trapped;

    // --- the registers, a cycle after the processor's write ----------------------
    logic [15:0] addr_w; logic [7:0] wdata_w; logic we_w, blit_w;
    always_ff @(posedge clk) begin
        addr_w <= addr; wdata_w <= wdata; we_w <= we; blit_w <= blit;
    end
    logic [3:0][9:0] h_len, v_len;
    logic [7:0] lo;                           // the low byte of a 16-bit write
    logic [9:0] pat_i; logic [5:0] attr_i;    // auto-incrementing indices
    wire rw = we_w && addr_w[15:8] == 8'h7f;
    // 0x00-0x0f: timing, a byte at a time - a block per length, since iverilog
    // refuses a variable index into a packed array on the left.
    for (genvar i = 0; i < 4; i++) begin : g_len
        wire sel = rw && addr_w[7:4] == 4'h0 && addr_w[2:1] == 2'(i);
        always @(posedge clk) if (sel) begin
            if (!addr_w[3]) begin if (addr_w[0]) h_len[i][9:8] <= wdata_w[1:0]; else h_len[i][7:0] <= wdata_w; end
            else            begin if (addr_w[0]) v_len[i][9:8] <= wdata_w[1:0]; else v_len[i][7:0] <= wdata_w; end
        end
    end
    always_ff @(posedge clk) if (rw) begin
        if (addr_w[7:0] == 8'h40) lo <= wdata_w;
        if (addr_w[7:0] == 8'h41) {blit, show} <= wdata_w[1:0];
        if (addr_w[7:0] == 8'h42) pat_i  <= {wdata_w[1:0], lo};
        if (addr_w[7:0] == 8'h43) attr_i <= lo[5:0];
        if (addr_w[7:0] == 8'h44) pat_i  <= pat_i + 10'd1;
        if (addr_w[7:0] == 8'h45) attr_i <= attr_i + 6'd1;
    end
    wire pal_we  = rw && addr_w[7:5] == 3'b001; // 0x20-0x3f: palette
    wire pat_we  = rw && addr_w[7:0] == 8'h44;  // high byte; low byte from 0x40
    wire attr_we = rw && addr_w[7:0] == 8'h45;

    // --- the display and its two buffers ----------------------------------------
    // The back buffer is addressed from the processor's late address every
    // cycle, for its writes and blit mode's reads alike, so the two stay in
    // the order the program made them.
    wire vrd; wire [13:0] vaddr; wire [15:0] vdata;
    wire [15:0] fb0_word, fb1_word;
    wire cpu_w = we_w && addr_w[15] && blit_w;
    wire [3:0] mask_w = addr_w[0] ? 4'b1100 : 4'b0011;
    SB_SPRAM256KA fb0 (.ADDRESS(show ? addr_w[14:1] : vaddr), .DATAIN({wdata_w, wdata_w}),
                       .MASKWREN(show && cpu_w ? mask_w : 4'h0), .WREN(show && cpu_w),
                       .CHIPSELECT(1'b1), .CLOCK(clk), .STANDBY(1'b0),
                       .SLEEP(1'b0), .POWEROFF(1'b1), .DATAOUT(fb0_word));
    SB_SPRAM256KA fb1 (.ADDRESS(show ? vaddr : addr_w[14:1]), .DATAIN({wdata_w, wdata_w}),
                       .MASKWREN(!show && cpu_w ? mask_w : 4'h0), .WREN(!show && cpu_w),
                       .CHIPSELECT(1'b1), .CLOCK(clk), .STANDBY(1'b0),
                       .SLEEP(1'b0), .POWEROFF(1'b1), .DATAOUT(fb1_word));
    logic show_q;
    always_ff @(posedge clk) show_q <= show;
    assign vdata       = show_q ? fb1_word : fb0_word;
    assign fb_cpu_word = show_q ? fb0_word : fb1_word;

    wire [9:0] line; wire vblank;
    video vid (.clk, .h_len, .v_len,
               .pal_we, .pal_addr(addr_w[4:0]), .pal_data(wdata_w),
               .spr_pat_we(pat_we), .spr_pat_addr(pat_i), .spr_pat_data({wdata_w, lo}),
               .spr_attr_we(attr_we), .spr_attr_addr(attr_i), .spr_attr_data({wdata_w, lo}),
               .mem_rd(vrd), .mem_addr(vaddr), .mem_rdata(vdata),
               .hsync_n, .vsync_n, .red, .green, .blue, .line, .vblank);
endmodule
