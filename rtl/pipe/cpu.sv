// =============================================================================
// cpu.sv - the pipelined experiment: dispatch, decode, ALU, over 16-bit memory
// =============================================================================
//
// AN EXPERIMENT BESIDE rtl/cpu.sv, NOT A REPLACEMENT FOR IT.  Written by hand
// except for rtl/pipe/classify.sv; the decode stage borrows rtl/lhs.sv,
// rtl/dest.sv and rtl/immgen.sv from the real processor unchanged.  It runs the
// one-register ALU instructions and halt, and stops at anything else: a
// microcoded instruction other than halt sets `trapped`.
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
//             the read port.  The left register's number, the right-hand side
//             - a register number, or a 16-bit value that looks like an
//             immediate to the ALU whatever it was made from - the operation
//             and the destination are latched.
//   ALU       the register file is read, the operation done, and the result
//             written, all in one cycle.  Nothing in front of the ALU but flops
//             and the register file's read muxes.
//
// NO FORWARDING IS NEEDED because the registers are read in the stage that
// writes them.  An instruction in ALU at cycle t writes at the edge ending t;
// the next one reaches ALU at t + 1 at the earliest and reads the new value.
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
//     register numbers binary, read by 8:1 mux       1177    26.25  25.9 .. 26.5
//     REGISTER SELECTS ONE-HOT, as here              1170    27.54  26.8 .. 28.4
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
// The last row is an ablation, not a design: it prices a register-count
// shift at nothing, so the barrel shifter behind a register read is not what
// sets the clock.  The ALU stage is simply deep - register read, operation,
// result mux, register write - at eight to nine LUTs, two thirds of it wire.
// rtl/cpu.sv reads its operands a cycle early for exactly this reason, and
// runs at 29.5 on the same harness.
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

    wire [1:0] kind, len;
    wire       c_wen, c_halt;
    wire [3:0] c_alu, c_lhs, c_rhs, c_dest;
    classify c (.op(op), .kind(kind), .len(len), .wen(c_wen), .halt(c_halt),
                .alu_op(c_alu), .lhs_src(c_lhs), .rhs_src(c_rhs), .dest_src(c_dest));

    wire is_alu = (kind == 2'd0);
    wire span3  = pc[0] & (len == 2'd3);   // three bytes starting odd: three words

    // The candidates for the next pc come off the pc flop in parallel, so the
    // classifier's length only picks one.
    wire [15:0] pc1 = pc + 16'd1, pc2 = pc + 16'd2, pc3 = pc + 16'd3;
    wire [14:0] pcw = pc[15:1];

    assign mem_addr = {go ? pcw + 15'd1 : pcw, 1'b0};

    always_ff @(posedge clk) begin
        nxt <= hi;
        if (rst) begin
            pc <= 16'd0; go <= 1'b0; stop <= 1'b0; use_nxt <= 1'b0;
        end else if (go) begin
            pc      <= (len == 2'd1) ? pc1 : (len == 2'd2) ? pc2 : pc3;
            go      <= is_alu & ~span3;
            stop    <= ~is_alu;
            use_nxt <= ~pc[0] & (len == 2'd1);
        end else if (!stop) begin
            go      <= 1'b1;               // the bubble: pc's word arrives now
            use_nxt <= 1'b0;
        end
    end

    // =========================================================================
    // DECODE
    // =========================================================================
    logic        d_valid, d_ucode, d_halt, d_odd, d_wen;
    logic [7:0]  d_op, d_b1;
    logic [3:0]  d_alu, d_lhs, d_rhs, d_dest;
    logic [15:0] d_pc;
    always_ff @(posedge clk) begin
        d_valid <= ~rst & go & is_alu;
        d_ucode <= ~rst & go & ~is_alu;
        d_halt  <= c_halt;
        d_odd   <= pc[0];
        d_op    <= op;
        d_b1    <= hi;                     // an even pc's byte 1
        d_wen   <= c_wen;
        {d_alu, d_lhs, d_rhs, d_dest} <= {c_alu, c_lhs, c_rhs, c_dest};
        d_pc    <= pc;
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

    // =========================================================================
    // ALU
    // =========================================================================
    // THE REGISTER NUMBERS ARRIVE ONE-HOT.  Decode has the time to expand
    // them, and the ALU stage then reads the register file as an AND-OR over
    // eight registers rather than through an eight-way binary mux, and writes
    // it with enables that are flops.  The right-hand side's OR has a ninth
    // term, the immediate, which decode zeroes whenever a register is chosen -
    // so no select stands between either one and the ALU.
    logic [7:0]  e_asel, e_bsel, e_we;
    logic [3:0]  e_op;
    logic [15:0] e_imm;
    logic        e_valid;             // for the harness
    logic [15:0] e_pc;                // for the harness
    always_ff @(posedge clk) begin
        e_valid <= d_valid;
        e_asel  <= 8'd1 << an;
        e_bsel  <= use_reg ? 8'd1 << bn : 8'd0;
        e_imm   <= use_reg ? 16'd0 : bval;
        e_we    <= (d_valid & d_wen) ? 8'd1 << wn : 8'd0;
        e_op    <= d_alu;
        e_pc    <= d_pc;
    end

    (* ram_style = "logic" *)
    logic [15:0] R [0:7];

    logic [15:0] av, bv;
    always_comb begin
        av = 16'd0;
        bv = e_imm;
        for (int k = 0; k < 8; k++) begin
            av = av | (R[k] & {16{e_asel[k]}});
            bv = bv | (R[k] & {16{e_bsel[k]}});
        end
    end
    wire [15:0] y;
    pipe_alu a (.lhs(av), .rhs(bv), .usel(e_imm[2:1]), .op(e_op), .y(y));

    always_ff @(posedge clk)
        for (int k = 0; k < 8; k++) if (e_we[k]) R[k] <= y;
    assign result = y;

    // --- the one microcoded instruction there is --------------------------------
    always_ff @(posedge clk)
        if (rst) begin halted <= 1'b0; trapped <= 1'b0; end
        else if (d_ucode) begin halted <= d_halt; trapped <= ~d_halt; end

endmodule
