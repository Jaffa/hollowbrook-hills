'use strict';
/* Isometric art engine: software-rasterized pixel art in "art pixel" space.
   1 art px is scaled up by PIXEL_SCALE * zoom at draw time (nearest-neighbour),
   which is what keeps edges hard instead of antialiased. */
(function (global) {

const AHW = 16, AHH = 8;            // half-width / half-height of a tile diamond
const AW = AHW * 2, AH = AHH * 2;
const ALEVEL = 8;                   // vertical rise per elevation level
const MAX_LEVEL = 12;

/* ---------------- colour ---------------- */
function hexToRgb(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function cl(v) { return v < 0 ? 0 : v > 255 ? 255 : v | 0; }
function sh(h, f) { const c = hexToRgb(h); return [cl(c[0] * f), cl(c[1] * f), cl(c[2] * f)]; }
function mixc(a, b, t) { return [cl(a[0] + (b[0] - a[0]) * t), cl(a[1] + (b[1] - a[1]) * t), cl(a[2] + (b[2] - a[2]) * t)]; }
function toHex(c) { return '#' + c.map(function (v) { return cl(v).toString(16).padStart(2, '0'); }).join(''); }
function mixHex(a, b, t) { return toHex(mixc(hexToRgb(a), hexToRgb(b), t)); }

function hash2(x, y, s) {
  let n = (x | 0) * 374761393 + (y | 0) * 668265263 + (s | 0) * 362437;
  n = (n ^ (n >>> 13)) * 1274126177;
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}
function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 16777619) >>> 0; } return h; }
function dith(a, b, p, seed) { return (x, y) => (hash2(x, y, seed) < p ? b : a); }

/* ---------------- raster ---------------- */
function Raster(w, h) { this.w = w; this.h = h; this.d = new Uint8ClampedArray(w * h * 4); }

Raster.prototype.set = function (x, y, c) {
  if (!c || x < 0 || y < 0 || x >= this.w || y >= this.h) return;
  const i = (y * this.w + x) * 4;
  this.d[i] = c[0]; this.d[i + 1] = c[1]; this.d[i + 2] = c[2]; this.d[i + 3] = 255;
};

function colFn(c) { return typeof c === 'function' ? c : function () { return c; }; }

// Even-odd scanline fill sampled at pixel centres: hard edges, no AA.
Raster.prototype.fill = function (pts, color) {
  if (!color) return;
  const f = colFn(color);
  let ymin = Infinity, ymax = -Infinity;
  for (const p of pts) { if (p.y < ymin) ymin = p.y; if (p.y > ymax) ymax = p.y; }
  const y0 = Math.max(0, Math.floor(ymin)), y1 = Math.min(this.h - 1, Math.ceil(ymax));
  const xs = [];
  for (let y = y0; y <= y1; y++) {
    const sy = y + 0.5;
    xs.length = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      if ((a.y <= sy && b.y > sy) || (b.y <= sy && a.y > sy)) {
        xs.push(a.x + (sy - a.y) / (b.y - a.y) * (b.x - a.x));
      }
    }
    if (xs.length < 2) continue;
    xs.sort(function (m, n) { return m - n; });
    for (let k = 0; k + 1 < xs.length; k += 2) {
      let sx = Math.ceil(xs[k] - 0.5), ex = Math.ceil(xs[k + 1] - 0.5) - 1;
      if (sx < 0) sx = 0;
      if (ex > this.w - 1) ex = this.w - 1;
      for (let x = sx; x <= ex; x++) this.set(x, y, f(x, y));
    }
  }
};

Raster.prototype.line = function (x0, y0, x1, y1, color) {
  const f = colFn(color);
  x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
  const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  for (;;) {
    this.set(x0, y0, f(x0, y0));
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x0 += sx; }
    if (e2 < dx) { err += dx; y0 += sy; }
  }
};

Raster.prototype.dash = function (x0, y0, x1, y1, color, on, off) {
  const f = colFn(color);
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
  for (let i = 0; i <= steps; i++) {
    if (i % (on + off) >= on) continue;
    const t = steps ? i / steps : 0;
    const x = Math.round(x0 + (x1 - x0) * t), y = Math.round(y0 + (y1 - y0) * t);
    this.set(x, y, f(x, y));
  }
};

Raster.prototype.ell = function (cx, cy, rx, ry, color) {
  const f = colFn(color);
  for (let y = Math.floor(-ry); y <= Math.ceil(ry); y++) {
    const t = y / ry;
    if (Math.abs(t) > 1) continue;
    const hw = rx * Math.sqrt(1 - t * t);
    const py = Math.round(cy + y);
    for (let x = Math.ceil(cx - hw - 0.5); x <= Math.ceil(cx + hw - 0.5) - 1; x++) this.set(x, py, f(x, py));
  }
};

/* Multiplies every opaque pixel, used to key ground shade to elevation. */
Raster.prototype.tint = function (f) {
  if (f === 1) return this;
  const d = this.d;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    d[i] = cl(d[i] * f); d[i + 1] = cl(d[i + 1] * f); d[i + 2] = cl(d[i + 2] * f);
  }
  return this;
};

Raster.prototype.toCanvas = function () {
  const cv = document.createElement('canvas');
  cv.width = this.w; cv.height = this.h;
  cv.getContext('2d').putImageData(new ImageData(this.d, this.w, this.h), 0, 0);
  return cv;
};

/* ---------------- projection ----------------
   Local footprint coords: cf in [0,fw], rf in [0,fh], z in art px upward. */
function makeProj(fw, fh, zmax) {
  const W = (fw + fh) * AHW, H = (fw + fh) * AHH + zmax;
  const ox = fh * AHW, oy = zmax;
  return {
    W: W, H: H,
    p: function (c, r, z) { return { x: (c - r) * AHW + ox, y: (c + r) * AHH - z + oy }; },
    ax: (fw - fh) * AHW / 2 + ox,
    ay: (fw + fh) * AHH / 2 + oy,
  };
}

/* ---------------- solids ---------------- */
function qTop(p, c0, r0, c1, r1, z) { return [p(c0, r0, z), p(c1, r0, z), p(c1, r1, z), p(c0, r1, z)]; }
function qRight(p, c, r0, r1, z0, z1) { return [p(c, r0, z1), p(c, r1, z1), p(c, r1, z0), p(c, r0, z0)]; }
function qLeft(p, r, c0, c1, z0, z1) { return [p(c0, r, z1), p(c1, r, z1), p(c1, r, z0), p(c0, r, z0)]; }

// Faces meeting at the near (south) corner are the visible ones.
function box(R, p, c0, r0, c1, r1, z0, z1, col) {
  if (col.right) R.fill(qRight(p, c1, r0, r1, z0, z1), col.right);
  if (col.left) R.fill(qLeft(p, r1, c0, c1, z0, z1), col.left);
  if (col.top) R.fill(qTop(p, c0, r0, c1, r1, z1), col.top);
}

function pyramid(R, p, c0, r0, c1, r1, z0, z1, col) {
  const cm = (c0 + c1) / 2, rm = (r0 + r1) / 2, apex = p(cm, rm, z1);
  R.fill([p(c0, r0, z0), p(c1, r0, z0), apex], col.far);
  R.fill([p(c0, r0, z0), p(c0, r1, z0), apex], col.far);
  R.fill([p(c0, r1, z0), p(c1, r1, z0), apex], col.left);
  R.fill([p(c1, r0, z0), p(c1, r1, z0), apex], col.right);
}

/* Extrude a cross-section along one axis. Handles gable / gambrel / shed / awning
   from one code path; profile is ordered along the varying axis so painting it in
   order draws far-to-near. */
function extrude(R, p, axis, a0, a1, profile, segColor, endColor) {
  const pt = axis === 'col'
    ? function (a, s, z) { return p(a, s, z); }     // varies in rf, extruded along cf
    : function (a, s, z) { return p(s, a, z); };    // varies in cf, extruded along rf
  for (let i = 0; i + 1 < profile.length; i++) {
    const A = profile[i], B = profile[i + 1];
    const c = segColor(A, B, i);
    if (!c) continue;
    R.fill([pt(a0, A.s, A.z), pt(a1, A.s, A.z), pt(a1, B.s, B.z), pt(a0, B.s, B.z)], c);
  }
  if (endColor) {
    let zb = Infinity;
    for (const q of profile) if (q.z < zb) zb = q.z;
    const poly = profile.map(function (q) { return pt(a1, q.s, q.z); });
    poly.push(pt(a1, profile[profile.length - 1].s, zb), pt(a1, profile[0].s, zb));
    R.fill(poly, endColor);
  }
}

function cylinder(R, p, cc, rc, rad, z0, z1, col) {
  const top = p(cc, rc, z1), bot = p(cc, rc, z0);
  const rx = rad * AHW * Math.SQRT2, ry = rad * AHH * Math.SQRT2;
  for (let x = -Math.floor(rx); x <= Math.floor(rx); x++) {
    const t = x / rx, dy = ry * Math.sqrt(Math.max(0, 1 - t * t));
    const px = Math.round(top.x + x);
    const y0 = Math.round(top.y + dy), y1 = Math.round(bot.y + dy);
    const f = 0.55 + 0.45 * (1 - (x + rx) / (2 * rx));
    const base = mixc(col.dark, col.lightRgb, f);
    for (let y = y0; y <= y1; y++) {
      const band = (y % 7 === 0) ? mixc(base, col.dark, 0.35) : base;
      R.set(px, y, band);
    }
  }
  R.ell(top.x, top.y, rx, ry, col.top);
}

/* ---------------- seasons ---------------- */
let season = 'summer';
const SNOWY = { winter: 1, christmas: 1 };

const FOLIAGE = {
  summer: { oak: '#3f7a3f', pine: '#2f6b4f', bush: '#4a7a3a' },
  autumn: { oak: '#c07a2a', pine: '#2a5f45', bush: '#8a6a2a' },
  winter: { oak: '#6a5340', pine: '#2a5744', bush: '#7a7268' },
  christmas: { oak: '#6a5340', pine: '#2a5744', bush: '#7a7268' },
  halloween: { oak: '#8a4a1a', pine: '#27503c', bush: '#5a5230' },
  easter: { oak: '#5aa04a', pine: '#357a58', bush: '#63a352' },
};

function leafOf(kind, fallback) {
  const set = FOLIAGE[season] || FOLIAGE.summer;
  return set[kind] || fallback;
}
function isSnowy() { return !!SNOWY[season]; }

/* ---------------- object definitions ---------------- */
const WIN_LIT = '#f5e58a', WIN_DARK = '#3f5a6a';

function spread(len, item, gap) {
  const n = Math.max(1, Math.floor((len + gap) / (item + gap)));
  const used = n * item + (n - 1) * gap;
  const out = [];
  for (let i = 0; i < n; i++) out.push((len - used) / 2 + i * (item + gap));
  return out;
}

function windowRows(bodyH) { return Math.max(1, Math.min(4, Math.floor((bodyH - 5) / 7))); }

function drawWindows(R, p, c0, r0, c1, r1, bodyH, cfg, seed) {
  const rows = cfg.windows === 0 ? 0 : windowRows(bodyH);
  const glass = cfg.windowColor || '#5fb8c9';
  const ww = 4, wh = 5, gap = 6;
  for (let i = 0; i < rows; i++) {
    const z = 5 + i * 7;
    if (z + wh > bodyH - 1) break;
    for (const s of spread((r1 - r0) * AHW, ww, gap)) {
      const a = r0 + s / AHW, b = a + ww / AHW;
      const lit = hash2(i, Math.round(s), seed) < 0.28;
      R.fill(qRight(p, c1, a, b, z, z + wh), lit ? sh(WIN_LIT, 0.72) : sh(glass, 0.5));
    }
    for (const s of spread((c1 - c0) * AHW, ww, gap)) {
      const a = c0 + s / AHW, b = a + ww / AHW;
      const lit = hash2(i, Math.round(s), seed + 7) < 0.28;
      R.fill(qLeft(p, r1, a, b, z, z + wh), lit ? WIN_LIT : sh(glass, 0.8));
    }
  }
}

