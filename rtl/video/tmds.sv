// =============================================================================
// tmds.sv - three TMDS lanes and a clock lane on eight plain pins
// =============================================================================
//
// Hand written.  ser is five times the pixel clock, and this makes the pixel
// clock from it.  Each lane is a pair of pins carrying opposite data, through
// the IO cells' DDR flops, so two bits a cycle of ser.
//
// THE ONLY CROSSING IS THE ROM'S WORD INTO THE SHIFTERS, and it is safe by
// construction, not by timing analysis.  The pixel clock rises at the start of
// ring state 0, and each lane loads at the end of state 2: three cycles of ser,
// 23.8 ns at 126 MHz, after the clock edge that moved the word, and two before
// the next.  nextpnr's report for that path, about 5 ns, is not a constraint.
//
// THE SHIFTERS ROTATE, RATHER THAN SHIFT IN ZEROS.  Those bits are never sent,
// and zeros became a synchronous reset, with a LUT and a long net in front of
// it: 142 MHz at best, against 149 rotating.
//
// EACH LANE HAS ITS OWN LOAD FLOP, because one for all three fans out to 30 LUTs.
//
// D_OUT_1 IS SAMPLED HALF A CYCLE AFTER D_OUT_0's EDGE.  A pair goes out as
// D_OUT_0 from the rising edge, then D_OUT_1 from the falling edge after it, so
// the second bit needs one more stage than the first, `second`.  That last hop
// has half a cycle, 3.97 ns at 126 MHz, and in nextpnr's model cannot be under
// 3.4 ns, flop beside pad: which caps this at 149 MHz, a 29.8 MHz pixel clock.
// ALL EIGHT PINS MUST BE ON ONE EDGE OF THE DIE, or the placer can't keep every
// flop near its pad: tools/fpga-hdmi.pcf has pins that are.
//
// THE RING IS SELF-STARTING, since an iCE40 flop can't start at 1.
// =============================================================================

module tmds_lane (
    input  logic       ser,
    input  logic       first,     // the pair's bits, a stage before the pins
    input  logic       second,
    output wire        p,
    output wire        n
);
    logic d0 = 1'b0, d0n = 1'b0, delay = 1'b0, d1 = 1'b0, d1n = 1'b0;
    always_ff @(posedge ser) begin
        d0 <= first;  d0n <= !first;
        delay <= second;
        d1 <= delay;  d1n <= !delay;
    end
    SB_IO #(.PIN_TYPE(6'b0100_01)) p_pad (.PACKAGE_PIN(p), .OUTPUT_CLK(ser), .D_OUT_0(d0),  .D_OUT_1(d1));
    SB_IO #(.PIN_TYPE(6'b0100_01)) n_pad (.PACKAGE_PIN(n), .OUTPUT_CLK(ser), .D_OUT_0(d0n), .D_OUT_1(d1n));
endmodule

module tmds (
    input  logic       ser,       // five times the pixel clock
    output wire        pclk,      // the pixel clock, on a global buffer
    input  logic [7:0] addr,      // tmds_rom's: a pixel byte, or blanking at 4 - 7
    output wire  [3:0] tmds_p,    // [0] blue, [1] green, [2] red, [3] clock
    output wire  [3:0] tmds_n
);

    logic [4:0] ring = 5'd0;
    logic pdiv = 1'b0;
    always_ff @(posedge ser) begin
        ring <= {ring[3:0], ~|ring[3:0]};
        pdiv <= ring[4] | ring[0];
    end
    SB_GB pclk_gb (.USER_SIGNAL_TO_GLOBAL_BUFFER(pdiv), .GLOBAL_BUFFER_OUTPUT(pclk));

    wire [29:0] word;
    tmds_rom rom (.clk(pclk), .addr, .word);

    logic load_b = 1'b0, load_g = 1'b0, load_r = 1'b0;
    logic [9:0] sb = 10'd0, sg = 10'd0, sr = 10'd0;
    logic ck0 = 1'b0, ck1 = 1'b0;
    always_ff @(posedge ser) begin
        load_b <= ring[1];  load_g <= ring[1];  load_r <= ring[1];
        sb <= load_b ? word[9:0]   : {sb[1:0], sb[9:2]};
        sg <= load_g ? word[19:10] : {sg[1:0], sg[9:2]};
        sr <= load_r ? word[29:20] : {sr[1:0], sr[9:2]};
        // 1111100000, in step with the shifters: a word's first pair in state 3.
        ck0 <= ring[2] | ring[3] | ring[4];
        ck1 <= ring[2] | ring[3];
    end

    tmds_lane b (.ser, .first(sb[0]), .second(sb[1]), .p(tmds_p[0]), .n(tmds_n[0]));
    tmds_lane g (.ser, .first(sg[0]), .second(sg[1]), .p(tmds_p[1]), .n(tmds_n[1]));
    tmds_lane r (.ser, .first(sr[0]), .second(sr[1]), .p(tmds_p[2]), .n(tmds_n[2]));
    tmds_lane c (.ser, .first(ck0),   .second(ck1),   .p(tmds_p[3]), .n(tmds_n[3]));

endmodule
