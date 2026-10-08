// =============================================================================
// x11.js - a window that shows RGB frames, speaking X11 over its socket
// =============================================================================
//
//   const win = await openWindow({ title, width, height, scale });
//   win.show({ width, height, rgb });
//   await win.closed;            // the window was closed, or a key pressed in it
//
// No Xlib, no libraries: the protocol is a few fixed-layout requests over the
// server's Unix socket, and this file sends seven of them - CreateWindow,
// ChangeProperty for the title, CreateGC, MapWindow, ConfigureWindow when the
// size changes, PutImage, and FreeGC's absence is the server's business when
// the connection goes.  The machine this was written on is a Chromebook,
// where Linux programs reach the display through XWayland; anything with an
// X server at $DISPLAY will do.
//
// AUTHENTICATION is the MIT-MAGIC-COOKIE-1 in $XAUTHORITY or ~/.Xauthority for
// the display's number, or none.  Only local displays, ":N", are supported.
//
// THE IMAGE is sent as a ZPixmap at the root window's depth, in strips that
// each fit the server's maximum request length, and kept for Expose events.
// =============================================================================

import { createConnection } from 'node:net';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

const pad4 = (n) => (n + 3) & ~3;

function cookie(display) {
  let buf;
  try { buf = readFileSync(process.env.XAUTHORITY || `${homedir()}/.Xauthority`); }
  catch { return null; }
  let o = 0;
  const field = () => { const n = buf.readUInt16BE(o); const v = buf.subarray(o + 2, o + 2 + n); o += 2 + n; return v; };
  while (o + 2 <= buf.length) {
    o += 2;                                            // family
    field();                                           // address
    const number = field().toString('latin1'), name = field().toString('latin1'), data = field();
    if (number === String(display) && name === 'MIT-MAGIC-COOKIE-1') return { name, data };
  }
  return null;
}

// The server's setup reply: the id range, the request limit, the image byte
// order, and the root window with its depth, visual masks and bits per pixel.
function parseSetup(b) {
  const vendorLen = b.readUInt16LE(24), nFormats = b[29];
  const s = {
    idBase: b.readUInt32LE(12), maxReq: b.readUInt16LE(26) * 4, msbImage: b[30] === 1,
  };
  let o = 40 + pad4(vendorLen);
  const formats = [];
  for (let i = 0; i < nFormats; i++, o += 8) formats.push({ depth: b[o], bpp: b[o + 1] });
  // The first screen.
  s.root = b.readUInt32LE(o);
  s.black = b.readUInt32LE(o + 12);
  s.visual = b.readUInt32LE(o + 32);
  s.depth = b[o + 38];
  const nDepths = b[o + 39];
  o += 40;
  for (let d = 0; d < nDepths; d++) {
    const nVis = b.readUInt16LE(o + 2);
    o += 8;
    for (let v = 0; v < nVis; v++, o += 24)
      if (b.readUInt32LE(o) === s.visual)
        s.masks = [b.readUInt32LE(o + 8), b.readUInt32LE(o + 12), b.readUInt32LE(o + 16)];
  }
  s.bpp = formats.find((f) => f.depth === s.depth)?.bpp;
  if (!s.masks || (s.bpp !== 32 && s.bpp !== 24)) throw new Error(`x11: unsupported visual (depth ${s.depth}, ${s.bpp} bpp)`);
  return s;
}

export function openWindow({ title = 'fructus', width = 640, height = 480, scale = 1 } = {}) {
  const m = /^(?:unix)?:(\d+)(?:\.\d+)?$/.exec(process.env.DISPLAY ?? '');
  if (!m) return Promise.reject(new Error(`x11: DISPLAY=${process.env.DISPLAY ?? ''} is not a local display`));
  const sock = createConnection(`/tmp/.X11-unix/X${m[1]}`);
  const auth = cookie(m[1]);

  return new Promise((resolve, reject) => {
    let inbuf = Buffer.alloc(0), setup = null, win = null;
    sock.on('error', (e) => (win ? win._close() : reject(new Error(`x11: ${e.message}`))));
    sock.on('connect', () => {
      const name = Buffer.from(auth ? auth.name : ''), data = auth ? auth.data : Buffer.alloc(0);
      const req = Buffer.alloc(12 + pad4(name.length) + pad4(data.length));
      req[0] = 0x6c;                                   // 'l': little-endian requests
      req.writeUInt16LE(11, 2);
      req.writeUInt16LE(name.length, 6);
      req.writeUInt16LE(data.length, 8);
      name.copy(req, 12);
      data.copy(req, 12 + pad4(name.length));
      sock.write(req);
    });
    sock.on('data', (chunk) => {
      inbuf = Buffer.concat([inbuf, chunk]);
      if (!setup) {
        if (inbuf.length < 8) return;
        const total = 8 + inbuf.readUInt16LE(6) * 4;
        if (inbuf.length < total) return;
        const reply = inbuf.subarray(0, total);
        inbuf = inbuf.subarray(total);
        if (reply[0] !== 1) {
          sock.destroy();
          return reject(new Error(`x11: connection refused: ${reply.subarray(8, 8 + reply[1]).toString('latin1')}`));
        }
        try { setup = parseSetup(reply); } catch (e) { sock.destroy(); return reject(e); }
        win = new Window(sock, setup, { title, width, height, scale });
        resolve(win);
      }
      // Events, errors and replies: 32 bytes each, a reply longer by its length.
      while (inbuf.length >= 32) {
        const extra = inbuf[0] === 1 ? inbuf.readUInt32LE(4) * 4 : 0;
        if (inbuf.length < 32 + extra) break;
        win._event(inbuf.subarray(0, 32));
        inbuf = inbuf.subarray(32 + extra);
      }
    });
    sock.on('close', () => (win ? win._close() : reject(new Error('x11: the server closed the connection'))));
  });
}

