// =============================================================================
// foreground.sv - the text generator: glyph bits and foreground colours
// =============================================================================
//
// Hand written; see docs/vga.md, "Line tables" and "Fonts", for the design this
// implements.
//
// One scan line of text: 80 cells of 8 columns from a font a byte wide, or
// with `wide` 40 cells of 16 from a font a 16-bit word wide, or with `five`
// 128 cells of 5 from the byte-wide font's top five bits.  For every column
// the output is the glyph bit,
// `fg_on`, and the cell's foreground colour, `fg_color`, a byte in the 8-bit
// pixel format; the fg/bg mux shows `fg_color` where `fg_on` is set and the
// background elsewhere.  The mode word's bits 15-14 are 00 for 8 columns, 01
// for 16, 10 for 5, and 11 for text off, which clears `fg_on`.
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
// FIVE-COLUMN CELLS TAKE ODD CYCLES TOO: three reads in five columns do not
// fit in the even ones.  At x mod 5 -
//
//     1  read the character code
//     2  its glyph row's address, as for 8 columns
//     3  read the glyph row
//     4  read the foreground colour
//     6  (the next cell's 1) glyph and colour move to the output stage
//
// so the reads fall at x mod 10 = 1, 3, 4, 6, 8, 9, and the background keeps
// 5 and 7.  Its reads come every pixels-per-word × width columns, at screen
// column 5 (LATENCY 8) or 7 (LATENCY 10) to begin with, so they stay clear of
// ours only when that period is a multiple of 10: width 5 at 1, 2, 4 or 8 bpp,
// or 3 bpp at any of its widths.  Any other background shares a cycle with
// the text, which gets the port; the background's pixels are then undefined.
// The move still comes at phase 6, so the latency is the same as the others'.
//
// THE MOVE IS AT PHASE 6 IN EVERY WIDTH, the first cycle after the colour has
// arrived, so the cell is shown from 7 cycles after its first column either
// way: column c appears at c + 7 whether cells are 5, 8 or 16 wide, and the
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
    logic        wide_q, five_q, off_q;

    // --- where the cell is ---------------------------------------------------
    // `ph` and `p5` ARE HELD AT 0 WHILE THE GENERATOR IS IDLE - `active` low
    // and the last cell shown - so they are 0 at column 0 without a test for
    // the line's first column.  That needs 8 idle cycles between lines, which
    // any legal timing has: the blanking is at least 11 (see
    // rtl/video/video.sv).
    logic [3:0] ph;                  // x mod 16
    logic [2:0] p5;                  // x mod 5
    logic [6:0] act_d;               // active, one to seven cycles ago
    wire        run   = active || act_d != 7'd0;
    wire [3:0]  ph_n  = run ? ph + 4'd1 : 4'd0;
    wire [2:0]  p5_n  = run && p5 != 3'd4 ? p5 + 3'd1 : 3'd0;
    wire [3:0]  phase = wide_q ? ph : {1'b0, ph[2:0]};
    wire        show  = act_d[6];                 // the column 7 cycles ago

    // --- reads ---------------------------------------------------------------
    // THE ADDRESS IS CHOSEN BY THE COLUMN, NOT BY THE READ.  `sel` picks the
    // pointer and `own` says the cycle is ours, both flops set the cycle
    // before from the next column's phase, so that only flops and `active`
    // stand in front of the SPRAM's address pins.  At 8 and 16 columns they
    // are the next ph's bits 2:1 and its even-ness; at 5 they follow the
    // table above.  At a phase with no read the pointer does not matter.
    // Picking it with rd_char and rd_glyph put the width mux and the phase
    // compares in front of the SPRAM, the longest path in the display.
    logic [14:0] gaddr;              // the glyph row's address
    logic [1:0]  sel;                // 0 char_ptr, 1 the glyph row, 2 color_ptr
    logic        own;                // this column's memory cycle is ours
    wire rd_char  = active && (five_q ? p5 == 3'd1 : phase == 4'd0);
    wire rd_glyph = active && (five_q ? p5 == 3'd3 : phase == 4'd2);
    wire rd_color = active && (five_q ? p5 == 3'd4 : phase == 4'd4);
    wire [14:0] addr = sel == 2'd0 ? cp : sel == 2'd1 ? gaddr : kp;

    assign mem_rd   = rd_char || rd_glyph || rd_color;
    assign mem_addr = addr[14:1];
    assign mem_turn = active && own;

    logic       lane;                // bit 0 of the last read's address
    wire [7:0]  byte_in = lane ? mem_rdata[15:8] : mem_rdata[7:0];

    // --- the cell waiting, and the cell showing ------------------------------------
    logic [15:0] glyph_next, glyph;  // the row, leftmost pixel in bit 15
    logic [7:0]  color_next, color;

    // WHAT FOLLOWS A READ IS TIMED BY THE READ: the glyph address the cycle
    // after the code's, the glyph and colour as they arrive, and the move to
    // the output stage the cycle after the colour, in every width.  At 5
    // columns the last cell's move is after `active` ends.
    logic got_char, got_glyph, got_color, move;

    always_ff @(posedge clk) begin
        act_d <= {act_d[5:0], active};
        ph    <= ph_n;
        p5    <= p5_n;
        sel   <= five_q ? (p5_n == 3'd1 ? 2'd0 : p5_n == 3'd3 ? 2'd1 : 2'd2) : ph_n[2:1];
        own   <= five_q ? p5_n == 3'd1 || p5_n == 3'd3 || p5_n == 3'd4 : !ph_n[0];
        lane  <= addr[0];

        got_char  <= rd_char;
        got_glyph <= rd_glyph;
        got_color <= rd_color;
        move      <= got_color;

        if (ld_mode) begin
            // THE FONT IS A REGISTER holding its address, and font_line counts
            // 64-byte steps from it - 128-byte for a 16-pixel font, whose rows
            // are twice as long, so that one font_line serves a font of either
            // width and 256 glyphs reach 64 rows in both.  font_line's low six
            // bits are zero, so the add is nine bits wide and font's low six
            // pass straight through.  The width comes straight from the word,
            // since wide_q loads at this same edge.  Five columns use the
            // 8-column font as it is.
            font_base <= font + (word[14] ? {word[7:0], 7'b0} : {1'b0, word[7:0], 6'b0});
            wide_q    <= word[14];
            five_q    <= word[15] && !word[14];
            off_q     <= word[15] && word[14];
        end
        if (ld_char)       cp <= word[14:0];
        else if (rd_char)  cp <= cp + 15'd1;
        if (ld_color)      kp <= word[14:0];
        else if (rd_color) kp <= kp + 15'd1;

        if (got_char)
            gaddr <= font_base + (wide_q ? {6'b0, byte_in, 1'b1} : {7'b0, byte_in});
        if (got_glyph) glyph_next <= {byte_in, mem_rdata[7:0]};
        if (got_color) color_next <= byte_in;

        if (move) begin
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
