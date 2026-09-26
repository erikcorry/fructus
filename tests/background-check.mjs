#!/usr/bin/env node
// =============================================================================
// background-check.mjs - rtl/video/background.sv against docs/vga.md
// =============================================================================
//
//   node tests/background-check.mjs
//
// The reference here computes every column's byte straight from the documented
// layout - little-endian words, pixels least significant bits first, five to a
// word at 3 bpp, an odd pointer dropping its low byte's pixels - and not from
// anything the circuit does, so agreement means the circuit implements the
// layout.
//
// WHAT IS SWEPT.  Every depth, every width from 1 to 8, odd and even pointers,
// and both parities of the memory slot against column 0, each over random
// memory at a random pointer.  Half the lines put column 0 at the documented
// minimum of 6 cycles after line_start, the rest further out at random.
// A line follows the last one's final column by at most one cycle, so a read
// still in flight when line_start arrives is exercised.  The testbench fails a
// read outside the generator's slot.  Run at LATENCY 1 and 3.
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
  console.log('skip  tests/background-check.mjs: iverilog not installed');
  process.exit(0);
}

// A fixed seed: a failure reproduces.
let seed = 0x5eed1234;
const rand = (n) => {
  seed ^= seed << 13; seed >>>= 0;
  seed ^= seed >>> 17;
  seed ^= seed << 5; seed >>>= 0;
  return seed % n;
};

const WORDS = 16384;
const mem = Array.from({ length: WORDS }, () => rand(0x10000));

// --- the reference ----------------------------------------------------------
const PREFIX = { 1: 0x1c, 2: 0x18, 3: 0x10, 4: 0x00 };

const expected = (ptr, bpp, width) => {
  const out = [];
  for (let x = 0; x < 640; x++) {
    const p = Math.floor(x / width);
    let v;
    if (bpp === 3) {
      const g = (ptr & 1 ? 3 : 0) + p;
      const w = mem[((ptr >> 1) + Math.floor(g / 5)) % WORDS];
      v = (w >> ((g % 5) * 3)) & 7;
    } else {
      const bit = ptr * 8 + p * bpp;
      const w = mem[(bit >> 4) % WORDS];
      v = (w >> (bit & 15)) & ((1 << bpp) - 1);
    }
    out.push(bpp === 8 ? v : PREFIX[bpp] | v);
  }
  return out;
};

// --- the lines --------------------------------------------------------------
const lines = [];
for (const bpp of [1, 2, 3, 4, 8])
  for (let width = 1; width <= 8; width++)
    for (const odd of [0, 1])
      for (const extra of [0, 1]) {
        const ptr = (rand(32768 - 1024) & ~1) | odd;
        const gap = extra ? 6 : 6 + rand(155);   // line_start to column 0; 6 is the minimum
        lines.push({ ptr, bpp, width, gap, extra });
      }

const dir = 'build/background-check';
mkdirSync(dir, { recursive: true });
const hex = (v, n) => v.toString(16).padStart(n, '0');
writeFileSync(`${dir}/mem.hex`, mem.map((w) => hex(w, 4)).join('\n') + '\n');
writeFileSync(`${dir}/cfg.hex`, lines.map((l) =>
  hex((l.extra << 31 | l.gap << 23 | l.width << 19 | l.bpp << 15 | l.ptr) >>> 0, 8)).join('\n') + '\n');

const tb = (latency) => `
module tb;
    reg clk = 0;
    always #5 clk = ~clk;

    reg         line_start = 0, active = 0, slot = 0;
    reg  [14:0] ptr;
    reg  [3:0]  bpp, width;
    wire        mem_rd;
    wire [13:0] mem_addr;
    reg  [15:0] mem_rdata;
    wire [7:0]  pixel;

    reg [15:0] mem [0:${WORDS - 1}];
    reg [31:0] cfg [0:${lines.length - 1}];

    background #(.LATENCY(${latency})) dut (
        .clk, .line_start, .ptr, .bpp, .width, .active,
        .slot, .mem_rd, .mem_addr, .mem_rdata, .pixel);

    always @(posedge clk) begin
        if (mem_rd === 1'b1 && slot !== 1'b1) begin
            $display("FAIL read outside the slot");
            $finish;
        end
        mem_rdata <= mem_rd === 1'b1 ? mem[mem_addr] : 16'hxxxx;
    end

    reg [${latency - 1}:0] act = 0;
    always @(posedge clk) act <= {act, active};

    integer f, i, k;
    always @(negedge clk) begin
        slot <= ~slot;
        if (act[${latency - 1}]) $fwrite(f, "%h ", pixel);
    end

    initial begin
        $readmemh("${dir}/mem.hex", mem);
        $readmemh("${dir}/cfg.hex", cfg);
        f = $fopen("${dir}/out.txt", "w");
        for (i = 0; i < ${lines.length}; i = i + 1) begin
            @(negedge clk);
            ptr = cfg[i][14:0]; bpp = cfg[i][18:15]; width = cfg[i][22:19];
            line_start = 1;
            @(negedge clk);
            line_start = 0;
            repeat (cfg[i][30:23] - 1) @(negedge clk);
            active = 1;
            repeat (640) @(negedge clk);
            active = 0;
            repeat (${latency}) @(negedge clk);
            $fwrite(f, "\\n");
            if (cfg[i][31]) @(negedge clk);
        end
        $fclose(f);
        $finish;
    end
endmodule
`;

let fail = 0;
for (const latency of [1, 3]) {
  writeFileSync(`${dir}/tb.sv`, tb(latency));
  const log = execFileSync('sh', ['-c',
    `iverilog -g2012 -o ${dir}/sim ${dir}/tb.sv rtl/video/background.sv && vvp -n ${dir}/sim`],
    { encoding: 'utf8' });
  if (/FAIL/.test(log)) { console.log(log.trim()); fail++; continue; }

  const got = readFileSync(`${dir}/out.txt`, 'utf8').split('\n');
  lines.forEach((l, i) => {
    const g = got[i].trim().split(/\s+/);
    const e = expected(l.ptr, l.bpp, l.width);
    const x = e.findIndex((v, j) => parseInt(g[j], 16) !== v);
    if (g.length !== 640 || x >= 0) {
      if (fail++ < 10)
        console.log(`FAIL latency ${latency} bpp ${l.bpp} width ${l.width} ptr 0x${hex(l.ptr, 4)}` +
          ` gap ${l.gap}: column ${x}, got ${g[x]}, want ${hex(e[x] ?? 0, 2)} (${g.length} columns)`);
    }
  });
}

if (fail) { console.log(`background-check: ${fail} failures`); process.exit(1); }
console.log(`ok    tests/background-check.mjs: ${lines.length} lines × 2 latencies, every column`);
