#!/usr/bin/env node
// =============================================================================
// check.mjs - terminal/terminal.cc, bytes to cells, against cases by hand
// =============================================================================
//
//   node terminal/check.mjs
//
// The generated tables must be what their generators make, and font.h's
// glyphs() must give the codes gen-font.mjs's rule does, for every base with
// every mark.
//
// Each case is bytes in and what terminal/dump.cc should say: the first lines
// of the screen, the cursor, the answers sent, and for some a line of colour
// runs.  Every case runs on the host, built with g++, and on Fructus under
// tools/fcc-run.mjs, which is skipped when the compiler is not built.
// =============================================================================

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const SOURCES = ['terminal/dump.cc', 'terminal/terminal.cc', 'terminal/decompose.cc', 'terminal/font.cc'];
const E = '\x1b', CSI = E + '[';
const a80 = 'a'.repeat(80);

// [name, input, lines from the top, [x, y], sends, { line: runs }]
const cases = [
  ['pending wrap', a80 + 'b', [a80, 'b'], [1, 1]],
  ['no wrap after CR', a80 + '\rX', ['X' + 'a'.repeat(79), ''], [1, 0]],
  ['autowrap off', `${CSI}?7l${'a'.repeat(79)}bc`, ['a'.repeat(79) + 'c'], [79, 0]],
  ['region scroll', `0\r\n1\r\n2\r\n3\r\n4${CSI}2;4r${CSI}4;1H\n`, ['0', '2', '3', '', '4'], [0, 3]],
  ['insert line', `0\r\n1\r\n2\r\n3${CSI}2;1H${CSI}L`, ['0', '', '1', '2', '3'], [0, 1]],
  ['delete lines', `0\r\n1\r\n2\r\n3${CSI}2;1H${CSI}2M`, ['0', '3', ''], [0, 1]],
  ['reverse index', `a${CSI}1;1H${E}M`, ['', 'a'], [0, 0]],
  ['insert cells', `abcdef${CSI}1;3H${CSI}2@`, ['ab  cdef'], [2, 0]],
  ['delete cells', `abcdef${CSI}1;2H${CSI}2P`, ['adef'], [1, 0]],
  ['erase cells', `abcdef${CSI}1;2H${CSI}3X`, ['a   ef'], [1, 0]],
  ['erase below', `abc\r\ndef${CSI}1;2H${CSI}J`, ['a', ''], [1, 0]],
  ['erase line left', `abcdef${CSI}1;3H${CSI}1K`, ['   def'], [2, 0]],
  ['erase in the background', `${CSI}44m${CSI}2J`, [''], [0, 0], [], { 0: '0-79 fg b3 bg 23' }],
  ['insert mode', `abc\r${CSI}4hX`, ['Xabc'], [1, 0]],
  ['accents', 'iíįéíįÅǰľé̂',
    ['iı́įéı́įÅȷ̌ľé'], [10, 0]],
  ['mark after a pending wrap', a80 + '́', ['a'.repeat(79) + 'á'], [79, 0]],
  ['bad UTF-8', Buffer.from([0x61, 0xff, 0x62, 0xc3, 0x28, 0x63, 0xc0, 0xaf]),
    ['a�b�(c��'], [8, 0]],
  // Wide, and not in the font.
  ['wide at the edge', 'x'.repeat(79) + '中', ['x'.repeat(79), '�'], [2, 1]],
  ['past U+FFFF', '\u{1f600}!', ['� !'], [3, 0]],
  ['line drawing', `${E}(0lq\x0eq\x0fq${E}(Bq`, ['┌─q─q'], [5, 0]],
  ['tabs', `a\tb${CSI}3g\tc`, ['a       b' + ' '.repeat(70) + 'c'], [79, 0]],
  ['tab stop set', `${CSI}3g${CSI}1;5H${E}H\r\tX`, ['    X'], [5, 0]],
  ['repeat', `ab${CSI}3b`, ['abbbb'], [5, 0]],
  ['cursor report in origin mode', `${CSI}5;10r${CSI}?6h${CSI}2;3H${CSI}6n`, [], [2, 5], [`${E}[2;3R`]],
  ['device attributes', `${CSI}c${CSI}>c`, [], [0, 0], [`${E}[?1;2c`, `${E}[>0;0;0c`]],
  // xterm leaves the cursor where it was.
  ['alternate screen', `main${CSI}?1049halt`, ['    alt'], [7, 0]],
  ['back from it', `main${CSI}?1049halt${CSI}?1049l`, ['main'], [4, 0]],
  ['save and restore', `${CSI}31mab${E}7${CSI}0m${CSI}5;5Hx${E}8y`, ['aby', '', '', '', '    x'], [3, 0], [],
    { 0: '0-2 fg 30 bg 20 3-79 fg b3 bg 20' }],
  ['SGR', `${CSI}1mA${CSI}22;31mB${CSI}1mC${CSI}38;5;196mD${CSI}38;2;0;255;0mE${CSI}0;7mF${CSI}0;4mG`,
    ['ABCDEFG'], [7, 0], [],
    { 0: '0-0 fg fe bg 20 1-1 fg 30 bg 20 2-2 fg 7b bg 20 3-3 fg 3a bg 20 4-4 fg e0 bg 20 5-5 fg 20 bg b3 6-6 fg b3 bg 20 u 7-79 fg b3 bg 20' }],
  ['strings and CAN', `${E}]0;title\x07A${E}]2;t${E}\\B${CSI}3\x18C`, ['ABC'], [3, 0]],
  ['alignment', `x${E}#8`, ['E'.repeat(80), 'E'.repeat(80)], [0, 0]],
];

