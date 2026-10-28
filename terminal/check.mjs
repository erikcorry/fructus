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
// 230400 baud, main.cc's rate, into its receive interrupt, the demo and a screenful scrolled
// many times over, none lost, and its last frame what terminal/preview.cc
// draws on the host from the same bytes, pixel for pixel.
//
// Each case is bytes in and what terminal/dump.cc should say: the first lines
// of the screen, the cursor, the answers sent, and for some lines of colour
// runs and lines as terminal/bidi.cc orders them for the display.  Every case runs on the host, built with g++, and on Fructus under
// tools/fcc-run.mjs, which is skipped when the compiler is not built.
//
// The dense terminal, -DTERMINAL_DENSE, has cases of its own, and main.cc
// built dense is held to its preview in the same way.
// =============================================================================

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { inflateSync } from 'node:zlib';

const SOURCES = ['terminal/dump.cc', 'terminal/terminal.cc', 'terminal/decompose.cc', 'terminal/font.cc',
                 'terminal/bidi.cc'];
const DENSE = ['-DTERMINAL_DENSE'], DENSE_SOURCES = ['terminal/dump.cc', 'terminal/terminal.cc', 'terminal/font5.cc'];
const E = '\x1b', CSI = E + '[';
const ROWS = 28, a80 = 'a'.repeat(80);
const right = (s) => s.padStart(80);   // a right-to-left row as shown
const SCP_RTL = `${CSI}2 k`;
const [SHALOM, OLAM, ABC] = ['\u05e9\u05dc\u05d5\u05dd', '\u05e2\u05d5\u05dc\u05dd', '\u05d0\u05d1\u05d2'];
const rev = (s) => [...s].reverse().join('');

// [name, input, lines from the top, [x, y], sends, { line: runs }, { line: as shown }]
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
  // The third set, Hebrew: its points are dropped, and like the second set
  // it takes no accent.
  ['third set', '\u05e9\u05c1\u05b8\u05dc\u05d5\u05b9\u05dd \u05ea\u05dc\u05be\u05d0\u05d1\u05d9\u05d1\u0301 \u20aa5\u05f3',
    ['\u05e9\u05dc\u05d5\u05dd \u05ea\u05dc\u05be\u05d0\u05d1\u05d9\u05d1 \u20aa5\u05f3'], [16, 0]],
  // Right to left, terminal.h and bidi.h.  A left-to-right paragraph turns
  // its Hebrew round, numbers and all, but not the brackets about it.
  ['bidi in a left-to-right row', `abc ${SHALOM} def\r\n${SHALOM} 123 ${OLAM}\r\nabc (${SHALOM}) def`,
    [`abc ${SHALOM} def`, `${SHALOM} 123 ${OLAM}`, `abc (${SHALOM}) def`], [14, 2], [], {},
    { 0: `abc ${rev(SHALOM)} def`, 1: `${rev(OLAM)} 123 ${rev(SHALOM)}`, 2: `abc (${rev(SHALOM)}) def` }],
  // ₪ beside a number is part of it; the brackets in a right-to-left run are
  // mirrored.
  ['bidi in a right-to-left row', `${SCP_RTL}${SHALOM}, world\r\n\u05de\u05d7\u05d9\u05e8 \u20aa5\r\n\u05d0(\u05d1)`,
    [`${SHALOM}, world`, '\u05de\u05d7\u05d9\u05e8 \u20aa5', '\u05d0(\u05d1)'], [4, 2], [], {},
    { 0: right(`world ,${rev(SHALOM)}`), 1: right('\u20aa5 \u05e8\u05d9\u05d7\u05de'), 2: right('(\u05d1)\u05d0') }],
  // SCP mid-line waits for the next line; explicit mode is the cells as they
  // are, from the right.
  ['bidi properties', `ab${SCP_RTL}cd\r\nef\r\n${CSI}8l${CSI}1 kxy${CSI}2 k\r\nxyz`,
    ['abcd', 'ef', 'xy', 'xyz'], [3, 3], [], {}, { 1: right('ef'), 3: right('zyx') }],
  // Autodetection from the first strong letter, and box drawing mirrored in
  // 2500's mode.
  ['bidi autodetection and boxes', `${CSI}?2501h${SHALOM} abc\r\nabc ${ABC}\r\n${CSI}?2500h${SCP_RTL}\u250c\u2500\u05d0\u2500\u2510`,
    [`${SHALOM} abc`, `abc ${ABC}`, '\u250c\u2500\u05d0\u2500\u2510'], [5, 2], [], {},
    { 0: right(`abc ${rev(SHALOM)}`), 1: `abc ${rev(ABC)}`, 2: right('\u250c\u2500\u05d0\u2500\u2510') }],
  // Hawaiian's ʻokina as ‘, the dot and macron below, the third set's
  // letters that take no accent, and Cyrillic's lookalikes as Latin.
  ['marks below, lookalikes', 'Hawai\u02bbi \u1e0d\u1e25\u1e37 \u1e3b\u1e49\u1e6f \u0140\u013f\u017f\u028c\u0245 \u04bb\u04ae\u04c0\u04d5\u04ab\u04d9',
    ['Hawai\u2018i d\u0323h\u0323l\u0323 l\u0331n\u0331t\u0331 \u0140\u013f\u017f\u028c\u0245 hYI\u00e6c\u0327\u0259'], [28, 0]],
  // Yiddish's points make a pointed letter of the third set, as its
  // presentation form does; a point the font has no letter for is dropped.
  // Tatar's own letters.
  ['Yiddish and Tatar', '\u05d0\u05b7\ufb2e\u05e4\u05bf\u05f2\u05b7\u05d2\u05b7 \u0497\u04e8',
    ['\ufb2e\ufb2e\ufb4e\ufb1f\u05d2 \u0497\u04e8'], [8, 0]],
  // Braille, a mark on it dropped, and underlined; the third set's blocks and
  // box drawing, and mixed light and heavy as the light.
  ['Braille, blocks and boxes', `\u2813\u2811\u2807\u2807\u2815 \u28ff\u0301\u2800${CSI}4m\u2841${CSI}0m \u258f\u2595\u254c\u2506\u2574 \u251d\u2542\u257c`,
    ['\u2813\u2811\u2807\u2807\u2815 \u28ff\u2800\u2841 \u258f\u2595\u254c\u2506\u2574 \u251c\u253c\u2500'], [19, 0]],
  ['strings and CAN', `${E}]0;title\x07A${E}]2;t${E}\\B${CSI}3\x18C`, ['ABC'], [3, 0]],
  ['alignment', `x${E}#8`, ['E'.repeat(80), 'E'.repeat(80)], [0, 0]],
];

