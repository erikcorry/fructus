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
// THE MODE is the register at 0x0480.  Bit 2 says which buffer is shown - 0
// B, 1 A - and bits 1:0 what happens to the OTHER one:
//
//     0  CPU        nothing: the processor's data is its own memory
//     1  COPY       every word the display reads is written into it too; only
//                   while A is shown - with B shown this is CPU
//     2  BLIT       the processor's data above 0x8000 is it
//     3  WRITETHRU  as CPU, but every write above 0x8000 is made to it instead
//
// COPY publishes A to B: held for a frame, it leaves in B every word the
// display fetches, which is all a shown buffer is ever read for (docs/vga.md,
// "Double buffering").  So a program may keep A as its latest image, draw
// each frame's change there, and copy it to B in one frame - or use the two
// alike, bringing each up from two frames ago itself, and never copy.  COPY
// ONLY RUNS ONE WAY because the other way buys nothing - either buffer can be
// the one kept latest - and cost 45 logic cells, for a 16-bit mux in front of
// A's data and a third arm on its address.
// WRITETHRU suits drawing that never reads back: the processor's loads above
// 0x8000 - its code, its constants - are its own, at full speed, and its
// stores there go to the buffer alone, so ram_hi above 0x8000 is read-only.
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
// data - loads and stores, not fetches - is the buffer not shown, and in
// WRITETHRU, when the stores are:
//
//     0x0000 - 0x03ff   ram_lo, the zero page: [rb, #imm10] with rb = 0x200
//                       reaches all of it (isa/fructus.toml, [[reloc]])
//     0x0400 - 0x04ff   the I/O page, isa/fructus.toml's [cpu.io]: the GPU's
//                       registers at 0x0480 - 0x04ef, docs/vga.md "Registers",
//                       written through into ram_lo as well.  The shadows'
//                       words at 0x0410 are the processor's own, and ram_lo
//                       beneath them; the guards are ram_lo, which the
//                       processor traps on touching
//     0x0500 - 0x7fff   ram_lo
//     0x8000 - 0xffff   ram_hi; in blit mode, data is the buffer not shown,
//                       and in writethru, stores are
//
// So everything from 0x0500 up is one linear area for a program that never
// uses blit mode.
//
// So a program in blit mode keeps its code anywhere, and its data, its
// constants and its stack below 0x8000 - the stack because compiled code
// reaches its frame with ordinary loads and stores.  pop keeps its ordinary
// routine, and so would read the processor's own memory at any address,
// while a push's stores above 0x8000 would go to the buffer - so a push or
// pop that reaches 0x8000 or above in blit mode stops the processor with
// `trapped`, before it moves a byte, as an unimplemented opcode does.
//
// THE REGISTERS ARE WRITTEN THROUGH INTO ram_lo, so a register reads back as
// what was last written to it from the memory itself, which is what keeps its
// address decode off the memory's write enable.  Only the four words the
// hardware changes have a read path: the status register and the arrays'
// three addresses.  They are chosen from the processor's address into a flop
// a cycle later, beside the memory's word, as `src' chooses between the two
// SPRAMs, and reach the processor on `mem_data', the port only its loads
// read, so that the choice is not in front of decode - and on blit mode's
// late port, through `lo_hold'.  An
// array's data register reads as the word last written to it, and moves
// nothing: the block RAMs' read ports are the display's.
//
// EVERY WRITE TO THE REGISTERS AND THE FRAME BUFFERS LANDS A CYCLE LATE, out of
// flops (`addr_w`, `wword_w`, `we_w`), so nothing combinational joins the
// processor's address to anything but its own two SPRAMs.  That was worth 3.9
// MHz in the whole system; see docs/vga.md, "The whole system on a UP5K".
//
// BLIT MODE'S LOADS COME BACK A CYCLE LATE - ld, ld8 and ldm, whose routines
// in rtl/ucode.sv say so - on the processor's `mem_late`: the
// buffer is addressed from `addr_w`, so its word is there two edges after
// the address, and a word from ram_lo is held a cycle to arrive with it.
// Which one is a flop too; the processor picks the byte itself.  rtl/cpu.sv's
// own header has why the word goes to a port of its own.
//
// CHANGING MODE NEEDS NO PADDING on the processor's side: the register is
// written a cycle after the store's last byte, and a following load's decode
// cycle, where its routine is chosen, is at least three cycles after that
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
//
// WITH FRUCTUS_UART, A SERIAL LINE: rtl/uart.sv, on ports uart_rx and
// uart_tx, its words at 0x0420 - 0x0429 in the processor's half of the I/O
// page, [cpu.io] in isa/fructus.toml.  Written and read like the GPU's
// registers; without the define, this file's netlist is what it was.
// =============================================================================

