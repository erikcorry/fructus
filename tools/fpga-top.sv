// =============================================================================
// fpga-top.sv - the processor behind a real SPRAM, for measuring
// =============================================================================
//
// NOT PART OF THE DESIGN.  This is the top level `just speed` synthesises, so
// that the numbers in rtl/cpu.sv's header are measured against something the
// part can actually build rather than against idealised flops on every port.
// rtl/ is generated from isa/fructus.toml; this file is written by hand and
// exists only to give the processor a memory and an observable output.
//
// THE MEMORY IS A REAL SB_SPRAM256KA - 16K x 16, addressed by mem_addr[14:1],
// with mem_addr[0] choosing which byte comes back.  That choice is REGISTERED,
// because the address it belongs to was sampled at the previous edge and the
// byte arrives a cycle later.  Writes go through MASKWREN, a nibble pair per
// byte, since the part has no byte-wide write of its own.
//
// USING THE REAL PRIMITIVE IS THE POINT.  A block RAM inferred from an array,
// or worse a register file of flops, hides the two things that actually set
// this machine's clock: the memory's clock-to-out on the read path, and its
// address and data setup on the write path.  Every critical path this harness
// has ever reported ends at ram.DATAIN or starts at ram.DATAOUT.
//
// EVERYTHING IS OBSERVED, or synthesis is entitled to delete it.  The ALU's
// result is shifted out of `dout` a bit at a time and halted and trapped are
// mixed into it, so no part of the datapath is a loop nothing looks at.  `din`
// drives reset through two flops, which also keeps reset off the input pad's
// timing path.
// =============================================================================

module top (input logic clk, input logic din, input logic irq, output wire dout);

    logic rst_q, rst;
    always_ff @(posedge clk) begin rst_q <= din; rst <= rst_q; end

    // IRQ ARRIVES ON A REAL PIN, and that is deliberate rather than tidy.
    // Tying it to a constant here would be worse than useless: yosys would fold
    // the interrupt-enable flop, the `take' term and the vector arm of the
    // address mux out of the design entirely, and every frequency below would
    // then be measured against a processor that cannot be interrupted.  The
    // path has to exist to be timed.
    //
    // Synchronised through two flops like reset, because it is asynchronous to
    // this clock and because it keeps the input pad off the timing path.
    logic irq_q, irq_s;
    always_ff @(posedge clk) begin irq_q <= irq; irq_s <= irq_q; end

    wire [15:0] addr;
    wire [15:0] word;
    wire [7:0]  wdata;
    wire        we;

    // Which half of the 16-bit word the last address asked for.
    logic lowbyte;
    always_ff @(posedge clk) lowbyte <= ~addr[0];
    wire [7:0] rdata = lowbyte ? word[7:0] : word[15:8];

    // One byte of the pair, chosen by the nibble mask; the data is presented on
    // both halves so that either lane can take it.
    wire [3:0] mask = addr[0] ? 4'b1100 : 4'b0011;

    SB_SPRAM256KA ram (.ADDRESS(addr[14:1]), .DATAIN({wdata, wdata}),
                       .MASKWREN(we ? mask : 4'h0), .WREN(we),
                       .CHIPSELECT(1'b1), .CLOCK(clk), .STANDBY(1'b0),
                       .SLEEP(1'b0), .POWEROFF(1'b1), .DATAOUT(word));

    wire halted, trapped;
    wire [15:0] result;
    cpu u (.clk(clk), .rst(rst), .mem_addr(addr), .mem_rdata(rdata),
           .mem_wdata(wdata), .mem_we(we), .irq(irq_s), .halted(halted), .trapped(trapped),
           .result(result));

    logic [15:0] so;
    always_ff @(posedge clk) so <= rst ? result : {so[14:0], 1'b0};
    assign dout = so[15] ^ halted ^ trapped;

endmodule
