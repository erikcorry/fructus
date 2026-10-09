#!/usr/bin/env node
// =============================================================================
// boot-check.mjs - tools/fpga-system.sv from power-up, with a flash behind it
// =============================================================================
//
//   node tests/boot-check.mjs
//
// The whole system, with yosys's models of the SPRAMs and of the SB_IO that
// makes the flash's clock, comes up with its memory empty, as a UP5K's does,
// and a model of a SPI flash on its pins.  rtl/spiboot.sv reads the image out
// of it, rtl/cpu.sv's boot loop stores it, and the processor is reset and
// runs it.  What is checked:
//
//   - the flash saw one read command, 0x03 and the image's offset;
//   - the processor's two SPRAMs hold all 64 KB of the image, byte for byte,
//     once the processor is out of its boot loop - so not a byte was skipped,
//     doubled or shifted, and the last did not wrap round onto the first;
//   - the image's bytes in the I/O page, which would turn blit mode and copy
//     on, set no mode, so the top half went to ram_hi as the image says;
//   - and the program at 0 runs: it sums 256 bytes of the image and halts,
//     which also shows that the guards the loop wrote through did not leave a
//     trap pending.
//
// The flash's output changes a few time units after its clock falls, as a
// real part's does.
//
// Needs iverilog and yosys's ice40 cell models.  Skips with a message when
// either is absent.
// =============================================================================

import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { assemble } from './harness.mjs';

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
  console.log('skip  tests/boot-check.mjs: iverilog or the ice40 cell models not installed');
  process.exit(0);
}
mkdirSync('build', { recursive: true });

const OFFSET = 0x100000;          // rtl/spiboot.sv's default
const TABLE = 0x2000, RESULT = 0x0600;
const src = `
        mov  r1, #${TABLE}
        mov  r2, #${TABLE + 256}
        mov  r0, #0
loop:
        ld8  r3, [r1, #0]
        add  r0, r0, r3
        add  r1, r1, #1
        br   lo, r1, r2, loop
        mov  r4, #${RESULT}
        st   r0, [r4, #0]
        halt
`;
writeFileSync('build/boot-prog.s', src.split('\n').map((l) => l.trim()).join('\n') + '\n');
const { code } = assemble('build/boot-prog.s');
rmSync('build/boot-prog.s', { force: true });

// The image: the program, and random bytes everywhere else - but for the
// mode register, 0x0480, where a byte that would set blit mode and COPY.
let s = 2654435761;
const rnd = () => (s ^= s << 13, s ^= s >>> 17, s ^= s << 5, s >>> 0);
const image = Array.from({ length: 65536 }, () => rnd() & 0xff);
code.forEach((b, k) => { image[k] = b; });
image[0x0480] = 0x06;             // want A, COPY
image[0x0481] = 0x00;
const sum = image.slice(TABLE, TABLE + 256).reduce((a, b) => a + b, 0) & 0xffff;
writeFileSync('build/boot-flash.hex', image.map((b) => b.toString(16).padStart(2, '0')).join('\n') + '\n');

