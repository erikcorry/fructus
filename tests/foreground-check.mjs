#!/usr/bin/env node
// =============================================================================
// foreground-check.mjs - rtl/video/foreground.sv against docs/vga.md
// =============================================================================
//
//   node tests/foreground-check.mjs
//
// The reference computes every column's glyph bit and foreground colour
// straight from the documented layout - a cell's code at char_ptr + cell, its
// glyph row at font + (font_line << 6) + code - a byte, bit 7 leftmost - or in
// the wide mode font + (font_line << 7) + 2 code - a little-endian word, bit
// 15 leftmost - its colour at
// color_ptr + cell, all little-endian bytes of 16-bit words - and not from
// anything the circuit does.
//
// WHAT IS SWEPT.  8- and 16-column cells, text on and off, over random memory
// with random pointers of either parity - and a random bit 15, which the
// generator must ignore, so that a pointer can be the processor's own address
// of the buffer above 0x8000 - and a random font_line, 24 lines of
// each.  The testbench counts x from column 0 and fails a read on an odd x,
// which belongs to the background generator.  Run at LATENCY 8, the least, and
// 10.
//
// Needs iverilog.  Skips with a message rather than failing when it is absent.
// =============================================================================

import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';

const have = (cmd) => {
  try { execFileSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }); return true; }
  catch { return false; }
};
if (!have('iverilog')) {
  console.log('skip  tests/foreground-check.mjs: iverilog not installed');
  process.exit(0);
}

// A fixed seed: a failure reproduces.
let seed = 0x0f0e0d0c;
const rand = (n) => {
  seed ^= seed << 13; seed >>>= 0;
  seed ^= seed >>> 17;
  seed ^= seed << 5; seed >>>= 0;
  return seed % n;
};

const WORDS = 16384;
const mem = Array.from({ length: WORDS }, () => rand(0x10000));
const byte = (a) => (mem[(a & 0x7fff) >> 1] >> ((a & 1) * 8)) & 0xff;
// The font register, the font's address, at random but even, as a 16-pixel
// font's must be; the address wraps at fifteen bits.  A glyph row, leftmost
// pixel in bit 15: a byte-wide row in the top half, a wide one a whole word.
const FONT = rand(16384) * 2;
const rowAt = (fl, code, wide) => {
  const base = FONT + (fl << (wide ? 7 : 6));
  return wide ? byte(base + 2 * code) | byte(base + 2 * code + 1) << 8 : byte(base + code) << 8;
};

// --- the reference ----------------------------------------------------------
const expected = ({ cp, kp, fl, wide, off }) => {
  const out = [];
  for (let x = 0; x < 640; x++) {
    const cell = wide ? x >> 4 : x >> 3;
    const bit  = wide ? x & 15 : x & 7;
    const row = rowAt(fl, byte(cp + cell), wide);
    const on = off ? 0 : (row >> (15 - bit)) & 1;
    out.push(on << 8 | byte(kp + cell));
  }
  return out;
};

// --- the lines --------------------------------------------------------------
const lines = [];
for (const wide of [0, 1])
  for (const off of [0, 1])
    for (let n = 0; n < 24; n++)
      lines.push({ cp: rand(32768 - 128), kp: rand(32768 - 128), fl: rand(256),
                   cp15: rand(2), kp15: rand(2), wide, off, gap: 3 + rand(158) });

const dir = 'build/foreground-check';
mkdirSync(dir, { recursive: true });
const hex = (v, n) => v.toString(16).padStart(n, '0');
writeFileSync(`${dir}/mem.hex`, mem.map((w) => hex(w, 4)).join('\n') + '\n');
// Bits: 55-48 gap, 43 color_ptr's bit 15, 42 char_ptr's, 41 off, 40 wide,
// 37-30 font_line, 29-15 color_ptr, 14-0 char_ptr.
const pack = (l) => BigInt(l.gap) << 48n | BigInt(l.kp15) << 43n | BigInt(l.cp15) << 42n |
                    BigInt(l.off) << 41n | BigInt(l.wide) << 40n |
                    BigInt(l.fl) << 30n | BigInt(l.kp) << 15n | BigInt(l.cp);
