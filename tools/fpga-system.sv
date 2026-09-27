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
// bit 15.  fba and fbb are frame buffers A and B, used alike: the display
// shows one, and the processor may reach the other.
//
// THE MODE is the register at 0x0241.  Bit 2 says which buffer is shown - 0
// B, 1 A - and bits 1:0 what happens to the OTHER one:
//
//     0  CPU        nothing: the processor's data is its own memory
//     1  COPY       every word the display reads is written into it too; only
//                   while A is shown - with B shown this is CPU
//     2  BLIT       the processor's data above 0x8000 is it
//     3  WRITETHRU  as CPU, but every write above 0x8000 is made to it as well
//
// COPY publishes A to B: held for a frame, it leaves in B every word the
// display fetches, which is all a shown buffer is ever read for (docs/vga.md,
// "Double buffering").  So a program may keep A as its latest image, draw
// each frame's change there, and copy it to B in one frame - or use the two
// alike, bringing each up from two frames ago itself, and never copy.  COPY
// ONLY RUNS ONE WAY because the other way buys nothing - either buffer can be
// the one kept latest - and cost 45 logic cells, for a 16-bit mux in front of
// A's data and a third arm on its address.
// WRITETHRU suits text, where a screen is small: the processor keeps its own
// copy above 0x8000, reads it at full speed, and the buffer follows it.
//
// THE SHOWN BUFFER AND THE COPY CHANGE ONLY IN VERTICAL SYNC, when the display
// reads nothing, so a copy is always of whole frames, vsync to vsync, and a
// change never cuts a read in two; hold COPY for two frame times to be sure of
// one.  The rest takes effect at once.  A processor write to a buffer being
// shown or copied into is dropped, so after a change of buffer, or after
// COPY, BLIT and WRITETHRU wait for the next vertical sync.  There is no
// status register to show it yet.
//
// THE MEMORY MAP.  The processor sees its own 64 KB, always, for instruction
// fetch.  Its data accesses do too, except in BLIT mode, when the top 32 KB of
// data - loads and stores, not fetches - is the buffer not shown:
//
//     0x0000 - 0x01ff   ram_lo, kept free for a zero page (README, "Possible
//                       enhancements")
//     0x0200 - 0x02ff   the registers, written through into ram_lo as well
//     0x0300 - 0x7fff   ram_lo
//     0x8000 - 0xffff   ram_hi; in blit mode, data is the buffer not shown
//
// So everything from 0x0300 up is one linear area for a program that never
// uses blit mode.
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
// MHz in the whole system; see docs/vga.md, "The whole system on a UP5K".
//
// BLIT MODE'S LOADS COME BACK A CYCLE LATE - ld, ld8 and ldm, whose routines
// in rtl/ucode.sv say so - on the processor's `mem_late`: the
// buffer is addressed from `addr_w`, so its word is there two edges after
// the address, and a word from ram_lo is held a cycle to arrive with it.
// Which one, and which byte, are flops too.  rtl/cpu.sv's own header has why
// that byte goes to a port of its own.
//
// CHANGING MODE NEEDS NO PADDING on the processor's side: the register is
// written a cycle after the store's last byte, and a following load's first
// address, where its routine is chosen, is at least three cycles after that
// byte.
//
// THE EXCEPTION VECTORS ARE THE PROCESSOR'S IN EVERY MODE.  Each, at the top
// of memory, is a jump it fetches and executes rather than an address it
// loads, and entering an exception reads no memory at all - the registers it
// saves go to shadows.  So blit mode cannot redirect them.  The mode does
// stay set through an interrupt: a handler that touches memory above 0x8000
// saves, clears and restores it itself.  tests/blit-check.mjs takes both brk
// and the interrupt line in blit mode.
//
// THE TIMING COMES UP AS 640x480 at 60 Hz, so the display runs sensibly
// before software has written it.
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

    // The mode, decoded as it is written, so that each use is one flop.
    // `want_a`: A is to be shown.  The others are what happens to the buffer
    // not shown.
    logic want_a = 1'b0, copy = 1'b0, blit = 1'b0, wthru = 1'b0;

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
    // `to_a_w`: the processor's buffer, the one not to be shown, is A - with
    // the write, and a cycle later still for blit mode's late reads.
    logic [15:0] addr_w; logic [7:0] wdata_w; logic we_w, fb_w, to_a_w, to_a_2;
    always_ff @(posedge clk) begin
        addr_w <= addr; wdata_w <= wdata; we_w <= we;
        fb_w <= blit | wthru; to_a_w <= !want_a; to_a_2 <= to_a_w;
    end
    // [0] front porch, [1] sync, [2] back porch, [3] pixels or lines.
    logic [3:0][9:0] h_len = {10'd640, 10'd48, 10'd96, 10'd16};
    logic [3:0][9:0] v_len = {10'd480, 10'd33, 10'd2,  10'd10};
    logic [7:0] lo;                           // the low byte of a 16-bit write
    logic [9:0] pat_i; logic [5:0] attr_i;    // auto-incrementing indices
    wire rw = we_w && addr_w[15:8] == 8'h02;
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
        if (addr_w[7:0] == 8'h41) begin
            want_a <= wdata_w[2];
            {wthru, blit, copy} <= wdata_w[1:0] == 2'd1 ? {2'b00, wdata_w[2]}
                                 : wdata_w[1:0] == 2'd2 ? 3'b010
                                 : wdata_w[1:0] == 2'd3 ? 3'b100 : 3'b000;
        end
        if (addr_w[7:0] == 8'h42) pat_i  <= {wdata_w[1:0], lo};
        if (addr_w[7:0] == 8'h43) attr_i <= lo[5:0];
        if (addr_w[7:0] == 8'h44) pat_i  <= pat_i + 10'd1;
        if (addr_w[7:0] == 8'h45) attr_i <= attr_i + 6'd1;
    end
    wire pal_we  = rw && addr_w[7:5] == 3'b001; // 0x20-0x3f: palette
    wire pat_we  = rw && addr_w[7:0] == 8'h44;  // high byte; low byte from 0x40
    wire attr_we = rw && addr_w[7:0] == 8'h45;

    // --- the display and its two buffers ----------------------------------------
    // `on_a`: the display reads A.  `copy_on`: the buffer it does not read is
    // written with every word it does.  Both follow the mode only in vertical
    // sync, and the `_q` copies are them a cycle later, for the word that
    // arrives then and for the copy's write of it.
    wire vrd; wire [13:0] vaddr; wire [15:0] vdata;
    logic on_a = 1'b0, copy_on = 1'b0, on_a_q = 1'b0, copy_q = 1'b0, vrd_q = 1'b0;
    logic [13:0] vaddr_q;
    always_ff @(posedge clk) begin
        if (!vsync_n) begin on_a <= want_a; copy_on <= copy; end
        on_a_q  <= on_a;
        copy_q  <= copy_on;
        vrd_q   <= vrd;
        vaddr_q <= vaddr;
    end
    wire into_b = copy_q;                     // B takes the copy of A: COPY
                                              // is set only with A shown

    // A buffer the display neither reads nor copies into is the processor's,
    // addressed from its late address, for its writes and blit mode's reads
    // alike, so the two stay in the order the program made them.  A write to
    // either of the other two is dropped.
    wire [15:0] fba_word, fbb_word;
    wire cpu_w   = we_w && addr_w[15] && fb_w && !copy_on;
    wire cpu_w_a = cpu_w &&  to_a_w && !on_a;
    wire cpu_w_b = cpu_w && !to_a_w &&  on_a;
    wire [3:0] mask_w = addr_w[0] ? 4'b1100 : 4'b0011;
    wire copy_w_b = into_b && vrd_q;
    SB_SPRAM256KA fba (.ADDRESS(on_a ? vaddr : addr_w[14:1]), .DATAIN({wdata_w, wdata_w}),
                       .MASKWREN(cpu_w_a ? mask_w : 4'h0), .WREN(cpu_w_a),
                       .CHIPSELECT(1'b1), .CLOCK(clk), .STANDBY(1'b0),
                       .SLEEP(1'b0), .POWEROFF(1'b1), .DATAOUT(fba_word));
    SB_SPRAM256KA fbb (.ADDRESS(!on_a ? vaddr : into_b ? vaddr_q : addr_w[14:1]),
                       .DATAIN(into_b ? fba_word : {wdata_w, wdata_w}),
                       .MASKWREN(copy_w_b ? 4'hf : cpu_w_b ? mask_w : 4'h0),
                       .WREN(copy_w_b || cpu_w_b),
                       .CHIPSELECT(1'b1), .CLOCK(clk), .STANDBY(1'b0),
                       .SLEEP(1'b0), .POWEROFF(1'b1), .DATAOUT(fbb_word));
    assign vdata       = on_a_q ? fba_word : fbb_word;
    assign fb_cpu_word = to_a_2 ? fba_word : fbb_word;

    wire [9:0] line; wire vblank;
    video vid (.clk, .h_len, .v_len,
               .pal_we, .pal_addr(addr_w[4:0]), .pal_data(wdata_w),
               .spr_pat_we(pat_we), .spr_pat_addr(pat_i), .spr_pat_data({wdata_w, lo}),
               .spr_attr_we(attr_we), .spr_attr_addr(attr_i), .spr_attr_data({wdata_w, lo}),
               .mem_rd(vrd), .mem_addr(vaddr), .mem_rdata(vdata),
               .hsync_n, .vsync_n, .red, .green, .blue, .line, .vblank);
endmodule
