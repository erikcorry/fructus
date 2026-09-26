// =============================================================================
// background.sv - the background pixel generator
// =============================================================================
//
// Hand written; see docs/vga.md, "Background", for the design this implements.
//
// One scan line of background: 640 columns from the line's `background_color`
// pointer, each pixel 1 to 8 columns wide, at the depth given by the mode
// word's 3-bit code.  The output is a byte in the 8-bit pixel format, ready
// for the fg/bg mux: an 8 bpp pixel is its byte, and a smaller one is a palette
// index, the pixel ORed into a fixed value per code -
//
//     code  bpp  index   entries
//     000    1   1110p   28-29
//     001    1   1111p   30-31
//     010    2   110pp   24-27
//     011    2   010pp    8-11
//     100    3   10ppp   16-23    even widths only
//     101    4   0pppp    0-15
//     110    8   the byte itself
//     111        spare; runs as 8 bpp
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
// THE LINE'S FIELDS COME STRAIGHT FROM ITS TABLE WORDS as they arrive: the
// pointer on the cycle `ld_ptr` is set, the depth and width on the cycle
// `ld_mode` is, both from `word`.
//
// TIMING.  `active` is high for the 640 visible columns.  The byte for column
// x is on `pixel` LATENCY cycles after the cycle in which `active` was high
// for x; LATENCY is at least 4, three for the fetch and one for the output
// register.  A larger LATENCY is made up mostly by running the whole
// generator later - delaying `active`, SHIFT flops, instead of the byte, 8 a
// cycle - by an even number of cycles, so its reads stay on odd x.  What
// SHIFT leaves over, one cycle at most, is an extra output register.
// =============================================================================

module background #(
    parameter int LATENCY = 8
) (
    input  logic        clk,

    input  logic        ld_ptr,      // `word` is the line's background_color entry
    input  logic        ld_mode,     // `word` is the line's graphics_mode entry
    /* verilator lint_off UNUSEDSIGNAL */
    input  logic [15:0] word,        // the pointer's bits 0 and 15 are ignored
    /* verilator lint_on UNUSEDSIGNAL */
    input  logic        active,      // one cycle per visible column

    output logic        mem_rd,      // read mem_addr this cycle
    output logic [13:0] mem_addr,    // word address
    input  logic [15:0] mem_rdata,   // the word read in the previous cycle

    output logic [7:0]  pixel
);

    // --- the line's mode, latched at line_start ---------------------------------
    logic [3:0] bpp;
    logic [4:0] base;                // ORed into a palette index
    always @* case (word[10:8])      // not always_comb: iverilog rejects its part select
        3'b000:  begin bpp = 4'd1; base = 5'b11100; end
        3'b001:  begin bpp = 4'd1; base = 5'b11110; end
        3'b010:  begin bpp = 4'd2; base = 5'b11000; end
        3'b011:  begin bpp = 4'd2; base = 5'b01000; end
        3'b100:  begin bpp = 4'd3; base = 5'b10000; end
        3'b101:  begin bpp = 4'd4; base = 5'b00000; end
        default: begin bpp = 4'd8; base = 5'b00000; end
    endcase

    logic [3:0] bpp_q;
    logic [4:0] base_q;
    logic [2:0] wmax;                // width - 1; width 8 wraps to 7

    wire [4:0] full = bpp_q == 4'd3 ? 5'd15 : 5'd16;

    // --- running late ---------------------------------------------------------------
    localparam int SHIFT = (LATENCY - 4) / 2 * 2;
    localparam int D     = LATENCY - 3 - SHIFT;   // output registers, 1 or 2
    logic act_in;                    // `active`, SHIFT cycles late
    if (SHIFT == 0) begin : g_now
        assign act_in = active;
    end else begin : g_late
        logic [SHIFT - 1:0] late;
        always_ff @(posedge clk) late <= SHIFT'({late, active});
        assign act_in = late[SHIFT - 1];
    end

    // --- where the shifter is --------------------------------------------------
    // x counts from the late column 0; `run` is `act_in` three cycles later,
    // the columns as the shifter sees them.
    logic [2:0] act_d;               // act_in, one to three cycles ago
    logic       odd;                 // x is odd: our cycle
    wire        run   = act_d[2];
    wire        first = act_in && !act_d[0];      // x = 0

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
        act_d   <= {act_d[1:0], act_in};
        odd     <= first ? 1'b1 : !odd;
        pending <= mem_rd;

        if (ld_mode) begin
            bpp_q    <= bpp;
            base_q   <= base;
            wmax     <= word[13:11];
        end
        if (ld_ptr)
            mem_addr <= word[14:1];
        else if (mem_rd)
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
    wire [4:0] mask = bpp_q == 4'd1 ? 5'b00001
                    : bpp_q == 4'd2 ? 5'b00011
                    : bpp_q == 4'd3 ? 5'b00111
                    :                  5'b01111;
    wire [7:0] fmt  = bpp_q == 4'd8 ? sr[7:0] : {3'b000, base_q | sr[4:0] & mask};

    logic [8 * D - 1:0] pipe;
    always_ff @(posedge clk)
        pipe <= (8 * D)'({pipe, fmt});
    assign pixel = pipe[8 * D - 1 -: 8];

endmodule
