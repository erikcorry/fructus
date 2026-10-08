#!/usr/bin/env node
// =============================================================================
// display-check.mjs - the simulator's display, tools/gpu.js
// =============================================================================
//
//   node tests/display-check.mjs
//
// Compiles tests/display.c, runs it on tools/sim.js with tools/gpu.js
// attached, and checks what the program could not check itself:
//
//   - WRITETHRU's stores reached buffer A and not the processor's memory;
//   - a store to the buffer still shown before the vertical sync was dropped,
//     and so was one to B while it was being copied into;
//   - COPY moved what the display read of A - the line tables and the
//     bands - and nothing else: a word of A never read stayed out of B, and a
//     word of B the display never read kept B's own value;
//   - BLIT's store reached B;
//   - the first frame of A: eight bands of colour, and the sprite;
//
// and the program's own checks, by its exit status: WRITETHRU's loads,
// BLIT's loads, and the status register's line and blank.
//
// The pixels are compared with tools/display.js's arithmetic, which
// tests/video-check.mjs holds to the RTL; this is about the model around it.
// Skips when the compiler is not built.
// =============================================================================

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { loadSpec } from '../tools/isa.js';
import { Machine } from '../tools/sim.js';
import { Gpu } from '../tools/gpu.js';

if (!existsSync('build/gcc/gcc/xgcc') || !existsSync('build/cross-bin/fructus-elf-as')) {
  console.log('skip  tests/display-check.mjs: the compiler is not built');
  process.exit(0);
}
mkdirSync('build', { recursive: true });
execFileSync('tools/fcc', ['-O2', 'tests/display.c', '-o', 'build/_display'], { stdio: 'inherit' });
const image = readFileSync('build/_display.bin');

const spec = loadSpec();
const m = new Machine(spec, { io: true });
m.load(image);
const frames = [];
const gpu = new Gpu(m, { onFrame: (pic) => frames.push(pic) });
const why = m.run({ max: 2e7, stopAt: spec.cpu.vectors.io_guard });
gpu.finish();

let fails = 0, checks = 0;
const check = (name, ok, detail = '') => {
  checks++;
  if (!ok && fails++ < 12) console.log(`  FAIL ${name}${detail ? `: ${detail}` : ''}`);
};
const hex = (v) => `0x${v.toString(16)}`;
const [A, B] = gpu.fb;
const word = (fb, a) => fb[a & 0x7fff] | fb[(a & 0x7fff) + 1] << 8;

check('the program halted', why === 'halted', why);
check('the program\'s own checks', m.R[0] === 0, `check ${m.R[0]} failed`);

// The bands as the program drew them: tests/display.c's DISPLAY_RGB values.
const rgb = (r, g, b) => (g + 1) << 5 | Math.floor(r / 3) << 4 | (r % 3) * 5 + b;
const BANDS = [[5, 0, 0], [0, 6, 0], [0, 0, 4], [5, 6, 0], [0, 6, 4], [5, 0, 4], [5, 6, 4], [2, 3, 2]];
for (let k = 0; k < 8; k++)
  check(`band ${k} in A`, A[0x80 * k] === rgb(...BANDS[k]) && A[0x80 * k + 79] === rgb(...BANDS[k]));
check('WRITETHRU did not store to the processor\'s memory', m.mem[0x8000] === image[0x8000],
      `${hex(m.mem[0x8000])}, the image has ${hex(image[0x8000])}`);
check('WRITETHRU stored to A', word(A, 0x8600) === 0x7e7e);
check('nor did it store 0x7e7e to the processor\'s memory', word(m.mem, 0x8600) !== 0x7e7e || word(image, 0x8600) === 0x7e7e);

check('a store to B while it was still shown was dropped', word(B, 0x8700) === 0, hex(word(B, 0x8700)));
check('a store to B after the sync landed', word(B, 0x8702) === 0x2222, hex(word(B, 0x8702)));
check('a store to B during the copy was dropped', word(B, 0x8704) === 0, hex(word(B, 0x8704)));
check('BLIT stored to B', word(B, 0x8706) === 0x4444, hex(word(B, 0x8706)));

for (const n of [0, 1, 239, 479]) {
  check(`COPY moved line ${n}'s background pointer`, word(B, 0xf800 + 2 * n) === word(A, 0xf800 + 2 * n));
  check(`COPY moved line ${n}'s mode word`, word(B, 0xfc00 + 2 * n) === word(A, 0xfc00 + 2 * n));
}
check('COPY moved band 5\'s pixels', B[0x80 * 5 + 40] === A[0x80 * 5 + 40]);
check('COPY left a word of A the display never read', word(B, 0x8600) === 0, hex(word(B, 0x8600)));
// Text is off on every line, so the character tables are never read.
check('COPY left the unread character table', word(B, 0xf000) === 0, hex(word(B, 0xf000)));

// The frames: the first of A is the swap.  One of B may come before it, when
// a vertical sync falls after the sprite was set up.
const f = frames.find((p) => p.buffer === 'A');
check('a frame of A was drawn', f, `${frames.map((p) => p.buffer)}`);
if (!f) { console.log('display-check: no frame of A'); process.exit(1); }
const at = (x, y) => Array.from(f.rgb.subarray((y * f.width + x) * 3, (y * f.width + x) * 3 + 3));
const want = ([r, g, b]) => [Math.round(r * 255 / 5), Math.round(g * 255 / 6), Math.round(b * 255 / 4)];
check('the frame is 640x480', f.width === 640 && f.height === 480, `${f.width}x${f.height}`);
for (let k = 0; k < 8; k++)
  for (const [x, y] of [[0, 60 * k], [639, 60 * k + 59], [320, 60 * k + 30]])
    if (!(x >= 100 && x < 108 && y >= 100 && y < 121))
      check(`the swap, band ${k} at ${x},${y}`, at(x, y).join() === want(BANDS[k]).join(),
            `${at(x, y)}, want ${want(BANDS[k])}`);
check('the swap, the sprite\'s corner', at(100, 100).join() === '255,255,255', `${at(100, 100)}`);
check('the swap, the sprite\'s last pixel', at(107, 120).join() === '255,255,255', `${at(107, 120)}`);
check('the swap, beside the sprite', at(108, 100).join() === want(BANDS[1]).join(), `${at(108, 100)}`);

if (fails) {
  console.log(`display-check: ${fails} of ${checks} checks failed`);
  process.exit(1);
}
console.log(`ok    tests/display-check.mjs: tools/gpu.js's modes, copy and frames, ${checks} checks, ${frames.length} frames`);
