module tb;
    logic clk = 0, rst = 1;
    logic [7:0] mem [0:65535];
    logic [15:0] rdata;
    wire [15:0] addr, wdata, rpc; wire [1:0] we; wire halted, trapped, ret;
    cpu u (.clk(clk), .rst(rst), .boot(1'b0), .mem_addr(addr), .mem_rdata(rdata),
           .mem_wdata(wdata), .mem_we(we), .irq(1'b0),
           .halted(halted), .trapped(trapped), .result(), .retire(ret), .retire_pc(rpc));
    always @(posedge clk) begin
        rdata <= {mem[{addr[15:1], 1'b1}], mem[{addr[15:1], 1'b0}]};
        if (we[0]) mem[{addr[15:1], 1'b0}] <= wdata[7:0];
        if (we[1]) mem[{addr[15:1], 1'b1}] <= wdata[15:8];
        if (we[0] && addr == 16'h0420) $write("%c", wdata[7:0]);
    end
    longint cyc, n;
    integer k;
    initial begin
        $readmemh("build/ib/db.hex", mem);
        repeat (3) begin #1 clk = 1; #1 clk = 0; end
        for (k = 0; k < 8; k = k + 1) u.R[k] = 0;
        u.shadow_sp = 0; u.shadow_lr = 0; u.shadow_isp = 0;
        rst = 0; cyc = 0; n = 0;
        while (!halted && !trapped && cyc < 64'd20000000) begin
            if (ret) n = n + 1;
            #1 clk = 1; #1 clk = 0;
            cyc = cyc + 1;
        end
        $display("\nRESULT halted=%0d trapped=%0d cycles=%0d retired=%0d r0=%h", halted, trapped, cyc, n, u.R[0]);
        $finish;
    end
endmodule
