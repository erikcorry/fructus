// =============================================================================
// pdf.js - text, lines and boxes as a PDF file, with nothing but node's zlib
// =============================================================================
//
//   const doc = new Pdf();                 // A4, points, origin TOP LEFT
//   const p = doc.page();
//   p.text(72, 72, 'Hello', { font: 'HB', size: 14 });
//   p.rect(72, 90, 100, 20, { fill: [0.9, 0.9, 1], stroke: [0, 0, 0] });
//   doc.outline('Hello', p);
//   writeFileSync('f.pdf', doc.bytes());
//   p.svg(svgText, { x: 50, y: 72, scale: 0.5, from: 0, to: 1200 });
//
// Only the base-14 fonts, which every reader carries, so nothing is embedded
// and nothing has to be found on disk.  That makes the text StandardEncoding,
// not Unicode: `encode` maps the few typographic characters the manual uses
// and refuses anything else rather than printing a wrong glyph.
//
// The widths are Helvetica's AFM metrics as ghostscript reports them, which a
// layout needs for wrapping and centring.  Courier is 600 throughout.
// =============================================================================

import { deflateSync } from 'node:zlib';

export const A4 = [595.28, 841.89];

const FONTS = {
  H:  'Helvetica',
  HB: 'Helvetica-Bold',
  HI: 'Helvetica-Oblique',
  C:  'Courier',
  CB: 'Courier-Bold',
};

// Widths of 32..126 in 1/1000 em.
const HELV = [
  278, 278, 355, 556, 556, 889, 667, 222, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  222, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
const HELV_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 278, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  278, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
  611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];

// The non-ASCII characters accepted, as [StandardEncoding code, width].  The
// widths happen to agree between Helvetica and its bold.
const EXTRA = {
  '–': [0xb1, 556],    // en dash
  '—': [0xd0, 1000],   // em dash
  '…': [0xbc, 1000],   // ellipsis
  '•': [0xb7, 350],    // bullet
  '·': [0xb4, 278],    // middle dot
  '‘': [0x60, 222],    // left single quote (bold is 278)
  '’': [0x27, 222],    // right single quote
};

export function encode(s) {
  const out = [];
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c >= 32 && c < 127) out.push(c);
    else if (EXTRA[ch]) out.push(EXTRA[ch][0]);
    else throw new Error(`pdf.js: no glyph for U+${c.toString(16)} in ${JSON.stringify(s)}`);
  }
  return out;
}

export function width(s, font = 'H', size = 10) {
  if (font[0] === 'C') return [...s].length * 0.6 * size;
  const tab = font === 'HB' ? HELV_BOLD : HELV;
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    w += c >= 32 && c < 127 ? tab[c - 32] : (EXTRA[ch]?.[1] ?? 556);
  }
  return (w * size) / 1000;
}

const num = (n) => (Math.round(n * 100) / 100).toString();
const rgb = (c) => c.map(num).join(' ');

// A string literal: StandardEncoding bytes, with the three delimiters escaped
// and everything outside printable ASCII as an octal escape.
const lit = (s) =>
  '(' + encode(s).map((b) =>
    b === 0x28 || b === 0x29 || b === 0x5c ? '\\' + String.fromCharCode(b)
    : b < 127 ? String.fromCharCode(b)
    : '\\' + b.toString(8)).join('') + ')';

class Page {
  constructor(doc) {
    this.doc = doc;
    this.ops = [];
    this.links = [];
  }

  y(v) { return this.doc.height - v; }

  text(x, y, s, { font = 'H', size = 10, color = [0, 0, 0] } = {}) {
    if (s === '') return;
    this.ops.push(`BT /${font} ${num(size)} Tf ${rgb(color)} rg ${num(x)} ${num(this.y(y))} Td ${lit(s)} Tj ET`);
  }

  line(x1, y1, x2, y2, { width = 0.5, color = [0, 0, 0] } = {}) {
    this.ops.push(`${num(width)} w ${rgb(color)} RG ${num(x1)} ${num(this.y(y1))} m ${num(x2)} ${num(this.y(y2))} l S`);
  }

