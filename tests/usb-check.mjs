#!/usr/bin/env node
// =============================================================================
// usb-check.mjs - rtl/usb.sv, alone and in tools/fpga-system.sv with FRUCTUS_USB
// =============================================================================
//
//   node tests/usb-check.mjs
//
// A low-speed device at the other end of the wire, written as behaviour - its
// own bit time, which the runs set 1.5% fast, exact and 1.5% slow, the
// limits of what a low-speed device may be.  It decodes every packet the
// host sends, SYNC, stuffing and EOP included, and answers an IN token with
// DATA1 and eight bytes chosen to need stuffing both ways, a NAK, the same
// DATA with its CRC spoilt, or nothing.
//
// THE PORT ALONE, its registers driven by the bench as a processor would:
//
//   - an IN token goes out whole, and DATA1 comes back a byte at a time, the
//     SYNC not delivered; `crc_ok' at the EOP;
//   - the ACK's SYNC, stored with `arm' set, waits for the EOP and goes two
//     bits after it - inside the 7.5-bit turnaround - and the ACK whole;
//   - a spoilt CRC: no ACK, the byte waiting dropped and arm cleared;
//   - a NAK; a timeout after 20 silent bits and not before 15;
//   - a byte run dry before a last one ends the packet with `error';
//   - the keep-alive, two bits of SE0, at a frame; `frame' clears by a write;
//   - reset holds SE0, and lets go.
//
// THE PORT IN THE SYSTEM, built with the UART too - whose words differ from its
// own in bit 4 alone - a program on the whole of it, as tests/uart-check.mjs
// runs one: an st8 of a byte with bit 0 set is not a last byte, so the packet
// runs dry and says `error'; then a whole IN transaction by interrupt - a handler
// feeding the token out on `hold empty', taking DATA1's bytes as they come,
// arming the ACK from the PID, and sending the ACK's PID when the SYNC goes.
//
// Needs iverilog, and yosys's ice40 cell models for the system.  Skips with a
// message when either is absent.
// =============================================================================

import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { assemble } from './harness.mjs';
import { loadSpec } from '../tools/isa.js';

const have = (cmd) => {
  try { execFileSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }); return true; }
  catch { return false; }
};
const CELLS = (() => {
  try {
    const dir = execFileSync('yosys-config', ['--datdir'], { encoding: 'utf8' }).trim();
    return `${dir}/ice40/cells_sim.v`;
  } catch { return '/usr/share/yosys/ice40/cells_sim.v'; }
})();
if (!have('iverilog') || !existsSync(CELLS)) {
  console.log('skip  tests/usb-check.mjs: iverilog or the ice40 cell models not installed');
  process.exit(0);
}
mkdirSync('build', { recursive: true });
const DIR = process.env.FRUCTUS_RTL ?? 'rtl';
let bad = 0;
const check = (what, ok, why = '') => {
  if (!ok) { bad++; console.log(`FAIL  ${what}${why ? `: ${why}` : ''}`); }
};

