#!/usr/bin/env node
// =============================================================================
// roundtrip.mjs - assemble, decode, re-assemble, compare
// =============================================================================
//
// The assembler and the decoder read the same `encoding` strings and share no
// code below that, so this is two independent implementations of the encoding
// checked against each other:
//
//      source -> customasm -> bytes -> tools/decode.js -> text -> customasm
//
// and the two byte streams must be identical.  What that catches is the class
// of bug check.js cannot: an encoding that is well formed and unambiguous on
// paper but that the assembler and a reader disagree about - a field's bits
// gathered in the wrong order, a split field reassembled backwards, a signed
// immediate read unsigned.  Every one of those round-trips wrong and validates
// clean.
//
// It also proves each binary TILES: decoding linearly from 0 must consume
// every byte and land exactly on the end.  A wrong length anywhere desynchronises
// the rest of the file, so this is a sharp test of `length_from_first_byte`.
//
//      node tests/roundtrip.mjs snippets/*.s tests/stress.s
// =============================================================================

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadSpec, root } from '../tools/isa.js';
import { buildDecoder, decode, render } from '../tools/decode.js';

const CA   = process.env.CUSTOMASM || 'customasm';
const TMP  = process.env.TMPDIR_FRUCTUS || join(root, 'build');
const spec = loadSpec();
const dec  = buildDecoder(spec);
const prelude = readFileSync(join(root, 'build/fructus.asm'), 'utf8');

function assemble(src, tag) {
  const inp = join(TMP, `_rt${tag}.asm`), out = join(TMP, `_rt${tag}.bin`);
  writeFileSync(inp, prelude + src);
  execFileSync(CA, ['-q', '-f', 'binary', '-o', out, inp]);
  return readFileSync(out);
}

let fail = 0;
for (const f of process.argv.slice(2)) {
  const bin = assemble(readFileSync(f, 'utf8'), 'a');
  const mem = new Uint8Array(0x10000);
  mem.set(bin);

  const lines = [];
  let pc = 0, n = 0, broke = false;
  while (pc < bin.length) {
    const d = decode(dec, mem, pc);
    if (!d) {
      console.log(`FAIL  ${f}: nothing decodes at 0x${pc.toString(16)} (first byte 0x${mem[pc].toString(16)})`);
      fail = 1; broke = true; break;
    }
    if (pc + d.nbytes > bin.length) {
      console.log(`FAIL  ${f}: ${d.insn.mnemonic} at 0x${pc.toString(16)} claims ${d.nbytes} bytes and runs past the end`);
      fail = 1; broke = true; break;
    }
    lines.push(render(spec, d));
    pc += d.nbytes; n++;
  }
  if (broke) continue;

  const bin2 = assemble(lines.join('\n') + '\n', 'b');
  const same = bin.length === bin2.length && bin.every((b, i) => b === bin2[i]);
  if (same) {
    console.log(`ok    ${f}  ${bin.length} bytes, ${n} instructions, round trip identical`);
  } else {
    fail = 1;
    console.log(`FAIL  ${f}  ${bin.length} bytes in, ${bin2.length} out`);
    for (let i = 0; i < Math.max(bin.length, bin2.length); i++) {
      if (bin[i] !== bin2[i]) {
        const at = lines.findIndex((_, k) => k >= 0) ;
        console.log(`  first difference at 0x${i.toString(16)}: ${(bin[i] ?? -1).toString(16)} -> ${(bin2[i] ?? -1).toString(16)}`);
        break;
      }
    }
  }
}
process.exit(fail);