// The dense terminal's, as cases above.
const a128 = 'a'.repeat(128);
const denseCases = [
  ['pending wrap', a128 + 'b', [a128, 'b'], [1, 1]],
  ['region scroll', `0\r\n1\r\n2\r\n3\r\n4${CSI}2;4r${CSI}4;1H\n`, ['0', '2', '3', '', '4'], [0, 3]],
  ['scrolled off the bottom', [...Array(70).keys()].join('\r\n'), ['10', '11'], [2, 59]],
  ['tabs', `a\tb${CSI}3g\tc`, ['a       b' + ' '.repeat(118) + 'c'], [127, 0]],
  // Wide is still two cells; marks and joiners are dropped.
  ['not ASCII', 'é中x\u0301\u200dy', ['\ufffd\ufffd xy'], [5, 0]],
  // One weight: heavy, double, mixed, dashed and rounded as the light.
  ['box drawing', `${E}(0lqkx${E}(B \u2550\u2551\u256d\u254c\u254e\u254b\u2542\u2578\u2577\u2573\u2580`,
    ['\u250c\u2500\u2510\u2502 \u2500\u2502\u250c\u2500\u2502\u253c\u253c\u2574\u2577X\ufffd'], [16, 0]],
  // Neither does anything, nor leaves a mark.
  ['underline and bidi', `${CSI}4mA${CSI}0m${CSI}2 k\u05d0B${CSI}?2501h`, ['A\ufffdB'], [3, 0], [], { 0: undefined }],
  ['bold is brighter', `${CSI}1mA${CSI}22;31mB${CSI}1mC${CSI}0;7mD`, ['ABCD'], [4, 0], [],
    { 0: '0-0 fg fe bg 20 1-1 fg 30 bg 20 2-2 fg 7b bg 20 3-3 fg 20 bg b3 4-127 fg b3 bg 20' }],
  ['alternate screen', `main${CSI}?1049halt`, ['    alt'], [7, 0]],
  // The primary comes back with its lines in their order, after the
  // alternate scrolled.
  ['back from it', `main\r\nline${CSI}?1049halt${'\r\n'.repeat(70)}x${CSI}?1049l`, ['main', 'line'], [4, 1]],
  ['alignment', `x${E}#8`, ['E'.repeat(128), 'E'.repeat(128)], [0, 0]],
];

