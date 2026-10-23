// =============================================================================
// data-bytes.mjs - which bytes of an assembled file are data, not code
// =============================================================================
//
// A table among the code - libgcc/lib1funcs.s's __recip_mul has one - stops a
// linear decode: its words are not instructions.  customasm's annotated
// output gives every source line its address and its bytes, so the bytes a
// `dw' or `dd' line made are known exactly, and a checker that walks the
// code steps over them.
// =============================================================================

import { execFileSync } from 'node:child_process';

// The set of data byte addresses in `inp`, a customasm source file that
// assembles from 0.
export function dataBytes(ca, inp) {
  const out = execFileSync(ca, ['-q', '-f', 'annotated', '-p', inp], { encoding: 'utf8' });
  const data = new Set();
  for (const line of out.split('\n')) {
    const m = /^\s*[0-9a-f]+:\d+ \|\s*([0-9a-f]+) \| ((?:[0-9a-f]{2} )*)\s*; (.*)$/.exec(line);
    if (!m || !/^\s*d[wd]\s/.test(m[3])) continue;
    const at = parseInt(m[1], 16), n = m[2].trim().split(/\s+/).filter(Boolean).length;
    for (let i = 0; i < n; i++) data.add(at + i);
  }
  return data;
}
