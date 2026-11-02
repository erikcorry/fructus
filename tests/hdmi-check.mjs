#!/usr/bin/env node
// =============================================================================
// hdmi-check.mjs - rtl/video/tmds.sv and video.sv built with FRUCTUS_HDMI
// =============================================================================
//
//   node tests/hdmi-check.mjs
//
// THE PINS.  Random addresses into tmds.sv, through yosys's own models of the
// IO cells and the global buffer, and the eight pins recorded every half cycle
// of the serial clock.  Each n pin must be its p pin's opposite; the clock lane
// must be 1111100000 for ever; and, cut into tens where the clock rises, each
// lane must be the ROM's symbols, in order, with bit 0 first.  The bit order is
// the point: a DDR pair sent the wrong way round still looks like a busy signal.
//
// THE FRAME.  video.sv built both ways, over the same random memory and palette,
// with VGA's timing.  Every cycle of a frame must agree: the HDMI address is the
// blanking code for the syncs outside the visible area, and inside it a byte
// whose decode through the docs' levels is what the DAC build puts on its pins.
//
// THE ROM.  Every byte's symbols decode, by the TMDS decoder, to its levels.
//
// Needs iverilog and yosys's ice40 cell models.  Skips with a message without.
// =============================================================================

import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';

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
  console.log('skip  tests/hdmi-check.mjs: iverilog or the ice40 cell models not installed');
  process.exit(0);
}

let failed = 0;
const fail = (msg) => { console.log(`FAIL  ${msg}`); failed++; };
const dir = 'build/hdmi-check';
mkdirSync(dir, { recursive: true });

let seed = 0x51c0de11;
const rand = (n) => {
  seed ^= seed << 13; seed >>>= 0;
  seed ^= seed >>> 17;
  seed ^= seed << 5; seed >>>= 0;
  return seed % n;
};

