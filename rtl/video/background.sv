// =============================================================================
// background.sv - the background pixel generator
// =============================================================================
//
// Hand written; see docs/vga.md, "Background", for the design this implements.
//
// One scan line of background: 640 columns from the line's `background_color`
// pointer, at 1, 2, 3, 4 or 8 bits per pixel, each pixel 1 to 8 columns wide
// (3 bpp at even widths only).
// The output is a byte in the 8-bit pixel format, ready for the fg/bg mux: an
// 8 bpp pixel is its byte, and a smaller one is a palette index with a fixed
// prefix per depth -
//
//     4 bpp  000 0pppp   entries  0-15
//     3 bpp  000 10ppp   entries 16-23
//     2 bpp  000 110pp   entries 24-27
//     1 bpp  000 1110p   entries 28-29
//
// NO FIFO: THE READS ARE A FIXED SCHEDULE.  Words are 16 bits, pixels least
// significant bits first, and the pointer is even.  Counting x from column 0,
// the text generator owns the even cycles and this one the odd, and a word
// arrives on `mem_rdata` the cycle after its read, as from an SPRAM.  Word 0 is
// read at x = 1 and goes straight into the shifter at the end of x = 2, so the
// shifter runs three cycles behind the columns.  Every later word is read two
// shifter cycles before its first pixel and likewise lands in the shifter the
// cycle it is needed, which is one of our cycles only if a word lasts an even
// number of cycles - always, except five pixels at an odd width, so 3 BPP IS
// ONLY SUPPORTED AT EVEN WIDTHS.  `bits_left` counts down from 16 (15 at 3
// bpp, whose bit 15 is unused) by bpp per pixel; the pixel with
// bits_left == bpp is the word's last.
//
// TIMING.  `line_start` latches the pointer and mode at any time before the
// line.  `active` is high for the 640 visible columns.  The byte for column x
// is on `pixel` LATENCY cycles after the cycle in which `active` was high for
// x; LATENCY is at least 4, three for the fetch and one for the output
// register, and the font/fg and sync pipelines are padded to the same depth.
// =============================================================================

module background #(
    parameter int LATENCY = 4
) (
    input  logic        clk,

    input  logic        line_start,  // latch ptr, bpp and width
    /* verilator lint_off UNUSEDSIGNAL */
    input  logic [14:0] ptr,         // byte address of the line's first pixel; bit 0 is ignored
    /* verilator lint_on UNUSEDSIGNAL */
    input  logic [3:0]  bpp,         // 1, 2, 3, 4 or 8
    input  logic [3:0]  width,       // 1 to 8 columns per pixel
    input  logic        active,      // one cycle per visible column

    output logic        mem_rd,      // read mem_addr this cycle
    output logic [13:0] mem_addr,    // word address
    input  logic [15:0] mem_rdata,   // the word read in the previous cycle

    output logic [7:0]  pixel
);

    // --- the line's mode, latched at line_start ---------------------------------
    logic [3:0] bpp_q;
    logic [2:0] wmax;                // width - 1; width 8 wraps to 7

    wire [4:0] full = bpp_q == 4'd3 ? 5'd15 : 5'd16;

    // --- where the shifter is --------------------------------------------------
    // x counts from column 0; `run` is `active` three cycles late, the columns
    // as the shifter sees them.
    logic [2:0] act_d;               // active, one to three cycles ago
    logic       odd;                 // x is odd: our cycle
    wire        run   = act_d[2];
    wire        first = active && !act_d[0];      // x = 0

    logic [15:0] sr;
    logic [4:0]  bits_left;
    logic [2:0]  wc;
    logic        pending;            // a read was issued last cycle

    wire step = run && wc == wmax;                // this cycle ends a pixel

    // The word ends two cycles from now: its last pixel ends next cycle.
    wire last_pixel  = bits_left == {1'b0, bpp_q};
    wire second_last = bits_left == {bpp_q, 1'b0};
    wire two_left = run && (wmax == 3'd0 ? second_last
                                         : last_pixel && wc == wmax - 3'd1);

    assign mem_rd = act_d[0] && !act_d[1]         // x = 1: word 0
                 || two_left && odd;

    logic [15:0] shifted;
    always_comb case (bpp_q)
        4'd1:    shifted = sr >> 1;
        4'd2:    shifted = sr >> 2;
        4'd3:    shifted = sr >> 3;
        4'd4:    shifted = sr >> 4;
        default: shifted = sr >> 8;
    endcase

    always_ff @(posedge clk) begin
        act_d   <= {act_d[1:0], active};
        odd     <= first ? 1'b1 : !odd;
        pending <= mem_rd;

        if (line_start) begin
            bpp_q    <= bpp;
            wmax     <= 3'(width - 4'd1);
            mem_addr <= ptr[14:1];
        end else if (mem_rd)
            mem_addr <= mem_addr + 14'd1;

        if (run)
            wc <= step ? 3'd0 : wc + 3'd1;
        else
            wc <= 3'd0;

        if (pending) begin
            sr        <= mem_rdata;
            bits_left <= full;
        end else if (step) begin
            sr        <= shifted;
            bits_left <= bits_left - {1'b0, bpp_q};
        end
    end

    // --- format and delay ----------------------------------------------------
    wire [7:0] fmt = bpp_q == 4'd1 ? {7'b0001110, sr[0]}
                   : bpp_q == 4'd2 ? {6'b000110,  sr[1:0]}
                   : bpp_q == 4'd3 ? {5'b00010,   sr[2:0]}
                   : bpp_q == 4'd4 ? {4'b0000,    sr[3:0]}
                   :                  sr[7:0];

    localparam int D = LATENCY - 3;
    logic [8 * D - 1:0] pipe;
    always_ff @(posedge clk)
        pipe <= (8 * D)'({pipe, fmt});
    assign pixel = pipe[8 * D - 1 -: 8];

endmodule
