// =============================================================================
// alu.sv - the ALU, and the multiplier beside it
// =============================================================================
//
// WRITTEN BY HAND, as rtl/cpu.sv is.  The operation codes are
// tools/control.js's, so tools/predecode-rows.js's rows mean the same thing
// here.  mul, whose SB_MAC16 delivers a cycle late, is not in the ALU: it is
// `mul` below, rtl/classify.sv makes it microcoded, and a routine takes its
// result into the sequencer's word a cycle after the ALU cycle.
//
// clz AND popcount ARE THE UNARY CODE, with `two` set, and take two cycles
// here: the first half's result goes into a flop of the ALU's own, q, and the
// second half works on q and reaches the result through the unary arm.  The
// first cycle's result is wrong - q from the cycle before - and rtl/cpu.sv
// holds the instruction a second cycle, whose result is right:
//
//     popcount  half1  each nibble's count, 0 to 4, in that nibble
//               half2  the four nibbles added
//     clz       half1  {z, z ? lhs[7:0] : lhs[15:8]}, z = the top byte is 0
//               half2  (q[8] ? 8 : 0) + the leading zeros of q[7:0], 8 for 0
//
// CODE 13 IS THE MEMORY SEQUENCER'S WORD, which is how a load's bytes and a
// block move's pointer reach the register file: through the ALU's result, as
// the byte-serial core's loads did through its pass-through, so the register
// file's write port has no second source in front of it.
//
// The fast unary operations are selected as the byte-serial core selected
// them - by bits 2:1 of the right-hand operand, which for a unary
// instruction is the imm3 value its encoding carries.  No separate select:
// rhs is a flop, and for a unary instruction it always holds that value.
// =============================================================================

// The unary select, from isa/fructus.toml.
`include "rtl/isa.svh"

module alu (
    input  logic        clk,
    input  logic [15:0] lhs,
    input  logic [15:0] rhs,
    input  logic [3:0]  op,
    input  logic        two,     // with the unary code: clz or popcount, from q
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

    // --- the fast unary three, as the byte-serial core had them ------------------
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
    // Which of rhs[2:1] chooses which is the spec's: tools/gen-isa.js.
    wire [1:0]  sel = rhs[2:1];
    wire [15:0] unf = `FRUCTUS_UNARY_FAST(sel, rev, {1'b0, cm}, sxt);

    // --- clz and popcount, a half a cycle ---------------------------------------
    function automatic [3:0] cnt4(input [3:0] n);
        cnt4 = {3'd0, n[0]} + {3'd0, n[1]} + {3'd0, n[2]} + {3'd0, n[3]};
    endfunction
    function automatic [3:0] clz8(input [7:0] b);
        clz8 = b[7] ? 4'd0 : b[6] ? 4'd1 : b[5] ? 4'd2 : b[4] ? 4'd3
             : b[3] ? 4'd4 : b[2] ? 4'd5 : b[1] ? 4'd6 : b[0] ? 4'd7 : 4'd8;
    endfunction
    wire        popsel = `FRUCTUS_UNARY_POP(sel);
    wire        ztop   = ~|lhs[15:8];
    wire [15:0] half1  = popsel ? {cnt4(lhs[15:12]), cnt4(lhs[11:8]), cnt4(lhs[7:4]), cnt4(lhs[3:0])}
                                : {7'd0, ztop, ztop ? lhs[7:0] : lhs[15:8]};
    logic [16:0] q;                   // {popcount, half1} of the cycle before
    always_ff @(posedge clk) q <= {popsel, half1};
    wire [4:0]  c8     = {1'b0, clz8(q[7:0])};
    wire [15:0] half2  = q[16] ? {11'd0, {2'd0, q[2:0]} + {2'd0, q[6:4]} + {2'd0, q[10:8]} + {2'd0, q[14:12]}}
                               : {11'd0, q[8] ? c8 + 5'd8 : c8};

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
        4'd12:      y = two ? half2 : unf;
        4'd13:      y = mdata;
        default:    y = 16'hxxxx;
    endcase

endmodule

// =============================================================================
// mul - the low half of a 16 x 16 product, a cycle late
// =============================================================================
//
// THE SB_MAC16 MULTIPLIES aq BY bq EVERY CYCLE into its own output register,
// so the product of a mul's ALU-cycle operands is there in the step after,
// which takes it into ldq.  The product never meets the ALU's result mux.
// Its inputs are the operand flops themselves, with nothing between: a bare
// wire from a flop is all that pulls toward the DSP's column, which is how it
// avoids what yosys's -dsp did to the byte-serial core's alu.sv - copy the flops in front of it
// into the DSP and drag their logic after them.  So it is instantiated, with
// the parameters the byte-serial core's alu.sv had, and nothing passes -dsp.
module mul (
    input  logic        clk,
    input  logic [15:0] a,
    input  logic [15:0] b,
    output logic [15:0] p        // a * b of the last edge's operands
);

    // The DSP itself for synthesis, and for tests/cpu-check.mjs's pass
    // against yosys's model of it, which checks these parameters; a plain
    // registered multiply otherwise.
`ifdef SYNTHESIS
 `define CPU_MAC
`endif
`ifdef CPU_CELLS
 `define CPU_MAC
`endif
`ifdef CPU_MAC
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
