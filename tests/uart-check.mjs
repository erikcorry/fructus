#!/usr/bin/env node
// =============================================================================
// uart-check.mjs - rtl/uart.sv, in tools/fpga-system.sv built with FRUCTUS_UART
// =============================================================================
//
//   node tests/uart-check.mjs
//
// A program on the WHOLE SYSTEM, as tests/blit-check.mjs runs one, with the
// test bench as the host at the other end of the serial line: it decodes
// what the UART sends, and sends bursts of its own when the program asks for
// them through a mailbox word in memory, clearing the word when the burst is
// over.  Divisor 7, eight clocks to a bit, so a byte is 80 cycles.  What is
// checked:
//
//   - the divisor comes up as 217, 115200 baud at 25.125 MHz;
//   - six bytes sent, each once `busy' clears - 0x00 and 0xff among them -
//     arrive at the host whole, with their stop bits;
//   - a byte received, polled: `received' set, a store to the data register
//     meanwhile sends a byte and leaves the received one waiting, a load
//     takes it and clears the flag;
//   - two bytes with no load between: `received' and `overrun', and the
//     first byte kept; the load clears both;
//   - a byte whose stop bit is low is dropped, and the one after it arrives;
//   - with the interrupt enabled, a byte enters the handler exactly once:
//     its load of the data register drops the line before its rti;
//   - with the transmitter's interrupt enabled, a handler sends a buffer a
//     byte an entry, one entry for each byte and one more to find it empty
//     and switch the interrupt off.
//
// Needs iverilog and yosys's ice40 cell models.  Skips with a message when
// either is absent.
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
  console.log('skip  tests/uart-check.mjs: iverilog or the ice40 cell models not installed');
  process.exit(0);
}
mkdirSync('build', { recursive: true });

const io = loadSpec().cpu.io;
const DATA = io.console, STAT = io.uart_status - io.console, DIV = io.uart_divisor - io.console;
const BIT = 8;                       // clocks to a bit: the program writes BIT - 1
const WORDS = 16384;
const RESULT = 0x6000;
const MB = 60;                       // the mailbox, at RESULT + 60
const SENT = [0x48, 0x69, 0x0a, 0x00, 0xff, 0x55];
const BUFFERED = [0x4f, 0x4b, 0x21];  // "OK!", by the transmitter's interrupt

const sends = SENT.map((b, k) => `
w${k}:   ld   r0, [r1, #${STAT}]
        brset r0, #1, w${k}        ; busy
        mov  r0, #${b}
        st8  r0, [r1]`).join('');
const ask = (n, label) => `
        mov  r0, #${n}
        st   r0, [r4, #${MB}]
${label}: ld   r0, [r4, #${MB}]         ; until the host has sent it
        br   ne, r0, #0, ${label}`;

