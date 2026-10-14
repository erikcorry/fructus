// =============================================================================
// usb.sv - a low-speed USB host port, for a keyboard or a mouse
// =============================================================================
//
// AN OPTION OF THE SYSTEM'S, built with FRUCTUS_USB: tools/fpga-system.sv
// instantiates it and maps its three words into the I/O page.  Written by
// hand.
//
// THE BITS ARE HARDWARE AND EVERYTHING ELSE IS SOFTWARE.  This does what
// happens once a bit - NRZI, bit stuffing, SYNC's alignment, the end of a
// packet, the 1 ms keep-alive - and what has a deadline shorter than an
// interrupt: the turnaround to an ACK, and the CRC that decides whether to
// send it.  Tokens, their CRC5s, setup packets, data toggles, enumeration and
// the HID reports are the processor's, a byte an interrupt: a byte on the
// line is about 134 of its cycles, and the byte waiting behind the one on the
// line gives a handler all of them.
//
// LOW SPEED: 1.5 Mbit/s, J is D- high, K is D+ high, and a byte goes low bit
// first.  A bit is a carry out of a phase accumulator, ACC bits wide, that
// adds INC every clock: 61 in 10 bits is 1.4997 Mbit/s at 25.175 MHz, and
// 1.4967 at 25.125.  The receiver sets the accumulator to half way at every
// edge it sees, so it samples each bit in its middle, whatever the device's
// clock.
//
// TRANSMITTING.  A byte stored to the data register waits in `hold' until the
// shift register takes it; bit 8 of the store says it is the packet's last.
// So software sends SYNC itself, as the byte 0x80, then the PID and the rest;
// the hardware stuffs a 0 after six 1s - also after the last byte, where the
// rule still applies - and ends the packet with two bits of SE0 and one of J
// before it lets go of the line.  If the shift register finds `hold' empty
// before a last byte, the packet ends there anyway, a short packet the device
// will drop for its CRC, and `error' says so.
//
// RECEIVING.  The line going to K starts a packet.  The SYNC byte is not
// delivered; the PID and every byte after it is, at the data register, with
// `received' set until a load takes it - and `error' if the next one arrived
// first.  SE0 sampled in a bit's middle ends the packet: `eop' is set, and
// `crc_ok' says whether everything after the PID - the data and its CRC16 -
// left the CRC's register at the residue 0x800d.  For a handshake, which has
// no CRC, it means nothing.
//
// THE ACK.  The host must start its ACK within 7.5 bit times of the device's
// EOP, which is shorter than an interrupt can promise.  So a handler that has
// seen a DATA PID stores 0x80, the ACK's SYNC, and sets `arm' in the control
// word: the byte waits in `hold' through the rest of the packet, and at its
// EOP goes two bits later - if the CRC was good.  If it was not, `hold' is
// emptied and no ACK goes, so the device sends the same data again with the
// same toggle, and nothing is lost.  The handler stores 0xd2 | 0x100, the PID
// as the last byte, when `hold' empties behind the SYNC.
//
// TIME.  A frame counter counts 1500 bits, 1 ms; at each it sets `frame',
// and with `keepalive' on sends a bare EOP - the low-speed keep-alive,
// without which a device suspends after 3 ms - as soon as the bus is idle and
// no answer is awaited.  A byte stored meanwhile waits for it.  `timeout'
// says nothing started arriving within 20 bits of a packet sent.  `reset'
// in the control word holds the line at SE0, which is a bus reset if held 10
// ms - ten frames.  The status word has the line itself, for finding a device.
//
// FIVE INTERRUPTS ON ONE LINE, each with its enable in the control word:
// `hold' empty, a byte received, `eop', `timeout' and `frame'.  All levels.
// eop, timeout, frame and error are cleared by writing 1s to them in the
// status word.
//
// A STORE IN THE CYCLE THE SHIFT REGISTER TAKES `hold' is the next byte:
// the shift register gets the old one, and `hold' stays full.
//
// HALF DUPLEX, so the transmitter and receiver share the shift register, its
// bit count, the count of 1s and the line's last level.
// =============================================================================

