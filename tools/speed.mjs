#!/usr/bin/env node
// =============================================================================
// speed.mjs - how fast rtl/ runs on an iCE40 UP5K
// =============================================================================
//
//   node tools/speed.mjs [seeds] [--floorplan | --system]
//                                   (or: just speed, just speed-system)
//
// Synthesises rtl/ with tools/fpga-top.sv - the processor behind one real
// SPRAM, read a word at a time - places it once per seed, and reports the
// median maximum frequency.  --floorplan places it with tools/fpga-top.py,
// whose region CPU_FP in the environment overrides.
//
// --system measures tools/fpga-system.sv instead: the processor built with
// FRUCTUS_BLIT, its 64 KB, the display and its frame buffers, floorplanned by
// tools/fpga-system.py.  Its floor is the pixel clock, 25.175 MHz, which is
// also the processor's clock in that system.
//
// WHY SIXTEEN SEEDS AND A MEDIAN.  nextpnr's placer is randomised, and a single
// placement of this design wanders by two or three MHz - enough to reverse the
// verdict on a change worth one.  The newer figures in rtl/cpu.sv's header are
// medians of sixteen, the older ones of eight, and a comparison is only
// meaningful against a median taken the same way over the same number.
//
// WHAT TO READ.  The median is the number; the spread says how much to trust a
// difference; the critical path's endpoints say where the time goes, which is
// usually more useful than the number.  A change that moves the median by less
// than the spread has not been shown to do anything.
// =============================================================================

import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { promisify } from 'node:util';

const run = promisify(execFile);
const args = process.argv.slice(2);
const SYSTEM = args.includes('--system');
const PLAN = SYSTEM ? 'tools/fpga-system.py' : args.includes('--floorplan') ? 'tools/fpga-top.py' : null;
const SEEDS = Number(args.find((a) => !a.startsWith('--')) ?? 16);
const OUT = SYSTEM ? 'build/speed-system' : 'build/speed';
const MODULES = ['cpu', 'classify', 'alu', 'ucode', 'lhs', 'dest', 'immgen', 'cond', 'compare',
  ...(SYSTEM ? ['video/video', 'video/timing', 'video/background', 'video/foreground', 'video/sprites'] : [])];

const have = async (cmd) => {
  try { await run('sh', ['-c', `command -v ${cmd}`]); return true; } catch { return false; }
};
for (const tool of ['yosys', 'nextpnr-ice40'])
  if (!await have(tool)) {
    console.log(`skip  tools/speed.mjs: ${tool} is not installed`);
    process.exit(0);
  }

mkdirSync(OUT, { recursive: true });
const files = [...MODULES.map((m) => `rtl/${m}.sv`), SYSTEM ? 'tools/fpga-system.sv' : 'tools/fpga-top.sv'];

// --- synthesise once; every seed places the same netlist -----------------------
process.stdout.write('synthesising ... ');
await run('yosys', ['-q', '-p',
  `read_verilog -sv ${SYSTEM ? '-DFRUCTUS_BLIT ' : ''}${files.join(' ')}; synth_ice40 -top top -json ${OUT}/top.json; `
  + `tee -o ${OUT}/top.stat stat`]);
const stat = readFileSync(`${OUT}/top.stat`, 'utf8');
// A design with a kept hierarchy has a section per module and then the
// whole design's, last - which is the one wanted.
const count = (cell) => Number([...stat.matchAll(new RegExp(`${cell}\\s+(\\d+)`, 'g'))].pop()?.[1] ?? 0);
console.log(`${count('SB_LUT4')} LUT4, ${count('SB_RAM40_4K')} block RAMs`);

// --- place once per seed, as many at a time as there are cores -----------------
const place = async (seed) => {
  const log = `${OUT}/s${seed}.log`;
  await run('sh', ['-c',
    `nextpnr-ice40 --up5k --package sg48 --pcf-allow-unconstrained `
    + `--json ${OUT}/top.json --seed ${seed} --freq 50 `
    + (PLAN ? `--pre-place ${PLAN} ` : '')
    + `> ${log} 2>&1 || true`]);
  const text = readFileSync(log, 'utf8');
  const mhz = text.match(/Max frequency for clock '[^']*': ([\d.]+) MHz/g)?.pop();
  if (!mhz) throw new Error(`seed ${seed}: nextpnr reported no frequency, see ${log}`);
  const crit = text.split('Critical path report for clock')[1]?.split('ns logic')[0] ?? '';
  const cells = /Source (\S+)/g, sinks = /Sink (\S+)/g;
  const src = [...crit.matchAll(cells)].map((m) => m[1]);
  const snk = [...crit.matchAll(sinks)].map((m) => m[1]);
  return {
    seed,
    mhz: Number(/([\d.]+) MHz/.exec(mhz)[1]),
    lc: Number(/ICESTORM_LC:\s+(\d+)\//.exec(text)?.[1] ?? 0),
    depth: Math.max(src.length - 1, 0),
    from: src[0] ?? '?',
    to: snk[snk.length - 1] ?? '?',
  };
};

const limit = Math.max(1, Math.min(cpus().length, SEEDS));
const seeds = [...Array(SEEDS).keys()].map((i) => i + 1);
const results = [];
for (let i = 0; i < seeds.length; i += limit)
  results.push(...await Promise.all(seeds.slice(i, i + limit).map(place)));

// --- report --------------------------------------------------------------------
const mhz = results.map((r) => r.mhz).sort((a, b) => a - b);
const median = (mhz[(mhz.length - 1) >> 1] + mhz[mhz.length >> 1]) / 2;
const short = (s) => s.replace(/_SB_.*$/, '').replace(/^u\./, '');

console.log();
for (const r of results)
  console.log(`  seed ${String(r.seed).padStart(2)}  ${r.mhz.toFixed(2).padStart(6)} MHz  `
            + `${String(r.depth).padStart(2)} cells  ${short(r.from).slice(0, 22).padEnd(22)}`
            + ` -> ${short(r.to).slice(0, 26)}`);
console.log();
console.log(`  ${results[0].lc} logic cells, ${count('SB_RAM40_4K')} block RAMs`);
console.log(`  MEDIAN ${median.toFixed(2)} MHz   spread ${mhz[0].toFixed(1)} .. `
          + `${mhz[mhz.length - 1].toFixed(1)}   over ${SEEDS} seeds`);
