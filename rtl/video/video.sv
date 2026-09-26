// =============================================================================
// video.sv - the display, from line tables to DAC pins
// =============================================================================
//
// Hand written; see docs/vga.md for the design.
//
//     timing ─┬─ line tables ─┬─ background ─┐
//             │               └─ foreground ─┤
//             ├─ cursor ──────────────────────┴─ select ─ palette ─ decode ─ pins
//             └─ hsync, vsync, visible, delayed to match ─────────────────────┘
//
// THE LINE TABLES ARE READ AS THE FRONT PORCH ENDS.  For line n - counted from
// the first visible line - the four entries are the words at n, 0x200 + n,
// 0x400 + n and 0x600 + n: background_color, graphics_mode, character_data and
// character_color.  They are read on the first four cycles after the front
// porch, and line_start follows once the last has arrived, so SYNC and
// back porch together must be at least 6 cycles.  The background's last reads
// run up to 3 cycles past the last column, so the front porch must be at least
// 2.  Standard timings are far longer.
//
// MEMORY.  One read port, shared on a fixed schedule: counting x from column
// 0, the text generator reads on even cycles and the background on odd, and
// the table reads fall in the blanking where neither reads.  A word arrives on
// `mem_rdata` the cycle after its read.
//
// THE PIXEL PATH.  The generators' outputs for column x arrive LATENCY cycles
// after it.  A cursor pixel that is not 0 is palette entry 1-15, in front of
// everything; otherwise the glyph bit picks the foreground colour or the
// background.  The
// byte goes to the palette, whose read is registered, and alongside it one
// cycle to match; a byte whose top three bits are 000 takes the palette entry.
// The decode to pin encodings is registered once more, so the pins show column
// x at LATENCY + 2, and hsync, vsync and visible are delayed to the same.  The
// pins are 0 whenever the delayed visible is not set.
//
// DECODE, docs/vga.md "8-bit pixel format" and "Pin encodings":
//
//     t = byte[7:5], c = byte[4:0]
//     t = 000                  black (a palette entry that is itself 000...)
//     c[3:0] = 1111            black (the two unused direct codes)
//     otherwise   green = t - 1,  red = c[3:0] div 5 + 3·c[4],  blue = c[3:0] mod 5
//
// with each level encoded for the weighted ladders, where all three pins high
// is full scale.
// =============================================================================

