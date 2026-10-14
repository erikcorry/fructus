// =============================================================================
// uart.sv - a serial line, for the USB converter most boards have
// =============================================================================
//
// AN OPTION OF THE SYSTEM'S, built with FRUCTUS_UART: tools/fpga-system.sv
// instantiates it and maps its three words into the I/O page, [cpu.io] in
// isa/fructus.toml, which has the register map.  Written by hand.
//
// EIGHT DATA BITS, NO PARITY, ONE STOP BIT, low bit first.  A bit is `div' + 1
// clocks, the divisor register, 12 bits: 217 from reset, 115200 baud at the
// system's 25.125 MHz, 0.05% fast; 2616 is 9600, and the slowest is 6134
// baud.  It must be at least 3.
//
// THE DIVISOR IS CLOCKS LESS ONE, so a counter reloads from it as it is: a
// register holding the clocks themselves put a subtractor beside each
// counter, 30 LUT4s of the 150 this took, and 16 bits rather than 12 another
// 15.
//
// THE TRANSMITTER IS A SHIFT REGISTER AND NOTHING MORE.  A byte stored while
// it is busy is dropped, so a sender waits for `busy' to clear; a holding
// register would let the next byte wait in it, but the sender would still
// wait for the line, a byte at a time, and the register would cost cells the
// system is short of.
//
// THE RECEIVER SAMPLES EACH BIT IN ITS MIDDLE: half a bit after the line
// falls, which is the start bit's middle - still low, or it was a glitch and
// is ignored - and a whole bit after each sample from then on.  The line is
// synchronised through two flops first.  A byte whose stop bit is high waits
// in `rx_byte' with `rx_full' set until a load of the data register takes it;
// one that arrives before then is lost, and says so in `overrun'.  A byte
// whose stop bit is low is a framing error, and is dropped.
//
// THE COUNTERS COUNT DOWN to zero and reload from `div', so a bit is a
// compare with zero on each side, and nothing compares with the divisor.
//
// TWO INTERRUPTS, ON ONE LINE: `received', and the transmitter idle, each
// with an enable in the status word.  Both are levels: the first holds until
// a load takes the byte, the second until a byte is stored or its enable is
// cleared - which is how a handler feeding a buffer out stops it, when the
// buffer runs dry.
// =============================================================================

module uart #(parameter logic [11:0] DIV_RESET = 12'd217) (
    input  logic        clk,
    input  logic        rst,
    // The processor's accesses, decoded by the system a cycle after its write.
    input  logic        wr_data,      // a byte stored to the data register: send it
    input  logic        wr_status,    // the status word: bits 4 and 5, the interrupts' enables
    input  logic        wr_div,       // the divisor
    input  logic [15:0] wword,        // the stored word
    input  logic        rd_data,      // a load took rx_byte
    output logic  [7:0] rx_byte,
    output logic [15:0] status,       // {10'b0, ie_tx, ie_rx, 1'b0, overrun, rx_full, busy}
    output logic        irq,          // rx_full or the transmitter idle, as enabled
    input  logic        rx_pin,
    output logic        tx_pin
);

    logic [11:0] div = DIV_RESET;
    logic        ie_rx = 1'b0, ie_tx = 1'b0;
    always_ff @(posedge clk)
        if (rst) begin
            div <= DIV_RESET;
            ie_rx <= 1'b0; ie_tx <= 1'b0;
        end else begin
            if (wr_div)    div <= wword[11:0];
            if (wr_status) begin ie_rx <= wword[4]; ie_tx <= wword[5]; end
        end

    // --- the transmitter -----------------------------------------------------------
    // tsh holds start, data and stop, and ones behind them: its bit 0 is the
    // line.  tbits is the bits still to send, zero when idle.
    logic  [9:0] tsh = 10'h3ff;
    logic  [3:0] tbits = 4'd0;
    logic [11:0] tcnt = 12'd0;
    wire         busy = tbits != 4'd0;
    always_ff @(posedge clk)
        if (rst) begin
            tsh <= 10'h3ff; tbits <= 4'd0;
        end else if (!busy) begin
            if (wr_data) begin
                tsh <= {1'b1, wword[7:0], 1'b0};
                tbits <= 4'd10;
                tcnt <= div;
            end
        end else if (tcnt == 12'd0) begin
            tsh <= {1'b1, tsh[9:1]};
            tbits <= tbits - 4'd1;
            tcnt <= div;
        end else
            tcnt <= tcnt - 12'd1;
    // The pin from a flop, so that it never glitches.
    initial tx_pin = 1'b1;
    always_ff @(posedge clk) tx_pin <= tsh[0];

    // --- the receiver ------------------------------------------------------------
    // rbits counts the samples still to take: 10 for the start bit, 9 to 2 the
    // data, 1 the stop bit; zero when idle.
    logic        rx1 = 1'b1, rx2 = 1'b1;
    logic  [3:0] rbits = 4'd0;
    logic [11:0] rcnt = 12'd0;
    logic  [7:0] rsh;
    logic        rx_full = 1'b0, overrun = 1'b0;
    wire         sample = rbits != 4'd0 && rcnt == 12'd0;
    wire         done   = sample && rbits == 4'd1 && rx2;
    always_ff @(posedge clk) begin
        rx1 <= rx_pin;
        rx2 <= rx1;
        if (rst) begin
            rbits <= 4'd0;
        end else if (rbits == 4'd0) begin
            if (!rx2) begin
                rbits <= 4'd10;
                rcnt <= {1'b0, div[11:1]};
            end
        end else if (rcnt == 12'd0) begin
            // A start bit that is high again was a glitch.
            rbits <= rbits == 4'd10 && rx2 ? 4'd0 : rbits - 4'd1;
            if (rbits != 4'd10 && rbits != 4'd1) rsh <= {rx2, rsh[7:1]};
            rcnt <= div;
        end else
            rcnt <= rcnt - 12'd1;
        // A load takes the byte; one arriving in the same cycle replaces it.
        if (rst) begin
            rx_full <= 1'b0; overrun <= 1'b0;
        end else begin
            if (rd_data) begin rx_full <= 1'b0; overrun <= 1'b0; end
            if (done) begin
                if (rx_full && !rd_data) overrun <= 1'b1;
                else begin rx_byte <= rsh; rx_full <= 1'b1; end
            end
        end
    end

    assign status = {10'd0, ie_tx, ie_rx, 1'b0, overrun, rx_full, busy};
    assign irq    = ie_rx & rx_full | ie_tx & !busy;

endmodule