function parse(out, rows) {
  const lines = out.split('\n');
  const sends = [];
  while (lines[0].startsWith('send ')) sends.push(lines.shift().slice(5).replaceAll('\\e', E));
  const [, x, y] = lines.shift().split(' ');
  const screen = lines.slice(0, rows).map((l) => l.slice(1));
  const runs = {}, shown = {};
  for (const l of lines.slice(rows))
    if (l.startsWith('>')) shown[parseInt(l.slice(1))] = l.slice(5);
    else if (l) runs[parseInt(l)] = l.slice(4);
  return { sends, cursor: [+x, +y], screen, runs, shown };
}

mkdirSync('build', { recursive: true });
const FRUCTUS = existsSync('build/gcc/gcc/xgcc') && existsSync('build/cross-bin/fructus-elf-as');
if (!FRUCTUS) console.log('skip  terminal/check.mjs on Fructus: the compiler is not built');

// dump.cc from sources, as build/NAME, on the host and on Fructus.
function dumpers(name, flags, sources) {
  const runners = [];
  execFileSync('g++', ['-std=c++17', '-O2', '-Wall', '-Iterminal', ...flags, ...sources, '-o', `build/${name}-host`]);
  runners.push(['host', (file) => execFileSync(`build/${name}-host`, { input: file.data })]);
  if (FRUCTUS) {
    execFileSync('tools/fcc', ['-Os', '-Iterminal', ...flags, ...sources, '-o', `build/${name}`], { stdio: 'inherit' });
    // fcc-run prints each byte the UART sends as one Latin-1 character.
    runners.push(['fructus', (file) => Buffer.from(execFileSync('node', ['tools/fcc-run.mjs',
      `build/${name}.bin`, '--input', file.path, '--max', '20000000'], { encoding: 'utf8' }), 'latin1')]);
  }
  return runners;
}
const runners = dumpers('_terminal', [], SOURCES);
const denseRunners = dumpers('_terminal-dense', DENSE, DENSE_SOURCES);

let fails = 0;

// The generated tables are what their generators make now, if 9x15 is here.
const NINE = '/usr/share/fonts/X11/misc/9x15.pcf.gz';
const SPLEENTT = `${homedir()}/github/spleentt-5x8-font/SpleenttMedium-8.bdf`;
const generated = [['terminal/gen-decompose.mjs', 'terminal/decompose.cc']];
if (existsSync(NINE)) generated.push(['terminal/gen-font.mjs', 'terminal/font.cc']);
else console.log(`skip  terminal/check.mjs's font.cc: no ${NINE}`);
if (existsSync(SPLEENTT)) generated.push(['terminal/gen-font5.mjs', 'terminal/font5.cc']);
else console.log(`skip  terminal/check.mjs's font5.cc: no ${SPLEENTT}`);
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

// main.cc, from the sources, played each input at its 230400 baud: none of it
// lost, and its last frame preview.cc's.  The sources' first is main.cc and
// their last vectors.s.
function paced(name, flags, sources, inputs) {
  execFileSync('tools/fcc', ['-Os', '-T', 'ld/fructus-writethru.ld', '-Iterminal', ...flags, ...sources,
                             '-o', `build/${name}`], { stdio: 'inherit' });
  execFileSync('g++', ['-std=c++17', '-O2', '-Wall', '-Iterminal', ...flags, 'terminal/preview.cc',
                       ...sources.slice(1, -1), '-o', `build/${name}-preview`]);
  for (const [input, data] of inputs) {
    writeFileSync(`build/${name}.in`, data);
    rmSync(`build/${name}-frames`, { recursive: true, force: true });
    const run = spawnSync('node', ['tools/fcc-run.mjs', `build/${name}.bin`, '--input', `build/${name}.in`,
                                   '--paced', '--stats', '--frames', `build/${name}-frames`,
                                   '--max', String(data.length * 2500 + 3e6)], { encoding: 'utf8' });
    const sent = run.stderr.match(/(\d+) of (\d+) bytes of input sent, (\d+) lost/);
    const last = readdirSync(`build/${name}-frames`).sort().at(-1);
    const want = execFileSync(`build/${name}-preview`, { input: data, maxBuffer: 1 << 21 });
    const got = pngPixels(`build/${name}-frames/${last}`);
    const wrong = [];
    if (!sent || sent[1] !== sent[2] || sent[3] !== '0') wrong.push(`the line: ${sent ? sent[0] : run.stderr.trim()}`);
    const px = want.subarray(want.length - got.length);
    let differ = 0;
    for (let i = 0; i < got.length; i += 3) if (got[i] !== px[i] || got[i + 1] !== px[i + 1] || got[i + 2] !== px[i + 2]) differ++;
    if (px.length !== got.length || differ) wrong.push(`${differ} pixels of the last frame differ from the preview's`);
    if (wrong.length) {
      fails++;
      console.log(`  FAIL ${flags.length ? 'dense ' : ''}main.cc, ${input}: ${wrong.join('; ')}`);
    }
  }
  rmSync(`build/${name}-frames`, { recursive: true, force: true });
}

