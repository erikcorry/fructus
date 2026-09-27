// =============================================================================
// foreground.sv - the text generator: glyph bits and foreground colours
// =============================================================================
//
// Hand written; see docs/vga.md, "Line tables" and "Fonts", for the design this
// implements.
//
// One scan line of text: 80 cells of 8 columns from a font a byte wide, or
// with `wide` 40 cells of 16 from a font a 16-bit word wide.  For every column
// the output is the glyph bit,
// `fg_on`, and the cell's foreground colour, `fg_color`, a byte in the 8-bit
// pixel format; the fg/bg mux shows `fg_color` where `fg_on` is set and the
// background elsewhere.  `off`, the mode word's text disable, clears `fg_on`.
//
// THREE BYTE READS PER CELL, ON A FIXED SCHEDULE.  Counting x from column 0,
// this generator owns the even cycles and the background the odd.  A read's
// word arrives on `mem_rdata` the cycle after, and the byte is picked from it
// by the address's bit 0, so any pointer may be odd.  At the cell's phase
// (x mod 8, or x mod 16 with `wide`) -
//
//     0  read the character code at char_ptr++
//     1  its glyph row's address:   font + (font_line << 6) + code, or with
//                                   `wide` font + (font_line << 7) + 2 code + 1
//     2  read the glyph row
//     4  read the foreground colour at color_ptr++
//     6  glyph and colour move to the output stage
//
// THE MOVE IS AT PHASE 6 IN BOTH WIDTHS, the first cycle after the colour has
// arrived, so the cell is shown from 7 cycles after its first column either
// way: column c appears at c + 7 whether cells are 8 or 16 wide, and the
// latency does not depend on the mode.  A wide cell is still showing its last
// 9 columns while the next cell's reads happen, which is why the glyph and
// colour wait in their own registers until phase 6.
//
// A WIDE GLYPH ROW IS ONE ALIGNED 16-BIT WORD, read in the same slot as a
// byte-wide one.  Its address is 2 code + 1 past the font base: the word at
// 2 code, and the + 1 sets the byte lane so that the existing lane select
// hands over its HIGH byte.  The glyph registers are 16 bits and always take
// that byte above the word's low byte, so a wide row arrives whole, high byte
// leftmost, and a byte-wide row arrives as its byte followed by eight bits
// that are never shown.  So the one mux the wide font costs is the code's
// place in the address add; the glyph shifts once a column in either mode,
// where the doubling it replaces had to shift every other.
//
// A glyph row's top bit - bit 7 of a byte, bit 15 of a word - is its leftmost
// pixel.
//
// THE LINE'S FIELDS COME STRAIGHT FROM ITS TABLE WORDS as they arrive on
// `word`: font_line, width and disable on `ld_mode`, the character pointer
// on `ld_char`, the colour pointer on `ld_color`.
//
// TIMING.  `active` is high for the 640 visible columns.  `fg_on` and `fg_color`
// for column x are out LATENCY cycles after the cycle in which `active` was
// high for x; LATENCY is at least 8, seven to the output stage and one for the
// output register.  The other generators run at the same LATENCY.
// =============================================================================

