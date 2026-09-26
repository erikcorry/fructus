#!/usr/bin/env node
// =============================================================================
// video-check.mjs - rtl/video/video.sv, line tables to DAC pins
// =============================================================================
//
//   node tests/video-check.mjs
//
// A frame buffer with random line tables - every depth code, width, text
// doubling and text disable, mixed line by line - over random memory, and a
// random palette.  The reference computes every cycle of a frame from
// docs/vga.md: the syncs from the timing, and for each visible column the
// background pixel, the glyph bit and foreground colour, the palette, and the
// decode to pin encodings.  The whole frame is compared - syncs, blanking and
// all nine pins - from one falling edge of vsync to the next.
//
// Run with the smallest porches the design allows (front porch 2, sync and
// back porch 6 together) and with standard VGA's, and fails if two readers
// ever share a cycle of the memory port.
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
  console.log('skip  tests/video-check.mjs: iverilog not installed');
  process.exit(0);
}

let seed = 0x7a1e5c0d;
const rand = (n) => {
  seed ^= seed << 13; seed >>>= 0;
  seed ^= seed >>> 17;
  seed ^= seed << 5; seed >>>= 0;
  return seed % n;
};

const LATENCY = 9;
const WORDS = 16384;
const LINES = 24;

// --- the frame buffer ---------------------------------------------------------
const mem = Array.from({ length: WORDS }, () => rand(0x10000));
const DEPTH = [[1, 0x1c], [1, 0x1e], [2, 0x18], [2, 0x08], [3, 0x10], [4, 0x00], [8, 0], [8, 0]];
const table = [];
for (let n = 0; n < LINES; n++) {
  const code = rand(8);
  let wm1 = rand(8);
  if (DEPTH[code][0] === 3) wm1 |= 1;          // 3 bpp: even widths only
  const mode = rand(2) << 15 | rand(2) << 14 | wm1 << 11 | code << 8 | rand(256);
  const t = { bg: rand(32768 - 1024) & ~1, mode, ch: rand(32768), co: rand(32768) };
  table.push(t);
  mem[n] = t.bg; mem[0x200 + n] = t.mode; mem[0x400 + n] = t.ch; mem[0x600 + n] = t.co;
}
const palette = Array.from({ length: 32 }, () => rand(256));

const byte = (a) => (mem[(a & 0x7fff) >> 1] >> ((a & 1) * 8)) & 0xff;

// --- the reference ----------------------------------------------------------
const bgPixel = (t, x) => {
  const [bpp, base] = DEPTH[(t.mode >> 8) & 7];
  const p = Math.floor(x / (((t.mode >> 11) & 7) + 1));
  let v;
  if (bpp === 3) {
    const w = mem[((t.bg >> 1) + Math.floor(p / 5)) % WORDS];
    v = (w >> ((p % 5) * 3)) & 7;
  } else {
    const bit = t.bg * 8 + p * bpp;
    v = (mem[(bit >> 4) % WORDS] >> (bit & 15)) & ((1 << bpp) - 1);
  }
  return bpp === 8 ? v : base | v;
};

const fgPixel = (t, x) => {
  const dbl = (t.mode >> 14) & 1, off = t.mode >> 15;
  const cell = dbl ? x >> 4 : x >> 3;
  const bit = dbl ? (x >> 1) & 7 : x & 7;
  const glyph = byte(0x1000 + (t.mode & 0xff) * 32 + byte(t.ch + cell));
  return { on: !off && (glyph >> (7 - bit)) & 1, color: byte(t.co + cell) };
};

const G = [0, 0b000, 0b001, 0b010, 0b100, 0b101, 0b110, 0b111];   // by t
const R = [0b000, 0b001, 0b010, 0b011, 0b110, 0b111];
const B = [0b000, 0b001, 0b100, 0b101, 0b111];

const pins = (n, x) => {
  const t = table[n];
  const fg = fgPixel(t, x);
  const sel = fg.on ? fg.color : bgPixel(t, x);
  const px = sel >> 5 ? sel : palette[sel & 31];
  const top = px >> 5, c = px & 15;
  if (top === 0 || c === 15) return 0;
  const r = Math.floor(c / 5) + 3 * ((px >> 4) & 1);
  return R[r] << 6 | G[top] << 3 | B[c % 5];
};

// One frame from vsync falling, as [hsync_n, vsync_n, pins] per cycle.
const frame = (h, v) => {
  const htot = h.reduce((a, b) => a + b), vtot = v.reduce((a, b) => a + b);
  const out = [];
  for (let l = 0; l < vtot; l++) {
    // Vertical phases from the start of sync: sync, back porch, visible, front porch.
    const vs = l < v[1];
    const n = l - v[1] - v[2];
    const vvis = n >= 0 && n < v[3];
    for (let hx = 0; hx < htot; hx++) {
      const hs = hx >= h[0] && hx < h[0] + h[1];
      const x = hx - h[0] - h[1] - h[2];
      const on = vvis && x >= 0;
      out.push((hs ? 0 : 1) << 10 | (vs ? 0 : 1) << 9 | (on ? pins(n, x) : 0));
    }
  }
  return out;
};

