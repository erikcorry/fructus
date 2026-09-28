// =============================================================================
// alu.sv - the pipelined experiment's ALU: rtl/alu.sv without its slow arms
// =============================================================================
//
// WRITTEN BY HAND, like the rest of rtl/pipe/ except its table.  The operation
// codes are rtl/alu.sv's, so tools/predecode-rows.js's rows mean the same thing
// here, but the three arms that are not a function of this cycle's inputs are
// gone: clz and popcount (code 13), whose result is registered half way, and
// mul (code 14), whose SB_MAC16 delivers a cycle late.  The experiment
// classifies all three as microcoded.
//
// CODE 13 IS REUSED for the memory sequencer's word, which is how a load's
// bytes and a block move's pointer reach the register file: through the ALU's
// result, as rtl/cpu.sv's loads reach it through the pass-through, so the
// register file's write port has no second source in front of it.
//
// The fast unary operations keep their home in the same way rtl/alu.sv gives
// them one - selected by bits 2:1 of the right-hand immediate, which is the
// imm3 value their encoding carries.  `usel` is those two bits taken straight
// from the immediate flop, ahead of the register mux the shifts must wait for.
// =============================================================================

module pipe_alu (
    input  logic [15:0] lhs,
    input  logic [15:0] rhs,
    input  logic [1:0]  usel,    // the fast unary operation: the immediate's bits 2:1
    input  logic [3:0]  op,
    input  logic [15:0] mdata,   // the memory sequencer's word: what a load or a
                                 // block move's pointer writes, under op 13
    output logic [15:0] y,
    output logic [15:0] sum      // the adder alone, ahead of the result mux: a
                                 // load's first address, for the address pins
);

    wire        sub  = op[0];
    assign      sum  = rhs + (lhs ^ {16{sub}}) + {15'd0, sub};
    wire [15:0] xorv = lhs ^ rhs;
    wire [15:0] andv = lhs & rhs;
    wire [15:0] hiv  = {rhs[7:0], lhs[7:0]};
    wire [3:0]  amt  = rhs[3:0];

    // --- the fast unary three, as rtl/unary.sv has them --------------------------
    wire [15:0] a   = lhs;
    wire [15:0] sxt = {{8{a[7]}}, a[7:0]};
    wire [15:0] rev = { a[0],  a[1],  a[2],  a[3],  a[4],  a[5],  a[6],  a[7],
                        a[8],  a[9],  a[10], a[11], a[12], a[13], a[14], a[15] };
    logic [14:0] cm;
    always_comb begin
        cm = 15'd0;
        for (int i = 0; i < 8; i++)
            for (int j = 0; j < 8; j++)
                cm[i + j] = cm[i + j] ^ (a[i] & a[8 + j]);
    end
    wire [15:0] unf = ~usel[0] ? {1'b0, cm} : usel[1] ? sxt : rev;

    always_comb case (op)
        4'd0, 4'd1: y = sum;
        4'd2:       y = {15'd0, ~|xorv};
        4'd3:       y = {15'd0, |andv};
        4'd4:       y = xorv;
        4'd5:       y = lhs | rhs;
        4'd6:       y = andv;
        4'd7:       y = rhs;
        4'd8:       y = lhs << amt;
        4'd9:       y = lhs >> amt;
        4'd10:      y = hiv;
        4'd11:      y = $signed(lhs) >>> amt;
        4'd12:      y = unf;
        4'd13:      y = mdata;
        default:    y = 16'hxxxx;
    endcase

endmodule

