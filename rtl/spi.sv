// =============================================================================
// spi.sv - a byte-wide SPI port, on the flash's pins and a header's
// =============================================================================
//
// AN OPTION OF THE SYSTEM'S, FRUCTUS_SPI in tools/fpga-system.sv: two words
// in the I/O page, [cpu.io] in isa/fructus.toml and crt/include/fructus/spi.h.
// It shares the flash's clock, data out and data in with rtl/spiboot.sv, which
// has them only while it boots, and has three chip selects: the flash's and a
// header's two.  So the running system can read the flash beyond its own
// image - the chooser's directory, crt/include/fructus/chooser.h - or program
// it, and talk to whatever is on the header.
//
// MODE 0 AT THE SYSTEM'S CLOCK, A BIT A CYCLE, AS SPIBOOT READS: `sck_on' is
// the second half of a DDR output, so the clock is high in the low half of
// each of the eight cycles a byte is on the wire.  `mosi' changes on the
// rising edge, half a cycle before the device samples it; the device changes
// `miso' on the falling one, which is the system's rising edge, and the bit is
// sampled at the edge that ends its cycle.  The flash's read, 0x03, is good to
// 33 MHz on the common parts.
//
// A BYTE STORED TO THE DATA REGISTER IS SENT, most significant bit first, and
// the eight bits the device sends meanwhile are kept.  `busy' is set from the
// cycle after the store's write to the eighth bit's: a load of the data
// register reads {busy, 7 zeros, the byte}, so `br lt, ra, #0' waits.  A byte
// stored while busy is dropped.
//
// WITH STREAM SET, A LOAD THAT FINDS BUSY CLEAR SENDS 0xff, so a read is one
// load a byte: each returns the byte before and starts the next.  A load that
// finds it busy changes nothing.  The first byte of a read is started by a
// store, since a load would return the byte before it; and the last load
// starts a byte nobody wants, which ending the chip select makes harmless.
//
// A WRITE TO THE CONTROL REGISTER ENDS ANY BYTE UNDER WAY, so a new chip
// select never starts on half a byte.  Its bits, 1 to select:
//
//     0  the flash         1  the header's CS0      2  the header's CS1
//     3  stream
//
// It is the system's to keep the flash's select off while spiboot reads; reset
// clears every select, so after a soft boot nothing is selected.
//
// Both words read through the late bit's window, as the UART's do; the control
// register has no read path and reads as the value last written.
// =============================================================================

module spi (
    input  logic        clk,
    input  logic        rst,
    input  logic        wr_data,      // a store to the data register: send wword[7:0]
    input  logic        wr_ctrl,      // a store to the control register
    input  logic [15:0] wword,
    input  logic        rd_data,      // a load of the data register, in its window
    output logic [7:0]  rx_byte,      // the last byte the device sent
    output logic        busy,         // a byte is on the wire
    output logic [2:0]  sel,          // the chip selects, 1 selected: flash, CS0, CS1
    output logic        sck_on,       // -> the clock's DDR output, its second half
    output logic        mosi,
    input  logic        miso
);
    logic       stream = 1'b0;
    logic [6:0] tx;                   // the byte's bits still to go
    logic [2:0] n;                    // and how many of them
    initial begin busy = 1'b0; sel = 3'b000; rx_byte = 8'hff; end

    wire go = !busy && (wr_data || rd_data && stream);
    assign sck_on = busy;

    always_ff @(posedge clk) begin
        if (busy) rx_byte <= {rx_byte[6:0], miso};
        if (go) begin
            {mosi, tx} <= wr_data ? wword[7:0] : 8'hff;
            n <= 3'd7;
        end else if (busy) begin
            {mosi, tx} <= {tx, 1'b1};
            n <= n - 3'd1;
        end
        if (rst || wr_ctrl)  busy <= 1'b0;
        else if (go)         busy <= 1'b1;
        else if (n == 3'd0)  busy <= 1'b0;
        if (rst) begin sel <= 3'b000; stream <= 1'b0; end
        else if (wr_ctrl) begin sel <= wword[2:0]; stream <= wword[3]; end
    end
endmodule