function roof(R, p, c0, r0, c1, r1, z, cfg, wallCol) {
  // Winter settles on the upward-facing surfaces rather than recolouring the whole roof.
  const rc = isSnowy() ? mixHex(cfg.roofColor || '#4a3f3a', '#eef4f8', 0.72) : (cfg.roofColor || '#4a3f3a');
  const type = cfg.roofType || 'flat';
  const rh = cfg.roofH || 8;
  const along = cfg.ridge === 'row' ? 'row' : 'col';

  if (type === 'flat') {
    box(R, p, c0, r0, c1, r1, z, z + 2, { top: sh(rc, 1.05), left: sh(rc, 0.8), right: sh(rc, 0.58) });
    R.fill(qTop(p, c0 + 0.08, r0 + 0.08, c1 - 0.08, r1 - 0.08, z + 1), sh(rc, 0.72));
    if (cfg.hvac) {
      const cm = (c0 + c1) / 2, rm = (r0 + r1) / 2;
      box(R, p, cm - 0.3, rm - 0.25, cm + 0.1, rm + 0.15, z + 1, z + 5,
        { top: '#9aa0a3', left: sh('#9aa0a3', 0.78), right: sh('#9aa0a3', 0.56) });
    }
    return;
  }

  const lo = along === 'col' ? r0 : c0, hi = along === 'col' ? r1 : c1;
  const mid = (lo + hi) / 2;
  const ext = along === 'col' ? [c0, c1] : [r0, r1];
  let profile;
  if (type === 'shed') profile = [{ s: lo, z: z + rh }, { s: hi, z: z }];
  else if (type === 'gambrel') profile = [
    { s: lo, z: z }, { s: lo + (hi - lo) * 0.22, z: z + rh * 0.62 }, { s: mid, z: z + rh },
    { s: hi - (hi - lo) * 0.22, z: z + rh * 0.62 }, { s: hi, z: z },
  ];
  else if (type === 'hip') {
    // Ridge inset from both ends; the two end slopes are the hips.
    const q = (hi - lo) * 0.5;
    profile = [{ s: lo, z: z }, { s: mid, z: z + rh }, { s: hi, z: z }];
    extrude(R, p, along, ext[0] + q * 0.55, ext[1] - q * 0.55, profile, function (A, B) {
      return B.z < A.z ? sh(rc, 0.72) : sh(rc, 1.02);
    }, null);
    const apexA = along === 'col' ? p(ext[0] + q * 0.55, mid, z + rh) : p(mid, ext[0] + q * 0.55, z + rh);
    const apexB = along === 'col' ? p(ext[1] - q * 0.55, mid, z + rh) : p(mid, ext[1] - q * 0.55, z + rh);
    const cA = along === 'col'
      ? [p(ext[0], r0, z), p(ext[0], r1, z)] : [p(c0, ext[0], z), p(c1, ext[0], z)];
    const cB = along === 'col'
      ? [p(ext[1], r0, z), p(ext[1], r1, z)] : [p(c0, ext[1], z), p(c1, ext[1], z)];
    R.fill([cA[0], cA[1], apexA], sh(rc, 0.95));
    R.fill([cB[0], cB[1], apexB], sh(rc, along === 'col' ? 0.62 : 0.68));
    return;
  }
  else profile = [{ s: lo, z: z }, { s: mid, z: z + rh }, { s: hi, z: z }];

  extrude(R, p, along, ext[0], ext[1], profile, function (A, B) {
    return B.z < A.z ? sh(rc, 0.7) : sh(rc, 1.03);
  }, sh(cfg.wall || wallCol, along === 'col' ? 0.58 : 0.8));
}

function genericBuild(R, proj, cfg, fw, fh, rot, seed) {
  const p = proj.p;
  const c0 = 0, r0 = 0, c1 = fw, r1 = fh;
  const bodyH = cfg.bodyH;
  const wall = cfg.wall;
  const col = { top: sh(wall, 1.0), left: sh(wall, 0.8), right: sh(wall, 0.58) };
  if (rot) cfg = Object.assign({}, cfg, { ridge: cfg.ridge === 'row' ? 'col' : 'row' });

  if (cfg.columns) {
    box(R, p, c0 + 0.12, r0 + 0.12, c1 - 0.12, r1 - 0.12, 0, bodyH, col);
    for (const s of spread((c1 - c0) * AHW, 3, 7)) {
      const a = c0 + s / AHW;
      box(R, p, a, r1 - 0.02, a + 3 / AHW, r1 + 0.1, 0, bodyH - 2,
        { top: sh(wall, 1.1), left: sh(wall, 0.95), right: sh(wall, 0.68) });
    }
  } else {
    box(R, p, c0, r0, c1, r1, 0, bodyH, col);
  }

  drawWindows(R, p, c0, r0, c1, r1, bodyH, cfg, seed);

  if (cfg.door !== false) {
    const cm = (c0 + c1) / 2;
    R.fill(qLeft(p, r1, cm - 2.2 / AHW, cm + 2.2 / AHW, 0, 7), sh(cfg.doorColor || '#3a2a1c', 0.9));
  }

  if (cfg.sign) {
    R.fill(qLeft(p, r1, c0 + 0.12, c1 - 0.12, bodyH - 6, bodyH - 1), sh(cfg.sign, 0.95));
    R.fill(qLeft(p, r1, c0 + 0.12, c1 - 0.12, bodyH - 6, bodyH - 5.4), sh(cfg.sign, 0.6));
    if (cfg.neon) R.fill(qRight(p, c1, r0 + 0.2, r1 - 0.2, bodyH - 6, bodyH - 1), sh(cfg.sign, 0.66));
  }

  if (cfg.awning) {
    const zA = Math.max(8, Math.round(bodyH * 0.52));
    extrude(R, p, 'col', c0 + 0.05, c1 - 0.05,
      [{ s: r1, z: zA }, { s: r1 + 0.3, z: zA - 3 }],
      function () { return sh(cfg.awning, 0.9); }, null);
  }

  roof(R, p, c0, r0, c1, r1, bodyH, cfg, wall);

  if (cfg.stacks) {
    const st = cfg.stackH || 14;
    for (let i = 0; i < cfg.stacks; i++) {
      const cc = c0 + 0.5 + i * 1.1, rc = r0 + 0.45;
      if (cc > c1 - 0.3) break;
      cylinder(R, p, cc, rc, 0.16, bodyH, bodyH + st,
        { top: sh('#9aa0a3', 1.05), lightRgb: sh('#9aa0a3', 1.0), dark: sh('#9aa0a3', 0.45) });
      R.fill(qTop(p, cc - 0.14, rc - 0.14, cc + 0.14, rc + 0.14, bodyH + st * 0.72), sh('#b8493f', 0.9));
    }
  }

  if (cfg.steeple) {
    const sH = cfg.steepleH || 20;
    const a = c1 - 0.95, b = c1 - 0.15, rm = (r0 + r1) / 2;
    box(R, p, a, rm - 0.4, b, rm + 0.4, bodyH - 2, bodyH + sH * 0.45,
      { top: sh(wall, 1.02), left: sh(wall, 0.84), right: sh(wall, 0.6) });
    R.fill(qLeft(p, rm + 0.4, a + 0.34, b - 0.34, bodyH + sH * 0.16, bodyH + sH * 0.3), sh('#3a3228', 1));
    R.fill(qRight(p, b, rm - 0.28, rm + 0.28, bodyH + sH * 0.16, bodyH + sH * 0.3), sh('#2e2820', 1));
    pyramid(R, p, a, rm - 0.4, b, rm + 0.4, bodyH + sH * 0.45, bodyH + sH,
      { far: sh(cfg.roofColor || '#4a3f3a', 1.02), left: sh(cfg.roofColor || '#4a3f3a', 0.74), right: sh(cfg.roofColor || '#4a3f3a', 0.55) });
  }

  if (cfg.pole) {
    const pH = cfg.poleH || 16, cc = c0 + 0.35, rc = r1 - 0.3;
    const base = p(cc, rc, 0), tip = p(cc, rc, pH);
    R.line(base.x, base.y, tip.x, tip.y, sh('#c9c2b8', 0.85));
    R.fill([tip, { x: tip.x + 7, y: tip.y + 2 }, { x: tip.x + 7, y: tip.y + 6 }, { x: tip.x, y: tip.y + 4 }], sh('#b8493f', 1));
  }

  if (cfg.canopy) {
    const zC = cfg.bodyH + 2;
    box(R, p, c0 - 0.15, r1 - 0.05, c1 + 0.15, r1 + 1.1, zC, zC + 2.5,
      { top: '#e8e2d4', left: sh('#e8e2d4', 0.8), right: sh('#e8e2d4', 0.58) });
    for (const cc of [c0, c1 - 0.12]) {
      box(R, p, cc, r1 + 0.85, cc + 0.12, r1 + 1.0, 0, zC,
        { top: '#b0aaa0', left: sh('#b0aaa0', 0.8), right: sh('#b0aaa0', 0.56) });
    }
  }

  if (season === 'christmas' && cfg.lights !== false) {
    const bulbs = ['#ff3d5f', '#f5e58a', '#3de17f', '#5fb8c9'];
    let n = 0;
    for (const s of spread((c1 - c0) * AHW, 1, 3)) {
      const a = c0 + s / AHW;
      R.fill(qLeft(p, r1, a, a + 1 / AHW, bodyH - 2, bodyH - 1), sh(bulbs[n++ % 4], 1));
    }
    for (const s of spread((r1 - r0) * AHW, 1, 3)) {
      const a = r0 + s / AHW;
      R.fill(qRight(p, c1, a, a + 1 / AHW, bodyH - 2, bodyH - 1), sh(bulbs[n++ % 4], 0.8));
    }
  }

  // Foundation shadow line grounds the volume against the tile.
  const base = [p(c0, r1, 0), p(c1, r1, 0), p(c1, r0, 0)];
  R.line(base[0].x, base[0].y, base[1].x, base[1].y, sh(wall, 0.32));
  R.line(base[1].x, base[1].y, base[2].x, base[2].y, sh(wall, 0.32));
}

