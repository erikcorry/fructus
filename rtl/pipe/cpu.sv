// =============================================================================
// cpu.sv - the pipelined experiment: dispatch, decode, ALU, over 16-bit memory
// =============================================================================
//
// AN EXPERIMENT BESIDE rtl/cpu.sv, NOT A REPLACEMENT FOR IT.  Written by hand
// except for rtl/pipe/classify.sv; the decode stage borrows rtl/lhs.sv,
// rtl/dest.sv, rtl/immgen.sv and rtl/cond.sv from the real processor
// unchanged, and the ALU stage rtl/compare.sv.  It runs the one-register ALU
// instructions, the conditional branches and halt, and stops at anything
// else: a microcoded instruction other than halt sets `trapped`.
//
// MEMORY IS A WORD WIDE.  `mem_addr` is a byte address whose bit 0 is always
// clear; the word at that address, the even byte low, is on `mem_rdata` the
// cycle after the edge that sampled it - the UP5K's SPRAM exactly, with no
// byte select in front of it.
//
// THREE STAGES, ONE INSTRUCTION A CYCLE when the bytes allow it:
//
//   DISPATCH  the opcode arrives - from the port, or from `nxt` - and
//             rtl/pipe/classify.sv categorises it.  If it is ALU the next
//             instruction's dispatch is the very next cycle, unless the bytes
//             cannot be there in time (below).
//   DECODE    the whole instruction is present, part of it perhaps still on
//             the read port.  Both operands are latched - the left one read
//             from the register file, the right one read from it or made into
//             a 16-bit value that looks like an immediate to the ALU, whatever
//             it was made from - with the operation and the destination.
//   ALU       two operand flops, the operation, and the result written.
//
// A CONDITIONAL BRANCH FLOWS THROUGH ALL THREE STAGES as an ALU instruction
// does, with the same operands and the same bypass - it compares a register
// with a register or a constant - and dispatch carries on behind it down the
// fall-through path.  Decode latches its condition, from rtl/cond.sv, and its
// target; the ALU stage decides it with rtl/compare.sv, a subtractor of its
// own beside the ALU on the same operand flops, and REGISTERS the verdict.
// If the branch is taken, the next cycle squashes the three instructions
// behind it - in the ALU stage, in decode, and dispatching - and reads the
// target's word, which dispatches the cycle after:
//
//     cycle   0          1          2          3            4
//     branch  dispatch   decode     ALU: taken
//     behind             dispatch   decode     squashed
//                                   dispatch   squashed
//                                              squashed
//     target                                   word read    dispatch
//
// So a taken branch costs four cycles, and one not taken costs what any
// three-byte instruction does.  Nothing behind a branch can have done
// anything by then, because only the ALU stage writes; and halt takes effect
// in the ALU stage rather than decode for the same reason.
//
// ONE BYPASS, FROM THE ALU STAGE INTO DECODE'S OPERAND FLOPS.  The instruction
// directly ahead is in the ALU stage while this one decodes and writes only at
// the edge that ends the cycle, so its result is not yet in the register file.
// Decode knows that instruction's destination - it latched it itself, one-hot,
// a cycle earlier - and takes the result in place of the read when the numbers
// match.  Anything older has already landed.
//
// WHERE THE BYTES ARE.  After the dispatch of an instruction at pc the address
// presented is ALWAYS the word after pc's word - whatever the instruction's
// length, and whether pc is odd or even.  The table of what that gives:
//
//     pc    len   byte 1        byte 2        next opcode           next dispatch
//     even   1    -             -             hi byte, kept in nxt  next cycle
//     even   2    hi, latched   -             port, lo              next cycle
//     even   3    hi, latched   port, lo      port, hi              next cycle
//     odd    1    -             -             port, lo              next cycle
//     odd    2    port, lo      -             port, hi              next cycle
//     odd    3    port, lo      port, hi      needs another word    a cycle later
//
// So the address never waits for the classifier: it is a function of pc and
// of whether this cycle dispatches, both flops.  The one case that costs a
// cycle is the one whose bytes span three words, and in that bubble the
// address is the next instruction's own word.
//
// An even-length gap is harmless: when an odd one-byte instruction follows an
// even one-byte one, the word after pc's word has already been read, and
// reading it again gives the same bytes.
//
// MEASURED on an iCE40 UP5K, yosys + nextpnr-ice40, behind a real
// SB_SPRAM256KA read a word at a time (tools/pipe-top.sv), medians of eight
// placement seeds - `just speed-pipe`:
//
//                                                   cells     MHz   spread
//     WITH THE CONDITIONAL BRANCHES                  1330    35.53  34.3 .. 36.1
//     operands read in decode, with the bypass       1186    34.95  34.0 .. 36.2
//
//   and before it, with the register file read in the ALU stage:
//
//     register numbers binary, read by 8:1 mux       1177    26.25  25.9 .. 26.5
//     register selects one-hot                       1170    27.54  26.8 .. 28.4
//     and the result mux an AND-OR, one-hot op       1188    26.85  25.6 .. 27.1
//     shift amount from the immediate only (wrong)   1145    27.59  27.1 .. 28.2
//     no shifts at all (wrong)                                30.50  29.6 .. 31.3
//     no shifts and no unary operations (wrong)               31.50  30.5 .. 33.0
//     shifts gated and ORed after the fast mux       1145    27.41  26.9 .. 28.3
//     read selects copied per nibble, `keep`         1175    26.25  25.7 .. 27.8
//     floorplanned, ALU stage in (1,1)-(12,12)       1191    26.55  25.4 .. 27.4
//     floorplanned, ALU stage in (1,4)-(14,14)       1191    27.02  26.2 .. 27.9
//
// THE SHIFTERS ARE THE THREE MHz BETWEEN THIS AND 30.  Everything else in the
// stage - the read, the adder, the logic operations, the result mux and the
// write - reaches 30.5 once they are gone.  They cannot be hidden by moving
// them to the end of the result: the rows that gate them in after a fast mux
// came out the same, because abc flattens the result mux however it is
// written.  The amount and the data are equally deep - a register read and
// four levels of barrel shifter each - so removing either one alone buys
// nothing, and copying the read selects to cut their fanout made the low
// nibble's copy, which IS the amount, the one that fans out to everything.
//
// NOR DOES PLACEMENT HELP.  The path is nine LUTs, and the placer already
// keeps them together: in the best seeds every hop is 1.8 to 3 ns of wire
// between neighbouring tiles, so confining the stage to a rectangle
// (tools/pipe-floorplan.py) gives the placer less room without making a
// single hop shorter.  At nine levels 30 MHz is out of reach wherever they
// sit; only fewer levels will get there.
//
// WHAT FIXED IT WAS MOVING THE READ, NOT THE SHIFTERS.  rtl/cpu.sv as of
// 735e301, which reads its operands a cycle early with the same shifters,
// measured 33.96 on this harness; the shifters were only too slow with a
// register read in front of them.  With the read in decode the ALU loop is
// operand flop, ALU, result mux, and then either the register file or - one
// LUT - the bypass into the operand flops, and it is off the critical path:
// every seed's path now runs from the SPRAM's data out, through decode, to an
// operand flop or the pc, in six or seven cells.
// =============================================================================