module usb #(parameter int ACC = 10, parameter logic [ACC-1:0] INC = 10'd61,
             parameter logic [10:0] FRAME = 11'd1500) (
    input  logic        clk,
    input  logic        rst,
    // The processor's accesses, decoded by the system a cycle after its write.
    input  logic        wr_data,      // bits 7:0 a byte to send, bit 8: the last
    input  logic        wr_status,    // 1s clear eop, timeout, frame and error
    input  logic        wr_ctrl,      // the enables, keepalive, reset, arm, flush
    input  logic [15:0] wword,
    input  logic        rd_data,      // a load took rx_byte
    output logic  [7:0] rx_byte,
    output logic [15:0] status,
    output logic        irq,
    input  logic        dp_in, dm_in,
    output logic        dp_out, dm_out, oe
);
    initial begin dp_out = 1'b0; dm_out = 1'b0; oe = 1'b0; end

    // --- the control word ----------------------------------------------------------
    // 0 hold empty  1 received  2 eop  3 timeout  4 frame: the interrupts'
    // enables.  5 keepalive, 6 reset (SE0).  7 arm: a 1 sets it, and the next
    // EOP clears it.  8 flush: empties hold and clears arm.
    logic ie_tx = 1'b0, ie_rx = 1'b0, ie_eop = 1'b0, ie_tmo = 1'b0, ie_frame = 1'b0;
    logic ka_en = 1'b0, force_se0 = 1'b0;

    // --- the line --------------------------------------------------------------------
    // Two flops each, and a third to see an edge.
    logic [2:0] dps = 3'b000, dms = 3'b000;
    always_ff @(posedge clk) begin dps <= {dps[1:0], dp_in}; dms <= {dms[1:0], dm_in}; end
    wire dp = dps[1], dm = dms[1];
    wire se0 = !dp && !dm;
    wire edge_seen = (dps[2] ^ dps[1]) | (dms[2] ^ dms[1]);

    // --- the bit clock -----------------------------------------------------------------
    localparam int T_IDLE = 0, T_DATA = 1, T_SE0A = 2, T_SE0B = 3, T_J = 4;
    localparam int R_IDLE = 0, R_DATA = 1, R_EOP = 2;
    logic [2:0] ts = T_IDLE;
    logic [1:0] rs = R_IDLE;
    logic [ACC-1:0] acc = '0;
    logic tick = 1'b0;
    wire  txing = ts != T_IDLE;
    always_ff @(posedge clk)
        if (!txing && edge_seen) {tick, acc} <= {1'b0, 1'b1, {(ACC-1){1'b0}}};
        else                     {tick, acc} <= acc + INC;

    // --- the shared state ----------------------------------------------------------------
    logic [7:0]  sh;                    // the byte going out, or coming in
    logic [2:0]  bc;                    // its bits so far
    logic [2:0]  ones;                  // 1s in a row, for the stuffing
    logic        lvl = 1'b0;            // the line's level: 0 J, 1 K
    logic [7:0]  hold;
    logic        hold_last, tlast, ending, kaq;
    logic        tx_full = 1'b0, arm = 1'b0;
    logic        rx_full = 1'b0, eop = 1'b0, crc_ok = 1'b0, timeout = 1'b0;
    logic        frame = 1'b0, error = 1'b0, ka_pend = 1'b0;
    logic [1:0]  nbyte;                 // 0 SYNC, 1 the PID, 2 under the CRC
    logic [15:0] crc;
    logic [1:0]  gap = 2'd0;            // bits still to wait after an EOP
    logic [4:0]  tmo = 5'd0;            // bits since a packet went, 0 when not waiting
    logic [10:0] fc = 11'd0;

    wire rbit = dp == lvl;              // NRZI: no change is a 1
    wire [7:0] rnext = {rbit, sh[7:1]};
    wire ka_go = ka_pend && !txing && rs == R_IDLE && !arm && tmo == 5'd0 && !force_se0;
    wire tx_go = tx_full && !txing && rs == R_IDLE && !arm && gap == 2'd0 && !ka_pend
                 && !force_se0;

    always_ff @(posedge clk) begin
        if (rst) begin
            ts <= T_IDLE; rs <= R_IDLE; tx_full <= 1'b0; arm <= 1'b0; rx_full <= 1'b0;
            eop <= 1'b0; timeout <= 1'b0; frame <= 1'b0; error <= 1'b0; ka_pend <= 1'b0;
            gap <= 2'd0; tmo <= 5'd0; fc <= 11'd0; lvl <= 1'b0;
            ie_tx <= 1'b0; ie_rx <= 1'b0; ie_eop <= 1'b0; ie_tmo <= 1'b0; ie_frame <= 1'b0;
            ka_en <= 1'b0; force_se0 <= 1'b0;
        end else begin
            // The processor's.  A byte stored replaces one still waiting.
            if (wr_data) begin hold <= wword[7:0]; hold_last <= wword[8]; tx_full <= 1'b1; end
            if (wr_status) begin
                if (wword[3]) eop <= 1'b0;
                if (wword[5]) timeout <= 1'b0;
                if (wword[6]) frame <= 1'b0;
                if (wword[7]) error <= 1'b0;
            end
            if (wr_ctrl) begin
                {force_se0, ka_en, ie_frame, ie_tmo, ie_eop, ie_rx, ie_tx} <= wword[6:0];
                if (wword[7]) arm <= 1'b1;
                if (wword[8]) begin arm <= 1'b0; tx_full <= 1'b0; end
            end
            if (rd_data) rx_full <= 1'b0;

            // The frame, a bit at a time.
            if (tick) begin
                fc <= fc == FRAME - 11'd1 ? 11'd0 : fc + 11'd1;
                if (fc == FRAME - 11'd1) begin frame <= 1'b1; ka_pend <= ka_en; end
                if (gap != 2'd0) gap <= gap - 2'd1;
                if (tmo != 5'd0) begin
                    tmo <= tmo == 5'd20 ? 5'd0 : tmo + 5'd1;
                    if (tmo == 5'd20) timeout <= 1'b1;
                end
            end

            // --- the transmitter -------------------------------------------------
            if (ka_go) begin
                ts <= T_SE0A; kaq <= 1'b1; ka_pend <= 1'b0;
            end else if (tx_go) begin
                ts <= T_DATA; kaq <= 1'b0; lvl <= 1'b0;
                sh <= hold; tlast <= hold_last; tx_full <= wr_data;
                bc <= 3'd0; ones <= 3'd0; ending <= 1'b0;
            end else if (tick) case (ts)
                T_DATA:
                    if (ones == 3'd6) begin lvl <= !lvl; ones <= 3'd0; end   // stuffed
                    else if (ending) ts <= T_SE0A;
                    else begin
                        if (!sh[0]) begin lvl <= !lvl; ones <= 3'd0; end
                        else ones <= ones + 3'd1;
                        sh <= {1'b0, sh[7:1]};
                        bc <= bc + 3'd1;
                        if (bc == 3'd7) begin
                            if (tlast) ending <= 1'b1;
                            else if (tx_full) begin
                                sh <= hold; tlast <= hold_last; tx_full <= wr_data;
                            end else begin ending <= 1'b1; error <= 1'b1; end
                        end
                    end
                T_SE0A: ts <= T_SE0B;
                T_SE0B: begin ts <= T_J; lvl <= 1'b0; end
                T_J: begin
                    ts <= T_IDLE;
                    if (!kaq) tmo <= 5'd1;          // an answer may follow
                end
                default: ts <= T_IDLE;
            endcase

            // --- the receiver ----------------------------------------------------
            if (!txing) case (rs)
                R_IDLE:
                    if (dp && !dm && !force_se0) begin
                        rs <= R_DATA; lvl <= 1'b0; bc <= 3'd0; ones <= 3'd0;
                        nbyte <= 2'd0; crc <= 16'hffff; tmo <= 5'd0;
                    end
                R_DATA:
                    if (tick) begin
                        if (se0) begin
                            rs <= R_EOP; eop <= 1'b1;
                            crc_ok <= crc == 16'h800d;
                            if (arm) begin
                                arm <= 1'b0;
                                if (crc != 16'h800d) tx_full <= 1'b0;
                            end
                        end else begin
                            lvl <= dp;
                            if (ones == 3'd6) ones <= 3'd0;             // stuffed: dropped
                            else begin
                                ones <= rbit ? ones + 3'd1 : 3'd0;
                                sh <= rnext;
                                bc <= bc + 3'd1;
                                if (nbyte == 2'd2)
                                    crc <= {crc[14:0], 1'b0} ^ (rbit ^ crc[15] ? 16'h8005 : 16'h0);
                                if (bc == 3'd7) begin
                                    if (nbyte != 2'd2) nbyte <= nbyte + 2'd1;
                                    if (nbyte != 2'd0) begin
                                        rx_byte <= rnext;
                                        if (rx_full && !rd_data) error <= 1'b1;
                                        rx_full <= 1'b1;
                                    end
                                end
                            end
                        end
                    end
                R_EOP:
                    if (dm && !dp) begin rs <= R_IDLE; gap <= 2'd2; end
                default: rs <= R_IDLE;
            endcase
        end
    end

    // The pins from flops, so they never glitch.
    wire drive_se0 = force_se0 || ts == T_SE0A || ts == T_SE0B;
    always_ff @(posedge clk) begin
        oe     <= force_se0 || txing;
        dp_out <= !drive_se0 && lvl;
        dm_out <= !drive_se0 && !lvl;
    end

    assign status = {5'd0, arm, dm, dp, error, frame, timeout, crc_ok, eop, rx_full, tx_full, txing};
    assign irq    = ie_tx & !tx_full | ie_rx & rx_full | ie_eop & eop | ie_tmo & timeout
                  | ie_frame & frame;

endmodule
