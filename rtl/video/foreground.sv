// =============================================================================
// foreground.sv - the text generator: glyph bits and foreground colours
// =============================================================================
//
// Hand written; see docs/vga.md, "Line tables" and "Fonts", for the design this
// implements.
//
// One scan line of text: 80 cells of 8 columns, or with `dbl` 40 cells of 16,
// each glyph bit shown twice.  For every column the output is the glyph bit,
// `fg_on`, and the cell's foreground colour, `fg_color`, a byte in the 8-bit
// pixel format; the fg/bg mux shows `fg_color` where `fg_on` is set and the
// background elsewhere.  `off`, the mode word's text disable, clears `fg_on`.
//
// THREE BYTE READS PER CELL, ON A FIXED SCHEDULE.  Counting x from column 0,
// this generator owns the even cycles and the background the odd.  A read's
// word arrives on `mem_rdata` the cycle after, and the byte is picked from it
// by the address's bit 0, so any pointer may be odd.  At the cell's phase
// (x mod 8, or x mod 16 with `dbl`) -
//
//     0  read the character code at char_ptr++
//     1  its glyph byte's address:  0x1000 + (font_line << 5) + code
//     2  read the glyph byte
//     4  read the foreground colour at color_ptr++
//     7  glyph and colour move to the output stage
//
// THE MOVE IS AT PHASE 7 IN BOTH WIDTHS, so the cell is shown from 8 cycles
// after its first column either way: column c appears at c + 8 whether cells
// are 8 or 16 wide, and the latency does not depend on the mode.  A doubled
// cell is still showing its last 8 columns while the next cell's reads happen,
// which is why the glyph and colour wait in their own registers until phase 7.
//
// A glyph byte's bit 7 is its leftmost pixel.
//
// TIMING.  `line_start` latches the pointers and mode at any time before the
// line.  `active` is high for the 640 visible columns.  `fg_on` and `fg_color`
// for column x are out LATENCY cycles after the cycle in which `active` was
// high for x; LATENCY is at least 9, eight to the output stage and one for the
// output register.  rtl/video/background.sv runs at the same LATENCY.
// =============================================================================

module foreground #(
    parameter int LATENCY = 9
) (
    input  logic        clk,

    input  logic        line_start,  // latch the pointers and mode
    input  logic [14:0] char_ptr,    // byte address of the line's character codes
    input  logic [14:0] color_ptr,   // byte address of the line's foreground colours
    input  logic [7:0]  font_line,
    input  logic        dbl,         // 40 columns of 16-pixel cells
    input  logic        off,         // text disabled
    input  logic        active,      // one cycle per visible column

    output logic        mem_rd,      // read mem_addr this cycle
    output logic [13:0] mem_addr,    // word address
    input  logic [15:0] mem_rdata,   // the word read in the previous cycle

    output logic        fg_on,
    output logic [7:0]  fg_color
);

    // --- the line, latched at line_start ------------------------------------------
    logic [14:0] cp, kp;             // character and colour byte pointers
    logic [14:0] font_base;
    logic        dbl_q, off_q;

    // --- where the cell is ---------------------------------------------------
    logic [3:0] ph;                  // x mod 16
    logic [7:0] act_d;               // active, one to eight cycles ago
    wire        first = active && !act_d[0];      // x = 0
    wire [3:0]  x16   = first ? 4'd0 : ph;
    wire [3:0]  phase = dbl_q ? x16 : {1'b0, x16[2:0]};
    wire        show  = act_d[7];                 // the column 8 cycles ago

    // --- reads ---------------------------------------------------------------
    logic [14:0] gaddr;              // the glyph byte's address
    wire rd_char  = active && phase == 4'd0;
    wire rd_glyph = active && phase == 4'd2;
    wire rd_color = active && phase == 4'd4;
    wire [14:0] addr = rd_char ? cp : rd_glyph ? gaddr : kp;

    assign mem_rd   = rd_char || rd_glyph || rd_color;
    assign mem_addr = addr[14:1];

    logic       lane;                // bit 0 of the last read's address
    wire [7:0]  byte_in = lane ? mem_rdata[15:8] : mem_rdata[7:0];

    // --- the cell waiting, and the cell showing ------------------------------------
    logic [7:0] glyph_next, color_next;
    logic [7:0] glyph, color;

    always_ff @(posedge clk) begin
        act_d <= {act_d[6:0], active};
        ph    <= x16 + 4'd1;
        lane  <= addr[0];

        if (line_start) begin
            cp        <= char_ptr;
            kp        <= color_ptr;
            font_base <= 15'h1000 + {2'b00, font_line, 5'b00000};
            dbl_q     <= dbl;
            off_q     <= off;
        end else begin
            if (rd_char)  cp <= cp + 15'd1;
            if (rd_color) kp <= kp + 15'd1;
        end

        if (active && phase == 4'd1) gaddr      <= font_base + {7'b0, byte_in};
        if (active && phase == 4'd3) glyph_next <= byte_in;
        if (active && phase == 4'd5) color_next <= byte_in;

        if (active && phase == 4'd7) begin
            glyph <= glyph_next;
            color <= color_next;
        end else if (!dbl_q || x16[0])
            glyph <= glyph << 1;
    end

    // --- out -----------------------------------------------------------------
    localparam int D = LATENCY - 8;
    logic [9 * D - 1:0] pipe;
    always_ff @(posedge clk)
        pipe <= (9 * D)'({pipe, show && !off_q && glyph[7], color});
    assign {fg_on, fg_color} = pipe[9 * D - 1 -: 9];

endmodule
