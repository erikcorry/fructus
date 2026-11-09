#!/usr/bin/env node
// =============================================================================
// spi-check.mjs - rtl/spi.sv in tools/fpga-system.sv, and its model
// =============================================================================
//
//   node tests/spi-check.mjs
//
// tests/spi.c, compiled, runs twice: on tools/sim.js with tools/spi.js and
// tools/flash.js, as tools/fcc-run.mjs --flash runs it, and on the WHOLE
// SYSTEM built with FRUCTUS_SPI, its memory preloaded, behind a test bench's
// flash that answers a bit at a time on the pins.  Both flashes start with
// byte a as tests/spi.c's PATTERN (a).  What is checked:
//
//   - the program's own checks pass on both: busy after a store and idle
//     after, the JEDEC ID, 300 bytes read across a page, a sector erased and
//     12 bytes programmed across a page's end in two commands, programming
//     only clearing bits, 0xff from the header with nothing on it, and a
//     write to the control register ending a byte;
//   - every result the program stored agrees between the two, and the
//     busy bit seen by a load 0 to 9 instructions after a store - which is
//     how tools/spi.js's BUSY_FROM and BUSY_TO are held to the hardware;
//   - the erased sector is the same in both flashes afterwards, byte for
//     byte, and nothing else in the RTL's changed;
//   - the flash's chip select was never low while spiboot had the pins: this
//     system is preloaded, so tests/boot-check.mjs --spi boots one with the
//     port built in, which this runs too.
//
// The test bench's flash changes its output a few time units after its clock
// falls, as a real part's does.
//
// Needs iverilog, yosys's ice40 cell models and the compiler.  Skips with a
// message when one is absent.
// =============================================================================

import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { loadSpec } from '../tools/isa.js';
import { Machine } from '../tools/sim.js';
import { Gpu } from '../tools/gpu.js';
import { Flash, FLASH_SIZE } from '../tools/flash.js';
import { attachSpi } from '../tools/spi.js';

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
  console.log('skip  tests/spi-check.mjs: iverilog or the ice40 cell models not installed');
  process.exit(0);
}
if (!existsSync('build/gcc/gcc/xgcc') || !existsSync('build/cross-bin/fructus-elf-as')) {
  console.log('skip  tests/spi-check.mjs: the compiler is not built');
  process.exit(0);
}
mkdirSync('build', { recursive: true });
execFileSync('tools/fcc', ['-Os', 'tests/spi.c', '-o', 'build/_spi'], { stdio: 'inherit' });
const image = new Uint8Array(65536);
image.set(readFileSync('build/_spi.bin').subarray(0, 65536));

const OUT = 0x7e00, NOUT = 40, SECTOR = 0x3ff000;
const pattern = (a) => (a * 7 + (a >>> 8)) & 0xff;
const flashImage = new Uint8Array(FLASH_SIZE);
for (let a = 0; a < FLASH_SIZE; a++) flashImage[a] = pattern(a);

let fails = 0, checks = 0;
const check = (name, ok, detail = '') => {
  checks++;
  if (!ok && fails++ < 12) console.log(`  FAIL ${name}${detail ? `: ${detail}` : ''}`);
};
const hex = (v) => `0x${v.toString(16)}`;

// --- the model -------------------------------------------------------------------
const spec = loadSpec();
const m = new Machine(spec, { io: true });
m.load(image);
const flash = new Flash(flashImage);
let gpu = null;
attachSpi(m, { late: () => gpu.late(), flash, io: spec.cpu.io });
gpu = new Gpu(m, { onFrame: () => {} });
const why = m.run({ max: 2e6, stopAt: spec.cpu.vectors.io_guard });
gpu.finish();
const simOut = Array.from({ length: NOUT }, (_, k) => m.mem[OUT + 2 * k] | m.mem[OUT + 2 * k + 1] << 8);
check('the model: the program halted', why === 'halted', why);
check('the model: the program\'s own checks', simOut[0] === 0, `check ${simOut[0]} failed`);

// --- the hardware ----------------------------------------------------------------
const words = (base) => Array.from({ length: 16384 }, (_, k) => image[base + 2 * k] | image[base + 2 * k + 1] << 8);
const hexw = (a) => a.map((v) => v.toString(16).padStart(4, '0')).join('\n') + '\n';
writeFileSync('build/spi-lo.hex', hexw(words(0)));
writeFileSync('build/spi-hi.hex', hexw(words(0x8000)));
const CYCLES = Math.ceil(m.cycles() * 1.5) + 2000;

