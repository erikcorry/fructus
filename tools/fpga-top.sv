// =============================================================================
// fpga-top.sv - the processor behind a real SPRAM, for measuring
// =============================================================================
//
// NOT PART OF THE DESIGN.  `node tools/speed.mjs` synthesises this, the
// processor with the least around it: one SPRAM, its first 32 KB.
// tools/fpga-system.sv is the whole system.
//
// THE SPRAM IS READ A WORD AT A TIME - there is no byte select behind it and
// no flop remembering which half was asked for.  A store writes one byte: it
// is presented on both halves, and the nibble mask - from the address's bit
// 0 - chooses which half takes it.
//
// Everything the core does is observed through `dout`, so nothing is
// optimised away.
// =============================================================================

module top (input logic clk, input logic din, input logic irq, output wire dout);

    logic rst_q, rst;
    always_ff @(posedge clk) begin rst_q <= din; rst <= rst_q; end

    // IRQ ARRIVES ON A REAL PIN, synchronised through two flops: tied to a
    // constant, yosys would
    // fold ie, the take and the whole interrupt path out of the design, and
    // the number would describe a processor that cannot be interrupted.
    logic irq_q, irq_s;
    always_ff @(posedge clk) begin irq_q <= irq; irq_s <= irq_q; end

    wire [15:0] addr;
    wire [15:0] word;
    wire [7:0]  wdata;
    wire        we;
    wire [3:0]  mask = addr[0] ? 4'b1100 : 4'b0011;

    SB_SPRAM256KA ram (.ADDRESS(addr[14:1]), .DATAIN({wdata, wdata}),
                       .MASKWREN(we ? mask : 4'h0), .WREN(we),
                       .CHIPSELECT(1'b1), .CLOCK(clk), .STANDBY(1'b0),
                       .SLEEP(1'b0), .POWEROFF(1'b1), .DATAOUT(word));

    wire halted, trapped;
    wire [15:0] result;
    cpu u (.clk(clk), .rst(rst), .mem_addr(addr), .mem_rdata(word),
                .mem_wdata(wdata), .mem_we(we), .irq(irq_s),
                .halted(halted), .trapped(trapped), .result(result), .retire(), .retire_pc());

    logic [15:0] so;
    always_ff @(posedge clk) so <= rst ? result : {so[14:0], 1'b0};
    assign dout = so[15] ^ halted ^ trapped;

endmodule
