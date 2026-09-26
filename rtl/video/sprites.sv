// =============================================================================
// sprites.sv - sixteen sprites through a line buffer
// =============================================================================
//
// Hand written; see docs/vga.md, "Sprites".
//
// Sixteen 24×21 sprites at 2 bits per pixel, in the manner of the VIC-II but
// twice as many and at full horizontal resolution.  Pixel value 0 is
// transparent and 1-3 take the sprite's three colours, each a palette entry
// 1-15 (a colour of 0 is transparent too).  Sprite 0 is in front of sprite 1
// and so on, and all of them are in front of text and background; sprite 0 is
// the mouse pointer.  A sprite may be doubled vertically, which costs no time;
// there is no horizontal doubling, which would double the writes and leave no
// room for sixteen.
//
// TWO LINE BUFFERS.  During each line the engine builds the next line's
// sprites into one buffer while the display reads the other, and they swap at
// the horizontal wrap.  A buffer is 1024 4-bit pixels, written 16 bits at a
// time with a nibble mask and read a word at a time with the nibble picked
// after: one SB_RAM40_4K each.  Screen column c is buffer pixel c + 48, so a
// sprite slides off either edge.
//
// THE ENGINE'S LINE, from the cycle after the horizontal wrap -
//
//     0 - 255     clear the building buffer, four pixels a write
//     256 + 28k   sprite 15 - k's slot, k = 0 ... 15, 28 cycles each
//
// - 704 cycles, so a line must be at least 705.  Clearing the whole buffer,
// not only what the display reads, means no pixel outlives its line however
// the visible area changes.  Drawing 15 first and 0 last, writing only colours
// that are not 0, puts the lower numbers in front without reading the buffer.
//
// A SLOT IS THE SAME LENGTH WHETHER THE SPRITE IS SHOWN OR NOT, so the
// attribute reads fall on fixed cycles: sprite s's words 0, 1 and 2 are read at
// 257 + 28·(15 - s) + {0, 1, 2} cycles after the wrap of the line before the
// one they draw.  A sprite is drawn at most once on a line, so it is reused
// only lower down the screen: during line n, a write before its slot is drawn
// on line n + 1, and one after it from line n + 2.
//
//     slot cycle 0, 1, 2     read attribute words 0, 1, 2
//     3, 11, 19              read pattern word 0, 1, 2 of the row
//     4 + 8w + j             pixel j of word w
//
// ATTRIBUTES, four 16-bit words per sprite at 4s + {0, 1, 2, 3} -
//
//     0   x + 48 [9:0], double height [10], pattern [14:11]
//     1   y + 42 [9:0]
//     2   colour 1 [3:0], colour 2 [7:4], colour 3 [11:8]
//     3   unused
//
// PATTERNS, sixteen of 64 words: row r is words 3r, 3r + 1 and 3r + 2, eight
// pixels to a word, pixel 0 in the low two bits; word 63 is unused.
//
// TIMING.  `target` is the visible line to build, read the cycle after `wrap`.
// `pixel` for column x is out LATENCY cycles after the cycle in which `active`
// was high for x; LATENCY is at least 3.  As in the other generators, the
// display side's work is done LATENCY - 2 cycles late by delaying `active`,
// and the buffer it reads is latched as its late line begins, because the
// buffers swap before its last late columns.
// =============================================================================