module foreground #(
    parameter int LATENCY = 8
) (
    input  logic        clk,

    input  logic        ld_mode,     // `word` is the line's graphics_mode entry
    input  logic        ld_char,     // `word` is its character_data entry
    input  logic        ld_color,    // `word` is its character_color entry
    input  logic [14:0] font,        // the font's address; even for a 16-pixel font
    input  logic [15:0] word,
    input  logic        active,      // one cycle per visible column

    output logic        mem_rd,      // read mem_addr this cycle
    output logic [13:0] mem_addr,    // word address
    output logic        mem_turn,    // an even column: mem_addr is ours if anyone's
    input  logic [15:0] mem_rdata,   // the word read in the previous cycle

    output logic        fg_on,
    output logic [7:0]  fg_color
);

    // --- the line, from its table words ---------------------------------------------
    logic [14:0] cp, kp;             // character and colour byte pointers
    logic [14:0] font_base;
    logic        wide_q, off_q;

    // --- where the cell is ---------------------------------------------------
    // `ph` IS HELD AT 0 WHILE THE GENERATOR IS IDLE - `active` low and the last
    // cell shown - so it is 0 at column 0 without a test for the line's first
    // column.  That needs 8 idle cycles between lines, which any legal timing
    // has: the blanking is at least 11 (see rtl/video/video.sv).
    logic [3:0] ph;                  // x mod 16
    logic [6:0] act_d;               // active, one to seven cycles ago
    wire [3:0]  x16   = ph;
    wire [3:0]  phase = wide_q ? x16 : {1'b0, x16[2:0]};
    wire        show  = act_d[6];                 // the column 7 cycles ago

    // --- reads ---------------------------------------------------------------
    // THE ADDRESS IS CHOSEN BY THE COLUMN, NOT BY THE READ.  The reads fall at
    // phases 0, 2 and 4, which are ph[2:1] = 0, 1 and 2 in either width, so the
    // pointer is picked by two flops and nothing else; at any other phase it is
    // not read and does not matter.  Picking it with rd_char and rd_glyph put
    // the width mux and the phase compares in front of the SPRAM's address
    // pins, the longest path in the display.  `mem_turn` is the same idea for
    // rtl/video/video.sv's choice between the generators.
    logic [14:0] gaddr;              // the glyph row's address
    wire rd_char  = active && phase == 4'd0;
    wire rd_glyph = active && phase == 4'd2;
    wire rd_color = active && phase == 4'd4;
    wire [14:0] addr = ph[2:1] == 2'd0 ? cp : ph[2:1] == 2'd1 ? gaddr : kp;

    assign mem_rd   = rd_char || rd_glyph || rd_color;
    assign mem_addr = addr[14:1];
    assign mem_turn = active && !ph[0];

    logic       lane;                // bit 0 of the last read's address
    wire [7:0]  byte_in = lane ? mem_rdata[15:8] : mem_rdata[7:0];

    // --- the cell waiting, and the cell showing ------------------------------------
    logic [15:0] glyph_next, glyph;  // the row, leftmost pixel in bit 15
    logic [7:0]  color_next, color;

    always_ff @(posedge clk) begin
        act_d <= {act_d[5:0], active};
        ph    <= active || act_d != 7'd0 ? ph + 4'd1 : 4'd0;
        lane  <= addr[0];

        if (ld_mode) begin
            // THE FONT IS A REGISTER holding its address, and font_line counts
            // 64-byte steps from it - 128-byte for a 16-pixel font, whose rows
            // are twice as long, so that one font_line serves a font of either
            // width and 256 glyphs reach 64 rows in both.  font_line's low six
            // bits are zero, so the add is nine bits wide and font's low six
            // pass straight through.  The width comes straight from the word,
            // since wide_q loads at this same edge.
            font_base <= font + (word[14] ? {word[7:0], 7'b0} : {1'b0, word[7:0], 6'b0});
            wide_q    <= word[14];
            off_q     <= word[15];
        end
        if (ld_char)       cp <= word[14:0];
        else if (rd_char)  cp <= cp + 15'd1;
        if (ld_color)      kp <= word[14:0];
        else if (rd_color) kp <= kp + 15'd1;

        if (active && phase == 4'd1)
            gaddr <= font_base + (wide_q ? {6'b0, byte_in, 1'b1} : {7'b0, byte_in});
        if (active && phase == 4'd3) glyph_next <= {byte_in, mem_rdata[7:0]};
        if (active && phase == 4'd5) color_next <= byte_in;

        if (active && phase == 4'd6) begin
            glyph <= glyph_next;
            color <= color_next;
        end else
            glyph <= glyph << 1;
    end

    // --- out -----------------------------------------------------------------
    localparam int D = LATENCY - 7;
    logic [9 * D - 1:0] pipe;
    always_ff @(posedge clk)
        pipe <= (9 * D)'({pipe, show && !off_q && glyph[15], color});
    assign {fg_on, fg_color} = pipe[9 * D - 1 -: 9];

endmodule
