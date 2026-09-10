#!/usr/bin/env node
// =============================================================================
// dis-check.mjs - binutils' disassembler against ours, operand by operand
// =============================================================================
//
//   node tests/dis-check.mjs tests/stress.s ...
//
// opcodes/fructus-dis.c and tools/decode.js are two independent readings of the
// same `encoding` strings - one hand-written C over a generated table, one
// JavaScript walking the TOML - so making them agree over a real corpus is
// evidence about the ENCODING, not about one copy matching another.
//
// AND IT COMPARES THE OPERANDS.  An earlier version of this check compared
// address, mnemonic and length only, and passed for weeks while
// fructus-dis.c read every eight-bit displacement from byte 2 - which is right
// for the three-byte branches and wrong for the two-byte jmpr, so a short jmpr
// disassembled as a branch to itself.  Structure agreeing is not the same as
// meaning agreeing.  Three real bugs have now come out of this file:
//
//   off8 read from byte 2 unconditionally      short jmpr named itself
//   `mov rd, #imm16' read rd from byte 1       it is in the OPCODE byte, and
//                                              the old field position made the
//                                              wrong read accidentally right
//   rel16 printed as an absolute address       `jmpr' and `jmp' share a layout
//                                              but not a meaning
//
// TILING IS THE OTHER HALF.  Decoding runs linearly from byte 0 and must land
// exactly on the end: a wrong length anywhere desynchronises everything after
// it, so this tests `length_from_first_byte' across a whole file at once.
//
// ONLY THE NUMERIC BASE IS NORMALISED.  objdump writes a mask as 0x8000 and we
// write 32768; both are the same number and neither is wrong.  Everything else
// - punctuation, brackets, operand order, register spelling, branch targets -
// must match character for character.
//
// It did not always.  objdump used to print `ld r0, r1, #4' for `ld r0, [r1,
// #4]', `mov r3, r3, #32767' for `mov r3, #32767', and a bare `add' for the
// pinned one-byte forms - none reassemblable, all from keying the printer on
// the ITYPE, which is a bit layout and not a syntax.  One layout serves
// `ld rd, [ra, #imm3]' and `add rd, ra, #imm3'.  fructus-dis.c now prints
// through the form table's syntax templates instead, so the class is gone
// rather than the instances patched.
// =============================================================================

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadSpec, root } from '../tools/isa.js';
import { buildDecoder, decode, render } from '../tools/decode.js';

const CA  = process.env.CUSTOMASM || 'customasm';
const TMP = process.env.TMPDIR_FRUCTUS || join(root, 'build');
const AS  = process.env.FRUCTUS_AS      || join(root, 'build/binutils/gas/as-new');
const OD  = process.env.FRUCTUS_OBJDUMP || join(root, 'build/binutils/binutils/objdump');

if (!existsSync(AS) || !existsSync(OD)) {
  console.log('note: fructus-elf binutils not built, so the disassemblers were '
            + 'NOT cross-checked (see tools/build-binutils.sh)');
  process.exit(0);
}

const spec = loadSpec();
const dec  = buildDecoder(spec);
const prelude = readFileSync(join(root, 'build/fructus.asm'), 'utf8');

// Hex and decimal are the same number; so are 0x98 and 0x0098.  Compare values.
const norm = (s) => s
  .replace(/0x([0-9a-fA-F]+)/g, (_, h) => String(parseInt(h, 16)))
  .replace(/\s*,\s*/g, ', ')
  .replace(/\s+/g, ' ')
  .trim();

let fail = 0;
for (const src of process.argv.slice(2)) {
  // customasm produces the bytes; gas is not the subject here, the DECODERS are.
  const inp = join(TMP, '_dis.asm'), bin = join(TMP, '_dis.bin');
  writeFileSync(inp, prelude + readFileSync(src, 'utf8'));
  execFileSync(CA, ['-q', '-f', 'binary', '-o', bin, inp]);
  const bytes = readFileSync(bin);

  // Hand the same bytes to binutils as a .byte blob, so no assembler decision
  // can creep in between the two readings.
  const blob = join(TMP, '_dis-bytes.s'), obj = join(TMP, '_dis.o');
  let asm = '\t.text\n';
  for (let i = 0; i < bytes.length; i += 12)
    asm += '\t.byte ' + [...bytes.slice(i, i + 12)]
      .map((x) => '0x' + x.toString(16).padStart(2, '0')).join(',') + '\n';
  writeFileSync(blob, asm);
  execFileSync(AS, ['-o', obj, blob]);

  const rows = execFileSync(OD, ['-d', obj], { encoding: 'utf8' })
    .split('\n')
    .map((l) => /^\s*([0-9a-f]+):\s+((?:[0-9a-f]{2} )+)\s*(.*)$/.exec(l))
    .filter(Boolean)
    .map((m) => ({ addr: parseInt(m[1], 16), n: m[2].trim().split(' ').length,
                   text: m[3] }));

  const mem = new Uint8Array(0x10000);
  mem.set(bytes);

  let pc = 0, n = 0, bad = 0;
  for (const row of rows) {
    const d = decode(dec, mem, pc);
    if (!d) { console.log(`FAIL  ${src}: nothing decodes at 0x${pc.toString(16)}`); bad++; break; }
    if (row.addr !== pc) { console.log(`FAIL  ${src}: objdump is at 0x${row.addr.toString(16)}, we are at 0x${pc.toString(16)}`); bad++; break; }
    if (row.n !== d.nbytes) {
      console.log(`FAIL  ${src} 0x${pc.toString(16)}: objdump reads ${row.n} bytes, we read ${d.nbytes}`);
      bad++; break;
    }
    const theirs = norm(row.text), mine = norm(render(spec, d));
    if (mine !== theirs) {
      console.log(`FAIL  ${src} 0x${pc.toString(16)}: objdump "${theirs}" but we say "${mine}"`);
      bad++;
    }
    pc += d.nbytes;
    n++;
  }

  if (!bad && pc !== bytes.length) {
    console.log(`FAIL  ${src}: decoded ${pc} bytes of ${bytes.length} - does not tile`);
    bad++;
  }
  if (bad) fail = 1;
  else console.log(`ok    ${src}: ${n} instructions, ${pc} bytes, objdump and `
                 + `decode.js agree on every operand`);
}

process.exit(fail);
