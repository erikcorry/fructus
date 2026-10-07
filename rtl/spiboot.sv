// =============================================================================
// spiboot.sv - the processor's memory, filled from the SPI flash at boot
// =============================================================================
//
// THE UP5K'S SPRAM COMES UP EMPTY.  Its block RAMs are loaded with the
// bitstream - rtl/ucode.sv is one - but the SPRAMs that are the processor's
// 64 KB have no initial contents.  So after configuration, and again whenever
// `start` is held, this reads BYTES bytes from the flash the bitstream came
// from, at OFFSET, and the processor stores them at 0, 1, 2 ... with its own
// sequencer: rtl/cpu.sv's `boot`, THE BOOT LOOP there.  Then it resets the
// processor without `boot`, and the processor starts at 0 with the image in
// place.  A chooser, or anything else bigger than one image, is a program
// that image runs.
//
// ONE READ COMMAND, 0x03 and a 24-bit address, and then the flash streams for
// as long as it is clocked.  SINGLE SPI AT THE PROCESSOR'S CLOCK: `sck_en` is
// the second half of a DDR output - tools/fpga-system.sv's SB_IO - so the
// clock is high in the low half of each cycle it is on.  The flash samples
// `mosi` on that rising edge, half a cycle after the flop changed it, and
// changes `miso` on the falling one, which is the processor's rising edge, so
// `miso` is sampled a whole cycle after it changed.  0x03 is good to 33 MHz
// on the common parts, above anything this system places at.
//
// EIGHT CYCLES A BYTE, AND THE PROCESSOR'S LOOP IS EIGHT STEPS, so neither
// waits for the other: the two are put in step once, by when the processor
// leaves reset, and stay so.  Counting cycles from the first after `start`
// as 0, the command goes out in cycles 1 .. 32 and bit 7 - j of byte m is on
// `miso` in cycle 33 + 8m + j.  So byte m is whole in `sr` in cycle 41 + 8m,
// and in `byte_q` from 42 + 8m to 49 + 8m.  The processor writes byte m at
// the edge ending its cycle 8m + 5, counting from its first cycle out of
// reset; leaving reset in cycle T0 = 40 puts that write in cycle 45 + 8m, the
// middle of the eight.  64 KB takes 8 x 65536 cycles, 17 ms at 30 MHz.
//
// THE END IS A RESET.  The processor's last byte is written in cycle
// T0 + 8 BYTES - 3, and it is reset in cycle T0 + 8 BYTES, before mar - which
// wraps at 64 KB - writes another; `boot` drops a cycle later, under the
// reset, and the reset lasts long enough for the processor to take that.
// =============================================================================

module spiboot #(
    parameter logic [23:0] OFFSET = 24'h100000,  // where in the flash the image is
    parameter int          BYTES  = 65536        // how much of it: from address 0
) (
    input  logic       clk,
    input  logic       start,      // held: boot again from the top
    output logic       rst,        // -> the processor
    output logic       boot,       // -> the processor, and the memory's data pins
    output logic       on,         // -> the flash: chip select, active high, and
                                   //    the clock's falling-edge half
    output logic       mosi,
    input  logic       miso,
    output logic [7:0] byte_q      // -> the memory's data pins, while `boot`
);
    localparam int T0  = 40;               // the processor's first cycle out of reset
    localparam int END = T0 + 8 * BYTES;   // and the first it is reset again
    localparam int SPI = 32 + 8 * BYTES;   // the last cycle the flash is clocked
    localparam int W   = $clog2(END + 4);
    localparam logic [31:0] CMD = {8'h03, OFFSET};

    // Everything comes out of a flop, and so is visible the cycle after the
    // count that set it: each comparison is against the cycle wanted, less one.
    logic [W-1:0] n = '0;
    logic         done = 1'b0;
    logic [31:0]  sh = CMD;
    logic [7:0]   sr;
    initial begin rst = 1'b1; boot = 1'b1; on = 1'b0; mosi = 1'b0; end

    always_ff @(posedge clk) begin
        if (start)     begin n <= '0; done <= 1'b0; end
        else if (!done) begin n <= n + 1'b1; if (n == W'(END + 3)) done <= 1'b1; end
        on   <= ~start & ~done & (n < W'(SPI));
        sh   <= (start | done) ? CMD : {sh[30:0], 1'b0};
        mosi <= sh[31];
        sr   <= {sr[6:0], miso};
        if (n[2:0] == 3'd1) byte_q <= sr;  // cycles 41 + 8m
        rst  <= start | (~done & (n < W'(T0 - 1) | n >= W'(END - 1)));
        boot <= start | (~done & (n < W'(END)));
    end
endmodule