module pipe_cpu (
    input  logic        clk,
    input  logic        rst,
    output logic [15:0] mem_addr,    // -> memory: a word address, bit 0 clear
    input  logic [15:0] mem_rdata,   // <- the word sampled at the last edge
    output logic        halted,
    output logic        trapped,
    output logic [15:0] result       // the ALU's output, for the harness
);

    // A taken branch, decided in the ALU stage at the last edge: this cycle
    // the three instructions behind it are wrong, and the fetch goes to `tgt_q`.
    logic        taken_q;
    logic [15:0] tgt_q;

    // =========================================================================
    // DISPATCH / PREDECODE
    // =========================================================================
    logic [15:0] pc;        // the instruction dispatching this cycle, if `go`
    logic        go;        // this cycle dispatches
    logic        stop;      // a microcoded instruction was dispatched: freeze
    logic        use_nxt;   // an odd pc's opcode is in nxt, not on the port
    logic [7:0]  nxt;       // the high byte of the word the port last held

    wire [7:0] lo = mem_rdata[7:0], hi = mem_rdata[15:8];
    wire [7:0] op = pc[0] ? (use_nxt ? nxt : hi) : lo;

    wire [1:0] kind, len, c_cond;
    wire       c_wen, c_halt;
    wire [3:0] c_alu, c_lhs, c_rhs, c_dest;
    classify c (.op(op), .kind(kind), .len(len), .wen(c_wen), .halt(c_halt),
                .alu_op(c_alu), .lhs_src(c_lhs), .rhs_src(c_rhs), .dest_src(c_dest),
                .cond_src(c_cond));

    // A CONDITIONAL BRANCH FLOWS LIKE AN ALU INSTRUCTION.  Dispatch carries on
    // down the fall-through path behind it, which costs nothing if the branch
    // is not taken, and is undone below if it is.
    wire is_cbr  = (kind == 2'd2);
    wire flows   = (kind == 2'd0) | is_cbr;
    wire span3   = pc[0] & (len == 2'd3);  // three bytes starting odd: three words

    // The candidates for the next pc come off the pc flop in parallel, so the
    // classifier's length only picks one.
    wire [15:0] pc1 = pc + 16'd1, pc2 = pc + 16'd2, pc3 = pc + 16'd3;
    wire [14:0] pcw = pc[15:1];

    assign mem_addr = taken_q ? {tgt_q[15:1], 1'b0} : {go ? pcw + 15'd1 : pcw, 1'b0};

    always_ff @(posedge clk) begin
        nxt <= hi;
        if (rst) begin
            pc <= 16'd0; go <= 1'b0; stop <= 1'b0; use_nxt <= 1'b0;
        end else if (taken_q) begin
            // The target's word is being read now; it dispatches next cycle.
            pc <= tgt_q; go <= 1'b1; stop <= 1'b0; use_nxt <= 1'b0;
        end else if (go) begin
            pc      <= (len == 2'd1) ? pc1 : (len == 2'd2) ? pc2 : pc3;
            go      <= flows & ~span3;
            stop    <= ~flows;
            use_nxt <= ~pc[0] & (len == 2'd1);
        end else if (!stop) begin
            go      <= 1'b1;               // the bubble: pc's word arrives now
            use_nxt <= 1'b0;
        end
    end

    // =========================================================================
    // DECODE
    // =========================================================================
    logic        d_valid, d_ucode, d_halt, d_odd, d_wen, d_cbr;
    logic [7:0]  d_op, d_b1;
    logic [3:0]  d_alu, d_lhs, d_rhs, d_dest;
    logic [1:0]  d_cond;
    logic [15:0] d_pc, d_pc3;
    always_ff @(posedge clk) begin
        d_valid <= ~rst & ~taken_q & go & flows;
        d_ucode <= ~rst & ~taken_q & go & ~flows;
        d_cbr   <= is_cbr;
        d_halt  <= c_halt;
        d_odd   <= pc[0];
        d_op    <= op;
        d_b1    <= hi;                     // an even pc's byte 1
        d_wen   <= c_wen;
        {d_alu, d_lhs, d_rhs, d_dest, d_cond} <= {c_alu, c_lhs, c_rhs, c_dest, c_cond};
        d_pc    <= pc;
        d_pc3   <= pc3;                    // a branch's next instruction
    end

    // The instruction, whole: byte 1 latched or on the port, byte 2 on the port.
    wire [7:0]  b1 = d_odd ? lo : d_b1;
    wire [7:0]  b2 = d_odd ? hi : lo;
    wire [23:0] ins = {b2, b1, d_op};

    wire [2:0] an, wn;
    lhs  l (.insn(ins), .src(d_lhs),  .regnum(an));
    dest d (.insn(ins), .src(d_dest), .regnum(wn));

    // --- the right-hand side, in rtl/rhs.sv's codes ------------------------------
    // A register is passed on as its number; anything else becomes a value.
    wire [2:0] rc = d_rhs[2:0];
    wire       rk = d_rhs[3];
    wire use_reg = (~rk & rc != 3'd4 & rc != 3'd2 & rc != 3'd3) | (rk & rc == 3'd5);
    wire use_imm = rk & (rc == 3'd3 | rc == 3'd4);
    wire [2:0]  bn = rk ? {ins[15:14], ins[0]} : rc;
    wire [15:0] imm;
    immgen g (.insn(ins), .cimm(rk & rc == 3'd4), .imm(imm));
    wire [15:0] konst = {{13{rc[2]}}, rc};
    wire [15:0] bval  = use_imm ? imm : rk ? konst : ins[23:8];

    // --- a branch's condition and target ------------------------------------------
    // The displacement is always the last byte, and it counts from the
    // instruction after the branch - which dispatch already had as pc + 3.
    wire [2:0] ccode;
    wire       cneg, cmask;
    cond cu (.insn(ins), .src(d_cond), .code(ccode), .neg(cneg), .mask(cmask));
    wire [15:0] tgt = d_pc3 + {{8{b2[7]}}, b2};

    // =========================================================================
    // ALU
    // =========================================================================
    // THE OPERANDS ARE READ IN DECODE, into flops, so the ALU stage is those
    // two flops, the ALU and the write - as in rtl/cpu.sv, which measures 34
    // on the same harness for that reason.  Read in the ALU stage instead, the
    // register file's read put two more levels in front of the shifters, and
    // that measured 27.54.
    //
    // THE ONE HAZARD IS THE INSTRUCTION DIRECTLY AHEAD.  It is in the ALU
    // stage while this one decodes, and its result reaches the register file
    // only at the edge that ends this cycle, so the read below cannot see it.
    // Anything older has already landed.  So decode compares its register
    // numbers with that instruction's destination - `e_we`, one-hot, which
    // decode itself latched a cycle ago - and takes the ALU's result instead
    // of the register file's.  On the ALU's side that is one LUT between `y`
    // and the operand flop, in place of the two levels of read it replaces.
    (* ram_style = "logic" *)
    logic [15:0] R [0:7];

    logic [7:0]  e_we;                // the destination in the ALU stage, one-hot
    wire  [15:0] y;

    wire fwd_a = e_we[an];
    wire fwd_b = use_reg & e_we[bn];
    wire [15:0] rb = use_reg ? R[bn] : bval;

    // Everything decode hands on is dropped in a cycle that squashes: the
    // instruction in decode then is one of the three behind a taken branch.
    wire keep = d_valid & ~taken_q;

    logic [3:0]  e_op;
    logic [1:0]  e_usel;              // the fast unary operation: bval[2:1]
    logic [15:0] aq, bq;
    logic        e_cbr, e_neg, e_mask, e_ucode, e_halt;
    logic [2:0]  e_code;
    logic [15:0] e_tgt;
    logic        e_valid;             // for the harness
    logic [15:0] e_pc;                // for the harness
    always_ff @(posedge clk) begin
        e_valid <= keep;
        aq      <= fwd_a ? y : R[an];
        bq      <= fwd_b ? y : rb;
        e_usel  <= bval[2:1];
        e_we    <= (keep & d_wen) ? 8'd1 << wn : 8'd0;
        e_op    <= d_alu;
        e_cbr   <= keep & d_cbr;
        {e_code, e_neg, e_mask} <= {ccode, cneg, cmask};
        e_tgt   <= tgt;
        e_ucode <= d_ucode & ~taken_q;
        e_halt  <= d_halt;
        e_pc    <= d_pc;
    end

    pipe_alu a (.lhs(aq), .rhs(bq), .usel(e_usel), .op(e_op), .y(y));

    // THE CONDITION HAS ITS OWN UNIT, as in rtl/cpu.sv: rtl/compare.sv's
    // subtractor reads the same operand flops as the ALU and none of its
    // result.  Its verdict is REGISTERED, so the comparison never reaches the
    // memory's address pins in the cycle it is made.  That costs a cycle on a
    // taken branch: the target dispatches two cycles after the branch's ALU
    // cycle, four after its own dispatch.
    wire taken;
    compare cp (.lhs(aq), .rhs(bq), .cond(e_code), .neg(e_neg), .mask(e_mask), .taken(taken));

    // The instruction in the ALU stage while taken_q is set is the first of
    // the three behind the branch, so it may neither write nor branch.
    always_ff @(posedge clk) begin
        taken_q <= ~rst & ~taken_q & e_cbr & taken;
        tgt_q   <= e_tgt;
        for (int k = 0; k < 8; k++) if (e_we[k] & ~taken_q) R[k] <= y;
    end
    assign result = y;

    // --- the one microcoded instruction there is --------------------------------
    // It takes effect in the ALU stage, not in decode, because a halt just
    // behind a taken branch reaches decode before the branch is decided.
    always_ff @(posedge clk)
        if (rst) begin halted <= 1'b0; trapped <= 1'b0; end
        else if (e_ucode & ~taken_q) begin halted <= e_halt; trapped <= ~e_halt; end

endmodule