// --- the device, shared by both benches ------------------------------------------
// Inside a module that has `dp', `dm', `h_oe' (the host driving), and the
// device's own d_oe, d_dp, d_dm.  HP is the host's bit as the device samples
// it, DP the device's own.  Every packet received is printed as "P bytes".
const DEVICE = `
    real HP = 1e9 / 1.5e6;
    real DP = 1e9 / 1.5e6 / DEVF;
    integer fails = 0;
    task automatic check(input bit ok, input string what);
        if (!ok) begin $display("FAIL %s", what); fails++; end
    endtask

    logic [7:0] pk [0:31]; integer plen = 0, npk = 0; real p_start, p_end;
    task automatic dev_recv;
        integer ones, nb, nbit; logic prev, b; logic [7:0] cur; string s;
        wait (dp === 1'b1 && dm === 1'b0);
        p_start = $realtime;
        prev = 0; ones = 0; nb = 0; nbit = 0;
        #(HP / 2);
        while (!(dp === 0 && dm === 0)) begin
            b = (dp == prev); prev = dp;
            if (ones == 6) begin
                check(!b, "stuffing: a 1 where a stuffed 0 belongs");
                ones = 0;
            end else begin
                ones = b ? ones + 1 : 0;
                cur = {b, cur[7:1]}; nbit++;
                if (nbit == 8) begin pk[nb] = cur; nb++; nbit = 0; end
            end
            #HP;
        end
        check(nbit == 0, "a packet ended mid-byte");
        #HP; check(dp === 0 && dm === 0, "EOP's second bit is SE0");
        #HP; check(dp === 0 && dm === 1, "EOP ends in J");
        wait (!h_oe);
        p_end = $realtime;
        s = "P";
        for (int i = 0; i < nb; i++) s = {s, $sformatf(" %02x", pk[i])};
        $display("%s", s);
        plen = nb; npk++;
    endtask

    logic [7:0] tx [0:31]; integer tlen;
    task automatic dev_send;
        integer ones; logic lvl;
        lvl = 0; ones = 0;
        d_oe = 1; d_dp = 0; d_dm = 1;
        for (int i = 0; i < tlen; i++)
            for (int k = 0; k < 8; k++) begin
                if (!tx[i][k]) begin lvl = !lvl; ones = 0; end else ones++;
                d_dp = lvl; d_dm = !lvl; #DP;
                if (ones == 6) begin lvl = !lvl; ones = 0; d_dp = lvl; d_dm = !lvl; #DP; end
            end
        d_dp = 0; d_dm = 0; #(2 * DP);
        d_dp = 0; d_dm = 1; #DP;
        d_oe = 0;
    endtask

    function automatic [15:0] crc16(input integer n);
        logic [15:0] c; c = 16'hffff;
        for (int i = 0; i < n; i++) begin
            c ^= tx[2 + i];
            for (int k = 0; k < 8; k++) c = c[0] ? (c >> 1) ^ 16'ha001 : c >> 1;
        end
        return ~c;
    endfunction

    // 0 DATA1, 1 DATA1 with its CRC spoilt, 2 NAK, 3 silent.
    integer dev_mode = 0;
    initial forever begin
        dev_recv;
        if (pk[1] == 8'h69) begin
            #(3 * DP);
            if (dev_mode == 2) begin tx[0] = 8'h80; tx[1] = 8'h5a; tlen = 2; dev_send; end
            else if (dev_mode != 3) begin
                tx[0] = 8'h80; tx[1] = 8'h4b;
                tx[2] = 8'hff; tx[3] = 8'hff; tx[4] = 8'h00; tx[5] = 8'h7e;
                tx[6] = 8'h04; tx[7] = 8'hfc; tx[8] = 8'h3f; tx[9] = 8'h81;
                {tx[11], tx[10]} = crc16(8) ^ (dev_mode == 1 ? 16'h0400 : 16'h0);
                tlen = 12; dev_send;
            end
        end
    end
`;
const DATA = [0xff, 0xff, 0x00, 0x7e, 0x04, 0xfc, 0x3f, 0x81];

