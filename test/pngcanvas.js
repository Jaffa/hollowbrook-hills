'use strict';
/* Software 2D canvas + PNG encoder, enough of the API for the renderer to run
   headlessly so scenes can be eyeballed without a browser. */
const zlib = require('zlib');

function parseColor(s) {
  if (typeof s !== 'string') return [0, 0, 0, 1];
  if (s[0] === '#') {
    const n = parseInt(s.slice(1), 16);
    if (s.length === 7) return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
    if (s.length === 4) {
      const r = (n >> 8) & 15, g = (n >> 4) & 15, b = n & 15;
      return [r * 17, g * 17, b * 17, 1];
    }
  }
  let m = s.match(/^rgba?\(([^)]+)\)$/);
  if (m) {
    const p = m[1].split(',').map(v => parseFloat(v.trim()));
    return [p[0] | 0, p[1] | 0, p[2] | 0, p.length > 3 ? p[3] : 1];
  }
  return [255, 0, 255, 1];
}

class Surface {
  constructor(w, h) {
    this.width = w; this.height = h;
    this.data = new Uint8ClampedArray(w * h * 4);
  }
  blend(x, y, c, a) {
    x |= 0; y |= 0;
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    if (a <= 0) return;
    const i = (y * this.width + x) * 4;
    const d = this.data;
    if (a >= 1) { d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = 255; return; }
    const sa = a, da = d[i + 3] / 255;
    const oa = sa + da * (1 - sa);
    d[i] = (c[0] * sa + d[i] * da * (1 - sa)) / oa;
    d[i + 1] = (c[1] * sa + d[i + 1] * da * (1 - sa)) / oa;
    d[i + 2] = (c[2] * sa + d[i + 2] * da * (1 - sa)) / oa;
    d[i + 3] = oa * 255;
  }
}

class Ctx {
  constructor(surface) {
    this.s = surface;
    this.fillStyle = '#000';
    this.strokeStyle = '#000';
    this.lineWidth = 1;
    this.font = '';
    this.textAlign = 'left';
    this.textBaseline = 'alphabetic';
    this.imageSmoothingEnabled = false;
    this._path = [];
    this._sub = null;
    this._tx = 0; this._ty = 0; this._sx = 1; this._sy = 1;
  }
  setTransform(a, b, c, d, e, f) { this._sx = a; this._sy = d; this._tx = e; this._ty = f; }
  save() {} restore() {} setLineDash() {}
  measureText(t) { return { width: (t || '').length * 6 }; }
  fillText() {}      // labels are verified separately; glyphs would add noise
  strokeText() {}

  _X(x) { return x * this._sx + this._tx; }
  _Y(y) { return y * this._sy + this._ty; }

  clearRect() {}
  fillRect(x, y, w, h) {
    const c = parseColor(this.fillStyle);
    const x0 = Math.round(this._X(x)), y0 = Math.round(this._Y(y));
    const x1 = Math.round(this._X(x + w)), y1 = Math.round(this._Y(y + h));
    for (let py = y0; py < y1; py++) for (let px = x0; px < x1; px++) this.s.blend(px, py, c, c[3]);
  }
  strokeRect(x, y, w, h) {
    const c = parseColor(this.strokeStyle);
    const x0 = Math.round(this._X(x)), y0 = Math.round(this._Y(y));
    const x1 = Math.round(this._X(x + w)), y1 = Math.round(this._Y(y + h));
    for (let px = x0; px < x1; px++) { this.s.blend(px, y0, c, c[3]); this.s.blend(px, y1 - 1, c, c[3]); }
    for (let py = y0; py < y1; py++) { this.s.blend(x0, py, c, c[3]); this.s.blend(x1 - 1, py, c, c[3]); }
  }

  beginPath() { this._path = []; this._sub = null; }
  moveTo(x, y) { this._sub = [{ x: this._X(x), y: this._Y(y) }]; this._path.push(this._sub); }
  lineTo(x, y) { if (!this._sub) this.moveTo(x, y); else this._sub.push({ x: this._X(x), y: this._Y(y) }); }
  closePath() { if (this._sub && this._sub.length > 1) this._sub.push({ x: this._sub[0].x, y: this._sub[0].y }); }
  ellipse(cx, cy, rx, ry) {
    // Approximated as a polygon; only used for soft shadows.
    const pts = [];
    for (let i = 0; i < 24; i++) {
      const t = i / 24 * Math.PI * 2;
      pts.push({ x: this._X(cx + Math.cos(t) * rx), y: this._Y(cy + Math.sin(t) * ry) });
    }
    this._sub = pts; this._path.push(pts);
  }
  arc(cx, cy, r) { this.ellipse(cx, cy, r, r); }