/* ---------------- custom builders ---------------- */
const CUSTOM = {
  silo: function (R, proj, cfg) {
    const p = proj.p;
    cylinder(R, p, 0.5, 0.5, 0.4, 0, cfg.bodyH, {
      top: sh('#d2ccc0', 1.02), lightRgb: sh('#d2ccc0', 1.0), dark: sh('#d2ccc0', 0.42),
    });
    const dome = p(0.5, 0.5, cfg.bodyH);
    R.ell(dome.x, dome.y - 2, 0.4 * AHW * Math.SQRT2, 0.4 * AHH * Math.SQRT2 + 2, sh('#8a8f94', 0.95));
    R.ell(dome.x, dome.y, 0.4 * AHW * Math.SQRT2, 0.4 * AHH * Math.SQRT2, sh('#d2ccc0', 1.05));
  },

  watertower: function (R, proj, cfg) {
    const p = proj.p;
    const legH = cfg.legH, tankH = cfg.tankH;
    const legs = [[0.22, 0.22], [0.78, 0.22], [0.22, 0.78], [0.78, 0.78]];
    legs.sort(function (a, b) { return (a[0] + a[1]) - (b[0] + b[1]); });
    for (const L of legs) {
      const cc = L[0] * 2, rc = L[1] * 2;
      box(R, p, cc - 0.07, rc - 0.07, cc + 0.07, rc + 0.07, 0, legH,
        { top: '#6a6a6a', left: sh('#6a6a6a', 0.82), right: sh('#6a6a6a', 0.6) });
    }
    for (const z of [legH * 0.35, legH * 0.7]) {
      const a = p(0.44, 0.44, z), b = p(1.56, 1.56, z);
      R.line(a.x, a.y, b.x, b.y, sh('#6a6a6a', 0.7));
      const c = p(1.56, 0.44, z), d = p(0.44, 1.56, z);
      R.line(c.x, c.y, d.x, d.y, sh('#6a6a6a', 0.7));
    }
    cylinder(R, p, 1, 1, 0.62, legH, legH + tankH, {
      top: sh('#b9c2c8', 1.04), lightRgb: sh('#b9c2c8', 1.0), dark: sh('#b9c2c8', 0.44),
    });
    R.fill(qLeft(p, 1.5, 0.5, 1.5, legH + tankH * 0.35, legH + tankH * 0.62), sh('#b8493f', 0.92));
    const top = p(1, 1, legH + tankH);
    pyramid(R, p, 0.42, 0.42, 1.58, 1.58, legH + tankH, legH + tankH + 6,
      { far: sh('#8a9196', 1.02), left: sh('#8a9196', 0.76), right: sh('#8a9196', 0.56) });
    R.set(Math.round(top.x), Math.round(top.y - 8), sh('#ff3d3d', 1));
  },

  radiotower: function (R, proj, cfg) {
    const p = proj.p;
    const H = cfg.bodyH, base = 0.34, tip = 0.46;
    const corners = [[0.5 - base, 0.5 - base], [0.5 + base, 0.5 - base], [0.5 + base, 0.5 + base], [0.5 - base, 0.5 + base]];
    const grey = sh('#8f9498', 1), dark = sh('#8f9498', 0.62);
    for (let i = 0; i < 4; i++) {
      const a = p(corners[i][0], corners[i][1], 0);
      const b = p(0.5 + (corners[i][0] - 0.5) * (tip / base) * 0.18, 0.5 + (corners[i][1] - 0.5) * (tip / base) * 0.18, H);
      R.line(a.x, a.y, b.x, b.y, i < 2 ? dark : grey);
    }
    for (let k = 1; k <= 7; k++) {
      const z = H * k / 8, t = 1 - k / 8 * 0.82;
      const ring = corners.map(function (c) {
        return p(0.5 + (c[0] - 0.5) * t, 0.5 + (c[1] - 0.5) * t, z);
      });
      for (let i = 0; i < 4; i++) R.line(ring[i].x, ring[i].y, ring[(i + 1) % 4].x, ring[(i + 1) % 4].y, k % 2 ? grey : dark);
    }
    const tipP = p(0.5, 0.5, H);
    R.set(Math.round(tipP.x), Math.round(tipP.y - 1), sh('#ff3d3d', 1));
    R.set(Math.round(tipP.x), Math.round(tipP.y - 2), sh('#ff8a8a', 1));
  },

  oak: function (R, proj, cfg) {
    const p = proj.p, c = p(0.5, 0.5, 0);
    const g = cfg.leaf || leafOf('oak', '#3f7a3f');
    const bare = isSnowy() && !cfg.evergreen;
    box(R, p, 0.44, 0.44, 0.56, 0.56, 0, 7, { top: sh('#5a3a22', 1), left: sh('#5a3a22', 0.8), right: sh('#5a3a22', 0.58) });
    const cy = c.y - 13;
    if (bare) {
      // Bare winter branches instead of a canopy.
      for (const a of [-0.9, -0.4, 0.4, 0.9, 0]) {
        R.line(c.x, c.y - 6, c.x + Math.sin(a) * 9, cy - Math.cos(a) * 5, sh('#5a4436', 1));
      }
      R.ell(c.x, cy + 1, 9, 5, dith(sh('#e8eef4', 1), null, 0.16, 23));
    } else {
      R.ell(c.x, cy + 3, 11, 8, dith(sh(g, 0.72), sh(g, 0.6), 0.35, 3));
      R.ell(c.x, cy, 11, 8, dith(sh(g, 1.0), sh(g, 0.84), 0.3, 11));
      R.ell(c.x - 3, cy - 3, 6, 4, dith(sh(g, 1.18), sh(g, 1.02), 0.3, 5));
      if (season === 'easter') {
        for (let i = 0; i < 7; i++) {
          const a = hash2(i, 3, 61) * Math.PI * 2, rr = 4 + hash2(i, 9, 67) * 6;
          R.set(Math.round(c.x + Math.cos(a) * rr), Math.round(cy + Math.sin(a) * rr * 0.6), sh('#ffc9dd', 1));
        }
      }
    }
  },

  pine: function (R, proj, cfg) {
    const p = proj.p, c = p(0.5, 0.5, 0);
    const g = cfg.leaf || leafOf('pine', '#2f6b4f');
    box(R, p, 0.45, 0.45, 0.55, 0.55, 0, 5, { top: sh('#4a3018', 1), left: sh('#4a3018', 0.8), right: sh('#4a3018', 0.58) });
    for (let i = 0; i < 4; i++) {
      const w = 11 - i * 2.4, yb = c.y - 4 - i * 5, hgt = 8;
      R.fill([{ x: c.x, y: yb - hgt }, { x: c.x + w, y: yb }, { x: c.x - w, y: yb }],
        dith(sh(g, 1 - i * 0.02), sh(g, 0.76), 0.28, 7 + i));
      if (isSnowy()) {
        R.line(c.x - w + 1, yb - 1, c.x, yb - hgt + 2, sh('#eef4f8', 1));
        R.line(c.x, yb - hgt + 2, c.x + w - 1, yb - 1, sh('#dbe6ee', 1));
      }
    }
  },

  bush: function (R, proj, cfg) {
    const p = proj.p, c = p(0.5, 0.5, 0), g = cfg.leaf || leafOf('bush', '#4a7a3a');
    R.ell(c.x, c.y - 3, 8, 5, dith(sh(g, 1), sh(g, 0.78), 0.32, 13));
    R.ell(c.x - 2, c.y - 5, 4, 3, sh(g, 1.15));
    if (isSnowy()) R.ell(c.x - 1, c.y - 6, 6, 3, sh('#eef4f8', 1));
  },

  /* ---- bridges & tunnels ---- */
  /* An embankment climbing from ground level to a bridge deck or a higher
     terrace. cfg.dir is the direction it rises towards ('col+', 'row-', ...);
     cfg.riseZ is how far, so the top lands exactly on what it meets. */
  ramp: function (R, proj, cfg) {
    const p = proj.p;
    const z = Math.max(1, cfg.riseZ || 6);
    const dir = cfg.dir || 'col+';
    const alongCol = dir.slice(0, 3) === 'col';
    const rising = dir.charAt(3) === '+';
    // Profile varies across the axis it climbs, extruded along the other one.
    const axis = alongCol ? 'row' : 'col';
    const profile = rising ? [{ s: 0, z: 0 }, { s: 1, z: z }] : [{ s: 0, z: z }, { s: 1, z: 0 }];
    const deck = cfg.deck || '#8a6a4a';

    extrude(R, p, axis, 0, 1, profile,
      function () { return sh(deck, 1.04); },
      sh(cfg.side || deck, 0.62));

    // Centre dashes so a road ramp reads as carriageway, not a plain wedge.
    if (cfg.mark) {
      const mark = sh(cfg.mark, 1);
      const steps = 5;
      for (let k = 0; k < steps; k++) {
        if (k % 2) continue;
        const t0 = k / steps, t1 = (k + 0.62) / steps;
        const z0 = rising ? z * t0 : z * (1 - t0);
        const z1 = rising ? z * t1 : z * (1 - t1);
        R.fill(alongCol
          ? [p(t0, 0.45, z0), p(t1, 0.45, z1), p(t1, 0.55, z1), p(t0, 0.55, z0)]
          : [p(0.45, t0, z0), p(0.45, t1, z1), p(0.55, t1, z1), p(0.55, t0, z0)], mark);
      }
    }
    // Kerb line along the visible flank.
    const lip = sh(cfg.side || deck, 0.95);
    const a = alongCol ? p(0, 1, profile[0].z) : p(1, 0, profile[0].z);
    const b = alongCol ? p(1, 1, profile[1].z) : p(1, 1, profile[1].z);
    R.line(a.x, a.y, b.x, b.y, lip);
  },

  bridge: function (R, proj, cfg, fw, fh, rot) {
    const p = proj.p;
    const deck = cfg.deck, rail = cfg.rail, pier = cfg.pier;
    const z = cfg.deckZ;
    // Along +col when unrotated; rot swaps which axis the span follows.
    const a0 = rot ? 0.5 - cfg.halfW : 0, a1 = rot ? 0.5 + cfg.halfW : 1;
    const b0 = rot ? 0 : 0.5 - cfg.halfW, b1 = rot ? 1 : 0.5 + cfg.halfW;
    for (const t of [0.12, 0.88]) {
      const cc = rot ? 0.5 : t, rr = rot ? t : 0.5;
      box(R, p, cc - 0.07, rr - 0.07, cc + 0.07, rr + 0.07, -6, z - 1,
        { top: sh(pier, 1), left: sh(pier, 0.8), right: sh(pier, 0.56) });
    }
    box(R, p, a0, b0, a1, b1, z - 2, z,
      { top: sh(deck, 1.02), left: sh(deck, 0.78), right: sh(deck, 0.56) });
    // Railings run down both long sides of the span.
    if (rot) {
      for (const cc of [a0, a1 - 0.06]) {
        box(R, p, cc, b0, cc + 0.06, b1, z, z + 5, { top: sh(rail, 1.05), left: sh(rail, 0.82), right: sh(rail, 0.6) });
      }
    } else {
      for (const rr of [b0, b1 - 0.06]) {
        box(R, p, a0, rr, a1, rr + 0.06, z, z + 5, { top: sh(rail, 1.05), left: sh(rail, 0.82), right: sh(rail, 0.6) });
      }
    }
    if (isSnowy()) R.fill(qTop(p, a0, b0, a1, b1, z), sh('#e2eaf0', 1));
  },

  /* Draws a portal onto the cliff face of the uphill neighbour. cfg.side is
     'col' when the rise is at -col (that neighbour's +col wall is what we see)
     or 'row' when it is at -row. cfg.depth is the rise in levels, so the facing
     lands exactly on top of the wall the terrain pass already drew. */
  tunnel: function (R, proj, cfg) {
    const p = proj.p, stone = cfg.stone;
    const onCol = cfg.side !== 'row';
    const H = Math.max(cfg.openH + 3, (cfg.depth || 0) * ALEVEL);
    // -col walls face +col (the darker face); -row walls face +row.
    const faceShade = onCol ? 0.62 : 0.84;
    const face = onCol
      ? (a, b, z0, z1) => qRight(p, 0, a, b, z0, z1)
      : (a, b, z0, z1) => qLeft(p, 0, a, b, z0, z1);

    R.fill(face(0, 1, 0, H), dith(sh(stone, faceShade), sh(stone, faceShade * 0.86), 0.22, 29));
    // Coursing so the facing reads as masonry rather than a flat panel.
    for (let z = 3; z < H; z += 4) R.fill(face(0, 1, z, z + 0.6), sh(stone, faceShade * 0.74));

    const dark = sh('#0b0810', 1);
    const openH = Math.min(cfg.openH, H - 1);
    const steps = 12;
    for (let k = 0; k < steps; k++) {
      const t = (k + 0.5) / steps;
      // Semicircular head on straight jambs.
      const w = t < 0.55 ? 0.3 : 0.3 * Math.cos((t - 0.55) / 0.45 * Math.PI / 2);
      R.fill(face(0.5 - w, 0.5 + w, openH * t, openH * (t + 1 / steps)), dark);
    }
    // Voussoir ring around the mouth.
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      const w = t < 0.55 ? 0.3 : 0.3 * Math.cos((t - 0.55) / 0.45 * Math.PI / 2);
      const ring = sh(stone, faceShade * 1.3);
      R.fill(face(0.5 - w - 0.055, 0.5 - w, openH * t, openH * (t + 1 / steps)), ring);
      R.fill(face(0.5 + w, 0.5 + w + 0.055, openH * t, openH * (t + 1 / steps)), ring);
    }
    R.fill(face(0.5 - 0.36, 0.5 + 0.36, openH, openH + 0.8), sh(stone, faceShade * 1.35));
    // Rails vanishing into the mouth sell the depth.
    if (cfg.rails) {
      const sleeper = sh('#4a3a2a', 1);
      for (let k = 0; k < 4; k++) {
        const t = k / 4;
        if (onCol) R.fill(qTop(p, 0.02 + t * 0.5, 0.34, 0.06 + t * 0.5, 0.66, 0), sleeper);
        else R.fill(qTop(p, 0.34, 0.02 + t * 0.5, 0.66, 0.06 + t * 0.5, 0), sleeper);
      }
    }
  },

  /* ---- fences, walls and hedges ---- */
  fence: function (R, proj, cfg, fw, fh, rot) {
    const p = proj.p, st = cfg.style, col = cfg.col;
    const H = cfg.h;
    const at = (t) => (rot ? { c: 0.5, r: t } : { c: t, r: 0.5 });

    if (st === 'stone') {
      const a = at(0), b = at(1);
      if (rot) box(R, p, 0.42, 0, 0.58, 1, 0, H, { top: sh(col, 1.06), left: sh(col, 0.84), right: sh(col, 0.6) });
      else box(R, p, 0, 0.42, 1, 0.58, 0, H, { top: sh(col, 1.06), left: sh(col, 0.84), right: sh(col, 0.6) });
      for (let k = 0; k < 6; k++) {
        const t = k / 6 + 0.08;
        const q = at(t);
        const pt = p(q.c, q.r + (rot ? 0 : 0.08), H * (k % 2 ? 0.5 : 0.75));
        R.set(Math.round(pt.x), Math.round(pt.y), sh(col, 0.7));
      }
      return;
    }

    if (st === 'hedge') {
      const g = leafOf('bush', '#4a7a3a');
      if (rot) box(R, p, 0.36, 0, 0.64, 1, 0, H, { top: dith(sh(g, 1.1), sh(g, 0.9), 0.4, 5), left: dith(sh(g, 0.86), sh(g, 0.7), 0.4, 7), right: dith(sh(g, 0.62), sh(g, 0.5), 0.4, 9) });
      else box(R, p, 0, 0.36, 1, 0.64, 0, H, { top: dith(sh(g, 1.1), sh(g, 0.9), 0.4, 5), left: dith(sh(g, 0.86), sh(g, 0.7), 0.4, 7), right: dith(sh(g, 0.62), sh(g, 0.5), 0.4, 9) });
      if (isSnowy()) {
        if (rot) R.fill(qTop(p, 0.36, 0, 0.64, 1, H), sh('#e8eef4', 1));
        else R.fill(qTop(p, 0, 0.36, 1, 0.64, H), sh('#e8eef4', 1));
      }
      return;
    }

    // Posts plus rails: picket, split rail and chain link differ only in infill.
    const posts = st === 'picket' ? 7 : 3;
    for (let k = 0; k <= posts; k++) {
      const t = k / posts;
      const q = at(t);
      const w = st === 'picket' ? 0.035 : 0.05;
      box(R, p, q.c - w, q.r - w, q.c + w, q.r + w, 0, st === 'picket' ? H : H * 1.05,
        { top: sh(col, 1.05), left: sh(col, 0.85), right: sh(col, 0.62) });
      if (st === 'picket') {
        const tip = p(q.c, q.r, H + 1.5);
        R.set(Math.round(tip.x), Math.round(tip.y), sh(col, 1.1));
      }
    }
    const rails = st === 'chain' ? [H * 0.95, H * 0.1] : st === 'split' ? [H * 0.8, H * 0.42] : [H * 0.72, H * 0.32];
    for (const z of rails) {
      if (rot) box(R, p, 0.47, 0, 0.53, 1, z - 1, z, { top: sh(col, 1), left: sh(col, 0.82), right: sh(col, 0.6) });
      else box(R, p, 0, 0.47, 1, 0.53, z - 1, z, { top: sh(col, 1), left: sh(col, 0.82), right: sh(col, 0.6) });
    }
    if (st === 'chain') {
      const mesh = sh(col, 0.78);
      for (let k = 0; k < 14; k++) {
        const t = k / 14 + 0.02;
        const q = at(t);
        const lo = p(q.c, q.r, H * 0.15), hi = p(q.c, q.r, H * 0.9);
        R.line(lo.x, lo.y, hi.x, hi.y, mesh);
      }
    }
    if (cfg.gate) {
      const q = at(0.5);
      if (rot) box(R, p, 0.4, 0.36, 0.6, 0.64, 0, H * 1.15, { top: sh(col, 1.1), left: sh(col, 0.9), right: sh(col, 0.66) });
      else box(R, p, 0.36, 0.4, 0.64, 0.6, 0, H * 1.15, { top: sh(col, 1.1), left: sh(col, 0.9), right: sh(col, 0.66) });
    }
  },

  /* ---- playground ---- */
  slide: function (R, proj, cfg, fw, fh, rot) {
    const p = proj.p, m = '#8a8f94', y = '#e8a33d';
    const H = 11;
    for (const t of [0.18, 0.3]) {
      const q = rot ? { c: 0.5, r: t } : { c: t, r: 0.5 };
      box(R, p, q.c - 0.04, q.r - 0.04, q.c + 0.04, q.r + 0.04, 0, H, { top: sh(m, 1), left: sh(m, 0.8), right: sh(m, 0.58) });
    }
    const a = rot ? p(0.5, 0.28, H) : p(0.28, 0.5, H);
    const b = rot ? p(0.5, 0.86, 1) : p(0.86, 0.5, 1);
    for (let k = -1; k <= 1; k++) {
      R.line(a.x + k, a.y, b.x + k, b.y, k === 0 ? sh(y, 1.05) : sh(y, 0.8));
    }
    R.fill(rot ? qTop(p, 0.42, 0.14, 0.58, 0.32, H) : qTop(p, 0.14, 0.42, 0.32, 0.58, H), sh(m, 1.05));
  },

  seesaw: function (R, proj, cfg, fw, fh, rot) {
    const p = proj.p;
    box(R, p, 0.44, 0.44, 0.56, 0.56, 0, 4, { top: '#8a8f94', left: sh('#8a8f94', 0.8), right: sh('#8a8f94', 0.56) });
    const a = rot ? p(0.5, 0.1, 7) : p(0.1, 0.5, 7);
    const b = rot ? p(0.5, 0.9, 2) : p(0.9, 0.5, 2);
    R.line(a.x, a.y, b.x, b.y, sh('#b8493f', 1.05));
    R.line(a.x, a.y + 1, b.x, b.y + 1, sh('#b8493f', 0.8));
  },

  sandbox: function (R, proj) {
    const p = proj.p;
    box(R, p, 0.12, 0.12, 0.88, 0.88, 0, 2, { top: sh('#d8c48a', 1.02), left: sh('#8a5a2a', 0.82), right: sh('#8a5a2a', 0.6) });
    R.fill(qTop(p, 0.18, 0.18, 0.82, 0.82, 2), dith(sh('#d8c48a', 1.05), sh('#c2aa72', 1), 0.3, 19));
  },

  roundabout: function (R, proj) {
    const p = proj.p, c = p(0.5, 0.5, 0);
    box(R, p, 0.47, 0.47, 0.53, 0.53, 0, 5, { top: '#8a8f94', left: sh('#8a8f94', 0.8), right: sh('#8a8f94', 0.56) });
    R.ell(c.x, c.y - 6, 11, 6, dith(sh('#3f6fa8', 1), sh('#3f6fa8', 0.8), 0.3, 11));
    R.ell(c.x, c.y - 7, 11, 6, sh('#4f7fb8', 1.05));
    for (let k = 0; k < 4; k++) {
      const a = k * Math.PI / 4;
      R.line(c.x, c.y - 7, c.x + Math.cos(a) * 10, c.y - 7 + Math.sin(a) * 5, sh('#2c5f8a', 1));
    }
  },

  climbframe: function (R, proj) {
    const p = proj.p, m = '#c0392b';
    const H = 12;
    const corners = [[0.18, 0.18], [0.82, 0.18], [0.18, 0.82], [0.82, 0.82]];
    corners.sort((a, b) => (a[0] + a[1]) - (b[0] + b[1]));
    for (const q of corners) {
      box(R, p, q[0] - 0.04, q[1] - 0.04, q[0] + 0.04, q[1] + 0.04, 0, H,
        { top: sh(m, 1), left: sh(m, 0.8), right: sh(m, 0.58) });
    }
    for (const z of [H, H * 0.55]) {
      for (const e of [[[0.18, 0.18], [0.82, 0.18]], [[0.18, 0.82], [0.82, 0.82]], [[0.18, 0.18], [0.18, 0.82]], [[0.82, 0.18], [0.82, 0.82]]]) {
        const a = p(e[0][0], e[0][1], z), b = p(e[1][0], e[1][1], z);
        R.line(a.x, a.y, b.x, b.y, sh(m, 0.9));
      }
    }
  },

  hoop: function (R, proj) {
    const p = proj.p;
    const pole = p(0.5, 0.72, 0), top = p(0.5, 0.72, 16);
    R.line(pole.x, pole.y, top.x, top.y, sh('#5a5a5a', 1));
    R.line(pole.x + 1, pole.y, top.x + 1, top.y, sh('#4a4a4a', 1));
    R.fill(qLeft(p, 0.5, 0.36, 0.64, 12, 16), sh('#e8e2d4', 1));
    R.fill(qLeft(p, 0.46, 0.42, 0.58, 11.5, 12), sh('#e8631f', 1));
  },

  /* ---- signs, utility and street furniture ---- */
  post: function (R, proj, cfg, fw, fh, rot) {
    const p = proj.p;
    const H = cfg.h, pole = cfg.pole || '#6a6a6a';
    const base = p(0.5, 0.5, 0), top = p(0.5, 0.5, H);
    R.line(base.x, base.y, top.x, top.y, sh(pole, 1));
    R.line(base.x + 1, base.y, top.x + 1, top.y, sh(pole, 0.75));
    if (cfg.sign === 'stop') {
      R.ell(top.x + 1, top.y + 2, 4, 4, sh('#c0392b', 1));
      R.ell(top.x + 1, top.y + 2, 3, 3, sh('#d84c40', 1.05));
    } else if (cfg.sign === 'plate') {
      R.fill([{ x: top.x - 4, y: top.y }, { x: top.x + 6, y: top.y + 3 }, { x: top.x + 6, y: top.y + 7 }, { x: top.x - 4, y: top.y + 4 }], sh(cfg.plate || '#3f6fa8', 1));
    } else if (cfg.sign === 'traffic') {
      box(R, p, 0.42, 0.42, 0.58, 0.58, H - 8, H, { top: '#2a2a2a', left: '#333', right: '#222' });
      const lx = Math.round(top.x - 2);
      R.set(lx, Math.round(top.y + 2), sh('#d84040', 1));
      R.set(lx, Math.round(top.y + 4), sh('#e8a33d', 1));
      R.set(lx, Math.round(top.y + 6), sh('#3de17f', 1));
    } else if (cfg.sign === 'billboard') {
      R.fill([{ x: top.x - 11, y: top.y - 1 }, { x: top.x + 12, y: top.y + 10 }, { x: top.x + 12, y: top.y + 22 }, { x: top.x - 11, y: top.y + 11 }], sh('#e8e2d4', 1));
      R.fill([{ x: top.x - 9, y: top.y + 1 }, { x: top.x + 10, y: top.y + 10 }, { x: top.x + 10, y: top.y + 18 }, { x: top.x - 9, y: top.y + 9 }], sh(cfg.plate || '#c0392b', 1));
    }
  },

  powerpole: function (R, proj, cfg) {
    const p = proj.p, w = '#6a4a2a', H = 30;
    const base = p(0.5, 0.5, 0), top = p(0.5, 0.5, H);
    R.line(base.x, base.y, top.x, top.y, sh(w, 1));
    R.line(base.x + 1, base.y, top.x + 1, top.y, sh(w, 0.72));
    for (const z of [H - 3, H - 9]) {
      const a = p(0.1, 0.9, z), b = p(0.9, 0.1, z);
      R.line(a.x, a.y, b.x, b.y, sh(w, 0.92));
      R.set(Math.round(a.x), Math.round(a.y - 1), sh('#3a3a3a', 1));
      R.set(Math.round(b.x), Math.round(b.y - 1), sh('#3a3a3a', 1));
    }
  },

  hydrant: function (R, proj) {
    const p = proj.p;
    box(R, p, 0.45, 0.45, 0.55, 0.55, 0, 5, { top: sh('#c0392b', 1.1), left: sh('#c0392b', 0.85), right: sh('#c0392b', 0.62) });
    box(R, p, 0.42, 0.47, 0.58, 0.53, 2.5, 3.5, { top: sh('#c0392b', 1), left: sh('#c0392b', 0.8), right: sh('#c0392b', 0.6) });
    const t = p(0.5, 0.5, 5);
    R.ell(t.x, t.y, 3, 2, sh('#e8e2d4', 1));
  },

  bin: function (R, proj, cfg) {
    const p = proj.p, col = cfg.col || '#4a5a4a';
    box(R, p, 0.4, 0.4, 0.6, 0.6, 0, cfg.h || 6, { top: sh(col, 1.1), left: sh(col, 0.85), right: sh(col, 0.62) });
    R.fill(qTop(p, 0.38, 0.38, 0.62, 0.62, cfg.h || 6), sh(col, 0.72));
  },

  dumpster: function (R, proj, cfg, fw, fh, rot) {
    const p = proj.p, col = '#3f6f4f';
    const a = rot ? [0.28, 0.1, 0.72, 0.9] : [0.1, 0.28, 0.9, 0.72];
    box(R, p, a[0], a[1], a[2], a[3], 0, 7, { top: sh(col, 1.08), left: sh(col, 0.84), right: sh(col, 0.6) });
    R.fill(qTop(p, a[0] + 0.04, a[1] + 0.04, a[2] - 0.04, a[3] - 0.04, 7), sh(col, 0.68));
  },

  bikerack: function (R, proj, cfg, fw, fh, rot) {
    const p = proj.p, m = '#8a8f94';
    for (let k = 0; k < 4; k++) {
      const t = 0.2 + k * 0.2;
      const q = rot ? { c: 0.5, r: t } : { c: t, r: 0.5 };
      const a = p(q.c - (rot ? 0.12 : 0), q.r - (rot ? 0 : 0.12), 0);
      const b = p(q.c - (rot ? 0.12 : 0), q.r - (rot ? 0 : 0.12), 5);
      const d = p(q.c + (rot ? 0.12 : 0), q.r + (rot ? 0 : 0.12), 5);
      const e = p(q.c + (rot ? 0.12 : 0), q.r + (rot ? 0 : 0.12), 0);
      R.line(a.x, a.y, b.x, b.y, sh(m, 1));
      R.line(b.x, b.y, d.x, d.y, sh(m, 1));
      R.line(d.x, d.y, e.x, e.y, sh(m, 0.8));
    }
  },

  phonebooth: function (R, proj) {
    const p = proj.p;
    box(R, p, 0.3, 0.3, 0.7, 0.7, 0, 14, { top: sh('#b8493f', 1.05), left: sh('#b8493f', 0.82), right: sh('#b8493f', 0.6) });
    R.fill(qLeft(p, 0.7, 0.36, 0.64, 4, 12), sh('#bfe6f2', 0.9));
    R.fill(qRight(p, 0.7, 0.36, 0.64, 4, 12), sh('#bfe6f2', 0.62));
    R.fill(qTop(p, 0.28, 0.28, 0.72, 0.72, 14), sh('#8a3a30', 1));
  },

  busstop: function (R, proj, cfg, fw, fh, rot) {
    const p = proj.p, m = '#5a6a72';
    const a = rot ? [0.3, 0.05, 0.7, 0.95] : [0.05, 0.3, 0.95, 0.7];
    for (const q of [[a[0], a[1]], [a[0], a[3]], [a[2], a[1]], [a[2], a[3]]]) {
      box(R, p, q[0] - 0.03, q[1] - 0.03, q[0] + 0.03, q[1] + 0.03, 0, 12,
        { top: sh(m, 1), left: sh(m, 0.8), right: sh(m, 0.58) });
    }
    box(R, p, a[0] - 0.06, a[1] - 0.06, a[2] + 0.06, a[3] + 0.06, 12, 13.5,
      { top: sh('#bfe6f2', 0.9), left: sh(m, 0.8), right: sh(m, 0.58) });
    if (rot) R.fill(qRight(p, a[2], a[1], a[3], 1, 11), sh('#bfe6f2', 0.5));
    else R.fill(qRight(p, a[2], a[1], a[3], 1, 11), sh('#bfe6f2', 0.5));
  },

  well: function (R, proj) {
    const p = proj.p;
    cylinder(R, p, 0.5, 0.5, 0.3, 0, 6, { top: sh('#0d0a12', 1), lightRgb: sh('#8a8f94', 1), dark: sh('#8a8f94', 0.45) });
    for (const t of [0.24, 0.76]) {
      box(R, p, t - 0.04, 0.46, t + 0.04, 0.54, 6, 15, { top: '#6a4a2a', left: sh('#6a4a2a', 0.8), right: sh('#6a4a2a', 0.58) });
    }
    pyramid(R, p, 0.16, 0.16, 0.84, 0.84, 15, 20,
      { far: sh('#8a5a3a', 1.02), left: sh('#8a5a3a', 0.78), right: sh('#8a5a3a', 0.56) });
  },

  fountain: function (R, proj) {
    const p = proj.p, c = p(0.5, 0.5, 0), stone = '#c9c2b8';
    cylinder(R, p, 0.5, 0.5, 0.44, 0, 4, { top: sh('#3f7fb8', 1), lightRgb: sh(stone, 1), dark: sh(stone, 0.5) });
    cylinder(R, p, 0.5, 0.5, 0.12, 4, 10, { top: sh(stone, 1.05), lightRgb: sh(stone, 1), dark: sh(stone, 0.5) });
    R.ell(c.x, c.y - 12, 5, 3, sh('#bfe6f2', 1));
    for (let k = 0; k < 6; k++) {
      const a = k * Math.PI / 3;
      R.line(c.x, c.y - 11, c.x + Math.cos(a) * 7, c.y - 7 + Math.sin(a) * 3, sh('#8fd0e8', 1));
    }
  },

  statue: function (R, proj) {
    const p = proj.p, stone = '#b9b2a6';
    box(R, p, 0.3, 0.3, 0.7, 0.7, 0, 6, { top: sh(stone, 1.05), left: sh(stone, 0.82), right: sh(stone, 0.6) });
    box(R, p, 0.42, 0.42, 0.58, 0.58, 6, 16, { top: sh(stone, 1.1), left: sh(stone, 0.88), right: sh(stone, 0.64) });
    const h = p(0.5, 0.5, 19);
    R.ell(h.x, h.y, 3, 3, sh(stone, 1.15));
  },

  pool: function (R, proj) {
    const p = proj.p;
    box(R, p, 0.06, 0.06, 0.94, 0.94, 0, 2, { top: sh('#d8d2c4', 1.02), left: sh('#c0bab0', 0.84), right: sh('#c0bab0', 0.6) });
    R.fill(qTop(p, 0.16, 0.16, 0.84, 0.84, 2), dith(sh('#3f9fd0', 1), sh('#358fc0', 1), 0.25, 31));
    R.fill(qTop(p, 0.16, 0.16, 0.84, 0.3, 2), sh('#5fc0e0', 1));
  },

  campfire: function (R, proj) {
    const p = proj.p, c = p(0.5, 0.5, 0);
    for (let k = 0; k < 5; k++) {
      const a = k * Math.PI / 2.5;
      R.line(c.x + Math.cos(a) * 6, c.y - 1 + Math.sin(a) * 3, c.x, c.y - 5, sh('#5a3a22', k % 2 ? 1 : 0.8));
    }
    R.ell(c.x, c.y - 6, 4, 3, sh('#e8631f', 1));
    R.ell(c.x, c.y - 8, 2, 2, sh('#f5e58a', 1));
    for (let k = 0; k < 5; k++) {
      const a = k * Math.PI / 2.5 + 0.4;
      R.set(Math.round(c.x + Math.cos(a) * 9), Math.round(c.y + Math.sin(a) * 4), sh('#8a8f94', 1));
    }
  },

  tent: function (R, proj, cfg, fw, fh, rot) {
    const p = proj.p, col = cfg.col || '#c06a2a';
    const along = rot ? 'row' : 'col';
    const prof = [{ s: 0.1, z: 0 }, { s: 0.5, z: 12 }, { s: 0.9, z: 0 }];
    extrude(R, p, along, 0.12, 0.88, prof,
      (A, B) => (B.z < A.z ? sh(col, 0.72) : sh(col, 1.02)), sh(col, 0.6));
    const a = rot ? p(0.12, 0.5, 12) : p(0.5, 0.12, 12);
    const b = rot ? p(0.88, 0.5, 12) : p(0.5, 0.88, 12);
    R.line(a.x, a.y, b.x, b.y, sh(col, 1.15));
  },

  woodpile: function (R, proj, cfg, fw, fh, rot) {
    const p = proj.p;
    for (let row = 0; row < 3; row++) {
      for (let k = 0; k < 4; k++) {
        const t = 0.18 + k * 0.21;
        const q = rot ? { c: 0.5, r: t } : { c: t, r: 0.5 };
        const z = row * 3;
        const shade = 0.7 + (k % 2) * 0.2 + row * 0.05;
        box(R, p, q.c - (rot ? 0.2 : 0.09), q.r - (rot ? 0.09 : 0.2), q.c + (rot ? 0.2 : 0.09), q.r + (rot ? 0.09 : 0.2), z, z + 3,
          { top: sh('#c9a878', shade + 0.2), left: sh('#8a5a2a', shade), right: sh('#6a4520', shade) });
      }
    }
  },

  satellite: function (R, proj) {
    const p = proj.p, c = p(0.5, 0.5, 0);
    box(R, p, 0.45, 0.45, 0.55, 0.55, 0, 6, { top: '#7a7a7a', left: '#6a6a6a', right: '#555' });
    R.ell(c.x + 1, c.y - 11, 8, 6, sh('#d8d2c4', 1));
    R.ell(c.x + 1, c.y - 11, 6, 4, sh('#b0aaa0', 1));
    R.set(Math.round(c.x + 1), Math.round(c.y - 11), sh('#3a3a3a', 1));
  },

  /* ---- vehicles ---- */
  truck: function (R, proj, cfg, fw, fh, rot) {
    const p = proj.p, body = cfg.body || '#3f6fa8', box2 = cfg.cargo || '#d8d2c4';
    // Kept close to the car's proportions; a vehicle must read as much smaller
    // than a house wall (bodyH 14) or it looks like a shed on the road.
    const cabTop = cfg.tall ? 10 : 8.5;
    const bedTop = cfg.tall ? 10 : 6.5;
    const A = rot ? [0.26, 0.06, 0.74, 0.94] : [0.06, 0.26, 0.94, 0.74];
    box(R, p, A[0], A[1], A[2], A[3], 1.5, 4.5,
      { top: sh(body, 0.9), left: sh(body, 0.72), right: sh(body, 0.52) });
    const cabA = rot ? [A[0], A[1], A[2], A[1] + 0.3] : [A[0], A[1], A[0] + 0.3, A[3]];
    box(R, p, cabA[0], cabA[1], cabA[2], cabA[3], 4.5, cabTop,
      { top: sh(body, 1.06), left: sh(body, 0.84), right: sh(body, 0.6) });
    const bedA = rot ? [A[0] + 0.03, A[1] + 0.32, A[2] - 0.03, A[3]] : [A[0] + 0.32, A[1] + 0.03, A[2], A[3] - 0.03];
    box(R, p, bedA[0], bedA[1], bedA[2], bedA[3], 4.5, bedTop,
      { top: sh(box2, 1.06), left: sh(box2, 0.84), right: sh(box2, 0.6) });
    // windscreen
    if (rot) R.fill(qRight(p, cabA[2], cabA[1] + 0.06, cabA[3] - 0.02, cabTop - 3, cabTop - 0.6), sh('#bfe6f2', 0.66));
    else R.fill(qLeft(p, cabA[3], cabA[0] + 0.06, cabA[2] - 0.02, cabTop - 3, cabTop - 0.6), sh('#bfe6f2', 0.86));
    // wheels sit under the chassis
    for (const t of [0.24, 0.78]) {
      const w = rot ? p(0.5, t, 0) : p(t, 0.5, 0);
      R.ell(w.x, w.y - 1.5, 3, 2, sh('#1a1a1a', 1));
    }
    if (cfg.lightbar) {
      const t = rot ? p(0.5, cabA[1] + 0.15, cabTop) : p(cabA[0] + 0.15, 0.5, cabTop);
      R.set(Math.round(t.x - 1), Math.round(t.y), sh('#d84040', 1));
      R.set(Math.round(t.x + 1), Math.round(t.y), sh('#3f6fa8', 1));
    }
  },

  tractor: function (R, proj, cfg, fw, fh, rot) {
    const p = proj.p, body = '#3f7a3f';
    const A = rot ? [0.36, 0.2, 0.64, 0.8] : [0.2, 0.36, 0.8, 0.64];
    box(R, p, A[0], A[1], A[2], A[3], 3, 9, { top: sh(body, 1.05), left: sh(body, 0.82), right: sh(body, 0.6) });
    box(R, p, A[0] + 0.06, A[1] + 0.06, A[2] - 0.06, A[3] - 0.06, 9, 14,
      { top: sh('#2a2a2a', 1), left: sh('#3a3a3a', 1), right: sh('#2a2a2a', 1) });
    const rear = rot ? p(0.5, 0.78, 0) : p(0.78, 0.5, 0);
    const front = rot ? p(0.5, 0.24, 0) : p(0.24, 0.5, 0);
    R.ell(rear.x, rear.y - 5, 6, 5, sh('#1a1a1a', 1));
    R.ell(front.x, front.y - 3, 3, 3, sh('#1a1a1a', 1));
  },

  /* ---- seasonal ---- */
  jackolantern: function (R, proj) {
    const p = proj.p, c = p(0.5, 0.5, 0);
    R.ell(c.x, c.y - 4, 7, 5, dith(sh('#e8731f', 1), sh('#d0621a', 1), 0.28, 7));
    R.ell(c.x, c.y - 5, 7, 5, sh('#e8731f', 1.04));
    R.line(c.x, c.y - 10, c.x + 1, c.y - 12, sh('#3f7a3f', 1));
    R.fill([{ x: c.x - 4, y: c.y - 6 }, { x: c.x - 2, y: c.y - 6 }, { x: c.x - 3, y: c.y - 4 }], sh('#f5e58a', 1));
    R.fill([{ x: c.x + 2, y: c.y - 6 }, { x: c.x + 4, y: c.y - 6 }, { x: c.x + 3, y: c.y - 4 }], sh('#f5e58a', 1));
    R.line(c.x - 3, c.y - 2, c.x + 3, c.y - 2, sh('#f5e58a', 1));
  },

  scarecrow: function (R, proj) {
    const p = proj.p, c = p(0.5, 0.5, 0);
    const base = p(0.5, 0.5, 0), top = p(0.5, 0.5, 16);
    R.line(base.x, base.y, top.x, top.y, sh('#8a5a2a', 1));
    const arm = p(0.5, 0.5, 12);
    R.line(arm.x - 8, arm.y - 2, arm.x + 8, arm.y + 2, sh('#8a5a2a', 0.9));
    R.fill([{ x: top.x - 4, y: top.y + 1 }, { x: top.x + 4, y: top.y + 1 }, { x: top.x + 3, y: top.y + 6 }, { x: top.x - 3, y: top.y + 6 }], sh('#c9a878', 1));
    R.ell(top.x, top.y + 1, 6, 2, sh('#8a6a3a', 1));
    R.set(Math.round(top.x - 2), Math.round(top.y + 3), sh('#2a2a2a', 1));
    R.set(Math.round(top.x + 2), Math.round(top.y + 3), sh('#2a2a2a', 1));
    R.fill(qLeft(p, 0.56, 0.36, 0.64, 6, 12), sh('#b8493f', 1));
  },

  haybale: function (R, proj, cfg, fw, fh, rot) {
    const p = proj.p, hay = '#c9a84a';
    cylinder(R, p, 0.5, 0.5, 0.34, 0, 9, { top: sh(hay, 1.06), lightRgb: sh(hay, 1), dark: sh(hay, 0.5) });
    const c = p(0.5, 0.5, 9);
    R.ell(c.x, c.y, 0.34 * AHW * Math.SQRT2, 0.34 * AHH * Math.SQRT2, dith(sh(hay, 1.1), sh(hay, 0.9), 0.35, 13));
  },

  deadtree: function (R, proj) {
    const p = proj.p, c = p(0.5, 0.5, 0), w = '#4a3f38';
    box(R, p, 0.44, 0.44, 0.56, 0.56, 0, 10, { top: sh(w, 1), left: sh(w, 0.8), right: sh(w, 0.58) });
    for (const a of [-1.0, -0.45, 0.45, 1.0]) {
      R.line(c.x, c.y - 9, c.x + Math.sin(a) * 10, c.y - 18 - Math.cos(a) * 3, sh(w, 1.05));
      R.line(c.x + Math.sin(a) * 7, c.y - 15, c.x + Math.sin(a) * 13, c.y - 21, sh(w, 0.85));
    }
  },

  xmastree: function (R, proj) {
    const p = proj.p, c = p(0.5, 0.5, 0), g = '#2a5744';
    box(R, p, 0.46, 0.46, 0.54, 0.54, 0, 4, { top: sh('#4a3018', 1), left: sh('#4a3018', 0.8), right: sh('#4a3018', 0.58) });
    const bulbs = ['#ff3d5f', '#f5e58a', '#3de17f', '#5fb8c9'];
    for (let i = 0; i < 4; i++) {
      const w = 11 - i * 2.4, yb = c.y - 3 - i * 5, hgt = 8;
      R.fill([{ x: c.x, y: yb - hgt }, { x: c.x + w, y: yb }, { x: c.x - w, y: yb }],
        dith(sh(g, 1 - i * 0.02), sh(g, 0.76), 0.28, 7 + i));
      for (let k = 0; k < 3; k++) {
        const t = (k + 1) / 4;
        R.set(Math.round(c.x - w + t * w * 2), Math.round(yb - 1), sh(bulbs[(i + k) % 4], 1));
      }
    }
    R.set(Math.round(c.x), Math.round(c.y - 27), sh('#f5e58a', 1));
    R.set(Math.round(c.x), Math.round(c.y - 26), sh('#e8d24a', 1));
  },

  snowman: function (R, proj) {
    const p = proj.p, c = p(0.5, 0.5, 0), s = '#eef4f8';
    R.ell(c.x, c.y - 4, 7, 5, dith(sh(s, 1), sh(s, 0.88), 0.2, 5));
    R.ell(c.x, c.y - 10, 5, 4, dith(sh(s, 1.02), sh(s, 0.9), 0.2, 9));
    R.ell(c.x, c.y - 15, 4, 3, sh(s, 1.04));
    R.set(Math.round(c.x - 1), Math.round(c.y - 16), sh('#2a2a2a', 1));
    R.set(Math.round(c.x + 2), Math.round(c.y - 16), sh('#2a2a2a', 1));
    R.set(Math.round(c.x + 1), Math.round(c.y - 14), sh('#e8731f', 1));
    R.ell(c.x, c.y - 18, 5, 2, sh('#2a2a2a', 1));
    R.line(c.x - 6, c.y - 10, c.x - 10, c.y - 13, sh('#5a3a22', 1));
    R.line(c.x + 6, c.y - 10, c.x + 10, c.y - 13, sh('#5a3a22', 1));
  },

  presents: function (R, proj) {
    const p = proj.p;
    const gifts = [[0.3, 0.3, 5, '#b8493f', '#f5e58a'], [0.62, 0.4, 4, '#3f6fa8', '#e8e2d4'], [0.42, 0.66, 6, '#3f7a3f', '#ff3d7f']];
    gifts.sort((a, b) => (a[0] + a[1]) - (b[0] + b[1]));
    for (const g of gifts) {
      box(R, p, g[0] - 0.14, g[1] - 0.14, g[0] + 0.14, g[1] + 0.14, 0, g[2],
        { top: sh(g[3], 1.08), left: sh(g[3], 0.84), right: sh(g[3], 0.6) });
      R.fill(qLeft(p, g[1] + 0.14, g[0] - 0.03, g[0] + 0.03, 0, g[2]), sh(g[4], 1));
      R.fill(qTop(p, g[0] - 0.14, g[1] - 0.03, g[0] + 0.14, g[1] + 0.03, g[2]), sh(g[4], 1));
    }
  },

  candycane: function (R, proj) {
    const p = proj.p, base = p(0.5, 0.5, 0);
    for (let z = 0; z < 14; z++) {
      const q = p(0.5, 0.5, z);
      R.set(Math.round(q.x), Math.round(q.y), sh(Math.floor(z / 2) % 2 ? '#e8e2d4' : '#c0392b', 1));
      R.set(Math.round(q.x + 1), Math.round(q.y), sh(Math.floor(z / 2) % 2 ? '#c8c2b4' : '#a02f24', 1));
    }
    const t = p(0.5, 0.5, 14);
    R.line(t.x, t.y, t.x + 4, t.y - 1, sh('#c0392b', 1));
  },

  eastereggs: function (R, proj) {
    const p = proj.p;
    const eggs = [[0.32, 0.34, '#ff8ac9'], [0.62, 0.36, '#8ad0ff'], [0.44, 0.62, '#f5e58a'], [0.7, 0.66, '#9ae8a0']];
    eggs.sort((a, b) => (a[0] + a[1]) - (b[0] + b[1]));
    for (const e of eggs) {
      const c = p(e[0], e[1], 0);
      R.ell(c.x, c.y - 3, 3, 4, sh(e[2], 1.05));
      R.ell(c.x - 1, c.y - 4, 1, 2, sh(e[2], 1.25));
      R.line(c.x - 2, c.y - 3, c.x + 2, c.y - 3, sh(e[2], 0.7));
    }
  },

  bunny: function (R, proj) {
    const p = proj.p, c = p(0.5, 0.5, 0), f = '#e8e2d4';
    R.ell(c.x, c.y - 4, 5, 4, sh(f, 1));
    R.ell(c.x + 3, c.y - 8, 3, 3, sh(f, 1.04));
    R.line(c.x + 2, c.y - 11, c.x + 2, c.y - 15, sh(f, 1.02));
    R.line(c.x + 4, c.y - 11, c.x + 5, c.y - 15, sh(f, 1.02));
    R.ell(c.x - 5, c.y - 4, 2, 2, sh(f, 1.1));
    R.set(Math.round(c.x + 4), Math.round(c.y - 8), sh('#2a2a2a', 1));
  },

  flowerbed: function (R, proj, cfg) {
    const p = proj.p;
    box(R, p, 0.12, 0.12, 0.88, 0.88, 0, 2, { top: sh('#5a3a22', 1.05), left: sh('#5a3a22', 0.82), right: sh('#5a3a22', 0.6) });
    R.fill(qTop(p, 0.16, 0.16, 0.84, 0.84, 2), dith(sh('#4a7a3a', 1), sh('#3f6a32', 1), 0.4, 11));
    const cols = ['#ff8ac9', '#f5e58a', '#ff5f5f', '#c98aff'];
    for (let i = 0; i < 10; i++) {
      const cc = 0.2 + hash2(i, 1, 71) * 0.6, rr = 0.2 + hash2(i, 2, 73) * 0.6;
      const q = p(cc, rr, 2);
      R.set(Math.round(q.x), Math.round(q.y - 1), sh(cols[i % 4], 1));
    }
  },

  boulder: function (R, proj) {
    const p = proj.p, c = p(0.5, 0.5, 0);
    R.ell(c.x, c.y - 3, 9, 6, dith(sh('#8a8f94', 0.9), sh('#8a8f94', 0.72), 0.3, 17));
    R.fill([{ x: c.x - 8, y: c.y - 4 }, { x: c.x - 1, y: c.y - 9 }, { x: c.x + 3, y: c.y - 5 }], sh('#8a8f94', 1.12));
  },

  bench: function (R, proj, cfg, fw, fh, rot) {
    const p = proj.p, w = '#8a5a2a';
    const a = rot ? 0.2 : 0.05, b = rot ? 0.8 : 0.95;
    if (rot) {
      box(R, p, a, 0.38, b, 0.62, 2, 3.5, { top: sh(w, 1), left: sh(w, 0.8), right: sh(w, 0.58) });
      box(R, p, a, 0.55, b, 0.62, 3.5, 8, { top: sh(w, 1.05), left: sh(w, 0.85), right: sh(w, 0.6) });
    } else {
      box(R, p, 0.38, a, 0.62, b, 2, 3.5, { top: sh(w, 1), left: sh(w, 0.8), right: sh(w, 0.58) });
      box(R, p, 0.55, a, 0.62, b, 3.5, 8, { top: sh(w, 1.05), left: sh(w, 0.85), right: sh(w, 0.6) });
    }
  },

  streetlight: function (R, proj, cfg) {
    const p = proj.p, H = cfg.bodyH;
    const base = p(0.5, 0.5, 0), top = p(0.5, 0.5, H);
    R.line(base.x, base.y, top.x, top.y, sh('#3a3a3a', 1));
    R.line(base.x + 1, base.y, top.x + 1, top.y, sh('#2a2a2a', 1));
    R.line(top.x, top.y, top.x + 5, top.y - 2, sh('#3a3a3a', 1));
    R.ell(top.x + 6, top.y - 1, 3, 2, sh(WIN_LIT, 1));
    R.ell(top.x + 6, top.y + 1, 4, 3, mixc(hexToRgb(WIN_LIT), [40, 30, 10], 0.55));
  },

  mailbox: function (R, proj) {
    const p = proj.p;
    box(R, p, 0.47, 0.47, 0.53, 0.53, 0, 5, { top: '#5a3a22', left: sh('#5a3a22', 0.8), right: sh('#5a3a22', 0.58) });
    box(R, p, 0.36, 0.42, 0.64, 0.58, 5, 8, { top: '#9aa0a3', left: sh('#9aa0a3', 0.82), right: sh('#9aa0a3', 0.6) });
  },

  car: function (R, proj, cfg, fw, fh, rot) {
    const p = proj.p, body = cfg.body || '#b8493f';
    const lo = 0.12, hi = 0.88, nlo = 0.3, nhi = 0.7;
    const A = rot ? [nlo, lo, nhi, hi] : [lo, nlo, hi, nhi];
    box(R, p, A[0], A[1], A[2], A[3], 1, 5,
      { top: sh(body, 1.05), left: sh(body, 0.82), right: sh(body, 0.6) });
    const B = rot ? [nlo + 0.06, lo + 0.22, nhi - 0.06, hi - 0.22] : [lo + 0.22, nlo + 0.06, hi - 0.22, nhi - 0.06];
    box(R, p, B[0], B[1], B[2], B[3], 5, 8,
      { top: sh(body, 0.9), left: sh('#bfe6f2', 0.86), right: sh('#bfe6f2', 0.6) });
    R.fill(qLeft(p, A[3], A[0], A[2], 1, 1.8), sh('#1a1a1a', 1));
  },

  bike: function (R, proj, cfg, fw, fh, rot) {
    const p = proj.p, c = p(0.5, 0.5, 0);
    const dx = rot ? 3 : 5, dy = rot ? 3 : 1;
    R.ell(c.x - dx, c.y - 3 - dy, 3.2, 2.4, sh('#2a2a2a', 1));
    R.ell(c.x + dx, c.y - 3 + dy, 3.2, 2.4, sh('#2a2a2a', 1));
    R.line(c.x - dx, c.y - 4 - dy, c.x + dx, c.y - 4 + dy, sh(cfg.body || '#2de1c2', 1));
    R.line(c.x, c.y - 9, c.x + dx * 0.4, c.y - 4, sh(cfg.body || '#2de1c2', 0.85));
  },

  picnic: function (R, proj, cfg, fw, fh, rot) {
    const p = proj.p, w = '#9a7a4a';
    const A = rot ? [0.1, 0.3, 0.9, 0.7] : [0.3, 0.1, 0.7, 0.9];
    box(R, p, A[0], A[1], A[2], A[3], 4, 5.5, { top: sh(w, 1), left: sh(w, 0.8), right: sh(w, 0.58) });
    const B = rot ? [0.15, 0.12, 0.85, 0.24] : [0.12, 0.15, 0.24, 0.85];
    box(R, p, B[0], B[1], B[2], B[3], 2, 3, { top: sh(w, 0.92), left: sh(w, 0.74), right: sh(w, 0.54) });
  },

  grave: function (R, proj) {
    const p = proj.p;
    box(R, p, 0.34, 0.46, 0.66, 0.54, 0, 7, { top: '#c9c2b8', left: sh('#c9c2b8', 0.82), right: sh('#c9c2b8', 0.6) });
    const t = p(0.5, 0.54, 7);
    R.ell(t.x, t.y, 5, 2.5, sh('#c9c2b8', 0.95));
  },

  swing: function (R, proj, cfg) {
    const p = proj.p, H = 12, m = '#8a8f94';
    for (const cc of [0.15, 0.85]) {
      const a = p(cc, 0.2, 0), b = p(cc, 0.5, H), c = p(cc, 0.8, 0);
      R.line(a.x, a.y, b.x, b.y, sh(m, 0.8));
      R.line(c.x, c.y, b.x, b.y, sh(m, 1));
    }
    const l = p(0.15, 0.5, H), r = p(0.85, 0.5, H);
    R.line(l.x, l.y, r.x, r.y, sh(m, 1));
    for (const t of [0.35, 0.65]) {
      const top = p(t, 0.5, H), st = p(t, 0.5, 4);
      R.line(top.x, top.y, st.x, st.y, sh('#3a3a3a', 1));
      R.fill(qLeft(p, 0.56, t - 0.08, t + 0.08, 4, 4.8), sh('#b8493f', 1));
    }
  },
};