class Window {
  constructor(sock, s, { title, width, height, scale }) {
    this.sock = sock; this.s = s; this.scale = scale;
    this.id = s.idBase | 1; this.gc = s.idBase | 2;
    this.width = width * scale; this.height = height * scale;
    this.pic = null;
    this.closed = new Promise((r) => { this._resolve = r; });
    this.isClosed = false;
    const shifts = s.masks.map((mk) => [Math.clz32(mk & -mk) ^ 31, 32 - Math.clz32(mk) - (Math.clz32(mk & -mk) ^ 31)]);
    // A channel's 8 bits, cut or widened to its mask's width, in its place.
    this.chan = shifts.map(([sh, bits]) => (v) => ((bits >= 8 ? v << (bits - 8) : v >> (8 - bits)) << sh) >>> 0);

    const titleBuf = Buffer.from(title, 'latin1');
    this.req(1, s.depth, [this.id, s.root, 0 /* x | y */, this.width | this.height << 16, 0 | 1 << 16, 0,
                          0x2 | 0x800, s.black, 0x1 | 0x8000 | 0x20000]);
    this.req(18, 0, [this.id, 39 /* WM_NAME */, 31 /* STRING */, 8, titleBuf.length], titleBuf);
    this.req(55, 0, [this.gc, this.id, 0]);
    this.req(8, 0, [this.id]);
  }

  // One request: its opcode, the byte after it, its 32-bit words, and any data.
  req(op, b1, words, data = null) {
    const n = 4 + words.length * 4 + (data ? pad4(data.length) : 0);
    const buf = Buffer.alloc(n);
    buf[0] = op; buf[1] = b1; buf.writeUInt16LE(n / 4, 2);
    words.forEach((w, i) => buf.writeUInt32LE(w >>> 0, 4 + 4 * i));
    if (data) data.copy(buf, 4 + words.length * 4);
    if (!this.isClosed) this.sock.write(buf);
  }

  show(pic) {
    this.pic = pic;
    const w = pic.width * this.scale, h = pic.height * this.scale;
    if (w !== this.width || h !== this.height) {
      this.width = w; this.height = h;
      this.req(12, 0, [this.id, 0x4 | 0x8, w, h]);    // ConfigureWindow: width, height
    }
    this.draw();
  }

  draw() {
    const pic = this.pic;
    if (!pic || this.isClosed) return;
    const { scale, s } = this, w = this.width, bypp = s.bpp / 8;
    const stride = pad4(w * bypp);
    const rows = Math.max(1, Math.floor((s.maxReq - 24) / stride));
    const [r, g, b] = this.chan;
    for (let y0 = 0; y0 < this.height; y0 += rows) {
      const n = Math.min(rows, this.height - y0), data = Buffer.alloc(n * stride);
      for (let y = 0; y < n; y++) {
        const src = Math.floor((y0 + y) / scale) * pic.width * 3;
        for (let x = 0; x < w; x++) {
          const p = src + Math.floor(x / scale) * 3;
          const v = (r(pic.rgb[p]) | g(pic.rgb[p + 1]) | b(pic.rgb[p + 2])) >>> 0;
          const o = y * stride + x * bypp;
          if (bypp === 4) s.msbImage ? data.writeUInt32BE(v, o) : data.writeUInt32LE(v, o);
          else if (s.msbImage) { data[o] = v >> 16; data[o + 1] = v >> 8; data[o + 2] = v; }
          else { data[o] = v; data[o + 1] = v >> 8; data[o + 2] = v >> 16; }
        }
      }
      // PutImage, ZPixmap: drawable, gc, width | height, x | y, left pad, depth.
      this.req(72, 2, [this.id, this.gc, w | n << 16, 0 | y0 << 16, s.depth << 8], data);
    }
  }

  _event(e) {
    const code = e[0] & 0x7f;
    if (code === 0 && !this.warned) {
      this.warned = true;
      console.error(`x11: error ${e[1]} from request ${e[10]}`);
    } else if (code === 12 && e.readUInt16LE(16) === 0) this.draw();     // Expose, the last of a batch
    else if (code === 2) this.close();                                    // KeyPress
    else if (code === 17) this._close();                                  // DestroyNotify
  }

  close() { if (!this.isClosed) { this.sock.end(); this._close(); } }
  _close() { if (!this.isClosed) { this.isClosed = true; this._resolve(); } }
}