writeFileSync('build/boot-tb.sv', `module tb;
    logic clk = 0, din = 0;
    wire dout, hsync_n, vsync_n; wire [2:0] red, green, blue;
    wire flash_sck, flash_cs_n, flash_mosi;
    logic flash_miso = 0;
    top dut (.clk, .din, .irq(1'b0), .dout, .hsync_n, .vsync_n, .red, .green, .blue,
             .flash_sck, .flash_cs_n, .flash_mosi, .flash_miso);

    // THE FLASH: a command's 32 bits in on the rising clock, then its bytes
    // out on the falling one, most significant bit first, until deselected.
    logic [7:0] flash [0:65535];
    logic [31:0] cmd = 0;
    integer bits = 0, cmds = 0, b;
    always @(posedge flash_cs_n) bits = 0;
    always @(negedge flash_cs_n) cmds = cmds + 1;
    always @(posedge flash_sck) if (flash_cs_n === 1'b0) begin
        if (bits < 32) cmd = {cmd[30:0], flash_mosi};
        bits = bits + 1;
    end
    always @(negedge flash_sck) if (flash_cs_n === 1'b0 && bits >= 32) begin
        b = bits - 32;
        // Past the image, a byte the image does not end with, so that a lap
        // too many - mar wraps - would show at address 0.
        flash_miso <= #3 (b / 8 < 65536 ? flash[cmd[23:0] - 24'h${OFFSET.toString(16)} + b / 8] : ~flash[0])
                         >> (7 - b % 8);
    end

    integer cyc, k, bad;
    logic [15:0] want;
    always #10 clk = ~clk;
    initial begin
        $readmemh("build/boot-flash.hex", flash);
        // The SPRAMs come up with nothing in them.
        for (k = 0; k < 16384; k = k + 1) begin dut.ram_lo.mem[k] = 16'hxxxx; dut.ram_hi.mem[k] = 16'hxxxx; end
        // THE MICROCODE ROM'S OUTPUT holds some word, which the simulator
        // leaves unknown, and with it the ROM's address, all through reset:
        // the flops that would settle it come out of reset unknown first.
        // Reset reaches the boot loop's word 1 from any word within three
        // cycles; this one, with D set, takes the longest.  Given a few
        // cycles into the 40 of reset, once those flops have been reset.
        repeat (4) @(posedge clk);
        #1 dut.u.u.word = 32'h00000008;
        cyc = 4;
        while (dut.boot !== 1'b0 && cyc < 600000) begin @(posedge clk); cyc = cyc + 1; end
        repeat (2) @(posedge clk);
        $display("BOOTED %0d %0d %h", cyc, cmds, cmd);
        bad = 0;
        for (k = 0; k < 32768; k = k + 1) begin
            want = {flash[2 * k + 1], flash[2 * k]};
            if ((k < 16384 ? dut.ram_lo.mem[k] : dut.ram_hi.mem[k - 16384]) !== want) begin
                if (bad < 8) $display("WORD %h %h %h", 16'(2 * k), k < 16384 ? dut.ram_lo.mem[k] : dut.ram_hi.mem[k - 16384], want);
                bad = bad + 1;
            end
        end
        $display("BAD %0d", bad);
        $display("MODE %b %b %b %b", dut.want_a, dut.copy, dut.blit, dut.wthru);
        cyc = 0;
        while (!dut.halted && !dut.trapped && cyc < 20000) begin @(posedge clk); cyc = cyc + 1; end
        repeat (2) @(posedge clk);
        $display("END %0d %0d %0d %h", dut.halted, dut.trapped, cyc, dut.ram_lo.mem[${RESULT >> 1}]);
        $finish;
    end
endmodule
`);

const DIR = process.env.FRUCTUS_RTL ?? 'rtl';
const RTL = ['cpu', 'classify', 'alu', 'ucode', 'lhs', 'dest', 'immgen', 'cond', 'compare', 'recip', 'spiboot']
  .map((m) => `${DIR}/${m}.sv`);
const VIDEO = ['video', 'timing', 'background', 'foreground', 'sprites'].map((m) => `${DIR}/video/${m}.sv`);
execFileSync('iverilog', ['-g2012', '-DFRUCTUS_BLIT', '-DNO_ICE40_DEFAULT_ASSIGNMENTS', '-o', 'build/boot-tb.vvp',
  ...RTL, ...VIDEO, CELLS, 'tools/fpga-system.sv', 'build/boot-tb.sv'], { stdio: ['ignore', 'ignore', 'inherit'] });
const out = execFileSync('vvp', ['-n', 'build/boot-tb.vvp'], { encoding: 'utf8' });
for (const f of ['build/boot-tb.vvp', 'build/boot-tb.sv', 'build/boot-flash.hex']) rmSync(f, { force: true });

const fails = [];
const line = (tag) => out.split('\n').find((l) => l.startsWith(`${tag} `))?.split(' ').slice(1);
const booted = line('BOOTED'), bad = line('BAD'), mode = line('MODE'), end = line('END');
if (!booted || !bad || !mode || !end) {
  console.log(`FAIL  tests/boot-check.mjs: the testbench did not finish\n${out}`);
  process.exit(1);
}
const want = (0x03000000 | OFFSET).toString(16).padStart(8, '0');
if (booted[1] !== '1') fails.push(`the flash was selected ${booted[1]} times, not once`);
if (booted[2] !== want) fails.push(`the flash's command was ${booted[2]}, not ${want}`);
if (bad[0] !== '0') fails.push(`${bad[0]} words of the 32768 differ from the image:\n` +
  out.split('\n').filter((l) => l.startsWith('WORD ')).map((l) => `        ${l}`).join('\n'));
if (mode.join('') !== '0000') fails.push(`the image's bytes in the I/O page set a mode: want_a copy blit wthru ${mode.join(' ')}`);
if (end[0] !== '1' || end[1] !== '0') fails.push(`the program did not halt: halted ${end[0]}, trapped ${end[1]}`);
if (parseInt(end[3], 16) !== sum) fails.push(`the program's sum was ${end[3]}, not ${sum.toString(16).padStart(4, '0')}`);

if (fails.length) {
  for (const f of fails) console.log(`FAIL  tests/boot-check.mjs: ${f}`);
  process.exit(1);
}
console.log(`ok    tests/boot-check.mjs: 64 KB from the flash in ${booted[0]} cycles, every byte in place, `
          + `no mode set from the I/O page, and the program at 0 ran: ${end[2]} cycles to halt`);
