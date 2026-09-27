#!/usr/bin/env node
// =============================================================================
// video-check.mjs - rtl/video/video.sv, line tables to DAC pins
// =============================================================================
//
//   node tests/video-check.mjs
//
// A frame buffer with random line tables - every depth code, width, text
// 16-pixel fonts and text disable, mixed line by line - over random memory, a
// random palette, and sixteen random sprites, half transparent, overlapping and
// partly off the screen's edges.  The reference computes every cycle of a frame from
// docs/vga.md: the syncs from the timing, and for each visible column the
// background pixel, the glyph bit and foreground colour, the palette, and the
// decode to pin encodings.  The whole frame is compared - syncs, blanking and
// all nine pins - from one falling edge of vsync to the next.
//
// Run with the smallest porches the design allows - front porch 6, sync and
// back porch 5 together; 5 and 4 fail - and with standard VGA's, and fails if
// two readers ever share a cycle of the memory port.
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

const LATENCY = 8;
const WORDS = 16384;
const LINES = 24;

// --- the frame buffer ---------------------------------------------------------
const mem = Array.from({ length: WORDS }, () => rand(0x10000));
const DEPTH = [[1, 0x1c], [1, 0x1e], [2, 0x18], [2, 0x08], [3, 0x10], [4, 0x00], [8, 0], [8, 0]];
const table = [];
// The font register, the font's address, at random but even.
const FONT = rand(16384) * 2;
for (let n = 0; n < LINES; n++) {
  const code = rand(8);
  let wm1 = rand(8);
  if (DEPTH[code][0] === 3) wm1 |= 1;          // 3 bpp: even widths only
  const mode = rand(2) << 15 | rand(2) << 14 | wm1 << 11 | code << 8 | rand(256);
  // Every pointer with a random bit 15, which the display must ignore, so that
  // a pointer can be the processor's own address of the buffer above 0x8000.
  const t = { bg: (rand(32768 - 1024) & ~1) | rand(2) << 15, mode, ch: rand(65536), co: rand(65536) };
  table.push(t);
  // The tables are the top 4 KB of the buffer, the text generator's lowest.
  mem[0x3c00 + n] = t.bg; mem[0x3e00 + n] = t.mode; mem[0x3800 + n] = t.ch; mem[0x3a00 + n] = t.co;
}
const palette = Array.from({ length: 32 }, () => rand(256));

// Sixteen sprite patterns of 64 words, eight 2-bit pixels to a word, about
// half the pixels transparent.
const px2 = () => rand(2) ? 0 : 1 + rand(3);
const patterns = Array.from({ length: 1024 }, () => {
  let w = 0;
  for (let i = 0; i < 8; i++) w |= px2() << (2 * i);
  return w;
});

// A sprite's attributes, as the engine's four words; x and y are screen
// coordinates + 48 and + 42.
const attrWords = (a) => [a.x | a.dh << 10 | a.p << 11, a.y,
                          a.c[0] | a.c[1] << 4 | a.c[2] << 8, 0];

// Sixteen sprites for a screen W columns wide: two overlapping, the front one
// with a transparent colour, one off the
// top-left at double height, one across the right edge at double height, one
// wrapped round the end of the line buffer into the invisible margin, one
// below the screen, and the rest anywhere.
const spriteSet = (W) => {
  const colours = () => [rand(16), rand(16), rand(16)];
  const set = [
    { x: 48 + 100, y: 42 + 2, dh: 0 },
    { x: 48 + 110, y: 42 + 5, dh: 0 },
    { x: 48 - 10, y: 42 - 10, dh: 1 },
    { x: 48 + W - 10, y: 42 + 12, dh: 1 },
    { x: 1020, y: 42 + 3, dh: 0 },
    { x: 48 + 300, y: 42 + 100, dh: 1 },
  ];
  while (set.length < 16)
    set.push({ x: rand(1024), y: 42 - 45 + rand(80), dh: rand(2) });
  const sprites = set.map((a) => ({ ...a, p: rand(16), c: colours() }));
  // Sprite 0's value 2 is transparent, over sprite 1: the transparency test
  // must come after the 2-bit value becomes a colour, or sprite 0 punches
  // holes in sprite 1.
  sprites[0].c = [1 + rand(15), 0, 1 + rand(15)];
  sprites[1].c = [1 + rand(15), 1 + rand(15), 1 + rand(15)];
  return sprites;
};

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
  const wide = (t.mode >> 14) & 1, off = t.mode >> 15;
  const cell = wide ? x >> 4 : x >> 3;
  const bit = wide ? x & 15 : x & 7;
  const base = FONT + ((t.mode & 0xff) << (wide ? 7 : 6)), code = byte(t.ch + cell);
  const row = wide ? byte(base + 2 * code) | byte(base + 2 * code + 1) << 8 : byte(base + code) << 8;
  return { on: !off && (row >> (15 - bit)) & 1, color: byte(t.co + cell) };
};