// --- the testbench ------------------------------------------------------------
const dir = 'build/video-check';
mkdirSync(dir, { recursive: true });
const hex = (v, n) => v.toString(16).padStart(n, '0');
writeFileSync(`${dir}/mem.hex`, mem.map((w) => hex(w, 4)).join('\n') + '\n');
writeFileSync(`${dir}/pal.hex`, palette.map((b) => hex(b, 2)).join('\n') + '\n');

const tb = (h, v) => `
module tb;
    reg clk = 0;
    always #5 clk = ~clk;

    reg  [3:0][9:0] h_len;
    reg  [3:0][9:0] v_len;
    reg         pal_we = 0;
    reg  [4:0]  pal_addr;
    reg  [7:0]  pal_data;
    wire        mem_rd;
    wire [13:0] mem_addr;
    reg  [15:0] mem_rdata;
    wire        hsync_n, vsync_n;
    wire [2:0]  red, green, blue;
    wire [9:0]  line;
    wire        vblank;

    reg [15:0] mem [0:${WORDS - 1}];
    reg [7:0]  pal [0:31];

    video #(.LATENCY(${LATENCY})) dut (
        .clk, .h_len, .v_len, .pal_we, .pal_addr, .pal_data,
        .mem_rd, .mem_addr, .mem_rdata,
        .hsync_n, .vsync_n, .red, .green, .blue, .line, .vblank);

    always @(posedge clk) begin
        if (dut.fg_rd + dut.bg_rd + dut.t_rd > 1) begin
            $display("FAIL two readers in one cycle");
            $finish;
        end
        mem_rdata <= mem_rd ? mem[mem_addr] : 16'hxxxx;
    end

    integer f, i, falls = 0;
    reg vs_prev = 1;
    always @(negedge clk) begin
        if (vs_prev && !vsync_n) falls = falls + 1;
        vs_prev = vsync_n;
        if (falls == 2) $fwrite(f, "%h\\n", {1'b0, hsync_n, vsync_n, red, green, blue});
        if (falls == 3) begin $fclose(f); $finish; end
    end

    initial begin
        h_len[0] = ${h[0]}; h_len[1] = ${h[1]}; h_len[2] = ${h[2]}; h_len[3] = ${h[3]};
        v_len[0] = ${v[0]}; v_len[1] = ${v[1]}; v_len[2] = ${v[2]}; v_len[3] = ${v[3]};
        $readmemh("${dir}/mem.hex", mem);
        $readmemh("${dir}/pal.hex", pal);
        f = $fopen("${dir}/out.txt", "w");
        for (i = 0; i < 32; i = i + 1) begin
            @(negedge clk);
            pal_we = 1; pal_addr = i; pal_data = pal[i];
        end
        @(negedge clk);
        pal_we = 0;
        #10000000;
        $display("FAIL no third vsync");
        $finish;
    end
endmodule
`;

const TIMINGS = [
  ['minimum porches', [2, 3, 3, 640], [2, 2, 3, LINES]],
  ['standard porches', [16, 96, 48, 640], [10, 2, 33, LINES]],
];

let fail = 0;
for (const [name, h, v] of TIMINGS) {
  writeFileSync(`${dir}/tb.sv`, tb(h, v));
  const log = execFileSync('sh', ['-c',
    `iverilog -g2012 -o ${dir}/sim ${dir}/tb.sv rtl/video/video.sv rtl/video/timing.sv ` +
    `rtl/video/background.sv rtl/video/foreground.sv && vvp -n ${dir}/sim`],
    { encoding: 'utf8' });
  if (/FAIL/.test(log)) { console.log(`${name}: ${log.trim()}`); fail++; continue; }

  const got = readFileSync(`${dir}/out.txt`, 'utf8').trim().split('\n').map((s) => parseInt(s, 16));
  const want = frame(h, v);
  const htot = h.reduce((a, b) => a + b);
  const k = want.findIndex((w, j) => got[j] !== w);
  if (got.length !== want.length || k >= 0) {
    fail++;
    const at = k >= 0 ? k : Math.min(got.length, want.length);
    console.log(`FAIL ${name}: line ${Math.floor(at / htot)} cycle ${at % htot} of the frame, ` +
      `got ${hex(got[at] ?? 0, 3)}, want ${hex(want[at] ?? 0, 3)} ` +
      `(${got.length} cycles, want ${want.length})`);
  }
}

if (fail) { console.log(`video-check: ${fail} failures`); process.exit(1); }
console.log(`ok    tests/video-check.mjs: ${TIMINGS.length} timings, every cycle of a ${LINES}-line frame`);
