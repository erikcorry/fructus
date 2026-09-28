// =============================================================================
// cpu.sv - the pipelined experiment: dispatch, decode, ALU, over 16-bit memory
// =============================================================================
//
// AN EXPERIMENT BESIDE rtl/cpu.sv, NOT A REPLACEMENT FOR IT.  Written by hand
// except for rtl/pipe/classify.sv; the decode stage borrows rtl/lhs.sv,
// rtl/dest.sv, rtl/immgen.sv and rtl/cond.sv from the real processor
// unchanged, and the ALU stage rtl/compare.sv.  It runs the one-register ALU
// instructions, the conditional branches, the jumps and calls, the loads and
// stores and block moves, and halt, and stops at anything else: a microcoded
// instruction other than halt sets `trapped`.
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
// three-byte instruction does.
//
// A JUMP OR CALL ENTERS THE PIPELINE TOO, but dispatch stops behind it, since
// its fall-through is never right.  Decode builds the target - bytes 1 and
// 2, the next pc plus the last byte, or the left operand for jmp ra, call ra
// and ret - and a call's return address as its right-hand operand, which lr
// takes through the ALU's pass-through.  In the jump's ALU cycle the fetch
// reads the target's word, chosen by flops, and it dispatches next: three
// cycles, with nothing to squash.  `call lr` goes to the next instruction,
// since its semantics write lr before reading it.  Nothing behind a branch can have done
// anything by then, because only the ALU stage writes; and halt takes effect
// in the ALU stage rather than decode for the same reason.
//
// A LOAD, A STORE OR A BLOCK MOVE ENTERS THE PIPELINE AND STOPS DISPATCH, and
// that is what keeps it off the bus while instructions are fetched: its own
// bytes are the last thing the fetch reads, and by its ALU cycle the port is
// idle.  The ALU cycle registers the first address; a sequencer then moves one
// byte a cycle, writes registers through the ALU's result, and releases
// dispatch as its last address goes out.  N bytes cost N + 4 cycles from one
// dispatch to the next: 5 for ld8 and st8, 6 for ld, st and a one-register
// push or pop, 10 for three registers.  See THE MEMORY SEQUENCER below.
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
//     A STORE'S DATA THROUGH DECODE'S LEFT PORT      1816    32.06  31.2 .. 32.8
//     through a byte-wide port of its own            1937    31.22  28.9 .. 31.7
//     with loads, stores and block moves             2050    31.35  29.9 .. 33.3
//     the sequencer's controls from its counter      1933    30.99  29.9 .. 31.4
//     empty opcodes' length left to the mapper       1371    33.59  32.8 .. 34.4
//     with the jumps and calls                       1388    32.96  32.5 .. 33.7
//     pc + 1, 2, 3 as a LUT increment, no carry      1384    32.05  31.3 .. 33.0
//     and length and kind looked up before the mux   1385    31.13  30.6 .. 33.1
//     and a flop of its own for the next pc          1412    32.67  31.4 .. 34.1
//     and one for a register jump's target, `keep`   1383    31.93  29.3 .. 32.9
//     with the conditional branches                  1330    35.53  34.3 .. 36.1
//     the verdict choosing the address, 3 cycles     1267    30.10  28.7 .. 31.7
//     backward predicted taken, verdict picks pc     1347    32.19  31.6 .. 33.0
//     and the verdict into one flop only             1362    31.73  29.8 .. 32.6
//     and rtl/compare.sv kept as its own hierarchy   1356    32.79  31.9 .. 33.4
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
// A TAKEN BRANCH STAYS AT FOUR CYCLES because nothing tried for three kept the
// clock.  Letting the comparison choose the next address put rtl/compare.sv's
// carry chain in front of the SPRAM's address pins; predicting backward
// branches taken, so the address comes from flops, cost three MHz however the
// verdict was then used, apparently by crowding the logic round the SPRAM -
// the slowed paths were the ALU's own, which had not changed.  A cycle on
// taken branches is not worth ten per cent on everything.
//
// THE pc'S THREE SUMS STAY ON THE CARRY CHAIN.  They are three chains - 41
// carry cells, the fetch address sharing pc + 2's - and a carry chain's cells
// must stand in a column; but they are fed by the pc flops alone and settle
// while the opcode is still leaving the SPRAM.  An increment of pc[15:2] as
// three levels of instantiated LUT4s, with the length's two-bit carry picking
// it, measured slower, and so did also reading the length before the opcode
// mux: what stands between the SPRAM and the pc is the classifier's table,
// three or four LUTs for a function of eight bits, and the five-input mux in
// front of it - not the sum behind it.
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
    output logic [15:0] mem_addr,    // -> memory: the word is [15:1]; [0] is the byte lane
                                     //    a store writes, and clear for every fetch
    input  logic [15:0] mem_rdata,   // <- the word sampled at the last edge
    output logic [7:0]  mem_wdata,   // -> memory: the byte to write, in lane mem_addr[0]
    output logic        mem_we,      // -> memory: write it at this edge
    output logic        halted,
    output logic        trapped,
    output logic [15:0] result,      // the ALU's output, for the harness
    output logic        retire,      // for the harness: an instruction completes
    output logic [15:0] retire_pc    //   this cycle, and this was its address
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

    wire [1:0] kind, len, c_cond, c_pcsrc, c_mn;
    wire       c_wen, c_halt, c_mem, c_mst, c_mw2, c_mblk, c_mpush;
    wire [3:0] c_alu, c_lhs, c_rhs, c_dest;
    classify c (.op(op), .kind(kind), .len(len), .wen(c_wen), .halt(c_halt),
                .alu_op(c_alu), .lhs_src(c_lhs), .rhs_src(c_rhs), .dest_src(c_dest),
                .cond_src(c_cond), .pc_src(c_pcsrc), .mem(c_mem), .mst(c_mst), .mw2(c_mw2),
                .mn(c_mn), .mblk(c_mblk), .mpush(c_mpush));

    // A CONDITIONAL BRANCH FLOWS LIKE AN ALU INSTRUCTION.  Dispatch carries on
    // down the fall-through path behind it, which costs nothing if the branch
    // is not taken, and is undone below if it is.
    //
    // A JUMP ENTERS THE PIPELINE BUT STOPS DISPATCH behind it, since its fall
    // through is never right: nothing follows it to be undone, and the ALU
    // stage restarts dispatch at its target.
    wire is_cbr  = (kind == 2'd2);
    wire is_jump = (kind == 2'd3);
    wire flows   = (kind == 2'd0) | is_cbr;
    // A MEMORY INSTRUCTION ENTERS THE PIPELINE AND STOPS DISPATCH, as a jump
    // does, and for the reason the bus needs: its own bytes are the last thing
    // the fetch reads before it, so from its ALU cycle on the port is the
    // sequencer's alone, and dispatch resumes only when the sequencer is done
    // with it.
    wire piped   = flows | is_jump | c_mem;
    wire span3   = pc[0] & (len == 2'd3);  // three bytes starting odd: three words

    // The candidates for the next pc come off the pc flop in parallel, so the
    // classifier's length only picks one.
    wire [15:0] pc1 = pc + 16'd1, pc2 = pc + 16'd2, pc3 = pc + 16'd3;
    wire [15:0] pcn = (len == 2'd1) ? pc1 : (len == 2'd2) ? pc2 : pc3;
    wire [14:0] pcw = pc[15:1];

    // A jump in the ALU stage reads its target's word, chosen by flops alone.
    wire        jnow;
    wire [15:0] jaddr;
    wire        aphase, mrestart;          // the memory sequencer, below
    logic [15:0] mar;
    assign mem_addr = taken_q ? {tgt_q[15:1], 1'b0}
                    : jnow    ? {jaddr[15:1], 1'b0}
                    : aphase  ? mar
                    :           {go ? pcw + 15'd1 : pcw, 1'b0};

    always_ff @(posedge clk) begin
        nxt <= hi;
        if (rst) begin
            pc <= 16'd0; go <= 1'b0; stop <= 1'b0; use_nxt <= 1'b0;
        end else if (taken_q) begin
            // The target's word is being read now; it dispatches next cycle.
            pc <= tgt_q; go <= 1'b1; stop <= 1'b0; use_nxt <= 1'b0;
        end else if (jnow) begin
            pc <= jaddr; go <= 1'b1; stop <= 1'b0; use_nxt <= 1'b0;
        end else if (mrestart) begin
            // The sequencer's last address is on the bus now.  The next cycle
            // is the bubble that reads pc's word, and dispatch follows it.
            stop <= 1'b0;
        end else if (go) begin
            pc      <= pcn;
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
    logic        d_valid, d_ucode, d_halt, d_odd, d_wen, d_cbr, d_jump;
    logic        d_mem, d_mst, d_mw2, d_mblk, d_mpush;
    logic [1:0]  d_mn;
    logic [7:0]  d_op, d_b1;
    logic [3:0]  d_alu, d_lhs, d_rhs, d_dest;
    logic [1:0]  d_cond, d_pcsrc, d_len;
    logic [15:0] d_pc;
    always_ff @(posedge clk) begin
        d_valid <= ~rst & ~taken_q & go & piped;
        d_ucode <= ~rst & ~taken_q & go & ~piped;
        d_cbr   <= is_cbr;
        d_jump  <= is_jump;
        {d_mem, d_mst, d_mw2, d_mn, d_mblk, d_mpush} <= {c_mem, c_mst, c_mw2, c_mn, c_mblk, c_mpush};
        d_pcsrc <= c_pcsrc;
        d_len   <= len;
        d_halt  <= c_halt;
        d_odd   <= pc[0];
        d_op    <= op;
        d_b1    <= hi;                     // an even pc's byte 1
        d_wen   <= c_wen;
        {d_alu, d_lhs, d_rhs, d_dest, d_cond} <= {c_alu, c_lhs, c_rhs, c_dest, c_cond};
        d_pc    <= pc;
    end

    // THE NEXT PC IS THE pc REGISTER.  Dispatch moved it on at the edge that
    // began this cycle, and nothing moves it again before this instruction
    // leaves decode except a redirect, which squashes this instruction too.
    // A flop of its own, loaded from the same sum, was measured on dispatch's
    // critical path at 32.67 MHz.
    wire [15:0] d_next = pc;

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
    // Code 2 is a call's return address, the next pc, which lr takes through
    // the ALU's pass-through.
    wire [15:0] bval  = use_imm ? imm : rk ? konst : (rc == 3'd2) ? d_next : ins[23:8];

    // --- a branch's condition, and a transfer's target -----------------------------
    // A displacement is always the last byte, and counts from the instruction
    // after - which dispatch had already, as the pc it moved on to.  An
    // absolute target is bytes 1 and 2; a register's is the left operand.
    //
    // `call lr` IS THE EXCEPTION: its semantics are `lr = pc; pc = R[a]`, in
    // that order, so it goes to the NEW lr - the next instruction - and not the
    // register's old value, which is what `aq` holds.
    wire [2:0] ccode;
    wire       cneg, cmask;
    cond cu (.insn(ins), .src(d_cond), .code(ccode), .neg(cneg), .mask(cmask));
    wire [7:0]  last    = (d_len == 2'd2) ? b1 : b2;
    wire        jreg    = (d_pcsrc == 2'd3);
    wire        calllr  = d_jump & d_wen & jreg & (an == 3'd7);
    wire [15:0] tgt     = (d_pcsrc == 2'd2) ? ins[23:8]
                        : calllr            ? d_next
                        :                     d_next + {{8{last[7]}}, last};

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
    // --- a memory instruction's registers, in the order of their addresses ------
    // The first is the destination field: a load's rd, a store's rs, a block
    // move's first register.  A push stores downward, so its registers lie in
    // memory the other way round, the last one lowest.
    wire [2:0] rb_ = ins[13:11], rc_ = {ins[15:14], ins[0]};
    wire [2:0] ml0_d = !d_mpush ? wn : (d_mn == 2'd3) ? rc_ : (d_mn == 2'd2) ? rb_ : wn;
    wire [2:0] ml1_d = !d_mpush ? rb_ : (d_mn == 2'd3) ? rb_ : wn;
    wire [2:0] ml2_d = !d_mpush ? rc_ : wn;
    wire [2:0] mN_d  = d_mw2 ? {d_mn, 1'b0} : {1'b0, d_mn};   // bytes: 1, 2, 4 or 6
    wire [15:0] moff_d = d_mpush ? -{13'd0, mN_d} : 16'd0;     // a push starts 2n down

    (* ram_style = "logic" *)
    logic [15:0] R [0:7];

    logic [7:0]  e_we;                // the destination in the ALU stage, one-hot
    wire  [15:0] y;

    // DECODE'S LEFT PORT IS BORROWED for a store's data: decode is empty from
    // a memory instruction's ALU cycle until the sequencer is done, and the
    // choice is made by flops, so it did not lengthen decode's paths.
    wire [2:0] kreg_b;
    wire [2:0] an_rd = (e_mem | mact) ? kreg_b : an;
    wire fwd_a = e_we[an];
    wire fwd_b = use_reg & e_we[bn];
    wire [15:0] rb = use_reg ? R[bn] : bval;

    // Everything decode hands on is dropped in a cycle that squashes: the
    // instruction in decode then is one of the three behind a taken branch.
    wire keep = d_valid & ~taken_q;
    wire mhold;                        // the sequencer holds e_op at 13

    logic [3:0]  e_op;
    logic [1:0]  e_usel;              // the fast unary operation: bval[2:1]
    logic [15:0] aq, bq;
    logic        e_cbr, e_neg, e_mask, e_ucode, e_halt, e_jump, e_jreg;
    logic [2:0]  e_code;
    logic [15:0] e_tgt;
    logic        e_mem, e_mst, e_mw2, e_mblk, e_mpush;
    logic [2:0]  e_mN, e_l0, e_l1, e_l2, e_ptr;
    logic [1:0]  e_mn;
    logic [15:0] e_moff;
    logic        e_valid;             // for the harness
    logic [15:0] e_pc;                // for the harness
    always_ff @(posedge clk) begin
        e_valid <= keep;
        aq      <= fwd_a ? y : R[an_rd];
        bq      <= fwd_b ? y : rb;
        e_usel  <= bval[2:1];
        e_we    <= (keep & d_wen) ? 8'd1 << wn : 8'd0;
        e_op    <= mhold ? 4'd13 : d_alu;
        e_cbr   <= keep & d_cbr;
        e_jump  <= keep & d_jump;
        e_jreg  <= jreg & ~calllr;
        {e_code, e_neg, e_mask} <= {ccode, cneg, cmask};
        e_tgt   <= tgt;
        e_ucode <= d_ucode & ~taken_q;
        e_mem   <= keep & d_mem;
        {e_mst, e_mw2, e_mblk, e_mpush} <= {d_mst, d_mw2, d_mblk, d_mpush};
        {e_mN, e_l0, e_l1, e_l2, e_ptr, e_mn} <= {mN_d, ml0_d, ml1_d, ml2_d, an, d_mn};
        e_moff  <= moff_d;
        e_halt  <= d_halt;
        e_pc    <= d_pc;
    end

    logic [15:0] ldq;                   // the sequencer's word: below
    pipe_alu a (.lhs(aq), .rhs(bq), .usel(e_usel), .op(e_op), .mdata(ldq), .y(y));

    // THE CONDITION HAS ITS OWN UNIT, as in rtl/cpu.sv: rtl/compare.sv's
    // subtractor reads the same operand flops as the ALU and none of its
    // result.  Its verdict is REGISTERED, so the comparison never reaches the
    // memory's address pins in the cycle it is made.  That costs a cycle on a
    // taken branch: the target dispatches two cycles after the branch's ALU
    // cycle, four after its own dispatch.
    assign jnow  = e_jump & ~taken_q;
    assign jaddr = e_jreg ? aq : e_tgt;

    wire taken;
    compare cp (.lhs(aq), .rhs(bq), .cond(e_code), .neg(e_neg), .mask(e_mask), .taken(taken));

    // The instruction in the ALU stage while taken_q is set is the first of
    // the three behind the branch, so it may neither write nor branch.
    always_ff @(posedge clk) begin
        taken_q <= ~rst & ~taken_q & e_cbr & taken;
        tgt_q   <= e_tgt;
        for (int k = 0; k < 8; k++) if ((e_we[k] & ~taken_q) | mwe[k]) R[k] <= y;
    end
    assign result = y;

    // =========================================================================
    // THE MEMORY SEQUENCER
    // =========================================================================
    // It starts in a memory instruction's ALU cycle, which computes the first
    // address into `mar` - so no adder stands in front of the address pins -
    // and then takes one cycle a byte, `mt` counting them from 1:
    //
    //     mt 1 .. N      the address is mar, which steps up by one; a store
    //                    writes the byte `wq` holds, filled the cycle before
    //     mt 2 .. N + 1  a load's byte arrives, from the lane mar[0] was, and
    //                    shifts into `ldq` - low byte first
    //     mt N           dispatch is released: mt N + 1 is the bubble that reads
    //                    the next instruction's word, which dispatches at N + 2
    //
    // AND IT WRITES REGISTERS THROUGH THE ALU: e_op is held at 13, whose result
    // is `ldq`, and `mwe` joins the write enables.  A loaded register is written
    // the cycle after its last byte arrives, while the next byte shifts in
    // behind it.  A block move's pointer is written through the same word:
    // a load's FIRST, at mt 1, with any loaded register that is the pointer
    // left unwritten - the semantics end with the pointer's own value - and a
    // store's LAST, at N + 1, so that a stored register that is the pointer is
    // still read as it was.  Every write lands before the next instruction
    // reaches decode at N + 3, so nothing needs the bypass.
    //
    // A BYTE AT A TIME, aligned or not: two bytes of a word cost two cycles,
    // which a later version may take in one.
    wire mstart = e_mem & ~taken_q;
    wire [15:0] ea   = aq + (e_mblk ? e_moff : bq);
    wire [15:0] ptrv = e_mpush ? ea : aq + {13'd0, e_mN};   // where the pointer ends

    logic       mact, mst, mw2, mblk, mlane, weq;
    logic [3:0] mt;
    logic [2:0] ml0, ml1, ml2, mpr;
    logic [7:0] wq;
    logic [15:0] mpc;

    // EVERY CONTROL IS A FLOP.  Each is a nine-step schedule, bit t - 1 for
    // step t, worked out once in the ALU cycle and shifted one place a cycle,
    // so what the step does is bit 0 of a shift register.  The register write
    // enables are a one-hot flop filled a cycle ahead.  Worked out from the
    // step counter as it went, they measured 30.99 MHz: the counter's sums and
    // compares, the enable decode, and then a global buffer, in front of the
    // register file's clock enables.
    function automatic [8:0] at(input [3:0] t);
        at = (t == 4'd0) ? 9'd0 : 9'd1 << (t - 4'd1);
    endfunction
    wire [3:0] eN   = {1'b0, e_mN};
    wire [3:0] eEnd = e_mst ? (e_mblk ? eN + 4'd1 : eN) : eN + 4'd2;
    wire [8:0] eA   = (9'd1 << eN) - 9'd1;                        // steps 1 .. N
    //  step:           a load's registers, when their last byte is in
    wire [8:0] eW0  = e_mst ? 9'd0 : at(e_mw2 ? 4'd4 : 4'd3);
    wire [8:0] eW1  = (~e_mst & e_mn >= 2'd2) ? at(4'd6) : 9'd0;
    wire [8:0] eW2  = (~e_mst & e_mn == 2'd3) ? at(4'd8) : 9'd0;
    //  a block's pointer: a load's first, a store's last
    wire [8:0] eP   = ~e_mblk ? 9'd0 : e_mst ? at(eN + 4'd1) : at(4'd1);

    logic [8:0] sA, sC, sR, sD, sW0, sW1, sW2, sP;
    assign aphase   = sA[0];
    assign mrestart = sR[0];
    wire   mcap     = sC[0];
    wire   mdone    = sD[0];
    wire   [7:0] mbyte = mlane ? hi : lo;

    // A loaded register that is the pointer is not written: the pointer's own
    // value is the one the semantics end with.
    wire sup0 = mblk & (ml0 == mpr), sup1 = mblk & (ml1 == mpr), sup2 = mblk & (ml2 == mpr);
    wire [7:0] mwe_n = mstart ? (eP[0] ? 8'd1 << e_ptr : 8'd0)
                     : ((sW0[1] & ~sup0) ? 8'd1 << ml0 : 8'd0)
                     | ((sW1[1] & ~sup1) ? 8'd1 << ml1 : 8'd0)
                     | ((sW2[1] & ~sup2) ? 8'd1 << ml2 : 8'd0)
                     | (sP[1] ? 8'd1 << mpr : 8'd0);
    logic [7:0] mwe;
    always_ff @(posedge clk) begin
        mwe <= rst ? 8'd0 : mwe_n;
        if (rst) {sA, sC, sR, sD, sW0, sW1, sW2, sP} <= '0;
        else if (mstart) begin
            sA  <= eA;
            sC  <= e_mst ? 9'd0 : eA << 1;                        // steps 2 .. N + 1
            sR  <= at(eN);
            sD  <= at(eEnd);
            {sW0, sW1, sW2, sP} <= {eW0, eW1, eW2, eP};
        end else
            {sA, sC, sR, sD, sW0, sW1, sW2, sP} <= {sA >> 1, sC >> 1, sR >> 1, sD >> 1,
                                                    sW0 >> 1, sW1 >> 1, sW2 >> 1, sP >> 1};
    end

    // e_op is 13 from the ALU cycle to the sequencer's last.
    assign mhold = mstart | (mact & ~mdone);

    // A store's next byte: byte k, in the cycle before the one that writes it -
    // the first register's low byte in the ALU cycle, and after that register
    // k / 2, half k % 2.  It is read through DECODE'S LEFT PORT, which has
    // nothing to do from a memory instruction's ALU cycle until the sequencer
    // releases dispatch.  Two ports of the sequencer's own - a word for the
    // later bytes and one for byte 0 - were 186 of its 572 LUTs; one port of
    // its own, a byte wide, still 114 more than borrowing.
    wire [2:0] kreg  = mstart ? e_l0 : (mt[2:1] == 2'd0) ? ml0 : (mt[2:1] == 2'd1) ? ml1 : ml2;
    assign kreg_b = kreg;
    wire       khalf = ~mstart & mt[0];
    wire [15:0] kword = R[an_rd];
    wire [7:0]  kbyte = khalf ? kword[15:8] : kword[7:0];

    always_ff @(posedge clk) begin
        if (rst)         mact <= 1'b0;
        else if (mstart) mact <= 1'b1;
        else if (mdone)  mact <= 1'b0;
        if (mstart) begin
            mt  <= 4'd1;
            mar <= ea;
            ldq <= ptrv;                   // a block's pointer, written from here
            {mst, mw2, mblk} <= {e_mst, e_mw2, e_mblk};
            {ml0, ml1, ml2, mpr} <= {e_l0, e_l1, e_l2, e_ptr};
            mpc <= e_pc;
            wq  <= kbyte;
            weq <= e_mst;
        end else begin
            mt  <= mt + 4'd1;
            if (aphase) begin mar <= mar + 16'd1; mlane <= mar[0]; end
            if (mcap)   ldq <= mw2 ? {mbyte, ldq[15:8]} : {8'h00, mbyte};
            wq  <= kbyte;
            weq <= mst & sA[1];            // a store writes in every address step
        end
    end
    assign mem_wdata = wq;
    assign mem_we    = weq & aphase;

    assign retire    = (e_valid & ~taken_q & ~e_mem) | mdone;
    assign retire_pc = mdone ? mpc : e_pc;

    // --- the one microcoded instruction there is --------------------------------
    // It takes effect in the ALU stage, not in decode, because a halt just
    // behind a taken branch reaches decode before the branch is decided.
    always_ff @(posedge clk)
        if (rst) begin halted <= 1'b0; trapped <= 1'b0; end
        else if (e_ucode & ~taken_q) begin halted <= e_halt; trapped <= ~e_halt; end

endmodule
