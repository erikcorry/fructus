#!/usr/bin/env node
// demo.mjs - bytes that show off the terminal: colours, accents, boxes.
//
//   node terminal/demo.mjs > build/demo.in
//   node tools/fcc-run.mjs build/terminal.bin --input build/demo.in --x11 --scale 2
//
// No line is wider than 80 columns, or it would wrap.
const E = '\x1b[';
const lines = [
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
  `${E}4mUnderlined: gjpqy Typography, ząę ţş, (brackets) [ok]; ┃│▒${E}0m and ${E}1;4;32mgreen gjpqy${E}0m`,
  '',
  '┌──────────┬─────────┐ ╔══════════╦═════════╗ ┏━━━━━━━━━┓ ╭─────────╮',
  '│ light    │ box     │ ║ double   ║ box     ║ ┃ heavy   ┃ │ rounded │',
  '├──────────┼─────────┤ ╠══════════╬═════════╣ ┣━━━━━━━━━┫ ╰─────────╯',
  '│ ░░▒▒▓▓██ │ ▁▂▃▄▅▆▇█│ ║ ▀▄▌▐▖▗▘▝ ║ ╒══╤══╕ ║ ┃ ▙▛▜▟▚▞  ┃ ╓──╥──╖',
  '└──────────┴─────────┘ ╚══════════╩═════════╝ ┗━━━━━━━━━┛ ╙──╨──╜',
  '',
];
for (let r = 0; r < 3; r++)
  lines.push([...Array(72).keys()].map((i) => `${E}48;5;${16 + 72 * r + i}m `).join('') + `${E}0m`);
lines.push('');
lines.push([...Array(16).keys()].map((i) => `${E}${i < 8 ? 40 + i : 92 + i}m   `).join('') + `${E}0m`);
lines.push([...Array(16).keys()].map((i) => `${E}${i < 8 ? 30 + i : 82 + i}m${i.toString(16).padStart(2)} `).join('') + `${E}0m`);

for (const l of lines) {
  const width = [...l.replace(/\x1b\[[0-9;]*m/g, '')].length;
  if (width > 80) throw new Error(`a line of ${width} columns: ${l}`);
}
process.stdout.write(lines.join('\r\n') + '\r\n$ ');