/* ---------------- the roster ---------------- */
const B = {
  house: { label: 'House', fw: 2, fh: 2, zmax: 26, cfg: { bodyH: 14, roofType: 'gable', roofH: 10, roofColor: '#5a4436', wall: '#b8493f' },
    variants: { red: { label: 'House (Red)', wall: '#b8493f' }, blue: { label: 'House (Blue)', wall: '#4f6fa8' }, yellow: { label: 'House (Yellow)', wall: '#d1a53d' }, green: { label: 'House (Green)', wall: '#5a8a5a' }, white: { label: 'House (White)', wall: '#e0dbcf' } } },
  house2: { label: 'Two-Storey House', fw: 2, fh: 2, zmax: 34, cfg: { bodyH: 22, roofType: 'gable', roofH: 10, roofColor: '#4a3f3a', wall: '#c9b48c' } },
  ranch: { label: 'Ranch House', fw: 3, fh: 2, zmax: 22, cfg: { bodyH: 12, roofType: 'hip', roofH: 8, roofColor: '#5a4436', wall: '#cbb9a0' } },
  cabin: { label: 'Log Cabin', fw: 2, fh: 2, zmax: 24, cfg: { bodyH: 13, roofType: 'gable', roofH: 9, roofColor: '#3f3630', wall: '#7a5636' } },
  trailer: { label: 'Trailer', fw: 2, fh: 1, zmax: 14, cfg: { bodyH: 9, roofType: 'shed', roofH: 3, roofColor: '#b0aaa0', wall: '#dcd6c8', windows: 1 } },
  diner: { label: "Diner", fw: 2, fh: 2, zmax: 22, cfg: { bodyH: 14, roofType: 'flat', roofColor: '#8a8578', wall: '#e8e2d4', sign: '#c0392b', awning: '#c0392b', windowColor: '#bfe6f2', hvac: true } },
  store: { label: 'Store', fw: 2, fh: 2, zmax: 24, cfg: { bodyH: 16, roofType: 'flat', roofColor: '#7a7568', wall: '#c8b89a', sign: '#2c5f8a', awning: '#2c5f8a', hvac: true },
    variants: { hardware: { label: 'Hardware Store', wall: '#c8b89a', sign: '#2c5f8a', awning: '#2c5f8a' }, grocery: { label: 'Grocery', wall: '#d8d2c0', sign: '#3f7a3f', awning: '#3f7a3f' }, video: { label: 'Video Rental', wall: '#e0d8c8', sign: '#d84040', awning: '#3a3a5a' }, arcade: { label: 'Arcade', wall: '#3a2f4a', sign: '#ff2e88', awning: '#8e2de2', neon: true, windowColor: '#2de1c2' } } },
  motel: { label: 'Motel', fw: 3, fh: 1, zmax: 18, cfg: { bodyH: 10, roofType: 'shed', roofH: 4, roofColor: '#9a9488', wall: '#d6c9a8', sign: '#e8a33d' } },
  gasstation: { label: 'Gas Station', fw: 2, fh: 2, zmax: 20, cfg: { bodyH: 10, roofType: 'flat', roofColor: '#8a8578', wall: '#e2ddd0', sign: '#d84040', canopy: true, windowColor: '#bfe6f2' } },
  school: { label: 'School', fw: 4, fh: 3, zmax: 40, cfg: { bodyH: 20, roofType: 'flat', roofColor: '#7a7568', wall: '#c9a876', pole: true, poleH: 16, hvac: true } },
  church: { label: 'Church', fw: 3, fh: 2, zmax: 50, cfg: { bodyH: 16, roofType: 'gable', roofH: 10, roofColor: '#6a5340', wall: '#e8ded0', steeple: true, steepleH: 22, windowColor: '#8e6ad2' } },
  townhall: { label: 'Town Hall', fw: 3, fh: 3, zmax: 34, cfg: { bodyH: 22, roofType: 'hip', roofH: 10, roofColor: '#5a5a62', wall: '#ded6c4', columns: true } },
  library: { label: 'Library', fw: 3, fh: 2, zmax: 20, cfg: { bodyH: 16, roofType: 'flat', roofColor: '#7a7568', wall: '#cdbfa4', columns: true } },
  sheriff: { label: "Sheriff's Office", fw: 2, fh: 2, zmax: 18, cfg: { bodyH: 12, roofType: 'flat', roofColor: '#7a7568', wall: '#b9c2c8', sign: '#2c5f8a' } },
  factory: { label: 'Factory / Mill', fw: 4, fh: 3, zmax: 38, cfg: { bodyH: 20, roofType: 'flat', roofColor: '#6a655c', wall: '#7a6a5a', stacks: 2, stackH: 14, windowColor: '#d8cfa8' } },
  warehouse: { label: 'Warehouse', fw: 3, fh: 2, zmax: 22, cfg: { bodyH: 14, roofType: 'shed', roofH: 6, roofColor: '#8a8578', wall: '#9a9488', windows: 0 } },
  barn: { label: 'Barn', fw: 3, fh: 2, zmax: 28, cfg: { bodyH: 12, roofType: 'gambrel', roofH: 14, roofColor: '#4a4a4a', wall: '#b8493f', windowColor: '#e8ded0' } },
  lab: { label: 'Government Lab', fw: 3, fh: 3, zmax: 20, cfg: { bodyH: 14, roofType: 'flat', roofColor: '#6a6a6a', wall: '#a8aaa6', windows: 0, door: false, hvac: true } },
  silo: { label: 'Grain Silo', fw: 1, fh: 1, zmax: 38, cfg: { bodyH: 34 }, build: CUSTOM.silo },
  watertower: { label: 'Water Tower', fw: 2, fh: 2, zmax: 48, cfg: { legH: 22, tankH: 16 }, build: CUSTOM.watertower },
  radiotower: { label: 'Radio Tower', fw: 1, fh: 1, zmax: 54, cfg: { bodyH: 52 }, build: CUSTOM.radiotower },

  /* ---- more buildings ---- */
  apartment: { label: 'Apartments', fw: 2, fh: 2, zmax: 42, cfg: { bodyH: 34, roofType: 'flat', roofColor: '#6a655c', wall: '#b08a6a', hvac: true } },
  duplex: { label: 'Duplex', fw: 3, fh: 2, zmax: 28, cfg: { bodyH: 15, roofType: 'gable', roofH: 10, roofColor: '#5a4436', wall: '#c9b48c' } },
  farmhouse: { label: 'Farmhouse', fw: 2, fh: 2, zmax: 32, cfg: { bodyH: 18, roofType: 'gable', roofH: 11, roofColor: '#4a4038', wall: '#e8e2d4', awning: '#8a6a4a' } },
  bank: { label: 'Bank', fw: 2, fh: 2, zmax: 26, cfg: { bodyH: 18, roofType: 'flat', roofColor: '#7a7568', wall: '#ded6c4', columns: true } },
  postoffice: { label: 'Post Office', fw: 2, fh: 2, zmax: 22, cfg: { bodyH: 14, roofType: 'flat', roofColor: '#7a7568', wall: '#c8c2b4', sign: '#2c5f8a' } },
  bowling: { label: 'Bowling Alley', fw: 3, fh: 2, zmax: 24, cfg: { bodyH: 13, roofType: 'flat', roofColor: '#7a7568', wall: '#d8c8a8', sign: '#ff2e88', neon: true } },
  cinema: { label: 'Movie Theatre', fw: 3, fh: 2, zmax: 30, cfg: { bodyH: 20, roofType: 'flat', roofColor: '#6a655c', wall: '#c0392b', sign: '#f5e58a', awning: '#8e2de2', neon: true } },
  tavern: { label: 'Tavern', fw: 2, fh: 2, zmax: 26, cfg: { bodyH: 14, roofType: 'gable', roofH: 9, roofColor: '#4a3f3a', wall: '#7a5636', sign: '#e8a33d' } },
  firestation: { label: 'Fire Station', fw: 2, fh: 2, zmax: 26, cfg: { bodyH: 16, roofType: 'flat', roofColor: '#6a655c', wall: '#b8493f', sign: '#e8e2d4' } },
  clinic: { label: 'Clinic', fw: 3, fh: 2, zmax: 24, cfg: { bodyH: 16, roofType: 'flat', roofColor: '#7a7568', wall: '#e8ece8', sign: '#c0392b' } },
  garage: { label: 'Garage / Shed', fw: 1, fh: 1, zmax: 18, cfg: { bodyH: 9, roofType: 'shed', roofH: 4, roofColor: '#8a8578', wall: '#b0a894', windows: 0 } },
  greenhouse: { label: 'Greenhouse', fw: 2, fh: 1, zmax: 20, cfg: { bodyH: 8, roofType: 'gable', roofH: 7, roofColor: '#bfe6f2', wall: '#cfe8ee', windows: 0, door: false } },
  boathouse: { label: 'Boathouse', fw: 2, fh: 1, zmax: 20, cfg: { bodyH: 9, roofType: 'gable', roofH: 6, roofColor: '#5a4436', wall: '#8a6a4a', windows: 1 } },
  icecream: { label: 'Ice Cream Stand', fw: 1, fh: 1, zmax: 18, cfg: { bodyH: 9, roofType: 'flat', roofColor: '#ff8ac9', wall: '#e8e2d4', sign: '#ff5f8f', awning: '#ff8ac9', windows: 1 } },
  lighthouse: { label: 'Lighthouse', fw: 1, fh: 1, zmax: 46, cfg: { bodyH: 36 }, build: CUSTOM.silo },

  /* ---- bridges & tunnels ---- */
  bridge: {
    label: 'Bridge', fw: 1, fh: 1, build: CUSTOM.bridge,
    zmax: function (cfg) { return Math.max(20, (cfg.deckZ || 6) + 12); },
    cfg: { deckZ: 6, halfW: 0.34, deck: '#8a6a4a', rail: '#a88a68', pier: '#8a8f94' },
    variants: {
      wood: { label: 'Bridge (Wood)', deck: '#8a6a4a', rail: '#a88a68', pier: '#6a4a2a' },
      stone: { label: 'Bridge (Stone)', deck: '#b0aaa0', rail: '#c9c2b8', pier: '#8a8f94' },
      road: { label: 'Bridge (Road)', deck: '#43434a', rail: '#8a8f94', pier: '#8a8f94' },
    },
  },
  ramp: {
    label: 'Ramp', fw: 1, fh: 1, build: CUSTOM.ramp,
    zmax: function (cfg) { return Math.max(6, (cfg.riseZ || 6)) + 4; },
    cfg: { riseZ: 6, dir: 'col+', deck: '#43434a', side: '#7d6449', mark: '#e0c34a' },
    variants: {
      road: { label: 'Ramp (Road)', deck: '#43434a', side: '#7d6449', mark: '#e0c34a' },
      wood: { label: 'Ramp (Wood)', deck: '#8a6a4a', side: '#6a4a2a', mark: null },
      stone: { label: 'Ramp (Stone)', deck: '#b0aaa0', side: '#8a8f94', mark: null },
    },
  },
  tunnel: {
    label: 'Tunnel Portal', fw: 1, fh: 1, build: CUSTOM.tunnel,
    zmax: function (cfg) { return Math.max(cfg.openH + 5, (cfg.depth || 0) * ALEVEL + 2); },
    cfg: { openH: 13, stone: '#8a8f94', depth: 2, side: 'col' },
    variants: {
      stone: { label: 'Tunnel (Stone)', stone: '#8a8f94' },
      brick: { label: 'Tunnel (Brick)', stone: '#9a5f4a' },
      rail: { label: 'Rail Tunnel', stone: '#7a7f84', rails: true },
    },
  },

  /* ---- fences, walls, hedges ---- */
  fence: {
    label: 'Fence', fw: 1, fh: 1, zmax: 16, build: CUSTOM.fence,
    cfg: { style: 'picket', col: '#e8e2d4', h: 4.5 },
    variants: {
      picket: { label: 'Picket Fence', style: 'picket', col: '#e8e2d4', h: 4.5 },
      split: { label: 'Split-Rail Fence', style: 'split', col: '#8a6a4a', h: 5 },
      chain: { label: 'Chain-Link Fence', style: 'chain', col: '#9aa0a6', h: 7 },
      stone: { label: 'Stone Wall', style: 'stone', col: '#b0aaa0', h: 5 },
      hedge: { label: 'Hedge', style: 'hedge', col: '#4a7a3a', h: 6.5 },
      gate: { label: 'Gate', style: 'picket', col: '#e8e2d4', h: 5.5, gate: true },
    },
  },

  /* ---- playground ---- */
  slide: { label: 'Slide', fw: 1, fh: 1, zmax: 18, cfg: {}, build: CUSTOM.slide },
  seesaw: { label: 'See-Saw', fw: 1, fh: 1, zmax: 14, cfg: {}, build: CUSTOM.seesaw },
  sandbox: { label: 'Sandbox', fw: 1, fh: 1, zmax: 10, cfg: {}, build: CUSTOM.sandbox },
  roundabout: { label: 'Roundabout', fw: 1, fh: 1, zmax: 16, cfg: {}, build: CUSTOM.roundabout },
  climbframe: { label: 'Climbing Frame', fw: 1, fh: 1, zmax: 20, cfg: {}, build: CUSTOM.climbframe },
  hoop: { label: 'Basketball Hoop', fw: 1, fh: 1, zmax: 22, cfg: {}, build: CUSTOM.hoop },

  /* ---- signs, utility, street furniture ---- */
  stopsign: { label: 'Stop Sign', fw: 1, fh: 1, zmax: 18, cfg: { h: 11, sign: 'stop' }, build: CUSTOM.post },
  trafficlight: { label: 'Traffic Light', fw: 1, fh: 1, zmax: 26, cfg: { h: 20, sign: 'traffic' }, build: CUSTOM.post },
  streetsign: { label: 'Street Sign', fw: 1, fh: 1, zmax: 18, cfg: { h: 11, sign: 'plate', plate: '#3f6fa8' }, build: CUSTOM.post },
  billboard: { label: 'Billboard', fw: 1, fh: 1, zmax: 40, cfg: { h: 14, sign: 'billboard', plate: '#c0392b' }, build: CUSTOM.post },
  powerpole: { label: 'Power Pole', fw: 1, fh: 1, zmax: 36, cfg: {}, build: CUSTOM.powerpole },
  hydrant: { label: 'Fire Hydrant', fw: 1, fh: 1, zmax: 10, cfg: {}, build: CUSTOM.hydrant },
  trashcan: { label: 'Trash Can', fw: 1, fh: 1, zmax: 12, cfg: { h: 6, col: '#4a5a4a' }, build: CUSTOM.bin },
  dumpster: { label: 'Dumpster', fw: 1, fh: 1, zmax: 12, cfg: {}, build: CUSTOM.dumpster },
  bikerack: { label: 'Bike Rack', fw: 1, fh: 1, zmax: 12, cfg: {}, build: CUSTOM.bikerack },
  phonebooth: { label: 'Phone Booth', fw: 1, fh: 1, zmax: 20, cfg: {}, build: CUSTOM.phonebooth },
  busstop: { label: 'Bus Shelter', fw: 1, fh: 1, zmax: 20, cfg: {}, build: CUSTOM.busstop },
  well: { label: 'Wishing Well', fw: 1, fh: 1, zmax: 26, cfg: {}, build: CUSTOM.well },
  fountain: { label: 'Fountain', fw: 1, fh: 1, zmax: 22, cfg: {}, build: CUSTOM.fountain },
  statue: { label: 'Statue', fw: 1, fh: 1, zmax: 26, cfg: {}, build: CUSTOM.statue },
  pool: { label: 'Swimming Pool', fw: 1, fh: 1, zmax: 10, cfg: {}, build: CUSTOM.pool },
  campfire: { label: 'Campfire', fw: 1, fh: 1, zmax: 14, cfg: {}, build: CUSTOM.campfire },
  tent: { label: 'Tent', fw: 1, fh: 1, zmax: 18, cfg: { col: '#c06a2a' }, build: CUSTOM.tent },
  woodpile: { label: 'Wood Pile', fw: 1, fh: 1, zmax: 16, cfg: {}, build: CUSTOM.woodpile },
  satellite: { label: 'Satellite Dish', fw: 1, fh: 1, zmax: 20, cfg: {}, build: CUSTOM.satellite },

  /* ---- vehicles ---- */
  pickup: { label: 'Pickup Truck', fw: 1, fh: 1, zmax: 14, cfg: { body: '#3f6fa8', cargo: '#3f6fa8' }, build: CUSTOM.truck },
  van: { label: 'Van', fw: 1, fh: 1, zmax: 16, cfg: { body: '#8a8578', cargo: '#c8c2b4', tall: true }, build: CUSTOM.truck },
  schoolbus: { label: 'School Bus', fw: 1, fh: 1, zmax: 16, cfg: { body: '#e8b33d', cargo: '#e8b33d', tall: true }, build: CUSTOM.truck },
  policecar: { label: 'Police Car', fw: 1, fh: 1, zmax: 14, cfg: { body: '#2a3a5a', cargo: '#e8e2d4', lightbar: true }, build: CUSTOM.truck },
  firetruck: { label: 'Fire Truck', fw: 1, fh: 1, zmax: 16, cfg: { body: '#c0392b', cargo: '#b8493f', tall: true, lightbar: true }, build: CUSTOM.truck },
  ambulance: { label: 'Ambulance', fw: 1, fh: 1, zmax: 16, cfg: { body: '#e8ece8', cargo: '#e8ece8', tall: true, lightbar: true }, build: CUSTOM.truck },
  icecreamvan: { label: 'Ice Cream Van', fw: 1, fh: 1, zmax: 16, cfg: { body: '#ff8ac9', cargo: '#e8e2d4', tall: true }, build: CUSTOM.truck },
  tractor: { label: 'Tractor', fw: 1, fh: 1, zmax: 18, cfg: {}, build: CUSTOM.tractor },

  /* ---- seasonal ---- */
  jackolantern: { label: 'Jack-o’-Lantern', fw: 1, fh: 1, zmax: 16, cfg: {}, build: CUSTOM.jackolantern },
  scarecrow: { label: 'Scarecrow', fw: 1, fh: 1, zmax: 26, cfg: {}, build: CUSTOM.scarecrow },
  haybale: { label: 'Hay Bale', fw: 1, fh: 1, zmax: 16, cfg: {}, build: CUSTOM.haybale },
  deadtree: { label: 'Dead Tree', fw: 1, fh: 1, zmax: 32, cfg: {}, build: CUSTOM.deadtree },
  xmastree: { label: 'Christmas Tree', fw: 1, fh: 1, zmax: 34, cfg: {}, build: CUSTOM.xmastree },
  snowman: { label: 'Snowman', fw: 1, fh: 1, zmax: 24, cfg: {}, build: CUSTOM.snowman },
  presents: { label: 'Presents', fw: 1, fh: 1, zmax: 12, cfg: {}, build: CUSTOM.presents },
  candycane: { label: 'Candy Cane', fw: 1, fh: 1, zmax: 20, cfg: {}, build: CUSTOM.candycane },
  eastereggs: { label: 'Easter Eggs', fw: 1, fh: 1, zmax: 12, cfg: {}, build: CUSTOM.eastereggs },
  bunny: { label: 'Easter Bunny', fw: 1, fh: 1, zmax: 22, cfg: {}, build: CUSTOM.bunny },
  flowerbed: { label: 'Flower Bed', fw: 1, fh: 1, zmax: 10, cfg: {}, build: CUSTOM.flowerbed },

  oak: { label: 'Oak Tree', fw: 1, fh: 1, zmax: 26, cfg: {}, build: CUSTOM.oak,
    variants: { green: { label: 'Oak Tree' }, autumn: { label: 'Autumn Tree', leaf: '#c07a2a' } } },
  pine: { label: 'Pine Tree', fw: 1, fh: 1, zmax: 30, cfg: {}, build: CUSTOM.pine },
  bush: { label: 'Bush', fw: 1, fh: 1, zmax: 12, cfg: {}, build: CUSTOM.bush },
  boulder: { label: 'Boulder', fw: 1, fh: 1, zmax: 12, cfg: {}, build: CUSTOM.boulder },
  bench: { label: 'Park Bench', fw: 1, fh: 1, zmax: 12, cfg: {}, build: CUSTOM.bench },
  streetlight: { label: 'Streetlight', fw: 1, fh: 1, zmax: 24, cfg: { bodyH: 18 }, build: CUSTOM.streetlight },
  mailbox: { label: 'Mailbox', fw: 1, fh: 1, zmax: 12, cfg: {}, build: CUSTOM.mailbox },
  car: { label: 'Car', fw: 1, fh: 1, zmax: 12, cfg: { body: '#b8493f' }, build: CUSTOM.car,
    variants: { red: { label: 'Car (Red)', body: '#b8493f' }, blue: { label: 'Car (Blue)', body: '#3f6fa8' }, tan: { label: 'Station Wagon', body: '#9a8a6a' } } },
  bike: { label: 'Bike', fw: 1, fh: 1, zmax: 12, cfg: { body: '#2de1c2' }, build: CUSTOM.bike },
  picnic: { label: 'Picnic Table', fw: 1, fh: 1, zmax: 12, cfg: {}, build: CUSTOM.picnic },
  grave: { label: 'Gravestone', fw: 1, fh: 1, zmax: 12, cfg: {}, build: CUSTOM.grave },
  swing: { label: 'Swing Set', fw: 1, fh: 1, zmax: 18, cfg: {}, build: CUSTOM.swing },
};