writeFileSync(`${dir}/cfg.hex`, lines.map((l) => pack(l).toString(16).padStart(14, '0')).join('\n') + '\n');

const tb = (latency) => `
module tb;
    reg clk = 0;
    always #5 clk = ~clk;

    reg         ld_mode = 0, ld_char = 0, ld_color = 0, active = 0;
    reg  [15:0] word;
    wire        mem_rd;
    wire [13:0] mem_addr;
    reg  [15:0] mem_rdata;
    wire        fg_on;
    wire [7:0]  fg_color;

    reg [15:0] mem [0:${WORDS - 1}];
    reg [55:0] cfg [0:${lines.length - 1}];

    foreground #(.LATENCY(${latency})) dut (
        .clk, .ld_mode, .ld_char, .ld_color, .font(15'd${FONT}), .word, .active,
        .mem_rd, .mem_addr, .mem_rdata, .fg_on, .fg_color);

    integer x = 0;
    reg act_prev = 0;
    always @(posedge clk) begin
        x = active && !act_prev ? 0 : x + 1;
        act_prev = active;
        if (mem_rd === 1'b1 && x % 2 == 1) begin
            $display("FAIL read on odd x %0d, line %0d", x, i);
            $finish;
        end
        mem_rdata <= mem_rd === 1'b1 ? mem[mem_addr] : 16'hxxxx;
    end

    reg [${latency - 1}:0] act = 0;
    always @(posedge clk) act <= {act, active};

    integer f, i;
    always @(negedge clk)
        if (act[${latency - 1}]) $fwrite(f, "%h ", {3'b000, fg_on, fg_color});

    initial begin
        $readmemh("${dir}/mem.hex", mem);
        $readmemh("${dir}/cfg.hex", cfg);
        f = $fopen("${dir}/out.txt", "w");
        for (i = 0; i < ${lines.length}; i = i + 1) begin
            @(negedge clk);
            // graphics_mode, character_data, character_color, in the order
            // the top level reads them.
            word = {cfg[i][41], cfg[i][40], 6'b0, cfg[i][37:30]};
            ld_mode = 1;
            @(negedge clk);
            ld_mode = 0; word = {cfg[i][42], cfg[i][14:0]}; ld_char = 1;
            @(negedge clk);
            ld_char = 0; word = {cfg[i][43], cfg[i][29:15]}; ld_color = 1;
            @(negedge clk);
            ld_color = 0;
            repeat (cfg[i][55:48] - 3) @(negedge clk);
            active = 1;
            repeat (640) @(negedge clk);
            active = 0;
            repeat (${latency}) @(negedge clk);
            $fwrite(f, "\\n");
            repeat (4) @(negedge clk);
        end
        $fclose(f);
        $finish;
    end
endmodule
`;

let fail = 0;
for (const latency of [8, 10]) {
  writeFileSync(`${dir}/tb.sv`, tb(latency));
  const log = execFileSync('sh', ['-c',
    `iverilog -g2012 -o ${dir}/sim ${dir}/tb.sv rtl/video/foreground.sv && vvp -n ${dir}/sim`],
    { encoding: 'utf8' });
  if (/FAIL/.test(log)) { console.log(log.trim()); fail++; continue; }

  const got = readFileSync(`${dir}/out.txt`, 'utf8').split('\n');
  lines.forEach((l, i) => {
    const g = got[i].trim().split(/\s+/);
    const e = expected(l);
    const x = e.findIndex((v, j) => parseInt(g[j], 16) !== v);
    if (g.length !== 640 || x >= 0) {
      if (fail++ < 10)
        console.log(`FAIL latency ${latency} wide ${l.wide} off ${l.off} char 0x${hex(l.cp, 4)}` +
          ` color 0x${hex(l.kp, 4)} font_line ${l.fl}: column ${x}, got ${g[x]},` +
          ` want ${hex(e[x] ?? 0, 3)} (${g.length} columns)`);
    }
  });
}

if (fail) { console.log(`foreground-check: ${fail} failures`); process.exit(1); }
console.log(`ok    tests/foreground-check.mjs: ${lines.length} lines × 2 latencies, every column`);
