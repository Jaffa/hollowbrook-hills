'use strict';
/* Terrain tile tops (with road/water autotiling) and cliff-wall sprites. */
(function (global) {

const I = global.Iso;
const AHW = I.AHW, AHH = I.AHH, AW = I.AW, AH = I.AH, ALEVEL = I.ALEVEL;
const sh = I.sh, dith = I.dith, hash2 = I.hash2, mixc = I.mixc, hexToRgb = I.hexToRgb;

const DIA = [{ x: AHW, y: 0 }, { x: AW, y: AHH }, { x: AHW, y: AH }, { x: 0, y: AHH }];
const CENTRE = { x: AHW, y: AHH };

/* Mask bit order: 0=+col, 1=+row, 2=-col, 3=-row. */
const DIRS = [
  { dc: 1, dr: 0, a: 1, b: 2 },
  { dc: 0, dr: 1, a: 2, b: 3 },
  { dc: -1, dr: 0, a: 3, b: 0 },
  { dc: 0, dr: -1, a: 0, b: 1 },
];
function lerp(p, q, t) { return { x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t }; }

/* An axis crossing the tile is an exact 2:1 diagonal, so markings can be walked
   as clean 2-px runs instead of a wobbling Bresenham line. */
const isColDir = (i) => i === 0 || i === 2;
function axisY(i, x) { return isColDir(i) ? 4 + (x - 8) / 2 : 4 + (24 - x) / 2; }
function halfRange(i) { return (i === 0 || i === 3) ? [16, 24] : [8, 16]; }
// Phase measured from the axis entry point so dashes stay in step tile-to-tile.
function phaseOf(i, x) { return isColDir(i) ? x - 8 : 24 - x; }

const TERRAIN = {
  grass: {
    label: 'Grass', variants: 4, base: '#3f7a3f', speck: '#356b35', p: 0.14,
    lip: '#4f8a42', rock: '#7d6449', rockDark: '#67513e',
    seasons: {
      autumn: { base: '#7c8a3c', speck: '#6a7530', lip: '#8a9a45' },
      winter: { base: '#e4ebf2', speck: '#d2dbe6', lip: '#f2f7fc', rock: '#8c7a63', rockDark: '#6f6250' },
      christmas: { base: '#e8eef4', speck: '#d6dfe8', lip: '#f4f8fc', rock: '#8c7a63', rockDark: '#6f6250' },
      halloween: { base: '#5c6a34', speck: '#4a5628', lip: '#6a7a3e' },
      easter: { base: '#4f9146', speck: '#438038', lip: '#63a352' },
    },
  },
  cornfield: {
    label: 'Cornfield', variants: 2, base: '#7a8a35', speck: '#5f7028', p: 0.2,
    lip: '#8a9a45', rock: '#7d6449', rockDark: '#67513e', rows: true,
    seasons: {
      autumn: { base: '#a8913c', speck: '#8c7530' },
      winter: { base: '#cfd6dc', speck: '#b4bcc4', rows: false },
      christmas: { base: '#cfd6dc', speck: '#b4bcc4' },
    },
  },
  dirt: { label: 'Dirt', variants: 3, base: '#8a6a45', speck: '#75563a', p: 0.16, lip: '#9a7a52', rock: '#8a6a45', rockDark: '#70543a' },
  gravel: { label: 'Gravel Lot', variants: 3, base: '#8f8a80', speck: '#78736a', p: 0.24, lip: '#a09a90', rock: '#8f8a80', rockDark: '#76716a' },
  sand: { label: 'Sand / Beach', variants: 3, base: '#d8c48a', speck: '#c2aa72', p: 0.18, lip: '#e2d09a', rock: '#c6aa70', rockDark: '#a98d5a' },
  snow: { label: 'Snow', variants: 3, base: '#e8eef4', speck: '#d4dde6', p: 0.12, lip: '#f6fafe', rock: '#b0bcc8', rockDark: '#93a1af', sparkle: true },
  rock: { label: 'Bare Rock', variants: 3, base: '#8a8f94', speck: '#767b80', p: 0.26, lip: '#9aa0a6', rock: '#7a7f84', rockDark: '#63686d' },
  ice: {
    label: 'Ice', variants: 1, base: '#a6d2e2', speck: '#bfe4ef', p: 0.1,
    lip: '#d4eef6', rock: '#6f9fb2', rockDark: '#537f92', mask: true, family: 'ice', cracks: true,
  },
  water: {
    label: 'River / Lake', variants: 1, base: '#2c5f8a', speck: '#37709c', p: 0.12,
    lip: '#3f7fa8', rock: '#1e4468', rockDark: '#163350', mask: true, family: 'water',
    seasons: { winter: { base: '#3a6d94', speck: '#4a80a6' } },
  },
  road: {
    label: 'Road', variants: 1, base: '#43434a', speck: '#4b4b52', p: 0.09,
    lip: '#7e7e7a', rock: '#70706c', rockDark: '#5b5b57', mask: true, family: 'road',
    kerb: '#6e6e68', mark: '#e0c34a',
  },
  freeway: {
    label: 'Freeway', variants: 1, base: '#3d3d44', speck: '#45454c', p: 0.09,
    lip: '#7e7e7a', rock: '#70706c', rockDark: '#5b5b57', mask: true, family: 'road',
    kerb: '#74746e', mark: '#e8e2d0', divided: true,
  },
};

let season = 'summer';
const topCache = new Map();
const wallCache = new Map();

/* Elevation drives ground brightness: isometric gives no other depth cue on
   same-coloured ground. Compressed towards the extremes so a 12-level peak
   stays green rather than washing out to white. */
const TINT_PER_LEVEL = 0.05;
const TINT_LIMIT = 0.34;
function tintFor(height) {
  const h = Math.max(-I.MAX_LEVEL, Math.min(I.MAX_LEVEL, height | 0));
  const raw = h * TINT_PER_LEVEL;
  const capped = TINT_LIMIT * Math.tanh(raw / TINT_LIMIT);
  return 1 + capped;
}

/* A 2:1 drop projects to the same screen offset as one step of ground, so a
   slope falling two levels per tile is pixel-identical to flat ground. The
   defence is the elevation tint above plus the seam shading the renderer draws
   on hidden drops; here we only re-seed the speckle per level so two heights
   never share an identical grain. Deliberately unstructured — a periodic hatch
   reads as corduroy at this scale. */
function grainSeed(variant, height) {
  return variant * 97 + 13 + (((height % 5) + 5) % 5) * 613;
}

function resolve(terrain) {
  const t = TERRAIN[terrain];
  const o = t.seasons && t.seasons[season];
  return o ? Object.assign({}, t, o) : t;
}

function setSeason(s) {
  if (s === season) return;
  season = s;
  topCache.clear();
  wallCache.clear();
}

function familyOf(terrain) {
  const t = TERRAIN[terrain];
  return t.family || terrain;
}

/* ---------------- road markings ---------------- */

// Walks one half-axis inward from an edge midpoint to the tile centre.
function halfAxisMarks(R, i, on, aa, opts) {
  const [x0, x1] = halfRange(i);
  const gap = opts.gap || 0;
  const period = opts.period || 4, onLen = opts.onLen || 2;
  for (let x = x0; x <= x1; x++) {
    if (gap && Math.abs(x - AHW) < gap) continue;
    if (opts.stopShort && Math.abs(x - AHW) < opts.stopShort) continue;
    if ((phaseOf(i, x) % period) >= onLen) continue;
    const y = axisY(i, x);
    const yi = Math.floor(y);
    R.set(x, yi, on);
    // Half-step rows get a dimmer tone: hand anti-aliasing for the 2:1 stair.
    if (aa && y !== yi) R.set(x, yi + 1, aa);
  }
}

/* Offsets a point sideways across the carriageway. The perpendicular ground
   direction is the other tile axis, so whole steps keep it on the pixel grid. */
function sideStep(i, n) {
  return isColDir(i) ? { dx: -2 * n, dy: n } : { dx: 2 * n, dy: n };
}

function inDiamond(x, y) {
  return Math.abs(x - AHW) / AHW + Math.abs(y - AHH) / AHH <= 1;
}

function laneLine(R, i, n, color, period, onLen, aa) {
  const [x0, x1] = halfRange(i);
  const o = sideStep(i, n);
  for (let x = x0; x <= x1; x++) {
    if (period && (phaseOf(i, x) % period) >= onLen) continue;
    const y = axisY(i, x), yi = Math.floor(y);
    const px = x + o.dx, py = yi + o.dy;
    if (inDiamond(px, py)) R.set(px, py, color);
    if (aa && y !== yi && inDiamond(px, py + 1)) R.set(px, py + 1, aa);
  }
}

function drawRoad(R, t, mask) {
  const kerb = hexToRgb(t.kerb);
  const kerbDark = sh(t.kerb, 0.72);
  const asphalt = hexToRgb(t.base);
  const mark = hexToRgb(t.mark);
  const markAA = mixc(mark, asphalt, 0.55);

  const conns = [];
  for (let i = 0; i < 4; i++) if (mask & (1 << i)) conns.push(i);

  // Thin two-tone shoulder only where the road actually ends.
  for (let i = 0; i < 4; i++) {
    if (mask & (1 << i)) continue;
    const d = DIRS[i], v1 = DIA[d.a], v2 = DIA[d.b];
    R.fill([v1, v2, lerp(v2, CENTRE, 0.14), lerp(v1, CENTRE, 0.14)], kerb);
    R.line(v1.x, v1.y, v2.x, v2.y, kerbDark);
  }

  if (!conns.length) {
    R.fill([{ x: AHW, y: 4 }, { x: 24, y: AHH }, { x: AHW, y: 12 }, { x: 8, y: AHH }], sh(t.base, 1.12));
    return;
  }

  if (t.divided) {
    const median = hexToRgb('#8f8f86');
    const medianAA = mixc(median, asphalt, 0.45);
    const nCol = (mask & 1 ? 1 : 0) + (mask & 4 ? 1 : 0);
    const nRow = (mask & 2 ? 1 : 0) + (mask & 8 ? 1 : 0);
    const alongCol = nCol >= 2 || (nCol === 1 && nRow === 0);
    const axisDirs = alongCol ? [0, 2] : nRow >= 1 ? [1, 3] : conns;

    // A freeway is meant to be laid two tiles wide: each tile is then one
    // carriageway, and the side facing its partner carries the reservation.
    const partnerPos = alongCol ? (mask & 2) : (mask & 1);
    const partnerNeg = alongCol ? (mask & 8) : (mask & 4);
    const wide = !!(partnerPos || partnerNeg);

    for (const i of axisDirs) {
      if (!wide) {
        laneLine(R, i, 0, median, 0, 0, medianAA);
        laneLine(R, i, -2, mark, 6, 3, markAA);
        laneLine(R, i, 2, mark, 6, 3, markAA);
        continue;
      }
      // sideStep n grows towards +row (col axis) / +col (row axis).
      const innerSign = partnerPos && !partnerNeg ? 1 : partnerNeg && !partnerPos ? -1 : 0;
      laneLine(R, i, 0, mark, 6, 3, markAA);            // lane divider
      if (innerSign === 0) continue;                     // middle of a 3+ wide road
      laneLine(R, i, innerSign * 4, median, 0, 0, medianAA);
      laneLine(R, i, -innerSign * 3, mark, 0, 0, markAA); // solid outer edge line
    }
    return;
  }

  // No centre line through a junction; the gap alone reads as an intersection.
  const junction = conns.length >= 3;
  for (const i of conns) {
    halfAxisMarks(R, i, mark, markAA, junction ? { gap: 5 } : {});
  }
}

/* ---------------- tile tops ---------------- */
function buildTop(key, terrain, variant, mask, height) {
  const t = resolve(terrain);
  const R = new I.Raster(AW, AH);
  const seed = grainSeed(variant, height);

  // Two grades of 1px grain: fine enough to read as ground, not as a pattern.
  const base = sh(t.base, 1), speck = sh(t.speck, 1);
  const fleck = t.mask ? null : mixc(base, speck, 1.8);
  R.fill(DIA, function (x, y) {
    const n = hash2(x, y, seed);
    if (n < t.p) return speck;
    if (fleck && n > 1 - t.p * 0.45) return fleck;
    return base;
  });

  if (t.rows) {
    for (let k = -1; k <= 3; k++) {
      const off = k * 4;
      R.line(off, AHH - off / 2 + 2, off + AW, AHH - off / 2 + 2 + AHH * 2, sh(t.speck, 0.85));
    }
    for (let i = 0; i < 10; i++) {
      const x = 3 + Math.floor(hash2(i, variant, 5) * (AW - 6));
      const y = Math.floor(hash2(i, variant, 9) * (AH - 4)) + 2;
      if (Math.abs(x - AHW) / AHW + Math.abs(y - AHH) / AHH <= 0.85) R.set(x, y, sh('#c9c24a', 1));
    }
  }

  if (t.sparkle) {
    for (let i = 0; i < 5; i++) {
      const x = 4 + Math.floor(hash2(i, variant, 31) * (AW - 8));
      const y = 2 + Math.floor(hash2(i, variant, 37) * (AH - 4));
      if (Math.abs(x - AHW) / AHW + Math.abs(y - AHH) / AHH <= 0.8) R.set(x, y, sh('#ffffff', 1));
    }
  }

  if (t.cracks) {
    for (let i = 0; i < 3; i++) {
      const sx = 6 + Math.floor(hash2(i, variant, 41) * 20);
      const sy = 4 + Math.floor(hash2(i, variant, 43) * 8);
      R.line(sx, sy, sx + 5, sy + 2, sh(t.lip, 1.05));
    }
  }

  if (TERRAIN[terrain].family === 'road') {
    drawRoad(R, t, mask);
  } else if (t.mask) {
    if (terrain === 'water') {
      for (let i = 0; i < 3; i++) R.dash(4 + i, 4 + i * 4, AW - 4 - i, 4 + i * 4, sh('#5fb8c9', 0.9), 2, 5);
    }
    for (let i = 0; i < 4; i++) {
      if (mask & (1 << i)) continue;
      const d = DIRS[i], v1 = DIA[d.a], v2 = DIA[d.b];
      R.fill([v1, v2, lerp(v2, CENTRE, 0.18), lerp(v1, CENTRE, 0.18)], sh(t.lip, 0.98));
    }
  }

  const cv = R.tint(tintFor(height)).toCanvas();
  topCache.set(key, cv);
  return cv;
}

function top(terrain, variant, mask, height) {
  const t = TERRAIN[terrain];
  const v = t.mask ? 0 : (variant | 0) % t.variants;
  const m = t.mask ? (mask | 0) : 0;
  const h = Math.max(-I.MAX_LEVEL, Math.min(I.MAX_LEVEL, height | 0));
  const key = terrain + '|' + v + '|' + m + '|' + season + '|' + h;
  return topCache.get(key) || buildTop(key, terrain, v, m, h);
}

/* ---------------- cliff walls ---------------- */
function buildWall(key, terrain, side, depth, height) {
  const t = resolve(terrain);
  const h = ALEVEL * depth + AHH;
  const R = new I.Raster(AHW, h);
  const poly = side === 'r'
    ? [{ x: AHW, y: 0 }, { x: 0, y: AHH }, { x: 0, y: AHH + ALEVEL * depth }, { x: AHW, y: ALEVEL * depth }]
    : [{ x: 0, y: 0 }, { x: AHW, y: AHH }, { x: AHW, y: AHH + ALEVEL * depth }, { x: 0, y: ALEVEL * depth }];
  const f = side === 'r' ? 0.62 : 0.84;
  const rock = sh(t.rock, f), dark = sh(t.rockDark, f);
  R.fill(poly, function (x, y) {
    if (y % 4 === 0 && hash2(x, y, 3) < 0.5) return dark;
    return hash2(x, y, 21) < 0.22 ? dark : rock;
  });
  if (side === 'r') {
    R.line(AHW, 0, 0, AHH, sh(t.lip, f * 1.25));
    R.line(AHW, 1, 0, AHH + 1, sh(t.lip, f * 0.85));
  } else {
    R.line(0, 0, AHW, AHH, sh(t.lip, f * 1.25));
    R.line(0, 1, AHW, AHH + 1, sh(t.lip, f * 0.85));
  }
  const cv = R.tint(tintFor(height)).toCanvas();
  wallCache.set(key, cv);
  return cv;
}

function wall(terrain, side, depth, height) {
  const d = Math.max(1, Math.min(I.MAX_LEVEL * 2, depth | 0));
  const h = Math.max(-I.MAX_LEVEL, Math.min(I.MAX_LEVEL, height | 0));
  const key = terrain + '|' + side + '|' + d + '|' + season + '|' + h;
  return wallCache.get(key) || buildWall(key, terrain, side, d, h);
}

global.Terrain = {
  DEFS: TERRAIN, DIRS: DIRS, top: top, wall: wall,
  setSeason: setSeason, familyOf: familyOf,
  get season() { return season; },
};

})(window);
