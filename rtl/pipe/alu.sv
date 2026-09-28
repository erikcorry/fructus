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
    output logic [15:0] y
);

    wire        sub  = op[0];
    wire [15:0] sum  = rhs + (lhs ^ {16{sub}}) + {15'd0, sub};
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