const G = [0, 0b000, 0b001, 0b010, 0b100, 0b101, 0b110, 0b111];   // by t
const R = [0b000, 0b001, 0b010, 0b011, 0b110, 0b111];
const B = [0b000, 0b001, 0b100, 0b101, 0b111];

// Attribute writes during the compared frame, each on visible line `line` at
// cycle `k` after that line's horizontal wrap.  Sprite s's word w is read at
// cycle readAt(s, w) = 257 + 28·(15 - s) + w after the wrap of the line before the one it
// draws, so a write during line n is drawn from line n + 1 if k < readAt(s, w) and from
// line n + 2 otherwise.  Each is one cycle either side of its read.
const readAt = (s, w) => 257 + 28 * (15 - s) + w;
const EVENTS = [
  { line: 5,  s: 3, w: 1, k: readAt(3, 1) - 1, patch: { y: 42 + 4 } },
  { line: 9,  s: 3, w: 0, k: readAt(3, 0) + 1, patch: { x: 48 + 300 } },
  { line: 12, s: 0, w: 2, k: readAt(0, 2) - 1, patch: { c: [7, 0, 9] } },
  { line: 14, s: 5, w: 1, k: readAt(5, 1) + 1, patch: { y: 42 + 10 } },
];

// The attributes line L is drawn with: the frame's starting set, with every
// write that lands before its read in the build of L, during line L - 1.
const attrsFor = (set, L) => {
  const out = set.map((a) => ({ ...a }));
  for (const e of EVENTS)
    if (e.line < L - 1 || (e.line === L - 1 && e.k < readAt(e.s, e.w)))
      Object.assign(out[e.s], e.patch);
  return out;
};

// Each write's word, from the attributes as they stand after the writes
// before it.
const eventWords = (set) => {
  const cur = set.map((a) => ({ ...a }));
  return EVENTS.map((e) => {
    Object.assign(cur[e.s], e.patch);
    return { ...e, addr: 4 * e.s + e.w, data: attrWords(cur[e.s])[e.w] };
  });
};

// The sprites' pixel at (x, n): the lowest-numbered sprite with a colour that
// is not 0 there, or 0.  Positions wrap round the 1024-pixel line buffer.
const spritePixel = (set0, n, x) => {
  const set = attrsFor(set0, n);
  for (const a of set) {
    const dy = n + 42 - a.y;
    if (dy < 0 || dy >= (a.dh ? 42 : 21)) continue;
    const row = a.dh ? dy >> 1 : dy;
    const dx = (x + 48 - a.x) & 1023;
    if (dx >= 24) continue;
    const v = (patterns[a.p * 64 + row * 3 + (dx >> 3)] >> ((dx & 7) * 2)) & 3;
    if (v && a.c[v - 1]) return a.c[v - 1];
  }
  return 0;
};

const pins = (set, n, x) => {
  const t = table[n];
  const fg = fgPixel(t, x);
  const cp = spritePixel(set, n, x);
  const sel = cp ? cp : fg.on ? fg.color : bgPixel(t, x);
  const px = sel >> 5 ? sel : palette[sel & 31];
  const top = px >> 5, c = px & 15;
  if (top === 0 || c === 15) return 0;
  const r = Math.floor(c / 5) + 3 * ((px >> 4) & 1);
  return R[r] << 6 | G[top] << 3 | B[c % 5];
};