function parse(out) {
  const lines = out.split('\n');
  const sends = [];
  while (lines[0].startsWith('send ')) sends.push(lines.shift().slice(5).replaceAll('\\e', E));
  const [, x, y] = lines.shift().split(' ');
  const screen = lines.slice(0, 28).map((l) => l.slice(1));
  const runs = {};
  for (const l of lines.slice(28)) if (l) runs[parseInt(l)] = l.slice(4);
  return { sends, cursor: [+x, +y], screen, runs };
}

mkdirSync('build', { recursive: true });
const runners = [];
execFileSync('g++', ['-std=c++17', '-O2', '-Wall', '-Iterminal', ...SOURCES, '-o', 'build/_terminal-host']);
runners.push(['host', (file) => execFileSync('build/_terminal-host', { input: file.data })]);
if (existsSync('build/gcc/gcc/xgcc') && existsSync('build/cross-bin/fructus-elf-as')) {
  execFileSync('tools/fcc', ['-Os', '-Iterminal', ...SOURCES, '-o', 'build/_terminal'], { stdio: 'inherit' });
  // fcc-run prints each byte the UART sends as one Latin-1 character.
  runners.push(['fructus', (file) => Buffer.from(execFileSync('node', ['tools/fcc-run.mjs',
    'build/_terminal.bin', '--input', file.path, '--max', '20000000'], { encoding: 'utf8' }), 'latin1')]);
} else {
  console.log('skip  terminal/check.mjs on Fructus: the compiler is not built');
}

let fails = 0;

// The generated tables are what their generators make now, if 9x15 is here.
const NINE = '/usr/share/fonts/X11/misc/9x15.pcf.gz';
const generated = [['terminal/gen-decompose.mjs', 'terminal/decompose.cc']];
if (existsSync(NINE)) generated.push(['terminal/gen-font.mjs', 'terminal/font.cc']);
else console.log(`skip  terminal/check.mjs's font.cc: no ${NINE}`);
for (const [gen, file] of generated)
  if (execFileSync('node', [gen], { stdio: ['ignore', 'pipe', 'ignore'] }).toString() !== readFileSync(file, 'utf8')) {
    fails++;
    console.log(`  FAIL ${file} is not what ${gen} makes`);
  }

// font.h's glyphs() against the generator's rule, every base and mark.
if (existsSync(NINE)) {
  const want = execFileSync('node', ['terminal/gen-font.mjs', '--rules'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
  execFileSync('g++', ['-std=c++17', '-O2', '-Wall', '-Iterminal', 'terminal/rules-check.cc',
    'terminal/font.cc', 'terminal/decompose.cc', '-o', 'build/_terminal-rules']);
  const got = execFileSync('build/_terminal-rules', { input: want }).toString();
  const w = want.split('\n'), g = got.split('\n');
  const bad = w.filter((l, i) => l !== g[i]);
  if (bad.length) {
    fails++;
    console.log(`  FAIL glyphs() and gen-font.mjs disagree on ${bad.length} pairs, first ${bad[0]}`);
  }
}

for (const [name, input, lines, cursor, sends = [], runs = {}] of cases) {
  const data = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8');
  const path = 'build/_terminal.in';
  writeFileSync(path, data);
  for (const [where, run] of runners) {
    const got = parse(run({ data, path }).toString('utf8'));
    const wrong = [];
    lines.forEach((l, i) => { if (got.screen[i] !== l) wrong.push(`line ${i} ${JSON.stringify(got.screen[i])}, not ${JSON.stringify(l)}`); });
    if (got.cursor.join() !== cursor.join()) wrong.push(`cursor ${got.cursor}, not ${cursor}`);
    if (JSON.stringify(got.sends) !== JSON.stringify(sends)) wrong.push(`sent ${JSON.stringify(got.sends)}, not ${JSON.stringify(sends)}`);
    for (const l in runs) if (got.runs[l] !== runs[l]) wrong.push(`runs of ${l} ${JSON.stringify(got.runs[l])}, not ${JSON.stringify(runs[l])}`);
    if (wrong.length) {
      fails++;
      console.log(`  FAIL ${name} (${where}): ${wrong.join('; ')}`);
    }
  }
}
console.log(`${fails ? 'FAIL' : 'ok  '}  terminal/check.mjs: ${cases.length} cases on ${runners.map((r) => r[0]).join(' and ')}`);
process.exit(fails ? 1 : 0);
