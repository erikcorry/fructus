// Assemble a source file and hand back a machine loaded with it.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadSpec, root } from '../tools/isa.js';
import { Machine } from '../tools/sim.js';

const CA = process.env.CUSTOMASM || 'customasm';
export const spec = loadSpec();

export function assemble(src) {
  const inp = join(root, 'build/_h.asm');
  const bin = join(root, 'build/_h.bin');
  writeFileSync(inp, readFileSync(join(root, 'build/fructus.asm'), 'utf8') + readFileSync(join(root, src), 'utf8'));
  execFileSync(CA, ['-q', '-f', 'binary', '-o', bin, inp]);
  const syms = new Map();
  for (const line of execFileSync(CA, ['-q', '-f', 'symbols', '-p', inp], { encoding: 'utf8' })
                      .replace(/\x1b\[[0-9;]*m/g, '').split('\n')) {
    const m = /^([\w.]+) = (0x[0-9a-f]+|\d+)$/.exec(line.trim());
    if (m) syms.set(m[1], Number(m[2]));
  }
  return { code: readFileSync(bin), syms };
}

// Call a routine with the given registers and run until it reaches `stopAt`.
export function callRoutine(m, code, entry, stopAt, regs, max = 10000) {
  m.mem.fill(0);
  m.load(code);
  m.R.fill(0);
  m.R[m.named.sp] = 0xfffe;
  // Explicit registers win: add32's second form uses r4:r5 and r6:r7 as data,
  // and r6 IS sp.  A routine that names a register is entitled to it.
  for (const [i, v] of Object.entries(regs)) m.R[i] = v & 0xffff;
  m.pc = entry;
  m.halted = false;
  m.count = 0;
  const why = m.run({ max, stopAt });
  if (why !== 'stopped') throw new Error(`routine did not reach its exit: ${why} at 0x${m.pc.toString(16)}`);
  return m.regs();
}

export const machine = () => new Machine(spec);

// A COST A SOURCE FILE QUOTES IS AN ESTIMATE, and is checked as one: within
// a tenth of what it says.  The branch predictor makes a loop's cost depend
// on what ran before it and on where its branches fall in the table, so the
// exact figure moves with every change to the predictor, and pinning it
// would make each such change an afternoon of editing comments.  A tenth
// still catches what the checks are for - a loop that lost its alignment
// byte, or a path that is not being taken, costs far more than that.
export const near = (got, want) => Math.abs(got - want) <= 0.1 * Math.abs(want);
