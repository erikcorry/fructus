#!/usr/bin/env node
// =============================================================================
// torture.mjs - GCC's C execute torture tests, on the simulator
// =============================================================================
//
//   node tools/torture.mjs [-O2] [-j N] [name-filter ...]
//
// Compiles every vendor/gcc/gcc/testsuite/gcc.c-torture/execute/*.c with
// tools/fcc, runs it with tools/fcc-run.mjs, and sorts the outcomes:
//
//   pass       exit status 0
//   abort      134 - the test's own check failed
//   exit       any other status
//   timeout    did not halt within the instruction cap
//   ice        internal compiler error
//   compile    the compiler rejected it (often a test needing int >= 32 bits)
//   link       undefined symbols - tallied, to show which libc routines
//              are worth writing next
//   n/a        needs an effective target this port lacks - usually 32-bit
//              int - so it was not run
//
// Results go to build/torture/results<opt>.txt, one line per test, so two
// runs can be diffed.  This is not the DejaGnu harness, but it reads the two
// directives that matter most: dg-require-effective-target, for n/a, and
// dg-options, whose portable flags (-std, -f, -O, -W, -D) are passed on.
// =============================================================================

import { execFile } from 'node:child_process';
import { readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { join, basename } from 'node:path';
import { root } from './isa.js';

const args = process.argv.slice(2);
let opt = '-O2', jobs = cpus().length;
const filters = [];
for (let i = 0; i < args.length; i++) {
  if (/^-O/.test(args[i])) opt = args[i];
  else if (args[i] === '-j') jobs = Number(args[++i]);
  else filters.push(args[i]);
}

const dir = join(root, 'vendor/gcc/gcc/testsuite/gcc.c-torture/execute');
const out = join(root, 'build/torture');
mkdirSync(out, { recursive: true });

let tests = readdirSync(dir).filter((f) => f.endsWith('.c')).sort();
if (filters.length) tests = tests.filter((f) => filters.some((p) => f.includes(p)));

const run = (cmd, argv, timeout) => new Promise((resolve) => {
  execFile(cmd, argv, { timeout, maxBuffer: 1 << 24 }, (err, stdout, stderr) =>
    resolve({ code: err ? (err.killed ? 'killed' : err.code) : 0, stdout, stderr }));
});

const results = [];
const undefs = new Map();

// Effective targets this port does not provide.  A test requiring one is
// reported `n/a' rather than run: most are int32plus, which a 16-bit int
// fails for reasons that say nothing about the compiler.
const MISSING = new Set([
  'int32plus', 'int32', 'int128', 'trampolines', 'untyped_assembly',
  'dfp', 'dfprt', 'fileio', 'mmap', 'c99_runtime', 'run_expensive_tests',
]);

// The test's own dg-options, minus switches for other targets.
function directives(text) {
  const need = [...text.matchAll(/dg-require-effective-target\s+(\w+)/g)].map((m) => m[1]);
  const missing = need.filter((t) => MISSING.has(t));
  const flags = [];
  // Written either `dg-options "-fwrapv"' or `dg-options { "-fwrapv" }'.
  for (const m of text.matchAll(/dg-(?:additional-)?options\s+(?:\{\s*)?"([^"]*)"\s*\}?(?:\s*\{\s*target\s+([^}]*)\})?/g)) {
    if (m[2] && !/\*-\*-\*/.test(m[2])) continue;          // for some other target
    for (const f of m[1].split(/\s+/))
      if (/^-(std=|f|O|W[^l]|D)/.test(f)) flags.push(f);
  }
  return { missing, flags };
}

async function one(file) {
  const name = basename(file, '.c');
  const exe = join(out, name + opt);
  const { missing, flags } = directives(readFileSync(join(dir, file), 'utf8'));
  if (missing.length) return ['n/a', name, missing.join(' ')];
  const c = await run(join(root, 'tools/fcc'),
    // -fpermissive: the tests are old C, with implicit int and implicit
    // declarations, which GCC 14 and later reject by default.  The real
    // torture harness passes it too.
    [opt, '-w', '-fpermissive', '-DSTACK_SIZE=4096', ...flags,
     join(dir, file), '-o', exe], 120000);
  if (c.code !== 0) {
    const text = c.stdout + c.stderr;
    if (/internal compiler error|Segmentation fault/.test(text)) {
      const where = /internal compiler error: (.*)/.exec(text);
      return ['ice', name, where ? where[1] : 'segfault'];
    }
    const u = [...text.matchAll(/undefined reference to `([^']+)'/g)].map((m) => m[1]);
    if (u.length) {
      for (const s of new Set(u)) undefs.set(s, (undefs.get(s) ?? 0) + 1);
      return ['link', name, [...new Set(u)].join(' ')];
    }
    const e = /error: (.*)/.exec(text);
    return ['compile', name, e ? e[1] : text.split('\n')[0]];
  }
  // A generous cap: arith-rand-ll does 64-bit arithmetic in software and needs
  // nearly 200 million instructions to finish.
  const r = await run('node', [join(root, 'tools/fcc-run.mjs'), exe + '.bin', '--max', '400000000'], 900000);
  if (r.code === 0) return ['pass', name, ''];
  if (r.code === 134) return ['abort', name, ''];
  if (r.code === 125 || r.code === 'killed') return ['timeout', name, r.stderr.trim()];
  return ['exit', name, String(r.code)];
}

let next = 0;
async function worker() {
  while (next < tests.length) {
    const t = tests[next++];
    results.push(await one(t));
  }
}
await Promise.all(Array.from({ length: jobs }, worker));

results.sort((a, b) => (a[1] < b[1] ? -1 : 1));
writeFileSync(join(out, `results${opt}.txt`),
  results.map((r) => `${r[0].padEnd(8)} ${r[1]}  ${r[2]}`).join('\n') + '\n');

const count = {};
for (const [k] of results) count[k] = (count[k] ?? 0) + 1;
console.log(`${tests.length} tests at ${opt}:`,
  Object.entries(count).map(([k, v]) => `${k} ${v}`).join(', '));
const top = [...undefs].sort((a, b) => b[1] - a[1]).slice(0, 25);
if (top.length) console.log('undefined:', top.map(([s, n]) => `${s} ${n}`).join(', '));
const ices = results.filter((r) => r[0] === 'ice');
const byIce = new Map();
for (const [, n, w] of ices) byIce.set(w, [...(byIce.get(w) ?? []), n]);
for (const [w, ns] of [...byIce].sort((a, b) => b[1].length - a[1].length).slice(0, 10))
  console.log(`ice ${ns.length}: ${w}  (${ns.slice(0, 3).join(' ')})`);
