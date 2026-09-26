// =============================================================================
// cursor.sv - the cursor sprite
// =============================================================================
//
// Hand written; see docs/vga.md, "Cursor".
//
// A 32×32 sprite at 4 bits per pixel: 0 is transparent, 1-15 are palette
// entries, and the top level puts it in front of text and background, ahead
// of the palette.
//
// THE BITMAP IS ITS OWN BLOCK RAM, READ EVERY PIXEL.  32 × 32 × 4 bits is 4096,
// exactly one SB_RAM40_4K, and its read port serves nothing else, so the pixel
// under each column is read as the column comes - no row buffer.  It is 512
// bytes, 16 to a row, the left pixel of each pair in the low nibble as in the
// background.  The CPU writes it a byte at a time through the other port.
//
// THE POSITION IS THE TOP-LEFT CORNER PLUS 32, so 0 is wholly off the left or
// top edge and the cursor slides off either edge a column or a line at a time.
// `x` and `y` are copied to shadow registers at `frame`, the end of the
// visible lines, so moving the cursor never draws half of it in each place.
//
// TIMING.  `line` is the visible line, from the top level.  `active` is high
// for the 640 visible columns.  `pixel` for column x is out LATENCY cycles
// after the cycle in which `active` was high for x; LATENCY is at least 3.  The
// work is done LATENCY - 2 cycles late, then one cycle for the block RAM's read
// and one for the output register.
// =============================================================================

module cursor #(
    parameter int LATENCY = 9
) (
    input  logic        clk,

    input  logic        we,          // the CPU's write port to the bitmap
    input  logic [8:0]  waddr,
    input  logic [7:0]  wdata,

    input  logic [9:0]  x,           // top-left corner + 32
    input  logic [9:0]  y,
    input  logic        frame,       // latch x and y

    input  logic [9:0]  line,
    input  logic        active,

    output logic [3:0]  pixel        // 0 is transparent
);

    logic [9:0] xq, yq;
    always_ff @(posedge clk)
        if (frame) begin
            xq <= x;
            yq <= y;
        end

    // --- the column, LATENCY - 2 cycles late -----------------------------------------
    // Delaying `active` costs K flops where delaying the pixel would cost 4 per
    // cycle, and a flop that only delays another takes a whole logic cell.
    localparam int K = LATENCY - 2;
    logic [K - 1:0] act_d;
    always_ff @(posedge clk)
        act_d <= K'({act_d, active});

    wire        act   = act_d[K - 1];
    logic       act_q;
    logic [9:0] col;
    wire        first = act && !act_q;
    wire  [9:0] c     = first ? 10'd0 : col;      // this cycle's column

    // The row is latched as the late line begins: `line` moves on at the end of
    // the visible line, before the last late columns.
    wire  [10:0] dy = {1'b0, line} + 11'd32 - {1'b0, yq};
    logic [4:0]  row;
    logic        row_hit;

    always_ff @(posedge clk) begin
        act_q <= act;
        col   <= c + 10'd1;
        if (first) begin
            row     <= dy[4:0];
            row_hit <= dy < 11'd32;
        end
    end

    wire [10:0] dx  = {1'b0, c} + 11'd32 - {1'b0, xq};
    wire        hit = act && dx < 11'd32 && (first ? dy < 11'd32 : row_hit);
    wire [4:0]  r   = first ? dy[4:0] : row;

    // --- the bitmap --------------------------------------------------------------
    logic [7:0] bitmap [512];
    logic [7:0] pair;
    logic       hit_q, odd_q;

    always_ff @(posedge clk) begin
        if (we)
            bitmap[waddr] <= wdata;
        pair  <= bitmap[{r, dx[4:1]}];
        hit_q <= hit;
        odd_q <= dx[0];
    end

    always_ff @(posedge clk)
        pixel <= !hit_q ? 4'd0 : odd_q ? pair[7:4] : pair[3:0];

endmodule