// --- the port alone ----------------------------------------------------------------
const UNIT = `\`timescale 1ns/10ps
module tb;
    logic clk = 0, rst = 1;
    always #19.86 clk = ~clk;                       // 25.175 MHz
    logic wr_data = 0, wr_status = 0, wr_ctrl = 0, rd_data = 0;
    logic [15:0] wword = 0;
    wire [7:0] rx_byte; wire [15:0] status; wire irq;
    wire h_dp, h_dm, h_oe;
    logic d_oe = 0, d_dp = 0, d_dm = 1;
    // The bus: the host's drive, the device's, or the device's pull-up on D-.
    wire dp = h_oe ? h_dp : d_oe ? d_dp : 1'b0;
    wire dm = h_oe ? h_dm : d_oe ? d_dm : 1'b1;
    usb u (.clk, .rst, .wr_data, .wr_status, .wr_ctrl, .wword, .rd_data,
           .rx_byte, .status, .irq, .dp_in(dp), .dm_in(dm),
           .dp_out(h_dp), .dm_out(h_dm), .oe(h_oe));
${DEVICE}
    // The processor's side, sampled on the falling edge.
    task automatic poke(input int which, input [15:0] w);
        @(posedge clk) begin
            wword <= w; wr_data <= which == 0; wr_status <= which == 1; wr_ctrl <= which == 2;
        end
        @(posedge clk) begin wr_data <= 0; wr_status <= 0; wr_ctrl <= 0; end
    endtask
    task automatic send(input [15:0] w);              // once hold is empty
        @(negedge clk);
        while (status[1]) @(negedge clk);
        poke(0, w);
    endtask
    logic [7:0] got [0:31]; integer glen;
    task automatic take;
        @(negedge clk);
        while (!status[2]) @(negedge clk);
        got[glen] = rx_byte; glen++;
        @(posedge clk) rd_data <= 1;
        @(posedge clk) rd_data <= 0;
        @(negedge clk);
    endtask
    task automatic in_token;
        send(16'h080); send(16'h069); send(16'h001); send(16'h1e8);
    endtask
    task automatic wait_eop;
        @(negedge clk);
        while (!status[3]) @(negedge clk);
    endtask

    real eop_seen;
    initial begin
        repeat (4) @(posedge clk); rst = 0;
        repeat (4) @(posedge clk);

        // 1: an IN token, DATA1 back, an ACK.
        glen = 0;
        in_token;
        wait (npk == 1);
        check(plen == 4 && pk[0] == 8'h80 && pk[1] == 8'h69 && pk[2] == 8'h01 && pk[3] == 8'he8,
              "the token's bytes");
        take;
        check(got[0] == 8'h4b, "DATA1's PID, the SYNC not delivered");
        poke(2, 16'h080);                              // arm
        poke(0, 16'h080);                              // and the ACK's SYNC waits
        for (int i = 0; i < 10; i++) take;
${DATA.map((b, i) => `        check(got[${1 + i}] == 8'h${b.toString(16)}, "data byte ${i}");`).join('\n')}
        wait_eop;
        check(status[4], "crc_ok on a good packet");
        check(status[1], "the SYNC still waiting at the EOP");
        eop_seen = $realtime;
        @(negedge clk);
        while (status[1]) @(negedge clk);
        poke(0, 16'h1d2);
        wait (npk == 2);
        check(plen == 2 && pk[0] == 8'h80 && pk[1] == 8'hd2, "the ACK, SYNC and PID");
        $display("TURN %0.2f", (p_start - eop_seen) / HP);
        check(p_start - eop_seen < 6 * HP, "the ACK inside the turnaround");
        poke(1, 16'h00f8);

        // 2: the CRC spoilt: no ACK, hold dropped, arm cleared.
        dev_dmode(1);
        glen = 0;
        in_token;
        take;
        poke(2, 16'h080); poke(0, 16'h080);
        for (int i = 0; i < 10; i++) take;
        wait_eop;
        check(!status[4], "crc_ok clear on a spoilt packet");
        repeat (4) @(negedge clk);
        check(!status[1] && !status[10], "the SYNC dropped and arm cleared");
        #(30 * HP);
        check(npk == 3, "no ACK after a spoilt CRC");
        poke(1, 16'h00f8);

        // 3: a NAK, then a timeout.
        dev_dmode(2);
        glen = 0;
        in_token; take;
        check(got[0] == 8'h5a, "the NAK");
        wait_eop;
        poke(1, 16'h00f8);
        dev_dmode(3);
        in_token;
        wait (h_oe); wait (!h_oe);
        #(15 * HP); check(!status[5], "no timeout after 15 bits");
        #(10 * HP); check(status[5], "a timeout by 25");
        poke(1, 16'h00f8);

        // 4: hold run dry before a last byte.
        send(16'h080); send(16'h0c3);
        @(negedge clk);
        while (status[0] || status[1]) @(negedge clk);
        check(status[7], "a packet run dry says error");
        poke(1, 16'h00f8);
        @(negedge clk);
        check(status[7:3] == 0, "and the write clears it");

        // 5: the keep-alive, at the next frame.
        poke(2, 16'h0030);                             // keep-alive, the frame's interrupt
        while (!irq) @(negedge clk);
        begin : ka
            real t0;
            wait (dp === 0 && dm === 0); t0 = $realtime;
            wait (dm === 1);
            $display("KA %0.2f", ($realtime - t0) / HP);
            check(($realtime - t0) / HP > 1.8 && ($realtime - t0) / HP < 2.3,
                  "the keep-alive is two bits of SE0");
        end
        poke(1, 16'h0040);
        @(negedge clk);
        check(!irq, "frame cleared by a write");

        // 6: a bus reset.
        poke(2, 16'h0040);
        repeat (4) @(negedge clk);
        check(dp === 0 && dm === 0, "reset holds SE0");
        poke(2, 16'h0000);
        repeat (4) @(negedge clk);
        check(dp === 0 && dm === 1, "and lets go");

        $display("FAILS %0d", fails);
        $finish;
    end
    task automatic dev_dmode(input integer m); dev_mode = m; endtask
    initial begin #20ms; $display("FAIL the bench ran out of time"); $display("FAILS 1"); $finish; end
endmodule
`;

const turns = [];
for (const f of ['0.985', '1.0', '1.015']) {
  writeFileSync('build/usb-unit.sv', UNIT.replace('DEVF', f));
  execFileSync('iverilog', ['-g2012', '-o', 'build/usb-unit.vvp', `${DIR}/usb.sv`, 'build/usb-unit.sv'],
               { stdio: ['ignore', 'ignore', 'inherit'] });
  const out = execFileSync('vvp', ['-n', 'build/usb-unit.vvp'], { encoding: 'utf8' });
  for (const m of out.matchAll(/^FAIL (.*)$/gm)) check(`rtl/usb.sv, the device at x${f}`, false, m[1]);
  check(`rtl/usb.sv, the device at x${f}: the bench finished`, /^FAILS 0$/m.test(out));
  turns.push(/^TURN ([\d.]+)$/m.exec(out)?.[1]);
}
for (const f of ['usb-unit.sv', 'usb-unit.vvp']) rmSync(`build/${f}`, { force: true });

// --- the port in the system ----------------------------------------------------------
const io = loadSpec().cpu.io;
const STAT = io.usb_status - io.usb_data, CTRL = io.usb_ctrl - io.usb_data;
const WORDS = 16384;
const RESULT = 0x6000;
// RESULT + : 0 status after the st8, 2 after clearing it, 4 at the end,
// 6 at the EOP, 8 TXI, 10 TXN - the token list's next and end, byte offsets
// into TXB - 12 the control word once the list is out, 14 done, 16 RXI,
// 32 the bytes received, 64 TXB, the words to send.
const TXB = [0x080, 0x069, 0x001, 0x1e8, 0x1d2];
const src = `
        mov  sp, #0x7000
        mov  r0, #0x7800
        mov  r1, #${io.shadow_isp}
        st   r0, [r1]              ; the interrupt stack
        mov  r4, #${RESULT}
${TXB.map((w, k) => `        mov  r0, #${w}\n        st   r0, [r4, #${64 + 2 * k}]`).join('\n')}
        mov  r1, #${io.usb_data}
        mov  r0, #0x80
        st8  r0, [r1]
w0:     ld   r0, [r1, #${STAT}]
        brclr r0, #1, w0           ; until it goes, and hold is empty
        mov  r0, #0x81
        st8  r0, [r1]              ; bit 0 set, but st8: not a last byte
w1:     ld   r0, [r1, #${STAT}]
        brset r0, #1, w1           ; and until it has gone
        st   r0, [r4, #0]          ; error: it ran dry
        mov  r0, #0xf8
        st   r0, [r1, #${STAT}]
        ld   r0, [r1, #${STAT}]
        st   r0, [r4, #2]          ; cleared
        mov  r0, #0
        st   r0, [r4, #8]
        mov  r0, #8
        st   r0, [r4, #10]         ; the token: TXB's first four
        mov  r0, #6
        st   r0, [r4, #12]         ; then listen: received and eop
        mov  r0, #1
        st   r0, [r1, #${CTRL}]    ; hold empty: the handler sends the token
        sei
wd:     ld   r0, [r4, #14]
        br   eq, r0, #0, wd
        cli
w2:     ld   r0, [r1, #${STAT}]
        brset r0, #1, w2           ; the ACK gone
        st   r0, [r4, #4]
        halt

handler:
        push r0, r2
        ld   r0, [r1, #${STAT}]
        brset r0, #4, hrx          ; a byte received
        brset r0, #8, heop
        brset r0, #2, hout         ; nothing to do: hold is full
        ld   r0, [r4, #8]
        ld   r2, [r4, #10]
        br   eq, r0, r2, hlast
        add  r2, r0, r4
        ld   r2, [r2, #64]
        st   r2, [r1]              ; the next word: a last byte has bit 8
        add  r0, r0, #2
        st   r0, [r4, #8]
hout:   pop  r2, r0
        rti
hlast:  ld   r0, [r4, #12]
        st   r0, [r1, #${CTRL}]
        br   ne, r0, #0, hout2
        mov  r0, #1
        st   r0, [r4, #14]         ; the ACK has gone into the shift register
hout2:  pop  r2, r0
        rti
hrx:    ld8  r0, [r1]
        ld   r2, [r4, #16]
        add  r2, r2, r4
        st8  r0, [r2, #32]
        ld   r2, [r4, #16]
        add  r2, r2, #1
        st   r2, [r4, #16]
        br   ne, r2, #1, hout3     ; only the PID decides
        mov  r2, #0x4b
        br   eq, r0, r2, hack
        mov  r2, #0xc3
        br   eq, r0, r2, hack
hout3:  pop  r2, r0
        rti
hack:   mov  r0, #8
        st   r0, [r4, #8]
        mov  r0, #10
        st   r0, [r4, #10]         ; the list: the ACK's PID alone
        mov  r0, #0
        st   r0, [r4, #12]         ; and then everything off
        mov  r0, #0x87
        st   r0, [r1, #${CTRL}]    ; arm; hold empty, received and eop
        mov  r0, #0x80
        st   r0, [r1]              ; the ACK's SYNC waits for the EOP
        pop  r2, r0
        rti
heop:   st   r0, [r4, #6]
        mov  r0, #8
        st   r0, [r1, #${STAT}]    ; eop cleared
        pop  r2, r0
        rti
`;
writeFileSync('build/usb-prog.s', src.split('\n').map((l) => l.trim()).join('\n') + '\n');
const { code, syms } = assemble('build/usb-prog.s');
rmSync('build/usb-prog.s', { force: true });
const prog = Array.from({ length: WORDS }, (_, w) => (code[2 * w] ?? 0) | ((code[2 * w + 1] ?? 0) << 8));
const VECTOR = 0xfff8;
writeFileSync('build/usb-vec.s', `jmp 0x${syms.get('handler').toString(16)}\n`);
const vec = [...assemble('build/usb-vec.s').code];
rmSync('build/usb-vec.s', { force: true });
const hiWords = new Array(WORDS).fill(0);
vec.forEach((b, k) => {
  const w = ((VECTOR + k) & 0x7fff) >> 1, hi = (VECTOR + k) & 1;
  hiWords[w] = hi ? (hiWords[w] & 0x00ff) | (b << 8) : (hiWords[w] & 0xff00) | b;
});
const hex = (a) => a.map((v) => v.toString(16).padStart(4, '0')).join('\n') + '\n';
writeFileSync('build/usb-lo.hex', hex(prog));
writeFileSync('build/usb-hi.hex', hex(hiWords));

writeFileSync('build/usb-sys.sv', `\`timescale 1ns/10ps
module tb;
    logic clk = 0, din = 1;
    wire dout, hsync_n, vsync_n; wire [2:0] red, green, blue;
    logic d_oe = 0, d_dp = 0, d_dm = 1;
    wire usb_dp, usb_dm;
    // The device drives, or its pull-up holds D- high; the host's pads drive
    // through rtl/usb.sv's oe, and a weak pull-down holds D+ low.
    assign usb_dp = d_oe ? d_dp : 1'bz;
    assign usb_dm = d_oe ? d_dm : 1'bz;
    pulldown (weak0) (usb_dp);
    pullup (weak1) (usb_dm);
    wire dp = usb_dp, dm = usb_dm, h_oe = dut.b_oe;
    top #(.BOOT(0)) dut (.clk, .din, .irq(1'b0), .dout, .hsync_n, .vsync_n, .red, .green, .blue,
                         .flash_sck(), .flash_cs_n(), .flash_mosi(), .flash_miso(1'b0),
                         .uart_rx(1'b1), .uart_tx(), .usb_dp, .usb_dm);
${DEVICE.replace('DEVF', '1.01')}
    integer cyc, k;
    initial begin
        $readmemh("build/usb-lo.hex", dut.ram_lo.mem);
        $readmemh("build/usb-hi.hex", dut.ram_hi.mem);
        repeat (4) begin #19.86 clk = 1; #19.86 clk = 0; end
        din = 0;
        for (cyc = 0; cyc < 200000 && !dut.halted && !dut.trapped; cyc = cyc + 1) begin
            #19.86 clk = 1; #19.86 clk = 0;
        end
        repeat (40) begin #19.86 clk = 1; #19.86 clk = 0; end
        $display("END %0d %0d %0d", dut.halted, dut.trapped, cyc);
        for (k = 0; k < 24; k = k + 1) $display("R %0d %h", k, dut.ram_lo.mem[${RESULT >> 1} + k]);
        $display("FAILS %0d", fails);
        $finish;
    end
endmodule
`);
const RTL = ['cpu', 'classify', 'alu', 'ucode', 'lhs', 'dest', 'immgen', 'cond', 'compare', 'uart', 'usb', 'spiboot']
  .map((m) => `${DIR}/${m}.sv`);
const VIDEO = ['video', 'timing', 'background', 'foreground', 'sprites'].map((m) => `${DIR}/video/${m}.sv`);
execFileSync('iverilog', ['-g2012', '-DFRUCTUS_BLIT', '-DFRUCTUS_UART', '-DFRUCTUS_USB', '-DNO_ICE40_DEFAULT_ASSIGNMENTS',
  '-o', 'build/usb-sys.vvp', ...RTL, ...VIDEO, CELLS, 'tools/fpga-system.sv', 'build/usb-sys.sv'],
  { stdio: ['ignore', 'ignore', 'inherit'] });
const out = execFileSync('vvp', ['-n', 'build/usb-sys.vvp'], { encoding: 'utf8' });
for (const f of ['usb-lo.hex', 'usb-hi.hex', 'usb-sys.sv', 'usb-sys.vvp']) rmSync(`build/${f}`, { force: true });

const R = new Map([...out.matchAll(/^R (\d+) ([0-9a-fx]+)$/gm)].map((m) => [+m[1], parseInt(m[2], 16)]));
const word = (off) => R.get(off >> 1);
const byte = (off) => (word(off & ~1) >> ((off & 1) * 8)) & 0xff;
const end = /^END (\d) (\d) (\d+)$/m.exec(out);
const packets = [...out.matchAll(/^P((?: [0-9a-f]{2})*)$/gm)].map((m) => m[1].trim());
for (const m of out.matchAll(/^FAIL (.*)$/gm)) check('the system\'s device', false, m[1]);
check('the program halts', end && end[1] === '1' && end[2] === '0', end ? `halted ${end[1]}, trapped ${end[2]}` : 'no END');
check('the device saw the run-dry byte, the token and the ACK',
      packets.length === 3 && packets[0] === '80 81' && packets[1] === '80 69 01 e8' && packets[2] === '80 d2',
      packets.join(' / '));
check('st8 is never a last byte: it ran dry', (word(0) & 0x80) !== 0, `status 0x${word(0)?.toString(16)}`);
check('a write of 1s clears error', (word(2) & 0xf8) === 0, `status 0x${word(2)?.toString(16)}`);
check('the handler took the PID and eight bytes, and the CRC',
      word(16) === 11 && byte(32) === 0x4b && DATA.every((b, k) => byte(33 + k) === b),
      Array.from({ length: word(16) ?? 0 }, (_, k) => byte(32 + k).toString(16)).join(' '));
check('the status at the EOP: eop and crc_ok', (word(6) & 0x18) === 0x18, `0x${word(6)?.toString(16)}`);
check('at the end: idle, armed no more, nothing waiting', (word(4) & 0x407) === 0, `0x${word(4)?.toString(16)}`);

if (bad === 0)
  console.log(`ok    rtl/usb.sv: a device 1.5% either side, the ACK ${turns.join('/')} bits after the EOP `
            + `is seen; in tools/fpga-system.sv an IN transaction by interrupt in ${end[3]} cycles`);
else {
  console.log(`FAIL  rtl/usb.sv: ${bad} checks failed`);
  process.exit(1);
}