module sprites #(
    parameter int LATENCY = 8
) (
    input  logic        clk,

    input  logic        pat_we,      // the CPU's write ports
    input  logic [9:0]  pat_addr,
    input  logic [15:0] pat_data,
    input  logic        attr_we,
    input  logic [5:0]  attr_addr,
    input  logic [15:0] attr_data,

    input  logic        wrap,        // the horizontal wrap: a line begins
    input  logic [9:0]  target,
    input  logic        active,

    output logic [3:0]  pixel        // 0 is transparent
);

    // --- the RAMs ------------------------------------------------------------------
    // no_rw_check: a read and a write of the same word in one cycle give
    // undefined data, as the block RAM does, rather than spending registers
    // and comparators to make it the old value.  The line buffers never meet
    // that way - the engine and the display use different buffers - and a CPU
    // write to an attribute or pattern word in the cycle the engine reads it
    // draws that sprite wrong for one line; software avoids both.
    (* ram_style = "block", no_rw_check *) logic [15:0] attrs [256];
    (* no_rw_check *) logic [15:0] pattern [1024];
    (* no_rw_check *) logic [15:0] lb0 [256];
    (* no_rw_check *) logic [15:0] lb1 [256];

    // --- the engine ----------------------------------------------------------------
    logic       bsel = 1'b0;         // the buffer being built
    logic       run = 1'b0;
    logic       clearing;
    logic [7:0] ccount;              // the word being cleared
    logic [3:0] s;                   // the sprite
    logic [4:0] t;                   // the cycle in its slot
    logic [9:0] tgt;

    always_ff @(posedge clk) begin
        if (wrap) begin
            bsel     <= !bsel;
            run      <= 1'b1;
            clearing <= 1'b1;
            ccount   <= 8'd0;
            s        <= 4'd15;
            t        <= 5'd0;
        end else if (run) begin
            if (clearing) begin
                if (ccount == 8'd0) tgt <= target;
                ccount <= ccount + 8'd1;
                if (ccount == 8'd255) clearing <= 1'b0;
            end else if (t == 5'd27) begin
                t <= 5'd0;
                s <= s - 4'd1;
                if (s == 4'd0) run <= 1'b0;
            end else
                t <= t + 5'd1;
        end
    end

    wire drawing = run && !clearing;

    // Attributes: read at slot cycles 0, 1 and 2, each out the cycle after.
    /* verilator lint_off UNUSEDSIGNAL */
    logic [15:0] attr_q;             // bit 15 is spare in every word
    /* verilator lint_on UNUSEDSIGNAL */
    always_ff @(posedge clk) begin
        if (attr_we) attrs[{2'b00, attr_addr}] <= attr_data;
        if (drawing && t < 5'd3) attr_q <= attrs[{2'b00, s, t[1:0]}];
    end

    logic [9:0]  sx;
    logic        dh, hit;
    logic [3:0]  pat;
    logic [4:0]  row;
    logic [11:0] colours;

    wire [10:0] dy = {1'b0, tgt} + 11'd42 - {1'b0, attr_q[9:0]};

    always_ff @(posedge clk)
        if (drawing)
            case (t)
                5'd1: begin
                    sx  <= attr_q[9:0];
                    dh  <= attr_q[10];
                    pat <= attr_q[14:11];
                end
                5'd2: begin
                    hit <= dy < (dh ? 11'd42 : 11'd21);
                    row <= dh ? dy[5:1] : dy[4:0];
                end
                5'd3: colours <= attr_q[11:0];
                default: ;
            endcase

    // Pattern words: read at 3, 11 and 19, each held until the next read, so a
    // word is read on the cycle of the last word's last pixel.
    wire        p_rd  = drawing && (t == 5'd3 || t == 5'd11 || t == 5'd19);
    wire [1:0]  rw    = t == 5'd3 ? 2'd0 : t == 5'd11 ? 2'd1 : 2'd2;
    wire [5:0]  pword = {1'b0, row} * 6'd3 + {4'b0, rw};
    logic [15:0] pat_q;
    always_ff @(posedge clk) begin
        if (pat_we) pattern[pat_addr] <= pat_data;
        if (p_rd)   pat_q <= pattern[{pat, pword}];
    end

    // Pixel j of word w at slot cycle 4 + 8w + j.
    wire [4:0]  pt   = t - 5'd4;
    wire [1:0]  w    = pt[4:3];
    wire [2:0]  j    = pt[2:0];
    wire [1:0]  v    = 2'(pat_q >> {j, 1'b0});
    wire [3:0]  col  = v == 2'd1 ? colours[3:0] : v == 2'd2 ? colours[7:4]
                     : v == 2'd3 ? colours[11:8] : 4'd0;
    wire [9:0]  pos  = sx + {5'b0, w, j};
    wire        plot = drawing && t >= 5'd4 && hit && col != 4'd0;

    // The building buffer's write port: a whole word while clearing, else one
    // nibble.
    wire        lb_we   = run && (clearing || plot);
    wire [7:0]  lb_addr = clearing ? ccount : pos[9:2];
    wire [15:0] lb_data = clearing ? 16'h0000 : {4{col}};
    wire [3:0]  lb_mask = clearing ? 4'b1111 : 4'b0001 << pos[1:0];

    always_ff @(posedge clk)
        for (int k = 0; k < 4; k++)
            if (lb_we && lb_mask[k]) begin
                if (bsel) lb1[lb_addr][4 * k +: 4] <= lb_data[4 * k +: 4];
                else      lb0[lb_addr][4 * k +: 4] <= lb_data[4 * k +: 4];
            end

    // --- the display, LATENCY - 2 cycles late -------------------------------------
    localparam int K = LATENCY - 2;
    logic [K - 1:0] act_d;
    always_ff @(posedge clk)
        act_d <= K'({act_d, active});

    wire        act   = act_d[K - 1];
    logic       act_q;
    logic [9:0] c_q;
    wire        first = act && !act_q;
    wire  [9:0] c     = first ? 10'd0 : c_q;
    wire  [9:0] a     = c + 10'd48;

    logic        dsel;               // the buffer shown, latched as the late line begins
    logic [15:0] q0, q1;
    logic [1:0]  lane_q;
    logic        dsel_q, show_q;

    always_ff @(posedge clk) begin
        act_q  <= act;
        c_q    <= c + 10'd1;
        if (first) dsel <= !bsel;
        q0     <= lb0[a[9:2]];
        q1     <= lb1[a[9:2]];
        lane_q <= a[1:0];
        dsel_q <= first ? !bsel : dsel;
        show_q <= act;
    end

    wire [15:0] q = dsel_q ? q1 : q0;
    always_ff @(posedge clk)
        pixel <= show_q ? 4'(q >> {lane_q, 2'b00}) : 4'd0;

endmodule