writeFileSync('build/spi-tb.sv', `module tb;
    logic clk = 0, din = 1;
    wire hsync_n, vsync_n; wire [2:0] red, green, blue;
    wire flash_sck, flash_cs_n, flash_mosi, spi_cs0_n, spi_cs1_n;
    logic flash_miso = 1;
    top #(.BOOT(0)) dut (.clk, .din, .irq(1'b0), .hsync_n, .vsync_n, .red, .green, .blue,
                         .flash_sck, .flash_cs_n, .flash_mosi, .flash_miso,
                         .spi_cs0_n, .spi_cs1_n);

    // THE FLASH, a bit at a time: each byte in on the rising clock, most
    // significant bit first, and each byte out on the falling one, decided
    // by the bytes before it, as tools/flash.js decides it.
    logic [7:0] flash [0:${FLASH_SIZE - 1}];
    logic [7:0] page [0:255]; logic pm [0:255];
    logic [7:0] inb = 0, cmd = 0, outb = 8'hff; logic [23:0] addr = 0;
    logic wel = 0;
    integer bits = 0, nb = 0, cmds = 0, i;
    function [7:0] respond(input integer n);
        case (cmd)
            8'h03: respond = n >= 4 ? flash[addr + n - 4] : 8'hff;
            8'h0b: respond = n >= 5 ? flash[addr + n - 5] : 8'hff;
            8'h9f: respond = n == 1 ? 8'hef : n == 2 ? 8'h40 : n == 3 ? 8'h16 : 8'hff;
            8'hab: respond = n >= 4 ? 8'h15 : 8'hff;
            8'h05: respond = n >= 1 ? {6'd0, wel, 1'b0} : 8'hff;
            default: respond = 8'hff;
        endcase
    endfunction
    always @(negedge flash_cs_n) begin
        bits = 0; nb = 0; cmds = cmds + 1;
        for (i = 0; i < 256; i = i + 1) pm[i] = 0;
        flash_miso <= #3 1'b1;
    end
    always @(posedge flash_sck) if (flash_cs_n === 1'b0) begin
        inb = {inb[6:0], flash_mosi};
        bits = bits + 1;
        if (bits % 8 == 0) begin
            if (nb == 0) cmd = inb;
            else if (nb <= 3) addr = {addr[15:0], inb};
            else if (cmd == 8'h02) begin page[(addr + nb - 4) & 255] = inb; pm[(addr + nb - 4) & 255] = 1; end
            nb = nb + 1;
        end
    end
    always @(negedge flash_sck) if (flash_cs_n === 1'b0) begin
        if (bits % 8 == 0) outb = respond(nb);
        flash_miso <= #3 outb[7 - bits % 8];
    end
    // Deselected, it stops driving, and the line floats high.
    always @(posedge flash_cs_n) flash_miso <= #3 1'b1;
    always @(posedge flash_cs_n) if (nb > 0) begin
        if (cmd == 8'h06) wel = 1;
        else if (cmd == 8'h04) wel = 0;
        else if (cmd == 8'h20 && nb >= 4) begin
            if (wel) for (i = 0; i < 4096; i = i + 1) flash[{addr[23:12], 12'd0} + i] = 8'hff;
            wel = 0;
        end else if (cmd == 8'h02 && nb >= 4) begin
            if (wel) for (i = 0; i < 256; i = i + 1)
                if (pm[i]) flash[{addr[23:8], 8'd0} + i] = flash[{addr[23:8], 8'd0} + i] & page[i];
            wel = 0;
        end
        nb = 0;
    end
    // spiboot never has the pins here, BOOT being 0; and the header's selects
    // are never low together with the flash's.
    integer clash = 0;
    always @(negedge clk) if (!flash_cs_n && (!spi_cs0_n || !spi_cs1_n)) clash = clash + 1;

    integer cyc, k, changed;
    always #10 clk = ~clk;
    initial begin
        for (k = 0; k < ${FLASH_SIZE}; k = k + 1) flash[k] = 8'(k * 7 + (k >> 8));
        $readmemh("build/spi-lo.hex", dut.ram_lo.mem);
        $readmemh("build/spi-hi.hex", dut.ram_hi.mem);
        repeat (6) @(posedge clk);
        din = 0;
        for (cyc = 0; cyc < ${CYCLES} && dut.halted !== 1'b1 && dut.trapped !== 1'b1; cyc = cyc + 1)
            @(posedge clk);
        repeat (2) @(posedge clk);
        $display("END %0d %0d %0d %0d %0d", dut.halted, dut.trapped, cyc, cmds, clash);
        for (k = 0; k < ${NOUT}; k = k + 1) $display("R %0d %h", k, dut.ram_lo.mem[${OUT >> 1} + k]);
        for (k = 0; k < 4096; k = k + 1) $display("F %h", flash[${SECTOR} + k]);
        changed = 0;
        for (k = 0; k < ${SECTOR}; k = k + 1) if (flash[k] !== 8'(k * 7 + (k >> 8))) changed = changed + 1;
        $display("CHANGED %0d", changed);
        $finish;
    end
endmodule
`);
const files = ['cpu', 'classify', 'alu', 'ucode', 'lhs', 'dest', 'immgen', 'cond', 'compare', 'spiboot', 'spi',
  'video/video', 'video/timing', 'video/background', 'video/foreground', 'video/sprites'].map((f) => `rtl/${f}.sv`);
