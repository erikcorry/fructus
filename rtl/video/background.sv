// =============================================================================
// background.sv - the background pixel generator
// =============================================================================
//
// Hand written; see docs/vga.md, "Background" and "Memory cycles and odd start
// addresses", for the design this implements.
//
// One scan line of background: 640 columns from the line's `background_color`
// pointer, at 1, 2, 3, 4 or 8 bits per pixel, each pixel 1 to 8 columns wide.
// The output is a byte in the 8-bit pixel format, ready for the fg/bg mux: an
// 8 bpp pixel is its byte, and a smaller one is a palette index with a fixed
// prefix per depth -
//
//     4 bpp  000 0pppp   entries  0-15
//     3 bpp  000 10ppp   entries 16-23
//     2 bpp  000 110pp   entries 24-27
//     1 bpp  000 1110p   entries 28-29
//
// MEMORY.  Words are 16 bits, pixels least significant bits first.  The
// generator may read only in its own memory cycle, `slot`, and the word
// arrives on `mem_rdata` in the cycle after the read, as it does from an SPRAM.
// A two-word FIFO ahead of the shift register absorbs where the slots fall
// relative to the columns: 8 bpp at width 1 takes a word every second column,
// every slot there is.  Once the FIFO is full the generator stops asking, so it
// reads at most three words past the end of the line, and which ones depends
// only on the line, as the write-through copy requires.
//
// AN ODD POINTER DISCARDS ITS LOW BYTE AS THE FIRST WORD LOADS: the word goes
// into the shift register shifted right by 8, and the pixel count starts at
// what is left.  At 3 bpp it is 9, three pixels, because pixel 2 straddles the
// byte.  The unpacker then starts at column 0 like any other line.
//
// TIMING.  `line_start` latches the pointer and mode and starts the fetch; it
// must come AT LEAST 6 CYCLES BEFORE COLUMN 0.  The worst case is 8 bpp from
// an odd pointer with the slot falling late: word 0 is read at +2, reaches the
// shift register at +4 holding one pixel, and word 1, read at +4, is in the
// FIFO only at the end of +5 - in time for the reload at the end of column 0,
// at +6.  tests/background-check.mjs runs lines at exactly 6, and 5 fails.
//
// `active` is high for the 640 visible columns.  The byte for column x is on
// `pixel` LATENCY cycles after the cycle in which `active` was high for x; the
// font/fg and sync pipelines are padded to the same depth.
// =============================================================================

module background #(
    parameter int LATENCY = 1
) (
    input  logic        clk,

    input  logic        line_start,  // latch ptr, bpp and width; start fetching
    input  logic [14:0] ptr,         // byte address of the line's first pixel
    input  logic [3:0]  bpp,         // 1, 2, 3, 4 or 8
    input  logic [3:0]  width,       // 1 to 8 columns per pixel
    input  logic        active,      // one cycle per visible column

    input  logic        slot,        // this cycle's memory read is ours
    output logic        mem_rd,      // read mem_addr this cycle
    output logic [13:0] mem_addr,    // word address
    input  logic [15:0] mem_rdata,   // the word read in the previous cycle

    output logic [7:0]  pixel
);

    // --- the line's mode, latched at line_start ---------------------------------
    logic [3:0] bpp_q;
    logic [2:0] wmax;                // width - 1; width 8 wraps to 7
    logic       odd;

    logic [4:0] ppw;                 // pixels per word
    logic [4:0] skip;                // pixels in the low byte of an odd start
    always_comb case (bpp_q)
        4'd1:    begin ppw = 5'd16; skip = 5'd8; end
        4'd2:    begin ppw = 5'd8;  skip = 5'd4; end
        4'd3:    begin ppw = 5'd5;  skip = 5'd3; end
        4'd4:    begin ppw = 5'd4;  skip = 5'd2; end
        default: begin ppw = 5'd2;  skip = 5'd1; end
    endcase

    // --- the FIFO ------------------------------------------------------------
    logic [15:0] f0, f1;             // f0 is the head
    logic [1:0]  fcnt;
    logic        pending;            // a read was issued last cycle
    logic        fetching;

    // --- the unpacker --------------------------------------------------------
    logic [15:0] sr;
    logic [4:0]  cnt;                // pixels left in sr; 0 is empty
    logic [2:0]  wc;
    logic        first;              // the next load is the line's first word

    wire step = active && wc == wmax;                // this column ends a pixel
    wire load = fcnt != 0 && (cnt == 0 || (step && cnt == 1));
    wire push = pending;

    assign mem_rd = slot && fetching && !line_start && {1'b0, fcnt} + {2'b0, pending} < 3'd2;

    logic [15:0] shifted;
    always_comb case (bpp_q)
        4'd1:    shifted = sr >> 1;
        4'd2:    shifted = sr >> 2;
        4'd3:    shifted = sr >> 3;
        4'd4:    shifted = sr >> 4;
        default: shifted = sr >> 8;
    endcase

    always_ff @(posedge clk) begin
        if (line_start) begin
            bpp_q    <= bpp;
            wmax     <= 3'(width - 4'd1);
            odd      <= ptr[0];
            mem_addr <= ptr[14:1];
            fetching <= 1'b1;
            pending  <= 1'b0;
            fcnt     <= 2'd0;
            cnt      <= 5'd0;
            wc       <= 3'd0;
            first    <= 1'b1;
        end else begin
            pending  <= mem_rd;
            if (mem_rd)
                mem_addr <= mem_addr + 14'd1;

            case ({push, load})
                2'b10: begin
                    if (fcnt == 0) f0 <= mem_rdata; else f1 <= mem_rdata;
                    fcnt <= fcnt + 2'd1;
                end
                2'b01: begin
                    f0 <= f1;
                    fcnt <= fcnt - 2'd1;
                end
                2'b11: begin
                    if (fcnt == 1) f0 <= mem_rdata;
                    else begin f0 <= f1; f1 <= mem_rdata; end
                end
                default: ;
            endcase

            if (active)
                wc <= step ? 3'd0 : wc + 3'd1;

            if (load) begin
                first <= 1'b0;
                if (first && odd) begin
                    sr  <= bpp_q == 4'd3 ? f0 >> 9 : f0 >> 8;
                    cnt <= ppw - skip;
                end else begin
                    sr  <= f0;
                    cnt <= ppw;
                end
            end else if (step) begin
                sr  <= shifted;
                cnt <= cnt - 5'd1;
            end
        end
    end

    // --- format and delay ----------------------------------------------------
    wire [7:0] fmt = bpp_q == 4'd1 ? {7'b0001110, sr[0]}
                   : bpp_q == 4'd2 ? {6'b000110,  sr[1:0]}
                   : bpp_q == 4'd3 ? {5'b00010,   sr[2:0]}
                   : bpp_q == 4'd4 ? {4'b0000,    sr[3:0]}
                   :                  sr[7:0];

    logic [8 * LATENCY - 1:0] pipe;
    always_ff @(posedge clk)
        pipe <= (8 * LATENCY)'({pipe, fmt});
    assign pixel = pipe[8 * LATENCY - 1 -: 8];

endmodule