module video #(
    parameter int LATENCY = 9
) (
    input  logic        clk,

    input  logic [3:0][9:0] h_len,  // struct timing: [0] front porch, [1] pulse,
    input  logic [3:0][9:0] v_len,  // [2] back porch, [3] pixels

    input  logic        pal_we,      // the CPU's palette write port
    input  logic [4:0]  pal_addr,
    input  logic [7:0]  pal_data,

    input  logic        cur_we,      // the CPU's write port to the cursor bitmap
    input  logic [8:0]  cur_addr,
    input  logic [7:0]  cur_data,
    input  logic [9:0]  cur_x,       // the cursor's top-left corner + 32
    input  logic [9:0]  cur_y,

    output logic        mem_rd,
    output logic [13:0] mem_addr,    // word address
    input  logic [15:0] mem_rdata,

    output logic        hsync_n,
    output logic        vsync_n,
    output logic [2:0]  red,
    output logic [2:0]  green,
    output logic [2:0]  blue,

    output logic [9:0]  line,        // for the status register
    output logic        vblank
);

    // --- timing ----------------------------------------------------------------
    logic [1:0] h_state, v_state;
    logic       h_wrap, v_wrap;

    timing h (.clk, .step(1'b1),   .len(h_len), .state(h_state), .wrap(h_wrap));
    timing v (.clk, .step(h_wrap), .len(v_len), .state(v_state), .wrap(v_wrap));

    wire v_vis  = v_state == 2'd3;
    wire active = h_state == 2'd3 && v_vis;

    logic [9:0] n = 10'd0;           // the line, from the first visible one
    always_ff @(posedge clk)
        if (h_wrap)
            n <= v_vis ? n + 10'd1 : 10'd0;

    assign line   = n;
    assign vblank = !v_vis;

    // --- the line tables ---------------------------------------------------------
    // tc counts the cycles since the front porch ended.
    logic [2:0]  tc = 3'd7;
    logic [14:0] t_bg, t_char, t_color;    // byte addresses: bit 15 unused
    logic [15:0] t_mode;

    always_ff @(posedge clk)
        tc <= h_state == 2'd0 ? 3'd0 : tc == 3'd7 ? 3'd7 : tc + 3'd1;

    wire        in_tables = v_vis && h_state != 2'd0 && h_state != 2'd3;
    wire        t_rd      = in_tables && tc < 3'd4;
    wire [13:0] t_addr    = {3'b000, tc[1:0], n[8:0]};
    wire        line_start = in_tables && tc == 3'd5;

    always_ff @(posedge clk)
        if (in_tables)
            case (tc)
                3'd1: t_bg    <= mem_rdata[14:0];
                3'd2: t_mode  <= mem_rdata;
                3'd3: t_char  <= mem_rdata[14:0];
                3'd4: t_color <= mem_rdata[14:0];
                default: ;
            endcase

    // --- the generators ------------------------------------------------------
    logic        bg_rd, fg_rd;
    logic [13:0] bg_addr, fg_addr;
    logic [7:0]  bg_pixel, fg_color;
    logic        fg_on;

    background #(.LATENCY(LATENCY)) bg (
        .clk, .line_start, .ptr(t_bg), .depth(t_mode[10:8]),
        .width({1'b0, t_mode[13:11]} + 4'd1), .active,
        .mem_rd(bg_rd), .mem_addr(bg_addr), .mem_rdata, .pixel(bg_pixel));

    foreground #(.LATENCY(LATENCY)) fg (
        .clk, .line_start, .char_ptr(t_char), .color_ptr(t_color),
        .font_line(t_mode[7:0]), .dbl(t_mode[14]), .off(t_mode[15]), .active,
        .mem_rd(fg_rd), .mem_addr(fg_addr), .mem_rdata, .fg_on, .fg_color);

    assign mem_rd   = fg_rd || bg_rd || t_rd;
    assign mem_addr = fg_rd ? fg_addr : bg_rd ? bg_addr : t_addr;

    logic [3:0] cur_pixel;
    cursor #(.LATENCY(LATENCY)) cur (
        .clk, .we(cur_we), .waddr(cur_addr), .wdata(cur_data),
        .x(cur_x), .y(cur_y), .frame(v_wrap), .line(n), .active, .pixel(cur_pixel));

    // --- cursor, fg/bg, then the palette -------------------------------------------
    wire [7:0] sel = cur_pixel != 4'd0 ? {4'b0000, cur_pixel}
                   : fg_on            ? fg_color
                   :                    bg_pixel;

    logic [7:0] palette [32];
    logic [7:0] pal_q, sel_q;
    always_ff @(posedge clk) begin
        if (pal_we)
            palette[pal_addr] <= pal_data;
        pal_q <= palette[sel[4:0]];
        sel_q <= sel;
    end

    wire [7:0] px = sel_q[7:5] == 3'b000 ? pal_q : sel_q;

    // --- decode ----------------------------------------------------------------
    logic [2:0] g_pins, r_pins, b_pins;
    logic [1:0] rdiv;                // c[3:0] div 5
    logic [2:0] bmod;                // c[3:0] mod 5
    always @* begin                  // not always_comb: iverilog rejects its part selects
        case (px[7:5])               // green = t - 1, weights 3 2 1
            3'd1: g_pins = 3'b000;
            3'd2: g_pins = 3'b001;
            3'd3: g_pins = 3'b010;
            3'd4: g_pins = 3'b100;
            3'd5: g_pins = 3'b101;
            3'd6: g_pins = 3'b110;
            3'd7: g_pins = 3'b111;
            default: g_pins = 3'b000;
        endcase
        rdiv = px[3:0] < 4'd5 ? 2'd0 : px[3:0] < 4'd10 ? 2'd1 : 2'd2;
        bmod = 3'(px[3:0] - 4'(rdiv) * 4'd5);
        case (3'(rdiv) + (px[4] ? 3'd3 : 3'd0))  // red, weights 2 2 1
            3'd0: r_pins = 3'b000;
            3'd1: r_pins = 3'b001;
            3'd2: r_pins = 3'b010;
            3'd3: r_pins = 3'b011;
            3'd4: r_pins = 3'b110;
            default: r_pins = 3'b111;
        endcase
        case (bmod)                  // blue, weights 2 1 1
            3'd0: b_pins = 3'b000;
            3'd1: b_pins = 3'b001;
            3'd2: b_pins = 3'b100;
            3'd3: b_pins = 3'b101;
            default: b_pins = 3'b111;
        endcase
    end

    wire black = px[7:5] == 3'b000 || px[3:0] == 4'b1111;

    // --- syncs and blanking, delayed to the pixels ----------------------------------
    // Column x's pixel is registered into the pins at the end of cycle
    // x + LATENCY + 1, so the syncs and visible are delayed LATENCY + 1 cycles
    // to meet it there.
    logic [3 * (LATENCY + 1) - 1:0] dl = '0;
    always_ff @(posedge clk)
        dl <= (3 * (LATENCY + 1))'({dl, h_state == 2'd1, v_state == 2'd1, active});

    wire hs = dl[3 * LATENCY + 2];
    wire vs = dl[3 * LATENCY + 1];
    wire vis = dl[3 * LATENCY];

    always_ff @(posedge clk) begin
        hsync_n <= !hs;
        vsync_n <= !vs;
        {red, green, blue} <= vis && !black ? {r_pins, g_pins, b_pins} : 9'd0;
    end

endmodule