execFileSync('iverilog', ['-g2012', '-DFRUCTUS_BLIT', '-DFRUCTUS_SPI', '-DNO_ICE40_DEFAULT_ASSIGNMENTS',
  '-o', 'build/spi-tb.vvp', ...files, CELLS, 'tools/fpga-system.sv', 'build/spi-tb.sv'], { stdio: ['ignore', 'ignore', 'inherit'] });
const out = execFileSync('vvp', ['-n', 'build/spi-tb.vvp'], { encoding: 'utf8', maxBuffer: 1 << 26 });
for (const f of ['build/spi-tb.vvp', 'build/spi-tb.sv', 'build/spi-lo.hex', 'build/spi-hi.hex']) rmSync(f, { force: true });
const end = /END (\d+) (\d+) (\d+) (\d+) (\d+)/.exec(out);
// An unknown digit reads as 0: only the busy bit of a byte half shifted in is compared.
const rtlOut = [...out.matchAll(/^R (\d+) ([0-9a-fx]+)$/gm)].map((r) => parseInt(r[2].replace(/x/g, '0'), 16));
const rtlSector = [...out.matchAll(/^F ([0-9a-fx]+)$/gm)].map((r) => parseInt(r[1], 16));
const changed = Number(/CHANGED (\d+)/.exec(out)?.[1] ?? -1);

check('the hardware: the program halted', end && end[1] === '1' && end[2] === '0', end?.[0] ?? 'no END');
check('the hardware: the program\'s own checks', rtlOut[0] === 0, `check ${rtlOut[0]} failed`);
check('the hardware: no header select with the flash\'s', end && end[5] === '0', end?.[5]);
for (let k = 1; k <= 10; k++)
  check(`a load ${k - 1} instructions after a store: busy alike`,
        (rtlOut[k] & 0x8000) === (simOut[k] & 0x8000),
        `hardware ${hex(rtlOut[k])}, model ${hex(simOut[k])}`);
// 33 is the data register after a byte was cut short: half of it is shifted
// in on the hardware, so its busy bit alone.
check('after a byte cut short: idle alike', (rtlOut[33] & 0x8000) === (simOut[33] & 0x8000),
      `hardware ${hex(rtlOut[33])}, model ${hex(simOut[33])}`);
for (let k = 11; k < NOUT; k++) if (k !== 33)
  check(`result ${k} alike`, rtlOut[k] === simOut[k], `hardware ${hex(rtlOut[k])}, model ${hex(simOut[k])}`);
let diff = 0;
for (let k = 0; k < 4096; k++) if (rtlSector[k] !== flash.mem[SECTOR + k]) diff++;
check('the erased sector alike in both flashes', rtlSector.length === 4096 && diff === 0, `${diff} bytes differ`);
check('nothing else in the hardware\'s flash changed', changed === 0, `${changed} bytes`);

// --- and booting, with the port built in --------------------------------------------
let boot = '';
try { boot = execFileSync('node', ['tests/boot-check.mjs', '--spi'], { encoding: 'utf8' }); }
catch (e) { boot = (e.stdout ?? '') + (e.stderr ?? ''); }
check('tests/boot-check.mjs --spi', /^ok/m.test(boot), boot.trim().split('\n').pop());

if (fails) {
  console.log(`spi-check: ${fails} of ${checks} checks failed`);
  process.exit(1);
}
const busyAt = simOut.slice(1, 11).map((v) => (v & 0x8000 ? 1 : 0)).join('');
console.log(`ok    tests/spi-check.mjs: rtl/spi.sv and tools/spi.js alike, ${checks} checks, `
            + `${end[4]} flash commands, busy after a store ${busyAt}, in ${end[3]} cycles`);