if (FRUCTUS) {
  let scroll = '';
  for (let i = 0; i < 300; i++) scroll += `${String(i).padStart(3)} ${'the quick brown fox '.repeat(4)}\r\n`;
  // Right to left, every row through all of bidi.cc: Hebrew, numbers,
  // brackets and Latin in right-to-left paragraphs.
  let rtl = `${SCP_RTL}${CSI}?2500h`;
  for (let i = 0; i < 100; i++) rtl += `${String(i).padStart(3)} ${SHALOM} (${OLAM}) world \u20aa${i} `.repeat(2) + '\r\n';
  paced('_terminal-main', [], ['terminal/main.cc', 'terminal/terminal.cc', 'terminal/decompose.cc',
                                'terminal/font.cc', 'terminal/row.cc', 'terminal/bidi.cc', 'terminal/vectors.s'],
        [['the demo', execFileSync('node', ['terminal/demo.mjs'])],
         ['300 lines scrolled', Buffer.from(scroll)],
         ['100 right-to-left lines scrolled', Buffer.from(rtl)]]);

  // Dense: 200 wide lines scrolled, and a full screen on the alternate one
  // and back, which brings the primary back from main.cc's .upper.
  let wide = '';
  for (let i = 0; i < 200; i++) wide += `${String(i).padStart(3)} ${'the quick brown fox '.repeat(6)}${CSI}${31 + i % 7}mcolour${CSI}0m\r\n`;
  let alt = `${CSI}44mprimary${CSI}0m\r\n${CSI}?1049h`;
  for (let i = 0; i < 70; i++) alt += `${CSI}1;${31 + i % 7}m${String(i).padStart(3)}${CSI}0m ${'jumps over the lazy dog '.repeat(5)}\r\n`;
  alt += `${CSI}?1049lback`;
  paced('_terminal-dense-main', DENSE, ['terminal/main.cc', 'terminal/terminal.cc', 'terminal/font5.cc', 'terminal/vectors.s'],
        [['the demo', execFileSync('node', ['terminal/demo.mjs', '--dense'])],
         ['200 lines scrolled', Buffer.from(wide)],
         ['the alternate screen and back', Buffer.from(alt)]]);
}

for (const [variant, list, rows, run_with] of [['', cases, ROWS, runners], ['dense ', denseCases, 60, denseRunners]])
for (const [name, input, lines, cursor, sends = [], runs = {}, shown = {}] of list) {
  const data = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8');
  const path = 'build/_terminal.in';
  writeFileSync(path, data);
  for (const [where, run] of run_with) {
    const got = parse(run({ data, path }).toString('utf8'), rows);
    const wrong = [];
    lines.forEach((l, i) => { if (got.screen[i] !== l) wrong.push(`line ${i} ${JSON.stringify(got.screen[i])}, not ${JSON.stringify(l)}`); });
    if (got.cursor.join() !== cursor.join()) wrong.push(`cursor ${got.cursor}, not ${cursor}`);
    if (JSON.stringify(got.sends) !== JSON.stringify(sends)) wrong.push(`sent ${JSON.stringify(got.sends)}, not ${JSON.stringify(sends)}`);
    for (const l in runs) if (got.runs[l] !== runs[l]) wrong.push(`runs of ${l} ${JSON.stringify(got.runs[l])}, not ${JSON.stringify(runs[l])}`);
    for (const l in shown) if (got.shown[l] !== shown[l]) wrong.push(`line ${l} shown ${JSON.stringify(got.shown[l])}, not ${JSON.stringify(shown[l])}`);
    if (wrong.length) {
      fails++;
      console.log(`  FAIL ${variant}${name} (${where}): ${wrong.join('; ')}`);
    }
  }
}
console.log(`${fails ? 'FAIL' : 'ok  '}  terminal/check.mjs: ${cases.length} cases and ${denseCases.length} dense on ` +
            runners.map((r) => r[0]).join(' and ') +
            (FRUCTUS ? ', main.cc and dense main.cc paced at 230400 against the preview' : ''));
process.exit(fails ? 1 : 0);