function label(id, variant) {
  const d = B[id];
  if (!d) return id;
  if (variant && d.variants && d.variants[variant] && d.variants[variant].label) return d.variants[variant].label;
  return d.label;
}

const objCache = new Map();
function setSeason(s) {
  if (s === season) return;
  season = s;
  objCache.clear();
}

/* `opts` lets a caller specialise a sprite from map context (a tunnel needs the
   height of the cliff it cuts into); it is folded into cfg and the cache key. */
function objectSprite(id, variant, rot, opts) {
  const extra = opts ? JSON.stringify(opts) : '';
  const key = id + '|' + (variant || '') + '|' + (rot ? 1 : 0) + '|' + season + '|' + extra;
  if (objCache.has(key)) return objCache.get(key);
  const def = B[id];
  let fw = def.fw, fh = def.fh;
  if (rot) { const t = fw; fw = fh; fh = t; }
  const cfg = Object.assign({}, def.cfg, (def.variants && def.variants[variant]) || {}, opts || {});
  const zmax = typeof def.zmax === 'function' ? def.zmax(cfg) : def.zmax;
  const proj = makeProj(fw, fh, zmax);
  const R = new Raster(proj.W, proj.H);
  (def.build || genericBuild)(R, proj, cfg, fw, fh, rot ? 1 : 0, hashStr(id + (variant || '')) & 1023);
  const sprite = { canvas: R.toCanvas(), ax: proj.ax, ay: proj.ay, w: proj.W, h: proj.H, fw: fw, fh: fh };
  objCache.set(key, sprite);
  return sprite;
}

function footprint(id, rot) {
  const d = B[id];
  return rot ? { fw: d.fh, fh: d.fw } : { fw: d.fw, fh: d.fh };
}

global.Iso = {
  AHW: AHW, AHH: AHH, AW: AW, AH: AH, ALEVEL: ALEVEL, MAX_LEVEL: MAX_LEVEL,
  Raster: Raster, makeProj: makeProj, sh: sh, dith: dith, hash2: hash2, mixc: mixc, hexToRgb: hexToRgb,
  OBJECT_DEFS: B, objectSprite: objectSprite, objectLabel: label, footprint: footprint,
  setSeason: setSeason, get season() { return season; },
  qTop: qTop, box: box,
};

})(window);
