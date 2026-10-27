#!/usr/bin/env node
// =============================================================================
// coverage.mjs - each language's letters through the terminal, and what it
// cannot show
// =============================================================================
//
//   node terminal/coverage.mjs [DIR...] [--aux]
//
// DIR is CLDR's per-locale character data, a directory of LOCALE/characters.json
// as unicode-org/cldr-json has it, by default
// ~/github/cldr-json/cldr-json/cldr-misc-full/main; terminal/coverage-extra.json
// is read as well, alphabets by hand for languages CLDR has no locale for.
// --aux adds each locale's auxiliary letters, those of loanwords and names.
//
// Each locale's exemplar letters, both cases, as grapheme clusters - a {ch}
// digraph is its letters, a letter and its marks are one - go through
// terminal/coverage.cc, which puts each into terminal.cc and says what the
// cell holds.  A line a locale, "ok" or its letters by what is wrong:
//
//     missing         the fallback, �
//     cells N         not one cell
//     mark dropped    the cell is the letter without its mark, or the mark is
//                     not drawn
//     two marks       more marks than the cell's one
//
// A cluster whose cell has another base than the cluster's letter alone is a
// letter of its own - ď, Ў, a pointed Hebrew letter - and is ok.
// =============================================================================

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';

const aux = process.argv.includes('--aux');
let dirs = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!dirs.length) dirs = [`${homedir()}/github/cldr-json/cldr-json/cldr-misc-full/main`];

mkdirSync('build', { recursive: true });
execFileSync('g++', ['-std=c++17', '-O2', '-Wall', '-Iterminal', 'terminal/coverage.cc', 'terminal/terminal.cc',
                     'terminal/decompose.cc', 'terminal/font.cc', '-o', 'build/_terminal-coverage']);

// A CLDR set, "[a b {ch} á-ć ́]", as clusters, both cases.
function clusters(set) {
  if (!set) return [];
  const items = [];
  const re = /\{([^}]*)\}|\\u\{?([0-9a-fA-F]{4,6})\}?|\\(.)|(\S)-(\S)|(\P{M}\p{M}*)/gu;
  for (const m of set.trim().replace(/^\[|\]$/g, '').matchAll(re)) {
    if (m[1] !== undefined) items.push(m[1]);
    else if (m[2]) items.push(String.fromCodePoint(parseInt(m[2], 16)));
    else if (m[3]) items.push(m[3]);
    else if (m[4]) for (let c = m[4].codePointAt(0); c <= m[5].codePointAt(0); c++) items.push(String.fromCodePoint(c));
    else items.push(m[6]);
  }
  const out = new Set();
  for (const item of items)
    for (const g of item.normalize('NFC').match(/\P{M}\p{M}*/gu) ?? []) {
      out.add(g);
      const u = g.toUpperCase();
      if ([...u].length === [...g].length) out.add(u.normalize('NFC'));
    }
  return [...out].filter((g) => /\p{L}/u.test(g));
}

const locales = {};
for (const d of dirs)
  for (const l of readdirSync(d).filter((l) => existsSync(`${d}/${l}/characters.json`))) {
    const c = JSON.parse(readFileSync(`${d}/${l}/characters.json`, 'utf8')).main[l].characters;
    locales[l] = clusters(c.exemplarCharacters).concat(aux ? clusters(c.auxiliary) : []);
  }
for (const [l, set] of Object.entries(JSON.parse(readFileSync('terminal/coverage-extra.json', 'utf8'))))
  locales[l] = clusters(set);

// Each cluster, and its letter without marks.
const all = [...new Set(Object.values(locales).flat())];
const bare = all.map((g) => g.normalize('NFD').match(/\P{M}/u)[0]);
const run = (gs) => execFileSync('build/_terminal-coverage', { input: gs.join('\n') + '\n' })
  .toString().trim().split('\n').map((l) => l.split(' '));
const cells = run(all), plain = run(bare);
const verdict = new Map();
all.forEach((g, i) => {
  const [x, b, mark, set, drawn, base] = cells[i];
  const marks = [...g.normalize('NFD')].filter((c) => /\p{M}/u.test(c)).length;
  const own = base !== plain[i][5] || set !== plain[i][3];
  let v = 'ok';
  if (b === 'F') v = 'missing';
  else if (+x !== 1) v = `cells ${x}`;
  else if (!marks || own) v = 'ok';
  else if (marks > 1) v = 'two marks';
  else if (+mark === 0 || !+drawn) v = 'mark dropped';
  verdict.set(g, v);
});

for (const [l, gs] of Object.entries(locales).sort()) {
  const by = {};
  for (const g of gs.filter((g) => verdict.get(g) !== 'ok')) (by[verdict.get(g)] ??= []).push(g);
  const wrong = Object.entries(by).map(([v, g]) => `${v}: ${g.join(' ')}`).join('; ');
  console.log(`${l.padEnd(8)} ${wrong || 'ok'}`);
}