  // (x, y) is the TOP left corner.
  rect(x, y, w, h, { fill = null, stroke = null, width = 0.5 } = {}) {
    const r = `${num(x)} ${num(this.y(y + h))} ${num(w)} ${num(h)} re`;
    if (fill && stroke) this.ops.push(`${num(width)} w ${rgb(fill)} rg ${rgb(stroke)} RG ${r} B`);
    else if (fill) this.ops.push(`${rgb(fill)} rg ${r} f`);
    else if (stroke) this.ops.push(`${num(width)} w ${rgb(stroke)} RG ${r} S`);
  }

  // A clickable area that jumps to another page, or to a URL if `target` is a
  // string.
  link(x, y, w, h, target) {
    this.links.push({ rect: [x, this.y(y + h), x + w, this.y(y)], target });
  }

  // Draw an SVG as vector graphics, its top left at (x, y) and `scale` points
  // to the SVG unit, showing only its band from y = `from` to y = `to` - which
  // is how a tall SVG is split across pages.
  //
  // ONLY THE SUBSET tools/gen-opcode-map.js WRITES: <rect> with fill, stroke
  // and rx, and <text> with font-size, font-weight, fill, text-anchor and
  // letter-spacing, in the root's font-family unless it names its own.  A
  // monospace family is drawn in Courier and anything else in Helvetica.
  // Anything outside that throws rather than being dropped: a missing element
  // in a map is a wrong map.
  svg(src, { x = 0, y = 0, scale = 1, from = 0, to = Infinity } = {}) {
    const root = /<svg\b([^>]*)>/.exec(src);
    if (!root) throw new Error('pdf.js: not an SVG');
    const rootAttrs = attrs(root[1]);
    const h = Math.min(to, +rootAttrs.height) - from;
    const W = +rootAttrs.width;
    const X = (v) => x + v * scale, Y = (v) => y + (v - from) * scale;

    this.ops.push(`q ${num(x)} ${num(this.y(y + h * scale))} ${num(W * scale)} ${num(h * scale)} re W n`);
    const body = src.slice(root.index + root[0].length).replace(/<\/svg>\s*$/, '');
    const el = /<(\w+)([^>]*?)(\/>|>([^<]*)<\/\1>)|(\S)/g;
    for (let m; (m = el.exec(body));) {
      if (m[5]) throw new Error(`pdf.js: stray text in SVG near ${JSON.stringify(body.slice(m.index, m.index + 40))}`);
      const [, tag, rawAttrs, , content] = m;
      const a = attrs(rawAttrs);
      if (tag === 'rect') {
        const rx = +(a.x ?? 0), ry = +(a.y ?? 0), w = +a.width, hh = +a.height;
        if (ry > to || ry + hh < from) continue;
        const fill = a.fill && a.fill !== 'none' ? colour(a.fill) : null;
        const stroke = a.stroke ? colour(a.stroke) : null;
        const path = roundRect(X(rx), this.y(Y(ry) + hh * scale), w * scale, hh * scale, +(a.rx ?? 0) * scale);
        if (fill) this.ops.push(`${this.alpha(fill.a)} ${rgb(fill.c)} rg ${path} f`);
        if (stroke) this.ops.push(`${this.alpha(stroke.a)} ${num(+(a['stroke-width'] ?? 1) * scale)} w ${rgb(stroke.c)} RG ${path} S`);
      } else if (tag === 'text') {
        const ty = +a.y, size = +(a['font-size'] ?? 16);
        if (ty - size > to || ty < from) continue;
        const text = unescapeXml(content ?? '');
        const family = a['font-family'] ?? rootAttrs['font-family'] ?? '';
        const bold = +(a['font-weight'] ?? 400) >= 600;
        const font = /mono/i.test(family) ? (bold ? 'CB' : 'C') : (bold ? 'HB' : 'H');
        const spacing = +(a['letter-spacing'] ?? 0);
        const fill = colour(a.fill ?? rootAttrs.fill ?? '#000');
        const w = (width(text, font, size) + spacing * [...text].length) * scale;
        const anchor = a['text-anchor'] ?? 'start';
        const tx = X(+a.x) - (anchor === 'middle' ? w / 2 : anchor === 'end' ? w : 0);
        this.ops.push(`${this.alpha(fill.a)} BT /${font} ${num(size * scale)} Tf ${num(spacing * scale)} Tc ${rgb(fill.c)} rg ` +
          `${num(tx)} ${num(this.y(Y(ty)))} Td ${lit(text)} Tj ET 0 Tc`);
      } else {
        throw new Error(`pdf.js: <${tag}> is not in the SVG subset`);
      }
    }
    this.ops.push('Q');
  }

