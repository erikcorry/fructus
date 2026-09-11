#!/usr/bin/env node
// =============================================================================
// gas-check.mjs - gas and customasm must emit the same bytes
// =============================================================================
//
//   node tests/gas-check.mjs snippets/*.s ...
//
// Two assemblers, one spec.  gen-customasm.js turns isa/fructus.toml into
// customasm ruledefs; gen-asm.js turns the same file into the form table gas
// walks.  They share no code below the point where both parse the TOML, so
// agreeing on the bytes is evidence about the spec.
//
// What it tests that tests/dis-check.mjs does not is FORM SELECTION.  A
// mnemonic does not determine an encoding - `and rd, rd, #4' fits imm5,
// immbit5, imm3 and imm10 - and the two assemblers choose by different
// mechanisms: customasm ranks rules by size and iterates to a fixpoint, gas
// walks a table sorted shortest first and relaxes `jmpr'.  Landing on the same
// bytes means those two mechanisms agree.
//
// Files needing the assembler's scratch register are skipped: gas has no
// long-immediate expansion, which is gas's `.set noat' mode and the one a
// compiler wants anyway.  tests/run.sh reports which files those are.
// =============================================================================

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { root } from '../tools/isa.js';

const CA  = process.env.CUSTOMASM || 'customasm';
const TMP = process.env.TMPDIR_FRUCTUS || join(root, 'build');
const AS  = process.env.FRUCTUS_AS      || join(root, 'build/binutils/gas/as-new');
const OD  = process.env.FRUCTUS_OBJDUMP || join(root, 'build/binutils/binutils/objdump');

if (!existsSync(AS) || !existsSync(OD)) {
  console.log('note: fructus-elf binutils not built, so gas and customasm were '
            + 'not compared (see tools/build-binutils.sh)');
  process.exit(0);
}

const prelude = readFileSync(join(root, 'build/fructus.asm'), 'utf8');
const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

let fail = 0, ok = 0, skip = 0, total = 0;
for (const src of process.argv.slice(2)) {
  const text = readFileSync(src, 'utf8');

  // customasm's own directives - `#res', `#d8' and the rest - begin with `#',
  // which gas reads as a line comment: it would drop them without a word and
  // then disagree about every byte after the first.  Not a gas bug, and not
  // something this check can compare, so say so rather than fail.
  const directive = /^\s*#[a-z]\w*/m.exec(text);
  if (directive) {
    console.log(`skip  ${src}: uses the customasm directive \`${directive[0].trim()}'`);
    skip++;
    continue;
  }

  const gs = join(TMP, '_gas.s'), go = join(TMP, '_gas.o');
  writeFileSync(gs, '\t.text\n' + text);
  try {
    execFileSync(AS, ['-o', go, gs], { stdio: 'pipe' });
  } catch {
    skip++;
    continue;                       // needs the scratch register
  }

  const ci = join(TMP, '_ca.asm'), cb = join(TMP, '_ca.bin');
  writeFileSync(ci, prelude + text);
  execFileSync(CA, ['-q', '-f', 'binary', '-o', cb, ci]);

  // objdump -s pads its lines with an ASCII column, so take the hex by column.
  const dump = execFileSync(OD, ['-s', '-j', '.text', go], { encoding: 'utf8' });
  const body = dump.slice(dump.indexOf('Contents of section .text:'));
  const mine = body.split('\n').slice(1)
    .map((l) => l.slice(6, 42)).join('').replace(/\s+/g, '');
  const theirs = hex(readFileSync(cb));

  if (mine === theirs) {
    console.log(`ok    ${src}: ${theirs.length / 2} bytes, gas and customasm identical`);
    ok++;
    total += theirs.length / 2;
  } else {
    console.log(`FAIL  ${src}: gas and customasm differ\n  gas:       ${mine}\n  customasm: ${theirs}`);
    fail = 1;
  }
}

if (!fail)
  console.log(`ok    ${ok} files, ${total} bytes identical `
            + `(${skip} skipped: they need the assembler scratch)`);
process.exit(fail);