// =============================================================================
// pipe_slow - clz and popcount, with a flop in the middle
// =============================================================================
//
// THE SPEC GIVES THEM AN EXTRA CYCLE, AND THE CYCLE DOES HALF THE WORK: the
// flop is in the middle of the logic, not after it, as rtl/unary.sv has it -
// so neither cycle holds the whole tree.  In the ALU cycle each nibble's count
// - one LUT level - and clz's priority encoder go into the flop, with which of
// the two was asked for; the step after, the adds run from the flop, and the
// routine takes the result into ldq.  rtl/unary.sv measured the split there,
// after the counts and before the adds, as the one that leaves the critical
// path: 30.19 MHz against 28.57 with the 3-bit adds before the flop too.
//
// NOT PART OF THE ALU: nothing here reaches the ALU's result mux or the
// register file's write port.  The adds are written as gates for the reason
// rtl/unary.sv gives: as `+` they take the carry chain, whose cells must stand
// in a column.  It works on aq every cycle, as the SB_MAC16 multiplies aq by
// bq every cycle; the routine takes the one it wants a step later.
module pipe_slow (
    input  logic        clk,
    input  logic [15:0] a,
    input  logic        pop,     // popcount, not clz
    output logic [15:0] y        // of the last edge's a and pop
);

    logic [4:0] cl;
    always_comb casez (a)
        16'b1???????????????: cl = 5'd0;
        16'b01??????????????: cl = 5'd1;
        16'b001?????????????: cl = 5'd2;
        16'b0001????????????: cl = 5'd3;
        16'b00001???????????: cl = 5'd4;
        16'b000001??????????: cl = 5'd5;
        16'b0000001?????????: cl = 5'd6;
        16'b00000001????????: cl = 5'd7;
        16'b000000001???????: cl = 5'd8;
        16'b0000000001??????: cl = 5'd9;
        16'b00000000001?????: cl = 5'd10;
        16'b000000000001????: cl = 5'd11;
        16'b0000000000001???: cl = 5'd12;
        16'b00000000000001??: cl = 5'd13;
        16'b000000000000001?: cl = 5'd14;
        16'b0000000000000001: cl = 5'd15;
        default:  cl = 5'd16;                   // a == 0
    endcase

    // A nibble's count as a table: each of its three bits is one LUT4.
    function automatic [2:0] cnt4(input [3:0] n);
        case (n)
        4'h0: cnt4 = 3'd0;  4'h1: cnt4 = 3'd1;  4'h2: cnt4 = 3'd1;  4'h3: cnt4 = 3'd2;
        4'h4: cnt4 = 3'd1;  4'h5: cnt4 = 3'd2;  4'h6: cnt4 = 3'd2;  4'h7: cnt4 = 3'd3;
        4'h8: cnt4 = 3'd1;  4'h9: cnt4 = 3'd2;  4'ha: cnt4 = 3'd2;  4'hb: cnt4 = 3'd3;
        4'hc: cnt4 = 3'd2;  4'hd: cnt4 = 3'd3;  4'he: cnt4 = 3'd3;  4'hf: cnt4 = 3'd4;
        endcase
    endfunction
    function automatic [3:0] add3(input [2:0] x, input [2:0] z);
        logic [2:0] c;
        c[0] = x[0] & z[0];
        c[1] = (x[1] & z[1]) | (c[0] & (x[1] ^ z[1]));
        c[2] = (x[2] & z[2]) | (c[1] & (x[2] ^ z[2]));
        add3 = {c[2], x[2] ^ z[2] ^ c[1], x[1] ^ z[1] ^ c[0], x[0] ^ z[0]};
    endfunction
    function automatic [4:0] add4(input [3:0] x, input [3:0] z);
        logic [3:0] c;
        c[0] = x[0] & z[0];
        c[1] = (x[1] & z[1]) | (c[0] & (x[1] ^ z[1]));
        c[2] = (x[2] & z[2]) | (c[1] & (x[2] ^ z[2]));
        c[3] = (x[3] & z[3]) | (c[2] & (x[3] ^ z[3]));
        add4 = {c[3], x[3] ^ z[3] ^ c[2], x[2] ^ z[2] ^ c[1], x[1] ^ z[1] ^ c[0], x[0] ^ z[0]};
    endfunction

    // --- the flop in the middle -------------------------------------------------
    logic        pop_q;
    logic [4:0]  cl_q;
    logic [11:0] n_q;                            // the four nibble counts
    always_ff @(posedge clk) begin
        pop_q <= pop;
        cl_q  <= cl;
        n_q   <= {cnt4(a[15:12]), cnt4(a[11:8]), cnt4(a[7:4]), cnt4(a[3:0])};
    end

    wire [4:0] pc = add4(add3(n_q[2:0], n_q[5:3]), add3(n_q[8:6], n_q[11:9]));
    assign y = {11'd0, pop_q ? pc : cl_q};

endmodule

// =============================================================================
// pipe_mul - the low half of a 16 x 16 product, a cycle late
// =============================================================================
//
// THE SB_MAC16 MULTIPLIES aq BY bq EVERY CYCLE into its own output register,
// so the product of a mul's ALU-cycle operands is there in the step after,
// which takes it into ldq.  The product never meets the ALU's result mux.
// Its inputs are the operand flops themselves, with nothing between: a bare
// wire from a flop is all that pulls toward the DSP's column, which is how it
// avoids what yosys's -dsp did to rtl/alu.sv - copy the flops in front of it
// into the DSP and drag their logic after them.  So it is instantiated, with
// rtl/alu.sv's parameters, and nothing passes -dsp.
module pipe_mul (
    input  logic        clk,
    input  logic [15:0] a,
    input  logic [15:0] b,
    output logic [15:0] p        // a * b of the last edge's operands
);

    // The DSP itself for synthesis, and for tests/pipe-check.mjs's pass
    // against yosys's model of it, which checks these parameters; a plain
    // registered multiply otherwise.
`ifdef SYNTHESIS
 `define PIPE_MAC
`endif
`ifdef PIPE_CELLS
 `define PIPE_MAC
`endif
`ifdef PIPE_MAC
    wire [31:0] o;
    SB_MAC16 #(
        .A_REG(1'b0), .B_REG(1'b0), .C_REG(1'b0), .D_REG(1'b0),
        .TOP_8x8_MULT_REG(1'b0), .BOT_8x8_MULT_REG(1'b0),
        .PIPELINE_16x16_MULT_REG1(1'b0), .PIPELINE_16x16_MULT_REG2(1'b1),
        .TOPOUTPUT_SELECT(2'b11), .BOTOUTPUT_SELECT(2'b11),
        .TOPADDSUB_LOWERINPUT(2'b10), .TOPADDSUB_UPPERINPUT(1'b1), .TOPADDSUB_CARRYSELECT(2'b11),
        .BOTADDSUB_LOWERINPUT(2'b10), .BOTADDSUB_UPPERINPUT(1'b1), .BOTADDSUB_CARRYSELECT(2'b00),
        .MODE_8x8(1'b0), .A_SIGNED(1'b0), .B_SIGNED(1'b0)
    ) mac (
        .CLK(clk), .CE(1'b1), .A(a), .B(b), .C(16'd0), .D(16'd0),
        .AHOLD(1'b0), .BHOLD(1'b0), .CHOLD(1'b0), .DHOLD(1'b0),
        .IRSTTOP(1'b0), .IRSTBOT(1'b0), .ORSTTOP(1'b0), .ORSTBOT(1'b0),
        .OLOADTOP(1'b0), .OLOADBOT(1'b0), .ADDSUBTOP(1'b0), .ADDSUBBOT(1'b0),
        .OHOLDTOP(1'b0), .OHOLDBOT(1'b0), .CI(1'b0), .ACCUMCI(1'b0), .SIGNEXTIN(1'b0),
        .O(o), .CO(), .ACCUMCO(), .SIGNEXTOUT()
    );
    assign p = o[15:0];
`else
    always_ff @(posedge clk) p <= a * b;
`endif

endmodule
