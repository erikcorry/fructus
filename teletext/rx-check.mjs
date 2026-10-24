#!/usr/bin/env node
// =============================================================================
// rx-check.mjs - the teletext pages' serial protocol, teletext/rx.h
// =============================================================================
//
//   node teletext/rx-check.mjs
//
// Builds teletext/rx-check.cc with rx.cc and vectors.s on
// ld/fructus-writethru.ld and runs it under tools/fcc-run.mjs with this
// input, a brk for each byte:
//
//   - page A: taken, every row dirty against the empty page before it;
//   - page B, A with one byte of row 3 changed: only row 3 dirty;
//   - a page of 10 bytes and one of 1001: both dropped;
//   - page C, B with 0x9d at the end of row 24: only row 24 dirty, and the
//     byte stored as 0x1d - while the dropped pages were written into the
//     same buffer, so the dirty rows are against B and not against them;
//   - and at the end nothing more to take.
//
// Skips when the compiler is not built.
// =============================================================================

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';

if (!existsSync('build/gcc/gcc/xgcc') || !existsSync('build/cross-bin/fructus-elf-as')) {
  console.log('skip  teletext/rx-check.mjs: the compiler is not built');
  process.exit(0);
}
mkdirSync('build', { recursive: true });
execFileSync('tools/fcc', ['-Os', '-T', 'ld/fructus-writethru.ld', '-Iteletext',
  'teletext/rx-check.cc', 'teletext/rx.cc', 'teletext/vectors.s', '-o', 'build/_teletext-rx'],
  { stdio: 'inherit' });

const a = Uint8Array.from({ length: 1000 }, (_, i) => 0x20 + (i % 90));
const b = Uint8Array.from(a); b[3 * 40 + 5] = 0x41;
const c = Uint8Array.from(b); c[24 * 40 + 39] = 0x9d;
const end = [0];
const input = Uint8Array.from([...a, ...end, ...b, ...end, ...Array(10).fill(0x78), ...end,
  ...Array(1001).fill(0x79), ...end, ...c, ...end]);
writeFileSync('build/_teletext-rx.in', input);

const sum = (page) => page.reduce((s, v) => (s + (v & 0x7f)) & 0xffff, 0);
const expected = [
  `page 0 dirty ${[...Array(25).keys()].join(' ')} sum ${sum(a)}`,
  `page 1 dirty 3 sum ${sum(b)}`,
  `page 0 dirty 24 sum ${sum(c)}`,
  'none',
  'overruns 0',
];

const out = execFileSync('node', ['tools/fcc-run.mjs', 'build/_teletext-rx.bin',
  '--input', 'build/_teletext-rx.in', '--max', '20000000'], { encoding: 'utf8' });
const got = out.trimEnd().split('\n');
let fails = 0;
for (let i = 0; i < Math.max(got.length, expected.length); i++)
  if (got[i] !== expected[i]) {
    fails++;
    console.log(`  FAIL line ${i + 1}: got ${JSON.stringify(got[i])}, expected ${JSON.stringify(expected[i])}`);
  }
console.log(`${fails ? 'FAIL' : 'ok  '}  teletext/rx-check.mjs: ${expected.length} lines of the handler's pages`);
process.exit(fails ? 1 : 0);