module top #(parameter bit BOOT = 1)    // 0: memory is preloaded, as the tests do
           (input logic clk, input logic din, input logic irq, output wire dout,
            output logic hsync_n, vsync_n, output logic [2:0] red, green, blue,
            output wire flash_sck, flash_cs_n, flash_mosi, input logic flash_miso
`ifdef FRUCTUS_UART
            , input logic uart_rx, output logic uart_tx
`endif
           );

    // THE PROCESSOR'S MEMORY IS FILLED FROM THE FLASH AT POWER-UP, and again
    // whenever din is held: rtl/spiboot.sv.  While `boot` is set the
    // processor's stores - its boot loop, rtl/cpu.sv - write the flash's byte
    // and not their own, and the register block and the frame buffers take no
    // write, so an image's bytes in the I/O page set no mode.
    logic rst_q = 1'b0, start = 1'b0, rst, boot;
    always_ff @(posedge clk) begin rst_q <= din; start <= rst_q; end
    wire [7:0] boot_byte; wire spi_on;
    if (BOOT) begin : g_boot
        spiboot sb (.clk, .start, .rst, .boot, .on(spi_on), .mosi(flash_mosi),
                    .miso(flash_miso), .byte_q(boot_byte));
    end else begin : g_noboot
        always_ff @(posedge clk) rst <= start;
        assign boot = 1'b0, spi_on = 1'b0, boot_byte = 8'h00, flash_mosi = 1'b0;
    end
    // The flash's clock, high in the low half of each cycle the read is on.
    SB_IO #(.PIN_TYPE(6'b0100_01)) sck_pad (.PACKAGE_PIN(flash_sck), .OUTPUT_CLK(clk),
                                             .D_OUT_0(1'b0), .D_OUT_1(spi_on));
    assign flash_cs_n = ~spi_on;
    logic irq_q, irq_s;
`ifndef FRUCTUS_UART
    always_ff @(posedge clk) begin irq_q <= irq; irq_s <= irq_q; end
`else
    // The UART's request joins the pin's in the second flop, so that the
    // processor's dispatch still sees a flop and nothing in front of it: as a
    // LUT after the flop, ie and rx_full were most seeds' critical path.
    wire uart_irq;                       // a byte received, if enabled: rtl/uart.sv
    always_ff @(posedge clk) begin irq_q <= irq; irq_s <= irq_q | uart_irq; end
`endif

    wire [15:0] addr; wire [15:0] wdata; wire [1:0] lanes;
    wire we = |lanes;
    wire [3:0] mask = {lanes[1], lanes[1], lanes[0], lanes[0]};
    wire hi = addr[15];

    // The mode, decoded as it is written, so that each use is one flop.
    // `want_a`: A is to be shown.  The others are what happens to the buffer
    // not shown.  `fb_st`: stores above 0x8000 go to it, and not to ram_hi -
    // BLIT and WRITETHRU, one flop so that ram_hi's write enable is one LUT.
    logic want_a = 1'b0, copy = 1'b0, blit = 1'b0, fb_st = 1'b0;

    // --- the processor's own 64 KB ----------------------------------------------
    wire [15:0] lo_word, hi_word;
    wire [15:0] mdata = boot ? {boot_byte, boot_byte} : wdata;
    SB_SPRAM256KA ram_lo (.ADDRESS(addr[14:1]), .DATAIN(mdata),
                          .MASKWREN(we && !hi ? mask : 4'h0), .WREN(we && !hi),
                          .CHIPSELECT(1'b1), .CLOCK(clk), .STANDBY(1'b0),
                          .SLEEP(1'b0), .POWEROFF(1'b1), .DATAOUT(lo_word));
    SB_SPRAM256KA ram_hi (.ADDRESS(addr[14:1]), .DATAIN(mdata),
                          .MASKWREN(we && hi && !fb_st ? mask : 4'h0), .WREN(we && hi && !fb_st),
                          .CHIPSELECT(1'b1), .CLOCK(clk), .STANDBY(1'b0),
                          .SLEEP(1'b0), .POWEROFF(1'b1), .DATAOUT(hi_word));

    // The SPRAM a read came from is chosen a cycle later, with the data.  The
    // processor takes the whole word and picks its own byte.
    logic src;
    always_ff @(posedge clk) src <= hi;
    // `io_q': the word read was one of the four registers with a read path,
    // and `io_word' is it; see the registers below.
    logic io_q = 1'b0; logic [15:0] io_word;
    wire [15:0] rdata = src ? hi_word : lo_word;
    wire [15:0] dword = io_q ? io_word : rdata;    // a load's: the processor's mem_data

    // --- blit mode's late reads ---------------------------------------------------
    wire [15:0] fb_cpu_word;
    logic hi1, hi2;
    logic [15:0] lo_hold;
    always_ff @(posedge clk) begin
        hi1 <= hi;  hi2 <= hi1;
        lo_hold <= io_q ? io_word : lo_word;
    end
    wire [15:0] late = hi2 ? fb_cpu_word : lo_hold;

    wire halted, trapped; wire [15:0] result;
    // THE PROCESSOR IS SYNTHESISED AS A HIERARCHY OF ITS OWN.  Flattened into
    // the system, abc mapped its decode and register read deeper - ten and
    // eleven cells from the SPRAM to an operand flop, against seven for the
    // processor alone behind the same two SPRAMs - and the system placed at
    // 24.44 MHz, below the pixel clock; 25.38 without blit mode.  Kept apart
    // it maps as it does alone: eight cells, 27.70 MHz, 26.9 to 29.1 over
    // sixteen seeds, floorplanned.  The price is the optimisations across its
    // ports, which here are wiring.
    (* keep_hierarchy *)
    cpu u (.clk(clk), .rst(rst), .boot(boot), .mem_addr(addr), .mem_rdata(rdata),
                .mem_wdata(wdata), .mem_we(lanes), .blit(blit), .mem_late(late), .mem_data(dword),
                .irq(irq_s),
                .halted(halted), .trapped(trapped), .result(result),
                .retire(), .retire_pc());
    logic [15:0] so;
    always_ff @(posedge clk) so <= rst ? result : {so[14:0], 1'b0};
    assign dout = so[15] ^ halted ^ trapped;

    // --- the registers, a cycle after the processor's write ----------------------
    // `to_a_w`: the processor's buffer, the one not to be shown, is A - with
    // the write, and a cycle later still for blit mode's late reads.
    // ONE REGISTER TO A WORD, at its even address, and a register is written
    // when that address's lane is - by an aligned `st', the whole word, or by
    // `st8', whose byte the processor puts in both lanes, so a register of 8
    // bits or fewer may take either.  A write to the odd byte alone is
    // dropped.  See [cpu.io] in isa/fructus.toml for why.
    logic [15:0] addr_w; logic [15:0] wword_w; logic [3:0] mask_w; logic we_w, fb_w, to_a_w, to_a_2;
    always_ff @(posedge clk) begin
        addr_w <= addr; wword_w <= wdata; we_w <= we & ~boot; mask_w <= mask;
        fb_w <= fb_st; to_a_w <= !want_a; to_a_2 <= to_a_w;
    end
    // [0] front porch, [1] sync, [2] back porch, [3] pixels or lines.
    logic [3:0][9:0] h_len = {10'd640, 10'd48, 10'd96, 10'd16};
    logic [3:0][9:0] v_len = {10'd480, 10'd33, 10'd2,  10'd10};
    // The arrays' addresses, each incremented by a write to its data register
    // and wrapping at its array's size.
    logic [4:0] pal_i; logic [9:0] pat_i; logic [5:0] attr_i;
    // The font's address: 0x6000, the 4 KB below the line tables, until
    // software says otherwise - room for 256 glyphs of 16 rows.  Its bit 15 is
    // ignored, like every pointer's.
    logic [14:0] font = 15'h6000;
    // 0x0480 - 0x04ff, the GPU's half of the page and its top guard.
    wire rw = we_w && mask_w[0] && addr_w[15:7] == 9'h009;
    // 0x90 - 0x9e: timing - a block per length, since iverilog refuses a
    // variable index into a packed array on the left.
    for (genvar i = 0; i < 4; i++) begin : g_len
        wire sel = rw && addr_w[7:4] == 4'h9 && addr_w[2:1] == 2'(i);
        always @(posedge clk) if (sel) begin
            if (!addr_w[3]) h_len[i] <= wword_w[9:0];
            else            v_len[i] <= wword_w[9:0];
        end
    end
    wire pal_we  = rw && addr_w[7:0] == 8'ha2;
    wire pat_we  = rw && addr_w[7:0] == 8'ha6;
    wire attr_we = rw && addr_w[7:0] == 8'haa;
    always_ff @(posedge clk) if (rw) begin
        if (addr_w[7:0] == 8'h80) begin
            want_a <= wword_w[2];
            fb_st <= wword_w[1];
            {blit, copy} <= wword_w[1:0] == 2'd1 ? {1'b0, wword_w[2]}
                          : wword_w[1:0] == 2'd2 ? 2'b10 : 2'b00;
        end
        if (addr_w[7:0] == 8'h82) font <= wword_w[14:0];
        if (addr_w[7:0] == 8'ha0) pal_i  <= wword_w[4:0];
        if (addr_w[7:0] == 8'ha4) pat_i  <= wword_w[9:0];
        if (addr_w[7:0] == 8'ha8) attr_i <= wword_w[5:0];
        if (pal_we)  pal_i  <= pal_i  + 5'd1;
        if (pat_we)  pat_i  <= pat_i  + 10'd1;
        if (attr_we) attr_i <= attr_i + 6'd1;
    end

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
    wire copy_w_b = into_b && vrd_q;
    SB_SPRAM256KA fba (.ADDRESS(on_a ? vaddr : addr_w[14:1]), .DATAIN(wword_w),
                       .MASKWREN(cpu_w_a ? mask_w : 4'h0), .WREN(cpu_w_a),
                       .CHIPSELECT(1'b1), .CLOCK(clk), .STANDBY(1'b0),
                       .SLEEP(1'b0), .POWEROFF(1'b1), .DATAOUT(fba_word));
    SB_SPRAM256KA fbb (.ADDRESS(!on_a ? vaddr : into_b ? vaddr_q : addr_w[14:1]),
                       .DATAIN(into_b ? fba_word : wword_w),
                       .MASKWREN(copy_w_b ? 4'hf : cpu_w_b ? mask_w : 4'h0),
                       .WREN(copy_w_b || cpu_w_b),
                       .CHIPSELECT(1'b1), .CLOCK(clk), .STANDBY(1'b0),
                       .SLEEP(1'b0), .POWEROFF(1'b1), .DATAOUT(fbb_word));
    assign vdata       = on_a_q ? fba_word : fbb_word;
    assign fb_cpu_word = to_a_2 ? fba_word : fbb_word;

    wire [9:0] line; wire vblank;

    // --- the UART, with FRUCTUS_UART: rtl/uart.sv ---------------------------------
    // Its three words, [cpu.io] in isa/fructus.toml, written like the GPU's
    // registers, a cycle late; the data register takes st8 as well as st.
    // `u_rd': a load of the data register, decoded with io_q from the
    // processor's address and not a store's, takes the received byte.  A load
    // puts its address out once; nothing else the processor does puts out an
    // I/O page address without a store, since no code runs from the page.
`ifdef FRUCTUS_UART
    localparam [15:0] U_DATA = `FRUCTUS_IO_CONSOLE, U_STAT = `FRUCTUS_IO_UART_STATUS,
                      U_DIV  = `FRUCTUS_IO_UART_DIVISOR;
    wire uw = we_w && mask_w[0];
    wire [7:0] u_byte; wire [15:0] u_status;
    logic u_rd = 1'b0;
    always_ff @(posedge clk) u_rd <= addr[15:1] == U_DATA[15:1] && !we && !boot;
    uart ser (.clk, .rst, .wr_data(uw && addr_w[15:1] == U_DATA[15:1]),
              .wr_status(uw && addr_w[15:1] == U_STAT[15:1]),
              .wr_div(uw && addr_w[15:1] == U_DIV[15:1]), .wword(wword_w),
              .rd_data(u_rd), .rx_byte(u_byte), .status(u_status), .irq(uart_irq),
              .rx_pin(uart_rx), .tx_pin(uart_tx));
`endif

    // --- the registers the hardware changes, read -------------------------------
    // 0x0484 status: bit 15 vertical blank, bits 9:0 the line.  0x04a0, 0x04a4
    // and 0x04a8 the palette's, the patterns' and the attributes' addresses.
    // Either byte of each word; the processor picks its own.
    // With FRUCTUS_UART, the received byte at the data register and the
    // UART's status too.
    wire [15:0] status = {vblank, 5'd0, line};
`ifndef FRUCTUS_UART
    always_ff @(posedge clk) begin
        io_q    <= addr[15:7] == 9'h009 && (addr[6:1] == 6'h02 || addr[6:1] == 6'h10
                                         || addr[6:1] == 6'h12 || addr[6:1] == 6'h14);
        io_word <= !addr[5] ? status : addr[3] ? {10'd0, attr_i}
                 : addr[2] ? {6'd0, pat_i} : {11'd0, pal_i};
    end
`else
    // The UART's two words are the four bytes at U_DATA, and bit 7 of the
    // address - 0 there, 1 for the GPU's - and bit 1 choose the word, so only
    // io_q's one bit waits for the whole address.  Chosen by the compares
    // themselves, the word was every seed's critical path: 25.14 MHz.
    always_ff @(posedge clk) begin
        io_q    <= addr[15:7] == 9'h009 && (addr[6:1] == 6'h02 || addr[6:1] == 6'h10
                                         || addr[6:1] == 6'h12 || addr[6:1] == 6'h14)
                   || addr[15:2] == U_DATA[15:2];
        io_word <= !addr[7] ? (addr[1] ? u_status : {8'd0, u_byte})
                 : !addr[5] ? status : addr[3] ? {10'd0, attr_i}
                 : addr[2] ? {6'd0, pat_i} : {11'd0, pal_i};
    end
`endif
    video vid (.clk, .h_len, .v_len, .font,
               .pal_we, .pal_addr(pal_i), .pal_data(wword_w[7:0]),
               .spr_pat_we(pat_we), .spr_pat_addr(pat_i), .spr_pat_data(wword_w),
               .spr_attr_we(attr_we), .spr_attr_addr(attr_i), .spr_attr_data(wword_w),
               .mem_rd(vrd), .mem_addr(vaddr), .mem_rdata(vdata),
               .hsync_n, .vsync_n, .red, .green, .blue, .line, .vblank);
endmodule
