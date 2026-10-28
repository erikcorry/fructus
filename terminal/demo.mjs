#!/usr/bin/env node
// demo.mjs - bytes that show off the terminal: colours, accents, boxes.
//
//   node terminal/demo.mjs > build/demo.in
//   node tools/fcc-run.mjs build/terminal.bin --input build/demo.in --x11 --scale 2
//
// --dense, the dense terminal's: ASCII, 128 columns.
//
// No line is wider than 80 columns, or 128, or it would wrap.
const E = '\x1b[';
const dense = process.argv.includes('--dense'), width = dense ? 128 : 80;
const lines = dense ? [
  `${E}1;36mFructus${E}0m dense terminal - 128x60, 5x8 cells from Tommy Thorn's Spleentt`,
  '',
  `${E}1mBold${E}0m ${E}7mreverse${E}0m ${E}31mred ${E}1;31mbold red${E}0m ${E}38;5;208morange${E}0m ` +
    `${E}44m blue bg ${E}0m ${E}38;2;255;0;255mtruecolour${E}0m ${E}1;33mbold yellow${E}0m ${E}2;3;4;5mnot shown${E}0m`,
  [...Array(95).keys()].map((i) => String.fromCharCode(32 + i)).join(''),
  'The quick brown fox jumps over the lazy dog.  THE QUICK BROWN FOX JUMPS OVER THE LAZY DOG.  0123456789 gjpqy Q_',
  'Not ASCII: Zażółć, €, →, 中 - each one box, the wide one two cells.',
  '',
  '┌──────────┬─────────┐ ╔══════════╦═════════╗ ┏━━━━━━━━━┓ ╭─────────╮',
  '│ light    │ box     │ ║ double   ║ box     ║ ┃ heavy   ┃ │ rounded │',
  '└──────────┴─────────┘ ╚══════════╩═════════╝ ┗━━━━━━━━━┛ ╰─────────╯',
  '',
  `${E}33mint${E}0m ${E}1mmain${E}0m(${E}33mint${E}0m argc, ${E}33mchar${E}0m **argv) {`,
  `  ${E}35mfor${E}0m (${E}33mint${E}0m i = ${E}31m0${E}0m; i < argc; i++) printf(${E}32m"%s\\n"${E}0m, argv[i]);  ${E}34m// 128 columns${E}0m`,
  `  ${E}35mreturn${E}0m ${E}31m0${E}0m;`,
  '}',
  '',
] : [
  `${E}1;36mFructus${E}0m terminal — 80×28, 8×17 cells, from X11's 9x15`,
  '',
  `${E}1mBold${E}0m ${E}4munderlined gjpqy${E}0m ${E}7mreverse${E}0m ${E}31mred ${E}1;31mbold red${E}0m ` +
    `${E}38;5;208morange${E}0m ${E}44m blue bg ${E}0m ${E}38;2;255;0;255mtruecolour${E}0m`,
  'Zażółć gęślą jaźń. Příliš žluťoučký kůň úpěl ďábelské ódy. Ľúbostný ťava.',
  'Æble Øre Åben, ß ẞ, Œuvre, Ģirts Ķemers, Ștefan Țară, Ð Þ ð þ, Ísland.',
  '€ ‘quote’ “quote” „Gänse“ «guillemets» – — … • ← ↑ → ↓ ≤ ≥ ≠ π ° ± ½ ©',
  '¿Qué tal, señor Muñoz? ¡Pingüino! Ação, coração, você, avô. Guaraní: ẽ ĩ ũ ỹ g̃',
  '✓ passed ✗ failed ■□▲▼►◄○ ↔↕⇐⇒⇔ ™†‡‰′″№ ∀x∈A: ∑∂∫√∞≈≡ ∅∧∨∩∪ ⌈x⌉⌊y⌋ ĸƏəƒ',
  'xⁿ⁰ a₀₁₂₃ ∏∇∆ ⇑⇓⇕ A⊂B⊃C ☐☑☒ ♪☺ ℕℤℝℚℂ ↤↥↦ △',
  '‗₧∁∄∉∋∌∓∘∝∟∡∤∥∦∮ ≃≅≉≙≟≢≪≫ ⊄⊅⊆⊇⊈⊉⊊⊋⊕⊗⊤⊥⊦⊧⋂⋃ ⌀⌐⌕⌠⌡ ☻☼♀♂♫♭♮♯',
  `${E}4mUnderlined: gjpqy Typography, ząę ţş, (brackets) [ok]; ┃│▒${E}0m and ${E}1;4;32mgreen gjpqy${E}0m`,
  '',
  '┌──────────┬─────────┐ ╔══════════╦═════════╗ ┏━━━━━━━━━┓ ╭─────────╮',
  '│ light    │ box     │ ║ double   ║ box     ║ ┃ heavy   ┃ │ rounded │',
  '├──────────┼─────────┤ ╠══════════╬═════════╣ ┣━━━━━━━━━┫ ╰─────────╯',
  '│ ░░▒▒▓▓██ │ ▁▂▃▄▅▆▇█│ ║ ▀▄▌▐▖▗▘▝ ║ ╒══╤══╕ ║ ┃ ▙▛▜▟▚▞  ┃ ╓──╥──╖',
  '└──────────┴─────────┘ ╚══════════╩═════════╝ ┗━━━━━━━━━┛ ╙──╨──╜',
  '',
];
const cube = dense ? 108 : 72;
for (let r = 0; r < 216 / cube; r++)
  lines.push([...Array(cube).keys()].map((i) => `${E}48;5;${16 + cube * r + i}m `).join('') + `${E}0m`);
if (dense) lines.push([...Array(24).keys()].map((i) => `${E}48;5;${232 + i}m   `).join('') + `${E}0m`);
lines.push('');
lines.push([...Array(16).keys()].map((i) => `${E}${i < 8 ? 40 + i : 92 + i}m   `).join('') + `${E}0m`);
lines.push([...Array(16).keys()].map((i) => `${E}${i < 8 ? 30 + i : 82 + i}m${i.toString(16).padStart(2)} `).join('') + `${E}0m`);

for (const l of lines) {
  const n = [...l.replace(/\x1b\[[0-9;]*m/g, '')].length;
  if (n > width) throw new Error(`a line of ${n} columns: ${l}`);
}
process.stdout.write(lines.join('\r\n') + '\r\n$ ');