  _line(a, b, c, alpha, w) {
    if (![a.x, a.y, b.x, b.y].every(Number.isFinite)) return;
    let x0 = Math.round(a.x), y0 = Math.round(a.y), x1 = Math.round(b.x), y1 = Math.round(b.y);
    const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    const t = Math.max(1, Math.round(w));
    for (;;) {
      for (let o = 0; o < t; o++) this.s.blend(x0, y0 + o, c, alpha);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x0 += sx; }
      if (e2 < dx) { err += dx; y0 += sy; }
    }
  }
  stroke() {
    const c = parseColor(this.strokeStyle);
    for (const sub of this._path) {
      for (let i = 0; i + 1 < sub.length; i++) this._line(sub[i], sub[i + 1], c, c[3], this.lineWidth * this._sx);
    }
  }
  fill() {
    const c = parseColor(this.fillStyle);
    for (const pts of this._path) {
      if (pts.length < 3) continue;
      let ymin = Infinity, ymax = -Infinity;
      for (const p of pts) { ymin = Math.min(ymin, p.y); ymax = Math.max(ymax, p.y); }
      for (let y = Math.floor(ymin); y <= Math.ceil(ymax); y++) {
        const xs = [];
        for (let i = 0; i < pts.length; i++) {
          const a = pts[i], b = pts[(i + 1) % pts.length];
          const sy2 = y + 0.5;
          if ((a.y <= sy2 && b.y > sy2) || (b.y <= sy2 && a.y > sy2)) {
            xs.push(a.x + (sy2 - a.y) / (b.y - a.y) * (b.x - a.x));
          }
        }
        xs.sort((m, n) => m - n);
        for (let k = 0; k + 1 < xs.length; k += 2) {
          for (let x = Math.ceil(xs[k] - 0.5); x < Math.ceil(xs[k + 1] - 0.5); x++) this.s.blend(x, y, c, c[3]);
        }
      }
    }
  }

  drawImage(src) {
    const img = src._img || (src.canvas && src.canvas._img);
    if (!img) return;
    let sx = 0, sy = 0, sw = src.width, sh = src.height, dx, dy, dw, dh;
    if (arguments.length === 3) { dx = arguments[1]; dy = arguments[2]; dw = sw; dh = sh; }
    else if (arguments.length === 5) { dx = arguments[1]; dy = arguments[2]; dw = arguments[3]; dh = arguments[4]; }
    else { sx = arguments[1]; sy = arguments[2]; sw = arguments[3]; sh = arguments[4]; dx = arguments[5]; dy = arguments[6]; dw = arguments[7]; dh = arguments[8]; }
    const X0 = this._X(dx), Y0 = this._Y(dy);
    const W = dw * this._sx, H = dh * this._sy;
    const px0 = Math.round(X0), py0 = Math.round(Y0);
    const px1 = Math.round(X0 + W), py1 = Math.round(Y0 + H);
    for (let py = py0; py < py1; py++) {
      const v = (py - py0) / (py1 - py0);
      const iy = Math.min(sh - 1, Math.max(0, Math.floor(sy + v * sh)));
      for (let px = px0; px < px1; px++) {
        const u = (px - px0) / (px1 - px0);
        const ix = Math.min(sw - 1, Math.max(0, Math.floor(sx + u * sw)));
        const i = (iy * img.width + ix) * 4;
        const a = img.data[i + 3] / 255;
        if (a > 0) this.s.blend(px, py, [img.data[i], img.data[i + 1], img.data[i + 2]], a);
      }
    }
  }
}

function crc32(buf) {
  let c, table = crc32._t;
  if (!table) {
    table = crc32._t = [];
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}

function writePng(surface, file) {
  const { width: w, height: h, data } = surface;
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    throw new Error('bad surface size ' + w + 'x' + h);
  }
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    for (let x = 0; x < w * 4; x++) raw[y * (w * 4 + 1) + 1 + x] = data[y * w * 4 + x];
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  require('fs').writeFileSync(file, png);
  return file;
}

module.exports = { Surface, Ctx, writePng, parseColor };