  // The graphics-state operator that sets fill and stroke opacity.
  alpha(a) {
    const name = `A${Math.round(a * 100)}`;
    this.doc.alphas.set(name, a);
    return `/${name} gs`;
  }
}

const attrs = (s) => Object.fromEntries([...s.matchAll(/([\w:-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));

const unescapeXml = (s) => s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_, e) =>
  ({ lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" })[e] ??
  String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1)));

// #rgb, #rrggbb, rgb() and rgba(), as [r, g, b] in 0..1 and an opacity.
function colour(s) {
  let m;
  if ((m = /^#([0-9a-f]{3})$/i.exec(s))) return { c: [...m[1]].map((h) => parseInt(h + h, 16) / 255), a: 1 };
  if ((m = /^#([0-9a-f]{6})$/i.exec(s))) return { c: [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255), a: 1 };
  if ((m = /^rgba?\(([^)]*)\)$/.exec(s))) {
    const v = m[1].split(',').map(Number);
    return { c: v.slice(0, 3).map((n) => n / 255), a: v[3] ?? 1 };
  }
  throw new Error(`pdf.js: colour ${s} is not in the SVG subset`);
}

// A rectangle with corners of radius r, in PDF coordinates: (x, y) is the
// BOTTOM left.  The control points are the usual 0.5523 of the radius.
function roundRect(x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  if (r <= 0) return `${num(x)} ${num(y)} ${num(w)} ${num(h)} re`;
  const k = r * 0.4477;
  const pts = [
    `${num(x + r)} ${num(y)} m`,
    `${num(x + w - r)} ${num(y)} l`,
    `${num(x + w - k)} ${num(y)} ${num(x + w)} ${num(y + k)} ${num(x + w)} ${num(y + r)} c`,
    `${num(x + w)} ${num(y + h - r)} l`,
    `${num(x + w)} ${num(y + h - k)} ${num(x + w - k)} ${num(y + h)} ${num(x + w - r)} ${num(y + h)} c`,
    `${num(x + r)} ${num(y + h)} l`,
    `${num(x + k)} ${num(y + h)} ${num(x)} ${num(y + h - k)} ${num(x)} ${num(y + h - r)} c`,
    `${num(x)} ${num(y + r)} l`,
    `${num(x)} ${num(y + k)} ${num(x + k)} ${num(y)} ${num(x + r)} ${num(y)} c`,
  ];
  return pts.join(' ') + ' h';
}

export class Pdf {
  constructor([w, h] = A4, { title = '', author = '' } = {}) {
    this.width = w;
    this.height = h;
    this.pages = [];
    this.outlines = [];
    this.info = { title, author };
    this.alphas = new Map();          // ExtGState name -> opacity
  }

  page() {
    const p = new Page(this);
    this.pages.push(p);
    return p;
  }

  // A bookmark.  `parent` is the value an earlier call returned, for nesting.
  outline(title, page, parent = null) {
    const o = { title, page, kids: [] };
    (parent ? parent.kids : this.outlines).push(o);
    return o;
  }

  bytes() {
    const objs = [];                  // index + 1 is the object number
    const alloc = () => objs.push(null);
    const set = (n, body) => { objs[n - 1] = body; };

    const catalog = alloc(), pagesN = alloc(), outlinesN = alloc(), infoN = alloc();
    const fontN = {};
    for (const [k, name] of Object.entries(FONTS)) {
      fontN[k] = alloc();
      set(fontN[k], `<< /Type /Font /Subtype /Type1 /BaseFont /${name} >>`);
    }
    const fontDict = '<< ' + Object.keys(FONTS).map((k) => `/${k} ${fontN[k]} 0 R`).join(' ') + ' >>';
    const gsDict = '<< ' + [...this.alphas].map(([k, a]) => `/${k} << /Type /ExtGState /ca ${num(a)} /CA ${num(a)} >>`).join(' ') + ' >>';

    const pageN = this.pages.map(() => alloc());
    const ref = (p) => `${pageN[this.pages.indexOf(p)]} 0 R`;

    this.pages.forEach((p, i) => {
      const content = deflateSync(Buffer.from(p.ops.join('\n'), 'latin1'));
      const c = alloc();
      set(c, { dict: `<< /Length ${content.length} /Filter /FlateDecode >>`, stream: content });
      const annots = p.links.map((l) => {
        const a = alloc();
        const action = typeof l.target === 'string'
          ? `/A << /S /URI /URI ${lit(l.target)} >>`
          : `/Dest [${ref(l.target)} /XYZ null null null]`;
        set(a, `<< /Type /Annot /Subtype /Link /Rect [${l.rect.map(num).join(' ')}] /Border [0 0 0] ${action} >>`);
        return `${a} 0 R`;
      });
      set(pageN[i], `<< /Type /Page /Parent ${pagesN} 0 R /MediaBox [0 0 ${num(this.width)} ${num(this.height)}] ` +
        `/Resources << /Font ${fontDict} /ExtGState ${gsDict} >> /Contents ${c} 0 R` +
        (annots.length ? ` /Annots [${annots.join(' ')}]` : '') + ' >>');
    });
    set(pagesN, `<< /Type /Pages /Kids [${pageN.map((n) => `${n} 0 R`).join(' ')}] /Count ${pageN.length} >>`);

    // The outline tree: each level is a doubly linked list under its parent.
    const outlineLevel = (items, parentN) => {
      const ns = items.map(() => alloc());
      items.forEach((o, i) => {
        const kids = o.kids.length ? outlineLevel(o.kids, ns[i]) : null;
        set(ns[i], `<< /Title ${lit(o.title)} /Parent ${parentN} 0 R /Dest [${ref(o.page)} /XYZ null null null]` +
          (i > 0 ? ` /Prev ${ns[i - 1]} 0 R` : '') +
          (i < ns.length - 1 ? ` /Next ${ns[i + 1]} 0 R` : '') +
          (kids ? ` /First ${kids[0]} 0 R /Last ${kids[kids.length - 1]} 0 R /Count -${kids.length}` : '') + ' >>');
      });
      return ns;
    };
    const top = outlineLevel(this.outlines, outlinesN);
    set(outlinesN, top.length
      ? `<< /Type /Outlines /First ${top[0]} 0 R /Last ${top[top.length - 1]} 0 R /Count ${top.length} >>`
      : '<< /Type /Outlines /Count 0 >>');

    set(infoN, `<< /Title ${lit(this.info.title)} /Author ${lit(this.info.author)} /Producer (tools/pdf.js) >>`);
    set(catalog, `<< /Type /Catalog /Pages ${pagesN} 0 R /Outlines ${outlinesN} 0 R /PageMode /UseOutlines >>`);

    const chunks = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
    let pos = chunks[0].length;
    const offsets = [];
    objs.forEach((o, i) => {
      offsets.push(pos);
      const parts = typeof o === 'string'
        ? [Buffer.from(`${i + 1} 0 obj\n${o}\nendobj\n`, 'latin1')]
        : [Buffer.from(`${i + 1} 0 obj\n${o.dict}\nstream\n`, 'latin1'), o.stream, Buffer.from('\nendstream\nendobj\n', 'latin1')];
      for (const b of parts) { chunks.push(b); pos += b.length; }
    });
    const xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` +
      offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('') +
      `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${infoN} 0 R >>\nstartxref\n${pos}\n%%EOF\n`;
    chunks.push(Buffer.from(xref, 'latin1'));
    return Buffer.concat(chunks);
  }
}
