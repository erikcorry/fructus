#!/usr/bin/env node
// =============================================================================
// dontcare-check.mjs - rtl/ with its don't-cares filled, as synthesis fills them
// =============================================================================
//
//   node tests/dontcare-check.mjs                      zeros, ones, random seed 1
//   node tests/dontcare-check.mjs random:7 --only=x    random seed 7, unread ones
//
// iverilog carries an x through as x, and a flop or a mux select that sees one
// mostly stays x or absorbs it.  Synthesis does neither: it picks a 0 or a 1
// for each, whichever makes the logic smaller.  So a don't-care that something
// reads after all can pass every simulation and break the hardware - both of
// rtl/classify.sv's that did, `two` on the routine rows and `ext` on halt, held
// an instruction in the ALU stage when a fill made them nonzero.
//
// This copies rtl/ to build/dontcare/rtl, rewrites every x digit of every
// literal assigned there to 0, to 1, or to random bits, and runs
// tests/rtl-check.mjs, tests/cpu-check.mjs and tests/blit-check.mjs on the
// copy, through their FRUCTUS_RTL.  They must pass every way.
//
// THE CASE OF THE x SAYS WHY IT IS ONE.  Verilog does not distinguish them;
// this does, so the two can be filled apart with --only:
//
//     x   unread: the value is made, and on this row nothing uses it - every
//         column of rtl/classify.sv, the nibble rtl/immgen.sv overrides.  The
//         hazard is that something latches it anyway.
//     X   never selected: the case input never takes that value on a row that
//         uses the result - rtl/alu.sv's codes folded into the fast group.
//         The hazard is that it does.
//
// Only a literal on the right of an = or <= is filled.  An x in a case item
// or under casex is a pattern, and filling it would change what matches, so
// one anywhere else stops the check rather than being guessed at.
//
// Needs iverilog.  Skips with a message rather than failing when it is absent.
// =============================================================================

import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, readFileSync, writeFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

const have = (cmd) => {
  try { execFileSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }); return true; }
  catch { return false; }
};
if (!have('iverilog')) {
  console.log('skip  tests/dontcare-check.mjs: iverilog not installed');
  process.exit(0);
}

const args = process.argv.slice(2);
const only = args.find((a) => a.startsWith('--only='))?.slice(7);
if (only !== undefined && only !== 'x' && only !== 'X') {
  console.error('dontcare-check: --only=x (unread) or --only=X (never selected)');
  process.exit(2);
}
const modes = args.filter((a) => !a.startsWith('--'));
if (modes.length === 0) modes.push('zero', 'one', 'random:1');

const svFiles = (dir) => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? svFiles(p) : /\.svh?$/.test(f) ? [p] : [];
});

// A sized literal with an x digit, and what stands before it.
const LIT = /(<?=\s*)?(\d+\s*'[bBhH])([0-9a-fA-F_xXzZ?]+)/g;

function fill(dir, mode) {
  const seed = mode.startsWith('random') ? Number(mode.split(':')[1] ?? 1) >>> 0 || 1 : 0;
  let s = seed;
  const rnd = () => (s ^= s << 13, s >>>= 0, s ^= s >>> 17, s ^= s << 5, s >>>= 0);
  const digit = (hex) =>
    mode === 'zero' ? '0' : mode === 'one' ? (hex ? 'f' : '1') : (rnd() & (hex ? 15 : 1)).toString(16);
  const n = { x: 0, X: 0 };
  for (const f of svFiles(dir)) {
    const src = readFileSync(f, 'utf8');
    if (/\bcasex\b/.test(src)) throw new Error(`${f}: casex, whose x digits are patterns`);
    const out = src.split('\n').map((line, i) => line.replace(LIT, (m, assign, base, v) => {
      if (!/[xX]/.test(v)) return m;
      if (!assign) throw new Error(`${f}:${i + 1}: an x outside an assignment - ${line.trim()}`);
      const hex = /[hH]/.test(base);
      return assign + base + v.replace(/[xX]/g, (c) => {
        if (only && c !== only) return c;
        n[c]++;
        return digit(hex);
      });
    })).join('\n');
    if (out !== src) writeFileSync(f, out);
  }
  return n;
}

const WHAT = { zero: 'zeros', one: 'ones' };
const TESTS = ['rtl-check', 'cpu-check', 'blit-check'];
const DIR = 'build/dontcare/rtl';
const TIMEOUT = 300;    // seconds a test may take; cpu-check, the longest, needs 45
let failed = false;
for (const mode of modes) {
  if (!/^(zero|one|random(:\d+)?)$/.test(mode)) {
    console.error(`dontcare-check: ${mode} is not zero, one or random:SEED`);
    process.exit(2);
  }
  rmSync(DIR, { recursive: true, force: true });
  cpSync('rtl', DIR, { recursive: true });
  const n = fill(DIR, mode);
  const what = `${WHAT[mode] ?? `random bits, seed ${mode.split(':')[1] ?? 1}`} (${n.x} x, ${n.X} X)`;
  const bad = [];
  for (const t of TESTS) {
    // A fill that hangs the processor must fail, not wait.  coreutils' timeout
    // signals its whole process group, so the vvp under the test goes too.
    const r = spawnSync('timeout', [String(TIMEOUT), 'node', `tests/${t}.mjs`],
                        { encoding: 'utf8', maxBuffer: 1 << 26, env: { ...process.env, FRUCTUS_RTL: DIR } });
    const out = (r.stdout ?? '') + (r.stderr ?? '');
    if (r.status === 124) bad.push(`      ${t}: did not finish in ${TIMEOUT} s`);
    else if (r.status !== 0 || /^FAIL/m.test(out))
      bad.push(`      ${t}:\n` + out.split('\n').filter((l) => /^FAIL|MISMATCH|Error|^program/.test(l))
        .slice(0, 12).map((l) => `        ${l}`).join('\n'));
  }
  if (bad.length === 0) console.log(`ok    rtl/ with its don't-cares as ${what}: ${TESTS.join(', ')} pass`);
  else { console.log(`FAIL  rtl/ with its don't-cares as ${what}:\n${bad.join('\n')}`); failed = true; }
}
rmSync('build/dontcare', { recursive: true, force: true });
process.exit(failed ? 1 : 0);
