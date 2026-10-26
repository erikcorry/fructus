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
// And main.cc itself, on the simulator with its display: bytes sent at
// 115200 baud into its receive interrupt, the demo and a screenful scrolled
// many times over, none lost, and its last frame what terminal/preview.cc
// draws on the host from the same bytes, pixel for pixel.
//
// Each case is bytes in and what terminal/dump.cc should say: the first lines
// of the screen, the cursor, the answers sent, and for some a line of colour
// runs.  Every case runs on the host, built with g++, and on Fructus under
// tools/fcc-run.mjs, which is skipped when the compiler is not built.
// =============================================================================

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

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
  // Colon sub-parameters: 4:3 curly is underline, 4:0 is off, and 58's
  // colour, in either form, is dropped whole - its 0s are not resets.
  ['underline styles and colour', `${CSI}31;4:3mA${CSI}58:2::0:0:0mB${CSI}58;2;0;0;0mC${CSI}4:0mD${CSI}38:2::255:0:0mE`,
    ['ABCDE'], [5, 0], [], { 0: '0-2 fg 30 bg 20 u 3-3 fg 30 bg 20 4-4 fg 3a bg 20 5-79 fg b3 bg 20' }],
  // Spacing accents are a space and the mark; aliases are another's base.
  ['spacing accents and aliases', '\u02c7\u02db \u2212x \u2010y \u02bc\u2015\u2009z',
    [' \u030c \u0328 -x -y \u2019\u2014 z'], [13, 0]],
  // Claude Code's spinner: its stars are *, and · stays between them.
  ['spinner stars', '\u2722\u00b7\u2733\u2736\u273b\u273d \u22ef', ['*\u00b7**** \u2026'], [8, 0]],
  // Greek and Cyrillic that look Latin, accented too; і has i's dot, and
  // takes an accent in its place.  Γ б в look like no Latin letter: their own.
  ['lookalikes', '\u0391\u0392\u0393 \u0410\u0431\u0432 \u0456\u0457\u0456\u0301 \u0401\u03cc',
    ['AB\u0393 A\u0431\u0432 i\u0131\u0308\u0131\u0301 E\u0308o\u0301'], [14, 0]],
  // A Greek capital's tonos is its own mark, at the letter's left; the dump
  // shows it as the acute it is in Unicode.
  ['tonos', '\u0386\u0389\u00c1', ['A\u0301H\u0301A\u0301'], [3, 0]],
  // Claude Code's others, aliases into the second set among them.
  ['Claude Code', '\u23fa \u23bf \u276f \u23f8 \u26a0 \u29c9 \u23f5 \u2714\u2718',
    ['\u25cf \u23bf \u276f \u23f8 \u26a0 \u29c9 \u25ba \u2713\u2717'], [16, 0]],
  // The second set: a symbol takes no accent, but is underlined.
  ['second set', `\u2713\u0301\u2200x\u2208${CSI}4m\u221e${CSI}0m\u0138`,
    ['\u2713\u2200x\u2208\u221e\u0138'], [6, 0], [], { 0: '0-3 fg b3 bg 20 4-4 fg b3 bg 20 u 5-79 fg b3 bg 20' }],
  ['second set past the x-height split', '\u211d\u2083\u2612\u21a6\u25b3', ['\u211d\u2083\u2612\u21a6\u25b3'], [5, 0]],
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

// A PNG of tools/png.js's - truecolour, every row filter 0 - as its rows' bytes.
function pngPixels(file) {
  const f = readFileSync(file), idat = [];
  for (let o = 8; o < f.length;) {
    const n = f.readUInt32BE(o);
    if (f.toString('latin1', o + 4, o + 8) === 'IDAT') idat.push(f.subarray(o + 8, o + 8 + n));
    o += 12 + n;
  }
  const raw = inflateSync(Buffer.concat(idat)), w = f.readUInt32BE(16), h = f.readUInt32BE(20);
  const out = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) raw.copy(out, y * w * 3, y * (1 + 3 * w) + 1, (y + 1) * (1 + 3 * w));
  return out;
}

if (runners.length > 1) {
  const MAIN = ['terminal/main.cc', 'terminal/terminal.cc', 'terminal/decompose.cc', 'terminal/font.cc',
                'terminal/row.cc', 'terminal/vectors.s'];
  execFileSync('tools/fcc', ['-Os', '-T', 'ld/fructus-writethru.ld', '-Iterminal', ...MAIN, '-o', 'build/_terminal-main'],
               { stdio: 'inherit' });
  execFileSync('g++', ['-std=c++17', '-O2', '-Wall', '-Iterminal', 'terminal/preview.cc', ...MAIN.slice(1, 5),
                       '-o', 'build/_terminal-preview']);
  let scroll = '';
  for (let i = 0; i < 100; i++) scroll += `${String(i).padStart(3)} ${'the quick brown fox '.repeat(4)}\r\n`;
  const inputs = [['the demo', execFileSync('node', ['terminal/demo.mjs'])],
                  ['100 lines scrolled', Buffer.from(scroll)]];
  for (const [name, data] of inputs) {
    writeFileSync('build/_terminal-main.in', data);
    rmSync('build/_terminal-frames', { recursive: true, force: true });
    const run = spawnSync('node', ['tools/fcc-run.mjs', 'build/_terminal-main.bin', '--input', 'build/_terminal-main.in',
                                   '--paced', '--stats', '--frames', 'build/_terminal-frames',
                                   '--max', String(data.length * 2500 + 3e6)], { encoding: 'utf8' });
    const sent = run.stderr.match(/(\d+) of (\d+) bytes of input sent, (\d+) lost/);
    const last = readdirSync('build/_terminal-frames').sort().at(-1);
    const want = execFileSync('build/_terminal-preview', { input: data, maxBuffer: 1 << 21 });
    const got = pngPixels(`build/_terminal-frames/${last}`);
    const wrong = [];
    if (!sent || sent[1] !== sent[2] || sent[3] !== '0') wrong.push(`the line: ${sent ? sent[0] : run.stderr.trim()}`);
    const px = want.subarray(want.length - got.length);
    let differ = 0;
    for (let i = 0; i < got.length; i += 3) if (got[i] !== px[i] || got[i + 1] !== px[i + 1] || got[i + 2] !== px[i + 2]) differ++;
    if (px.length !== got.length || differ) wrong.push(`${differ} pixels of the last frame differ from the preview's`);
    if (wrong.length) {
      fails++;
      console.log(`  FAIL main.cc, ${name}: ${wrong.join('; ')}`);
    }
  }
  rmSync('build/_terminal-frames', { recursive: true, force: true });
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
console.log(`${fails ? 'FAIL' : 'ok  '}  terminal/check.mjs: ${cases.length} cases on ${runners.map((r) => r[0]).join(' and ')}` +
            (runners.length > 1 ? ', main.cc paced at 115200 against the preview' : ''));
process.exit(fails ? 1 : 0);
