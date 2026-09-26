// =============================================================================
// timing.sv - one direction of the display timing
// =============================================================================
//
// Hand written; see docs/vga.md, "Timing generator".
//
// Four phases in the order they happen, each `len[phase]` steps long -
//
//     0 front porch   1 sync   2 back porch   3 visible
//
// - a 2-bit state and a 10-bit countdown, never a sum of the lengths.  When
// the countdown is 0 the state moves on and the countdown loads the new
// phase's length - 1, through the same decrementer as the ordinary count.
// Every length must be at least 1.  A length written mid-frame takes effect the
// next time its phase is entered.
//
// Instantiated twice: horizontally with `step` always set, and vertically with
// `step` set by the horizontal copy's `wrap`, so every vertical edge falls at
// the start of a horizontal front porch.
//
// It comes up in the visible phase with the countdown at 0, so the first step
// enters the front porch and loads its length: no reset is needed.
// =============================================================================

module timing (
    input  logic       clk,
    input  logic       step,
    input  logic [3:0][9:0] len,   // [0] front porch, [1] sync, [2] back porch, [3] visible
    output logic [1:0] state,
    output logic       wrap          // this step leaves the visible phase
);

    logic [9:0] countdown = 10'd0;
    initial state = 2'd3;

    wire done = countdown == 10'd0;
    assign wrap = step && done && state == 2'd3;

    always_ff @(posedge clk)
        if (step) begin
            countdown <= (done ? len[state + 2'd1] : countdown) - 10'd1;
            if (done)
                state <= state + 2'd1;
        end

endmodule