const src = `
        mov  sp, #0x7000
        mov  r0, #0x7800
        mov  r1, #${io.shadow_isp}
        st   r0, [r1]              ; the interrupt stack
        mov  r4, #${RESULT}
        mov  r1, #${DATA}
        mov  r0, #${BIT - 1}
        st   r0, [r1, #${DIV}]
${sends}
txend:  ld   r0, [r1, #${STAT}]
        brset r0, #1, txend
        st   r0, [r4, #0]          ; 0: all sent, nothing received
        mov  r0, #1
        st   r0, [r4, #${MB}]      ; one byte, 0x41
rx1:    ld   r0, [r1, #${STAT}]
        brclr r0, #2, rx1
        st   r0, [r4, #2]          ; 2: received
        mov  r0, #0x21
        st8  r0, [r1]              ; a byte sent while one waits
        ld   r0, [r1, #${STAT}]
        st   r0, [r4, #4]          ; 3: busy, and still received
        ld8  r0, [r1]
        st   r0, [r4, #6]          ; 0x41
        ld   r0, [r1, #${STAT}]
        and  r0, r0, #6
        st   r0, [r4, #8]          ; 0: taken
mb1:    ld   r0, [r4, #${MB}]
        br   ne, r0, #0, mb1
${ask(3, 'mb3')}
        ld   r0, [r1, #${STAT}]
        st   r0, [r4, #10]         ; 6: received and overrun
        ld   r0, [r1]
        st   r0, [r4, #12]         ; 0x0011, the first, by a word load
        ld   r0, [r1, #${STAT}]
        st   r0, [r4, #14]         ; 0: both cleared
${ask(4, 'mb4')}
        ld   r0, [r1, #${STAT}]
        st   r0, [r4, #16]         ; 2: the bad byte dropped, not an overrun
        ld8  r0, [r1]
        st   r0, [r4, #18]         ; 0x3c
        mov  r0, #0x10
        st   r0, [r1, #${STAT}]    ; the interrupt on
        sei
        mov  r0, #5
        st   r0, [r4, #${MB}]
iw:     ld   r0, [r4, #40]
        br   eq, r0, #0, iw
        mov  r3, #200              ; long enough for a stuck line to re-enter
dly:    add  r3, r3, #-1
        br   ne, r3, #0, dly
        cli
        ld   r0, [r1, #${STAT}]
        st   r0, [r4, #20]         ; 0x10: enabled, nothing waiting
${BUFFERED.map((b, k) => `        mov  r0, #${b}\n        st8  r0, [r4, #${64 + k}]`).join('\n')}
        mov  r0, #0
        st   r0, [r4, #24]         ; the next byte to send
        mov  r0, #${BUFFERED.length}
        st   r0, [r4, #26]         ; and the end
        mov  r0, #0x20
        st   r0, [r1, #${STAT}]    ; the transmitter's interrupt on, alone
        sei
tw:     ld   r0, [r4, #28]
        br   eq, r0, #0, tw        ; until the handler finds the buffer empty
        cli
txend2: ld   r0, [r1, #${STAT}]
        brset r0, #1, txend2
        st   r0, [r4, #32]         ; 0: off again, and idle
        halt

handler:
        push r0, r2
        ld   r0, [r1, #${STAT}]
        brclr r0, #2, htx          ; nothing received: the transmitter's
        ld8  r0, [r1]              ; takes the byte, which drops the line
        st   r0, [r4, #22]
        ld   r0, [r4, #40]
        add  r0, r0, #1
        st   r0, [r4, #40]
        pop  r2, r0
        rti
htx:    ld   r0, [r4, #30]
        add  r0, r0, #1
        st   r0, [r4, #30]         ; count the transmitter's entries
        ld   r0, [r4, #24]
        ld   r2, [r4, #26]
        br   eq, r0, r2, hdone
        add  r2, r0, r4
        ld8  r2, [r2, #64]
        st8  r2, [r1]              ; sent: busy again, which drops the line
        add  r0, r0, #1
        st   r0, [r4, #24]
        pop  r2, r0
        rti
hdone:  mov  r0, #0
        st   r0, [r1, #${STAT}]    ; empty: the interrupt off
        mov  r0, #1
        st   r0, [r4, #28]
        pop  r2, r0
        rti
`;
writeFileSync('build/uart-prog.s', src.split('\n').map((l) => l.trim()).join('\n') + '\n');
const { code, syms } = assemble('build/uart-prog.s');
rmSync('build/uart-prog.s', { force: true });
const prog = Array.from({ length: WORDS }, (_, w) => (code[2 * w] ?? 0) | ((code[2 * w + 1] ?? 0) << 8));

// The interrupt's vector, a jump to the handler at 0xfff8 in ram_hi.
const VECTOR = 0xfff8;
writeFileSync('build/uart-vec.s', `jmp 0x${syms.get('handler').toString(16)}\n`);
const vec = [...assemble('build/uart-vec.s').code];
rmSync('build/uart-vec.s', { force: true });
const hiWords = new Array(WORDS).fill(0);
vec.forEach((b, k) => {
  const w = ((VECTOR + k) & 0x7fff) >> 1, hi = (VECTOR + k) & 1;
  hiWords[w] = hi ? (hiWords[w] & 0x00ff) | (b << 8) : (hiWords[w] & 0xff00) | b;
});
const hex = (a) => a.map((v) => v.toString(16).padStart(4, '0')).join('\n') + '\n';
writeFileSync('build/uart-lo.hex', hex(prog));
writeFileSync('build/uart-hi.hex', hex(hiWords));

const MBW = (RESULT + MB) >> 1;
writeFileSync('build/uart-tb.sv', `module tb;
    logic clk = 0, din = 1, host_tx = 1;
    wire dout, hsync_n, vsync_n, host_rx; wire [2:0] red, green, blue;
    top #(.BOOT(0)) dut (.clk, .din, .irq(1'b0), .dout, .hsync_n, .vsync_n, .red, .green, .blue,
                         .flash_sck(), .flash_cs_n(), .flash_mosi(), .flash_miso(1'b0),
                         .uart_rx(host_tx), .uart_tx(host_rx));
    integer cyc, k, div0 = -1;

    // THE HOST'S TRANSMITTER: the bursts the program asks for, a bit every
    // ${BIT} cycles, changed on the falling edge, and two idle bits after each.
    task send(input [7:0] b, input stop);
        integer i;
        begin
            host_tx = 0; repeat (${BIT}) @(negedge clk);
            for (i = 0; i < 8; i = i + 1) begin host_tx = b[i]; repeat (${BIT}) @(negedge clk); end
            host_tx = stop; repeat (${BIT}) @(negedge clk);
            host_tx = 1; repeat (${2 * BIT}) @(negedge clk);
        end
    endtask
    initial forever begin
        @(negedge clk);
        if (dut.ram_lo.mem[${MBW}] != 16'd0) begin
            case (dut.ram_lo.mem[${MBW}])
                16'd1: send(8'h41, 1);
                16'd3: begin send(8'h11, 1); send(8'h22, 1); end
                16'd4: begin send(8'h5a, 0); send(8'h3c, 1); end
                16'd5: send(8'h77, 1);
            endcase
            dut.ram_lo.mem[${MBW}] = 16'd0;
        end
    end

    // THE HOST'S RECEIVER: a falling line, then each bit sampled in its middle.
    logic [7:0] got [0:15]; logic stops [0:15]; integer n = 0;
    initial forever begin : rx
        integer i; logic [7:0] b;
        @(negedge clk);
        if (host_rx === 1'b0) begin
            repeat (${BIT / 2}) @(negedge clk);
            for (i = 0; i < 8; i = i + 1) begin repeat (${BIT}) @(negedge clk); b[i] = host_rx; end
            repeat (${BIT}) @(negedge clk);
            if (n < 16) begin got[n] = b; stops[n] = host_rx; end
            n = n + 1;
        end
    end

    initial begin
        $readmemh("build/uart-lo.hex", dut.ram_lo.mem);
        $readmemh("build/uart-hi.hex", dut.ram_hi.mem);
        repeat (4) begin #1 clk = 1; #1 clk = 0; end
        div0 = dut.ser.div;
        din = 0;
        for (cyc = 0; cyc < 100000 && !dut.halted && !dut.trapped; cyc = cyc + 1) begin
            #1 clk = 1; #1 clk = 0;
        end
        repeat (2) begin #1 clk = 1; #1 clk = 0; end
        $display("END %0d %0d %0d", dut.halted, dut.trapped, cyc);
        $display("DIV %0d", div0);
        for (k = 0; k < 24; k = k + 1) $display("R %0d %h", k, dut.ram_lo.mem[${RESULT >> 1} + k]);
        $display("N %0d", n);
        for (k = 0; k < 16 && k < n; k = k + 1) $display("T %0d %h %0d", k, got[k], stops[k]);
        $finish;
    end
endmodule
`);

const DIR = process.env.FRUCTUS_RTL ?? 'rtl';
const RTL = ['cpu', 'classify', 'alu', 'ucode', 'lhs', 'dest', 'immgen', 'cond', 'compare', 'uart', 'spiboot']
  .map((m) => `${DIR}/${m}.sv`);
const VIDEO = ['video', 'timing', 'background', 'foreground', 'sprites'].map((m) => `${DIR}/video/${m}.sv`);
execFileSync('iverilog', ['-g2012', '-DFRUCTUS_BLIT', '-DFRUCTUS_UART', '-DNO_ICE40_DEFAULT_ASSIGNMENTS',
  '-o', 'build/uart-tb.vvp', ...RTL, ...VIDEO, CELLS, 'tools/fpga-system.sv', 'build/uart-tb.sv'],
  { stdio: ['ignore', 'ignore', 'inherit'] });
const out = execFileSync('vvp', ['-n', 'build/uart-tb.vvp'], { encoding: 'utf8' });
for (const f of ['uart-lo.hex', 'uart-hi.hex', 'uart-tb.sv', 'uart-tb.vvp']) rmSync(`build/${f}`, { force: true });

const R = new Map([...out.matchAll(/^R (\d+) ([0-9a-fx]+)$/gm)].map((m) => [+m[1], parseInt(m[2], 16)]));
const word = (off) => R.get(off >> 1);
const end = /^END (\d) (\d) (\d+)$/m.exec(out);
const tx = [...out.matchAll(/^T \d+ ([0-9a-fx]+) (\d)$/gm)].map((m) => [parseInt(m[1], 16), +m[2]]);

let bad = 0;
const check = (what, ok, why = '') => {
  if (!ok) { bad++; console.log(`FAIL  ${what}${why ? `: ${why}` : ''}`); }
};
check('the program halts', end && end[1] === '1' && end[2] === '0', end ? `halted ${end[1]}, trapped ${end[2]}` : 'no END');
check('the divisor comes up as 217', /^DIV 217$/m.test(out), /^DIV (.*)$/m.exec(out)?.[1]);
const want = [...SENT, 0x21, ...BUFFERED];
check('the host received every byte sent, in order',
      tx.length === want.length && tx.every(([b], k) => b === want[k]),
      tx.map(([b]) => b.toString(16)).join(' '));
check('every byte sent ended in a stop bit', tx.every(([, s]) => s === 1));
const results = [
  [0,  0,      'status, all sent: idle'],
  [2,  2,      'status, a byte arrived: received'],
  [4,  3,      'status, a byte sent while one waits: busy and received'],
  [6,  0x41,   'the byte received, by ld8'],
  [8,  0,      'received, after the load: clear'],
  [10, 6,      'status, two bytes unread: received and overrun'],
  [12, 0x11,   'the first of them kept, by a word load'],
  [14, 0,      'status after the load: both clear'],
  [16, 2,      'a byte with a low stop bit dropped, the next received, no overrun'],
  [18, 0x3c,   'the byte after the bad one'],
  [20, 0x10,   'status at the end: enabled, nothing waiting'],
  [22, 0x77,   'the handler took the byte'],
  [40, 1,      'the interrupt entered the handler exactly once'],
  [30, BUFFERED.length + 1, 'the transmitter\'s interrupt: an entry a byte, and one to stop'],
  [32, 0,      'status after the buffer: interrupts off, idle'],
];
for (const [off, v, what] of results)
  check(what, word(off) === v, `0x${word(off)?.toString(16)} where 0x${v.toString(16)} was expected`);

if (bad === 0)
  console.log(`ok    rtl/uart.sv in tools/fpga-system.sv: ${want.length} bytes sent, ${BUFFERED.length} of them `
            + `by interrupt, 5 received, overrun, a framing error and the interrupt, in ${end[3]} cycles`);
else {
  console.log(`FAIL  rtl/uart.sv: ${bad} checks failed`);
  process.exit(1);
}