// --- the ROM ---------------------------------------------------------------------
const rom = [];
for (const m of readFileSync('rtl/video/tmds_rom.sv', 'utf8')
  .matchAll(/rom\[8'h([0-9a-f]+)\] = 30'b([01]+)_([01]+)_([01]+);/g))
  rom[parseInt(m[1], 16)] = { r: m[2], g: m[3], b: m[4] };
if (rom.length !== 256) fail(`the ROM has ${rom.length} entries`);

const decode = (s) => {                     // a symbol, bit 9 on the left
  const q = parseInt(s, 2);
  let d = q & 255;
  if (q >> 9 & 1) d ^= 255;
  let out = d & 1;
  for (let i = 1; i < 8; i++) {
    const x = ((d >> i) ^ (d >> (i - 1))) & 1;
    out |= (q >> 8 & 1 ? x : 1 - x) << i;
  }
  return out;
};
// The byte's levels, or null for black.
const levels = (a) => {
  const t = a >> 5, low = a & 15;
  if (t === 0 || low === 15) return null;
  return { g: t - 1, r: Math.floor(low / 5) + 3 * (a >> 4 & 1), b: low % 5 };
};
for (let a = 0; a < 256; a++) {
  if (a >= 4 && a < 8) continue;
  const l = levels(a) ?? { g: 0, r: 0, b: 0 };
  const near = (v, want) => Math.abs(v - want) <= 7;
  if (!near(decode(rom[a].g), l.g * 255 / 6) || !near(decode(rom[a].r), l.r * 255 / 5)
      || !near(decode(rom[a].b), l.b * 255 / 4)) fail(`ROM ${a.toString(16)} decodes wrongly`);
}

// --- the pins ----------------------------------------------------------------------
const WORDS = 2000;
const addrs = Array.from({ length: WORDS }, () => rand(256));
writeFileSync(`${dir}/addrs.hex`, addrs.map((a) => a.toString(16)).join('\n') + '\n');
writeFileSync(`${dir}/pins.sv`, `
\`timescale 1ns/1ps
module tb;
  reg ser = 0; wire pclk; reg [7:0] addr = 0; wire [3:0] p, n;
  reg [7:0] a [0:${WORDS - 1}];
  integer i = 0, f;
  always #4 ser = !ser;
  tmds dut (.ser, .pclk, .addr, .tmds_p(p), .tmds_n(n));
  always @(posedge pclk) begin addr <= a[i]; i <= i + 1; if (i == ${WORDS - 1}) begin $fclose(f); $finish; end end
  initial begin
    $readmemh("${dir}/addrs.hex", a);
    f = $fopen("${dir}/pins.txt", "w");
    #1;                                 // mid-way through each half cycle
    forever begin #4 $fwrite(f, "%b %b\\n", p, n); end
  end
endmodule`);
execFileSync('sh', ['-c',
  `iverilog -g2012 -DNO_ICE40_DEFAULT_ASSIGNMENTS -o ${dir}/pins ${dir}/pins.sv rtl/video/tmds.sv rtl/video/tmds_rom.sv ${CELLS} 2>&1 | grep -v 'sorry\\|warning' ; vvp -n ${dir}/pins`],
  { stdio: 'inherit' });
const samples = readFileSync(`${dir}/pins.txt`, 'utf8').trim().split('\n').map((l) => l.split(' '))
  .filter(([p, n]) => !/[xz]/.test(p + n));
if (samples.length < 19000) fail(`only ${samples.length} defined samples of the pins`);
let opposite = 0;
// Past the first few, where a pair's flops are all still at their power-up 0.
for (const [p, n] of samples.slice(40)) for (let i = 0; i < 4; i++) if (p[i] === n[i]) opposite++;
if (opposite) fail(`${opposite} samples have a pair not opposite`);
const lane = (i) => samples.map(([p]) => p[3 - i]).join('');   // %b prints bit 3 first
const clock = lane(3);
const start = clock.indexOf('1111100000', clock.indexOf('0'));
if (start < 0) fail('the clock lane never shows 1111100000');
for (let i = start; i + 10 <= clock.length; i += 10)
  if (clock.slice(i, i + 10) !== '1111100000') { fail(`clock lane at bit ${i} is ${clock.slice(i, i + 10)}`); break; }
// bit 0 first on the wire: a symbol, read in the order sent, is reversed to bit 9 first.
const words = (bits) => {
  const out = [];
  for (let i = start; i + 10 <= bits.length; i += 10) out.push([...bits.slice(i, i + 10)].reverse().join(''));
  return out;
};
const got = { b: words(lane(0)), g: words(lane(1)), r: words(lane(2)) };
// One fixed latency in pixels: find it on blue, then hold all three to it.  A
// lane may also be off by a whole number of bits from the clock, and must not be.
let latency = -1;
for (let l = 0; l < 8 && latency < 0; l++) {
  let ok = true;
  for (let i = 10; i < 1000 && ok; i++) ok = got.b[i + l] === rom[addrs[i]].b;
  if (ok) latency = l;
}
if (latency < 0) fail(`blue never matches the ROM; first symbols ${got.b.slice(8, 12)}, wanted near ${addrs.slice(8, 12).map((a) => rom[a].b)}`);
else {
  let bad = 0;
  for (let i = 10; i + latency < got.b.length; i++)
    for (const c of 'bgr') if (got[c][i + latency] !== rom[addrs[i]][c]) bad++;
  if (bad) fail(`${bad} symbols differ from the ROM`);
  else console.log(`ok    ${got.b.length} symbols on each of three lanes, bit 0 first, ${latency} pixels late`);
}

// --- the frame ---------------------------------------------------------------------
const H = [16, 96, 48, 640], V = [10, 2, 33, 480];
const htot = H.reduce((a, b) => a + b), vtot = V.reduce((a, b) => a + b);
writeFileSync(`${dir}/mem.hex`, Array.from({ length: 16384 }, () => rand(0x10000).toString(16)).join('\n') + '\n');
// A palette entry may not be 4 - 7; others are as random as can be.
const pal = Array.from({ length: 32 }, () => { let v; do v = rand(256); while (v >= 4 && v < 8); return v; });
const frame = (hdmi) => `
module tb;
  reg clk = 0; always #1 clk = !clk;
  reg [15:0] mem [0:16383]; reg [15:0] q = 0;
  wire rd; wire [13:0] addr; wire hsync_n, vsync_n; wire [9:0] line; wire vblank;
  ${hdmi ? 'wire [7:0] tmds_addr; reg [7:0] rom_q = 0; always @(posedge clk) rom_q <= tmds_addr;  // the ROM\'s register'
    : 'wire [2:0] red, green, blue;'}
  logic [3:0][9:0] h = {10'd${H[3]}, 10'd${H[2]}, 10'd${H[1]}, 10'd${H[0]}};
  logic [3:0][9:0] v = {10'd${V[3]}, 10'd${V[2]}, 10'd${V[1]}, 10'd${V[0]}};
  reg pal_we = 0; reg [4:0] pal_a = 0; reg [7:0] pal_d = 0;
  reg pat_we = 0; reg [9:0] pat_a = 0; reg attr_we = 0; reg [5:0] attr_a = 0;
  video u (.clk, .h_len(h), .v_len(v), .font(15'h6000),
    .pal_we, .pal_addr(pal_a), .pal_data(pal_d),
    .spr_pat_we(pat_we), .spr_pat_addr(pat_a), .spr_pat_data(16'd0),
    .spr_attr_we(attr_we), .spr_attr_addr(attr_a), .spr_attr_data(16'd0),
    .mem_rd(rd), .mem_addr(addr), .mem_rdata(q),
    .hsync_n, .vsync_n, ${hdmi ? '.tmds_addr,' : '.red, .green, .blue,'} .line, .vblank);
  always @(posedge clk) if (rd) q <= mem[addr];
  integer f, i, falls = 0; reg vq = 1;
  reg [7:0] pv [0:31];
  initial begin
    $readmemh("${dir}/mem.hex", mem);
    ${pal.map((p, i) => `pv[${i}] = 8'h${p.toString(16)};`).join(' ')}
    f = $fopen("${dir}/frame-${hdmi ? 'hdmi' : 'vga'}.txt", "w");
    @(negedge clk);
    for (i = 0; i < 32; i++) begin pal_we = 1; pal_a = i; pal_d = pv[i]; @(negedge clk); end
    pal_we = 0;
    for (i = 0; i < 1024; i++) begin pat_we = 1; pat_a = i; @(negedge clk); end
    pat_we = 0;
    for (i = 0; i < 64; i++) begin attr_we = 1; attr_a = i; @(negedge clk); end
    attr_we = 0;
  end
  always @(posedge clk) begin
    vq <= vsync_n;
    if (vq && !vsync_n) falls <= falls + 1;
    if (falls == 3 && vq && !vsync_n) begin $fclose(f); $finish; end
    if (falls == 2) ${hdmi ? `$fwrite(f, "%b %b %h\\n", hsync_n, vsync_n, rom_q);`
      : `$fwrite(f, "%b %b %b%b%b\\n", hsync_n, vsync_n, red, green, blue);`}
  end
endmodule`;
const V_FILES = 'rtl/video/video.sv rtl/video/timing.sv rtl/video/background.sv rtl/video/foreground.sv rtl/video/sprites.sv';
for (const hdmi of [false, true]) {
  const n = hdmi ? 'hdmi' : 'vga';
  writeFileSync(`${dir}/${n}.sv`, frame(hdmi));
  execFileSync('sh', ['-c', `iverilog -g2012 ${hdmi ? '-DFRUCTUS_HDMI' : ''} -o ${dir}/${n} ${dir}/${n}.sv ${V_FILES} 2>&1 | grep -v 'sorry\\|warning'; vvp -n ${dir}/${n}`],
    { stdio: 'inherit' });
}
const lines = (n) => readFileSync(`${dir}/frame-${n}.txt`, 'utf8').trim().split('\n').map((l) => l.split(' '));
const A = lines('vga'), B = lines('hdmi');
if (A.length !== htot * vtot || B.length !== htot * vtot) fail(`frames of ${A.length} and ${B.length} cycles, wanted ${htot * vtot}`);
// The DAC encodings, docs/vga.md "Pin encodings".
const G = ['000', '001', '010', '100', '101', '110', '111'];
const R = ['000', '001', '010', '011', '110', '111'];
const Bl = ['000', '001', '100', '101', '111'];
let blanks = 0, pixels = 0, shown = new Set(), wrong = 0;
for (let i = 0; i < Math.min(A.length, B.length); i++) {
  const [hv, vv, pins] = A[i], [hh, vh, ah] = B[i];
  const a = parseInt(ah, 16);
  if (hv !== hh || vv !== vh) { if (wrong++ < 5) fail(`cycle ${i}: syncs ${hv}${vv} against ${hh}${vh}`); continue; }
  if (a >= 4 && a < 8) {
    blanks++;
    const want = 4 + (hh === '0' ? 1 : 0) + (vh === '0' ? 2 : 0);
    if (a !== want || pins !== '000000000') { if (wrong++ < 5) fail(`cycle ${i}: blanking ${a}, syncs ${hh}${vh}, pins ${pins}`); }
    continue;
  }
  pixels++; shown.add(a);
  const l = levels(a);
  const want = l ? R[l.r] + G[l.g] + Bl[l.b] : '000000000';
  if (pins !== want) { if (wrong++ < 5) fail(`cycle ${i}: byte ${ah} wants ${want}, the DACs show ${pins}`); }
}
if (blanks !== htot * vtot - H[3] * V[3]) fail(`${blanks} cycles of blanking`);
if (pixels !== H[3] * V[3]) fail(`${pixels} visible cycles`);
if (shown.size < 100) fail(`only ${shown.size} different bytes shown: a weak test`);
if (!wrong) console.log(`ok    a whole frame agrees with the DAC build: ${pixels} pixels, ${shown.size} different bytes, ${blanks} blanking cycles`);

if (failed) process.exit(1);
console.log('ok    hdmi-check');