// One frame from vsync falling, as [hsync_n, vsync_n, pins] per cycle.
const frame = (h, v, set) => {
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
      out.push((hs ? 0 : 1) << 10 | (vs ? 0 : 1) << 9 | (on ? pins(set, n, x) : 0));
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
writeFileSync(`${dir}/pat.hex`, patterns.map((w) => hex(w, 4)).join('\n') + '\n');

const tb = (h, v, set) => `
module tb;
    reg clk = 0;
    always #5 clk = ~clk;

    reg  [3:0][9:0] h_len;
    reg  [3:0][9:0] v_len;
    reg         pal_we = 0;
    reg  [4:0]  pal_addr;
    reg  [7:0]  pal_data;
    reg         spr_pat_we = 0, spr_attr_we = 0;
    reg  [9:0]  spr_pat_addr;
    reg  [5:0]  spr_attr_addr;
    reg  [15:0] spr_pat_data, spr_attr_data;
    wire        mem_rd;
    wire [13:0] mem_addr;
    reg  [15:0] mem_rdata;
    wire        hsync_n, vsync_n;
    wire [2:0]  red, green, blue;
    wire [9:0]  line;
    wire        vblank;

    reg [15:0] mem [0:${WORDS - 1}];
    reg [7:0]  pal [0:31];
    reg [15:0] pat [0:1023];

    integer f, i, falls = 0;

    // The attribute writes during the compared frame, at cycle kc after a
    // horizontal wrap on the given visible line.
    integer kc = 0, e;
    reg         ev_we = 0;
    reg  [5:0]  ev_a;
    reg  [15:0] ev_d;
    always @(negedge clk) begin
        kc = dut.h_wrap ? 0 : kc + 1;
        ev_we = 0;
        if (falls == 2 && dut.v_state == 2'd3) begin
${eventWords(set).map((e) => `            if (dut.n == ${e.line} && kc == ${e.k}) begin ev_we = 1; ev_a = ${e.addr}; ev_d = 16'h${hex(e.data, 4)}; end`).join('\n')}
        end
    end
    reg [15:0] attr [0:63];

    video #(.LATENCY(${LATENCY})) dut (
        .clk, .h_len, .v_len, .font(15'd${FONT}), .pal_we, .pal_addr, .pal_data,
        .spr_pat_we, .spr_pat_addr, .spr_pat_data,
        .spr_attr_we(spr_attr_we || ev_we),
        .spr_attr_addr(ev_we ? ev_a : spr_attr_addr),
        .spr_attr_data(ev_we ? ev_d : spr_attr_data),
        .mem_rd, .mem_addr, .mem_rdata,
        .hsync_n, .vsync_n, .red, .green, .blue, .line, .vblank);

    always @(posedge clk) begin
        if (dut.fg_rd + dut.bg_rd + dut.t_rd > 1) begin
            $display("FAIL two readers in one cycle");
            $finish;
        end
        mem_rdata <= mem_rd ? mem[mem_addr] : 16'hxxxx;
    end

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
        $readmemh("${dir}/pat.hex", pat);
${set.flatMap(attrWords).map((w, i) => `        attr[${i}] = 16'h${hex(w, 4)};`).join('\n')}
        f = $fopen("${dir}/out.txt", "w");
        for (i = 0; i < 32; i = i + 1) begin
            @(negedge clk);
            pal_we = 1; pal_addr = i; pal_data = pal[i];
        end
        @(negedge clk);
        pal_we = 0;
        for (i = 0; i < 1024; i = i + 1) begin
            spr_pat_we = 1; spr_pat_addr = i; spr_pat_data = pat[i];
            @(negedge clk);
        end
        spr_pat_we = 0;
        for (i = 0; i < 64; i = i + 1) begin
            spr_attr_we = 1; spr_attr_addr = i; spr_attr_data = attr[i];
            @(negedge clk);
        end
        spr_attr_we = 0;
        #10000000;
        $display("FAIL no third vsync");
        $finish;
    end
endmodule
`;

// A line must be at least 705 cycles for the sprite engine, so the smallest
// porches go with a wider picture.
const TIMINGS = [
  ['minimum porches', [6, 3, 2, 704], [2, 2, 3, LINES]],
  ['standard porches', [16, 96, 48, 640], [10, 2, 33, LINES]],
];

let fail = 0;
for (const [name, h, v] of TIMINGS) {
  const set = spriteSet(h[3]);
  writeFileSync(`${dir}/tb.sv`, tb(h, v, set));
  const log = execFileSync('sh', ['-c',
    `iverilog -g2012 -o ${dir}/sim ${dir}/tb.sv rtl/video/video.sv rtl/video/timing.sv ` +
    `rtl/video/background.sv rtl/video/foreground.sv rtl/video/sprites.sv && vvp -n ${dir}/sim`],
    { encoding: 'utf8' });
  if (/FAIL/.test(log)) { console.log(`${name}: ${log.trim()}`); fail++; continue; }

  const got = readFileSync(`${dir}/out.txt`, 'utf8').trim().split('\n').map((s) => parseInt(s, 16));
  const want = frame(h, v, set);
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
