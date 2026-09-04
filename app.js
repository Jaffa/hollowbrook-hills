'use strict';

const I = window.Iso, T = window.Terrain;
const PS = 2;                                  // art px -> screen px at zoom 1
const TILE_W = I.AW * PS, TILE_H = I.AH * PS;  // 64 x 32
const LEVEL_H = I.ALEVEL * PS;                 // 16
const MAX_LEVEL = I.MAX_LEVEL;
const MIN_LEVEL = -I.MAX_LEVEL;
const HISTORY_LIMIT = 50;
const MIN_ZOOM = 0.4, MAX_ZOOM = 3;

const SEASONS = ['summer', 'autumn', 'winter', 'halloween', 'christmas', 'easter'];

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function randInt(n) { return Math.floor(Math.random() * n); }

// Declared before createMap runs, which stamps the current season onto new maps.
let season = 'summer';

/* =====================================================================
   MODEL
   ===================================================================== */
function makeCell() { return { terrain: 'grass', tv: randInt(4), height: 0, label: null }; }

function createMap(name, w, h) {
  const cells = [];
  for (let r = 0; r < h; r++) {
    const row = [];
    for (let c = 0; c < w; c++) row.push(makeCell());
    cells.push(row);
  }
  return { version: 2, name: name, season: season, width: w, height: h, cells: cells, objects: [] };
}

/* v1 files stored one object per cell and had no heightmap. */
function migrate(data) {
  if (data.version >= 2) {
    data.objects = data.objects || [];
    for (const row of data.cells) {
      for (const cell of row) {
        if (typeof cell.height !== 'number') cell.height = 0;
        if (typeof cell.tv !== 'number') cell.tv = randInt(4);
      }
    }
    return data;
  }
  const ID_MAP = {
    house: 'house', shop: 'store', treeround: 'oak', treepine: 'pine', watertower: 'watertower',
    radiotower: 'radiotower', church: 'church', school: 'school', factory: 'factory', silo: 'silo',
    barn: 'barn', cemetery: 'grave', park: 'bench', streetlight: 'streetlight', car: 'car',
  };
  const VAR_MAP = { diner: 'diner', hardware: 'hardware', arcade: 'arcade' };
  const out = createMap(data.name || 'New Town', data.width, data.height);
  for (let r = 0; r < data.height; r++) {
    for (let c = 0; c < data.width; c++) {
      const old = (data.cells[r] && data.cells[r][c]) || {};
      const cell = out.cells[r][c];
      cell.terrain = T.DEFS[old.terrain] ? old.terrain : 'grass';
      cell.tv = typeof old.groundVariant === 'number' ? old.groundVariant : randInt(4);
      cell.label = old.label || null;
      if (old.object && ID_MAP[old.object.id]) {
        const id = ID_MAP[old.object.id];
        let variant = old.object.variant;
        if (id === 'store') variant = VAR_MAP[variant] || 'hardware';
        if (!I.OBJECT_DEFS[id].variants) variant = undefined;
        else if (!I.OBJECT_DEFS[id].variants[variant]) variant = Object.keys(I.OBJECT_DEFS[id].variants)[0];
        out.objects.push({ id: id, variant: variant, rot: 0, col: c, row: r, label: null });
      }
    }
  }
  return out;
}

let map = createMap('New Town', 24, 18);
let occ = [];

function reindex() {
  occ = [];
  for (let r = 0; r < map.height; r++) occ.push(new Array(map.width).fill(-1));
  map.objects.forEach(function (o, i) {
    const f = I.footprint(o.id, o.rot);
    for (let r = o.row; r < o.row + f.fh; r++) {
      for (let c = o.col; c < o.col + f.fw; c++) {
        if (r >= 0 && c >= 0 && r < map.height && c < map.width) occ[r][c] = i;
      }
    }
  });
}

function inBounds(c, r) { return c >= 0 && r >= 0 && c < map.width && r < map.height; }
function objAt(c, r) { const i = occ[r][c]; return i < 0 ? null : map.objects[i]; }

/* =====================================================================
   STATE
   ===================================================================== */
let camera = { originX: 0, originY: 0, zoom: 1 };
let tool = { kind: 'terrain', id: 'grass' };
let brush = 1;
let rot = 0;
let showGrid = true;
let drawMode = 'free';        // free | line | rect | fill
let hover = { col: -1, row: -1 };
let dragFrom = null;          // anchor for line/rect previews
let painting = false, panning = false, panStart = null;
let altKey = false;          // inverts raise/lower while held
let history = [], future = [];
let needsRender = true;

const canvas = document.getElementById('mapCanvas');
const ctx = canvas.getContext('2d');
const wrap = document.getElementById('canvasWrap');

function markDirty() { needsRender = true; }

function snapshot() { return JSON.stringify({ c: map.cells, o: map.objects, n: map.name, w: map.width, h: map.height }); }
function restore(s) {
  const d = JSON.parse(s);
  map.cells = d.c; map.objects = d.o; map.name = d.n; map.width = d.w; map.height = d.h;
  reindex(); refreshLegend(); syncFields(); markDirty();
}
function pushHistory() {
  history.push(snapshot());
  if (history.length > HISTORY_LIMIT) history.shift();
  future.length = 0;
}
function undo() { if (history.length) { future.push(snapshot()); restore(history.pop()); } }
function redo() { if (future.length) { history.push(snapshot()); restore(future.pop()); } }

/* =====================================================================
   PROJECTION
   ===================================================================== */
function metrics(cam) {
  const z = cam.zoom;
  return { hw: TILE_W * z / 2, hh: TILE_H * z / 2, lv: LEVEL_H * z, s: PS * z };
}

function tileXY(col, row, h, cam, m) {
  return {
    x: (col - row) * m.hw + cam.originX,
    y: (col + row) * m.hh - h * m.lv + cam.originY,
  };
}

function heightAt(c, r) { return inBounds(c, r) ? map.cells[r][c].height : 0; }

function pointInPoly(px, py, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if ((a.y > py) !== (b.y > py) && px < (b.x - a.x) * (py - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/* Front-to-back scan: the first tile whose top face or cliff contains the
   point is the one the user sees there. */
function pickTile(mx, my, cam) {
  cam = cam || camera;
  const m = metrics(cam);
  for (let d = map.width + map.height - 2; d >= 0; d--) {
    const cLo = Math.max(0, d - (map.height - 1)), cHi = Math.min(map.width - 1, d);
    for (let c = cLo; c <= cHi; c++) {
      const r = d - c;
      const h = map.cells[r][c].height;
      const p = tileXY(c, r, h, cam, m);
      const dx = Math.abs(mx - p.x) / m.hw, dy = Math.abs(my - p.y) / m.hh;
      if (dx + dy <= 1) return { col: c, row: r };
      const dR = h - heightAt(c + 1, r), dL = h - heightAt(c, r + 1);
      if (dR > 0 && pointInPoly(mx, my, [
        { x: p.x + m.hw, y: p.y }, { x: p.x, y: p.y + m.hh },
        { x: p.x, y: p.y + m.hh + dR * m.lv }, { x: p.x + m.hw, y: p.y + dR * m.lv }])) return { col: c, row: r };
      if (dL > 0 && pointInPoly(mx, my, [
        { x: p.x - m.hw, y: p.y }, { x: p.x, y: p.y + m.hh },
        { x: p.x, y: p.y + m.hh + dL * m.lv }, { x: p.x - m.hw, y: p.y + dL * m.lv }])) return { col: c, row: r };
    }
  }
  return { col: -1, row: -1 };
}

/* =====================================================================
   RENDERING
   ===================================================================== */
function roadMask(c, r) {
  const fam = T.familyOf(map.cells[r][c].terrain);
  let mask = 0;
  for (let i = 0; i < 4; i++) {
    const d = T.DIRS[i], nc = c + d.dc, nr = r + d.dr;
    if (inBounds(nc, nr) && T.familyOf(map.cells[nr][nc].terrain) === fam) mask |= (1 << i);
  }
  return mask;
}

/* One depth-ordered pass for terrain, grid and objects. Everything must share
   the pass: a tile's grid lines have to be overpainted by whatever is in front
   of it, and a cliff in front of a building has to occlude that building. */
function drawWorld(fctx, cam, m, view, grid) {
  const needMask = T.DEFS;
  if (grid) fctx.lineWidth = 1;

  // Objects sort onto the depth of their front-most footprint corner.
  const buckets = new Map();
  map.objects.forEach(function (o, i) {
    const f = I.footprint(o.id, o.rot);
    const d = (o.col + f.fw - 1) + (o.row + f.fh - 1);
    if (!buckets.has(d)) buckets.set(d, []);
    buckets.get(d).push({ o: o, h: map.cells[o.row][o.col].height, i: i });
  });

  const maxD = map.width + map.height - 2;
  for (let d = 0; d <= maxD; d++) {
    const cLo = Math.max(0, d - (map.height - 1)), cHi = Math.min(map.width - 1, d);
    for (let c = cLo; c <= cHi; c++) {
      const r = d - c;
      const cell = map.cells[r][c];
      const p = tileXY(c, r, cell.height, cam, m);
      if (view && (p.x + m.hw < view.x0 || p.x - m.hw > view.x1 ||
                   p.y + m.hh + Math.abs(cell.height) * m.lv < view.y0 || p.y - m.hh > view.y1)) continue;

      const dR = cell.height - heightAt(c + 1, r);
      const dL = cell.height - heightAt(c, r + 1);
      if (dR > 0) {
        const w = T.wall(cell.terrain, 'r', dR, cell.height);
        fctx.drawImage(w, p.x, p.y, w.width * m.s, w.height * m.s);
      }
      if (dL > 0) {
        const w = T.wall(cell.terrain, 'l', dL, cell.height);
        fctx.drawImage(w, p.x - m.hw, p.y, w.width * m.s, w.height * m.s);
      }
      const spr = T.top(cell.terrain, cell.tv, needMask[cell.terrain].mask ? roadMask(c, r) : 0, cell.height);
      fctx.drawImage(spr, p.x - m.hw, p.y - m.hh, spr.width * m.s, spr.height * m.s);

      /* A drop away from the camera (-col / -row) has no visible cliff, yet its
         neighbour lands in the same screen slot a same-height tile would, so the
         two tops merge into one false plane. Shade those seams. */
      const upC = heightAt(c - 1, r) - cell.height;
      const upR = heightAt(c, r - 1) - cell.height;
      if (upC < 0 || upR < 0) {
        fctx.lineWidth = Math.max(1, m.s * 0.5);
        fctx.strokeStyle = 'rgba(12,8,20,0.42)';
        if (upC < 0) {
          fctx.beginPath();
          fctx.moveTo(p.x - m.hw, p.y);
          fctx.lineTo(p.x, p.y - m.hh);
          fctx.stroke();
        }
        if (upR < 0) {
          fctx.beginPath();
          fctx.moveTo(p.x, p.y - m.hh);
          fctx.lineTo(p.x + m.hw, p.y);
          fctx.stroke();
        }
      }

      if (grid) {
        fctx.lineWidth = 1;
        // Only the two far edges, so shared edges are not stroked twice.
        fctx.strokeStyle = 'rgba(255,255,255,0.10)';
        fctx.beginPath();
        fctx.moveTo(p.x - m.hw, p.y);
        fctx.lineTo(p.x, p.y - m.hh);
        fctx.lineTo(p.x + m.hw, p.y);
        fctx.stroke();
        // Cliff tops get a brighter near edge so steps stay readable.
        if (dR > 0 || dL > 0) {
          fctx.strokeStyle = 'rgba(255,255,255,0.16)';
          fctx.beginPath();
          fctx.moveTo(p.x + m.hw, p.y);
          fctx.lineTo(p.x, p.y + m.hh);
          fctx.lineTo(p.x - m.hw, p.y);
          fctx.stroke();
        }
      }
    }

    const here = buckets.get(d);
    if (!here) continue;
    here.sort(function (a, b) { return a.h - b.h || a.i - b.i; });
    for (const e of here) drawObject(fctx, cam, m, e.o);
  }
}

function diamondPath(fctx, p, m) {
  fctx.beginPath();
  fctx.moveTo(p.x, p.y - m.hh);
  fctx.lineTo(p.x + m.hw, p.y);
  fctx.lineTo(p.x, p.y + m.hh);
  fctx.lineTo(p.x - m.hw, p.y);
  fctx.closePath();
}

function objectAnchor(o, cam, m) {
  const f = I.footprint(o.id, o.rot);
  const h = map.cells[o.row][o.col].height;
  const a = tileXY(o.col, o.row, h, cam, m);
  const b = tileXY(o.col + f.fw - 1, o.row + f.fh - 1, h, cam, m);
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, f: f };
}

/* A tunnel mouth belongs to the cliff beside it, so it is specialised from the
   map: pick the uphill neighbour whose wall we can actually see (-col or -row)
   and match the portal to that wall's height. */
function tunnelOpts(o) {
  const own = map.cells[o.row][o.col].height;
  const upCol = heightAt(o.col - 1, o.row) - own;
  const upRow = heightAt(o.col, o.row - 1) - own;
  if (upCol <= 0 && upRow <= 0) return { depth: 0, side: o.rot ? 'row' : 'col' };
  // Tie goes to the side the user rotated towards.
  const useCol = upCol === upRow ? !o.rot : upCol > upRow;
  return useCol ? { depth: upCol, side: 'col' } : { depth: upRow, side: 'row' };
}

const DIR_NAME = ['col+', 'row+', 'col-', 'row-'];   // matches T.DIRS order
const BRIDGE_CLEARANCE = 5;   // art px a deck keeps above whatever it spans

function isSpanned(c, r) {
  if (!inBounds(c, r)) return false;
  const fam = T.familyOf(map.cells[r][c].terrain);
  if (fam === 'water' || fam === 'ice') return true;
  const o = objAt(c, r);
  return !!(o && o.id === 'bridge');
}

/* Deck height for a bridge: level with the bank it runs to, but never sitting
   down in the water. Walking the span means a multi-tile bridge picks the same
   height for every one of its tiles, so the deck stays flat. */
function bridgeOpts(o) {
  const own = map.cells[o.row][o.col].height;
  const dc = o.rot ? 0 : 1, dr = o.rot ? 1 : 0;
  let bank = null;
  for (const sign of [1, -1]) {
    for (let k = 1; k <= 10; k++) {
      const c = o.col + dc * k * sign, r = o.row + dr * k * sign;
      if (!inBounds(c, r)) break;
      if (isSpanned(c, r)) continue;
      const h = map.cells[r][c].height;
      bank = bank === null ? h : Math.max(bank, h);
      break;
    }
  }
  const rise = bank === null ? BRIDGE_CLEARANCE : (bank - own) * I.ALEVEL;
  return { deckZ: Math.max(rise, BRIDGE_CLEARANCE) };
}

// Absolute height, in art px, of the surface a ramp should meet on a tile.
function surfaceZ(c, r) {
  const base = map.cells[r][c].height * I.ALEVEL;
  const o = objAt(c, r);
  if (o && o.id === 'bridge') return base + bridgeOpts(o).deckZ;
  return base;
}

/* A ramp works out what it is climbing: an adjacent bridge deck first, else the
   tallest uphill neighbour. That way road-to-bridge joins line up without the
   user having to nominate a direction. */
function rampOpts(o) {
  const ownZ = map.cells[o.row][o.col].height * I.ALEVEL;
  let best = null;

  for (let i = 0; i < 4; i++) {
    const d = T.DIRS[i], nc = o.col + d.dc, nr = o.row + d.dr;
    if (!inBounds(nc, nr)) continue;
    const nb = objAt(nc, nr);
    const rise = surfaceZ(nc, nr) - ownZ;
    if (rise <= 0) continue;
    // A bridge deck wins over plain ground: that is the join worth smoothing.
    const rank = nb && nb.id === 'bridge' ? 2 : 1;
    if (!best || rank > best.rank || (rank === best.rank && rise > best.riseZ)) {
      const bv = nb && nb.id === 'bridge' && I.OBJECT_DEFS.bridge.variants[nb.variant];
      best = { rank: rank, dir: DIR_NAME[i], riseZ: rise, deck: bv ? bv.deck : null };
    }
  }

  if (!best) return { dir: o.rot ? 'row+' : 'col+', riseZ: BRIDGE_CLEARANCE };
  const out = { dir: best.dir, riseZ: Math.max(1, best.riseZ) };
  if (best.deck) out.deck = best.deck;
  return out;
}

function spriteFor(o) {
  if (o.id === 'tunnel') return I.objectSprite(o.id, o.variant, o.rot, tunnelOpts(o));
  if (o.id === 'ramp') return I.objectSprite(o.id, o.variant, o.rot, rampOpts(o));
  if (o.id === 'bridge') return I.objectSprite(o.id, o.variant, o.rot, bridgeOpts(o));
  return I.objectSprite(o.id, o.variant, o.rot);
}

function drawObject(fctx, cam, m, o) {
  const spr = spriteFor(o);
  const an = objectAnchor(o, cam, m);
  fctx.drawImage(spr.canvas, an.x - spr.ax * m.s, an.y - spr.ay * m.s, spr.w * m.s, spr.h * m.s);
}

function labelEntries() {
  const out = [];
  for (const o of map.objects) if (o.label) out.push({ label: o.label, col: o.col, row: o.row, obj: o });
  for (let r = 0; r < map.height; r++) {
    for (let c = 0; c < map.width; c++) {
      if (map.cells[r][c].label) out.push({ label: map.cells[r][c].label, col: c, row: r, obj: null });
    }
  }
  return out;
}

function drawLabels(fctx, cam, m) {
  const size = Math.max(8, Math.round(9 * cam.zoom));
  fctx.font = size + "px 'Press Start 2P', monospace";
  fctx.textAlign = 'center';
  fctx.textBaseline = 'alphabetic';
  for (const e of labelEntries()) {
    const h = map.cells[e.row][e.col].height;
    let x, topY;
    if (e.obj) {
      const spr = spriteFor(e.obj);
      const an = objectAnchor(e.obj, cam, m);
      x = an.x;
      topY = an.y - spr.ay * m.s;
    } else {
      const p = tileXY(e.col, e.row, h, cam, m);
      x = p.x; topY = p.y - m.hh;
    }
    const tagY = topY - 14 * cam.zoom;
    const tw = fctx.measureText(e.label).width;
    fctx.strokeStyle = 'rgba(0,0,0,0.55)';
    fctx.lineWidth = Math.max(1, cam.zoom);
    fctx.beginPath();
    fctx.moveTo(x, topY);
    fctx.lineTo(x, tagY + 3);
    fctx.stroke();
    fctx.fillStyle = 'rgba(10,7,18,0.88)';
    fctx.fillRect(x - tw / 2 - 5, tagY - size, tw + 10, size + 7);
    fctx.strokeStyle = '#e8a33d';
    fctx.strokeRect(x - tw / 2 - 5, tagY - size, tw + 10, size + 7);
    fctx.fillStyle = '#f1e9da';
    fctx.fillText(e.label, x, tagY);
  }
}

function drawHover(fctx, cam, m) {
  if (!inBounds(hover.col, hover.row)) return;
  fctx.lineWidth = Math.max(1, 1.5 * cam.zoom);

  if (dragFrom) {
    fctx.strokeStyle = '#f5e58a';
    for (const t of spanCells(dragFrom, hover, drawMode)) {
      diamondPath(fctx, tileXY(t.col, t.row, map.cells[t.row][t.col].height, cam, m), m);
      fctx.stroke();
    }
    return;
  }

  const cells = brushCells(hover.col, hover.row);
  const ghost = tool.kind === 'object' ? I.footprint(tool.id, rot) : null;
  if (ghost) {
    const ok = canPlace(hover.col, hover.row, ghost);
    fctx.strokeStyle = ok ? '#2de1c2' : '#ff3d5f';
    for (let r = hover.row; r < hover.row + ghost.fh; r++) {
      for (let c = hover.col; c < hover.col + ghost.fw; c++) {
        if (!inBounds(c, r)) continue;
        diamondPath(fctx, tileXY(c, r, map.cells[r][c].height, cam, m), m);
        fctx.stroke();
      }
    }
    return;
  }
  fctx.strokeStyle = '#2de1c2';
  for (const t of cells) {
    diamondPath(fctx, tileXY(t.col, t.row, map.cells[t.row][t.col].height, cam, m), m);
    fctx.stroke();
  }
}

function renderFrame(fctx, cam, opts) {
  const m = metrics(cam);
  drawWorld(fctx, cam, m, opts.view, opts.grid);
  if (opts.hover) drawExtendPreview(fctx, cam, m);
  if (opts.labels) drawLabels(fctx, cam, m);
  if (opts.hover) drawHover(fctx, cam, m);
}

function render() {
  needsRender = false;
  const dpr = window.devicePixelRatio || 1;
  const w = wrap.clientWidth, h = wrap.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, w, h);
  syncExtendHandles();
  renderFrame(ctx, camera, {
    grid: showGrid, labels: true, hover: true,
    view: { x0: -80, y0: -200, x1: w + 80, y1: h + 80 },
  });
}

function loop() {
  if (needsRender) render();
  requestAnimationFrame(loop);
}

/* =====================================================================
   EDITING
   ===================================================================== */
function brushCells(col, row) {
  const out = [];
  const rad = brush - 1;
  for (let r = row - rad; r <= row + rad; r++) {
    for (let c = col - rad; c <= col + rad; c++) {
      if (inBounds(c, r)) out.push({ col: c, row: r });
    }
  }
  return out;
}

function canPlace(col, row, f) {
  for (let r = row; r < row + f.fh; r++) {
    for (let c = col; c < col + f.fw; c++) {
      if (!inBounds(c, r) || occ[r][c] >= 0) return false;
    }
  }
  return true;
}

function placeObject(col, row) {
  const f = I.footprint(tool.id, rot);
  if (!canPlace(col, row, f)) return false;
  // Buildings need a level pad, so flatten the footprint to the anchor's height.
  const h = map.cells[row][col].height;
  for (let r = row; r < row + f.fh; r++) {
    for (let c = col; c < col + f.fw; c++) map.cells[r][c].height = h;
  }
  map.objects.push({ id: tool.id, variant: tool.variant, rot: rot, col: col, row: row, label: null });
  reindex();
  markDirty();
  return true;
}

function eraseAt(col, row) {
  const i = occ[row][col];
  if (i < 0) return false;
  map.objects.splice(i, 1);
  reindex();
  markDirty();
  return true;
}

function adjustHeight(col, row, delta) {
  const seen = new Set();
  const targets = [];
  for (const t of brushCells(col, row)) {
    const o = objAt(t.col, t.row);
    if (o) {
      // Move a whole building together so its pad stays flat.
      const key = 'o' + map.objects.indexOf(o);
      if (seen.has(key)) continue;
      seen.add(key);
      const f = I.footprint(o.id, o.rot);
      for (let r = o.row; r < o.row + f.fh; r++) {
        for (let c = o.col; c < o.col + f.fw; c++) targets.push({ col: c, row: r });
      }
    } else {
      const key = t.col + ',' + t.row;
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push(t);
    }
  }
  let changed = false;
  for (const t of targets) {
    const cell = map.cells[t.row][t.col];
    const next = clamp(cell.height + delta, MIN_LEVEL, MAX_LEVEL);
    if (next !== cell.height) { cell.height = next; changed = true; }
  }
  if (changed) markDirty();
  return changed;
}

function levelTo(col, row, h) {
  let changed = false;
  for (const t of brushCells(col, row)) {
    const cell = map.cells[t.row][t.col];
    if (cell.height !== h) { cell.height = h; changed = true; }
  }
  if (changed) markDirty();
  return changed;
}

/* Tiles covered by a line/rect drag, in grid space. */
function spanCells(a, b, mode) {
  const out = [];
  if (mode === 'rect') {
    const c0 = Math.min(a.col, b.col), c1 = Math.max(a.col, b.col);
    const r0 = Math.min(a.row, b.row), r1 = Math.max(a.row, b.row);
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) if (inBounds(c, r)) out.push({ col: c, row: r });
    return out;
  }
  // Straight run along whichever grid axis the drag favours, so roads stay tidy.
  const dc = b.col - a.col, dr = b.row - a.row;
  if (Math.abs(dc) >= Math.abs(dr)) {
    const step = dc >= 0 ? 1 : -1;
    for (let c = a.col; c !== b.col + step; c += step) if (inBounds(c, a.row)) out.push({ col: c, row: a.row });
  } else {
    const step = dr >= 0 ? 1 : -1;
    for (let r = a.row; r !== b.row + step; r += step) if (inBounds(a.col, r)) out.push({ col: a.col, row: r });
  }
  return out;
}

/* Flood fill over tiles sharing the starting terrain (4-connected). */
function fillCells(col, row) {
  const target = map.cells[row][col].terrain;
  const seen = new Set([col + ',' + row]);
  const stack = [{ col: col, row: row }];
  const out = [];
  while (stack.length) {
    const t = stack.pop();
    out.push(t);
    if (out.length > map.width * map.height) break;
    for (const d of T.DIRS) {
      const nc = t.col + d.dc, nr = t.row + d.dr;
      const key = nc + ',' + nr;
      if (!inBounds(nc, nr) || seen.has(key)) continue;
      if (map.cells[nr][nc].terrain !== target) continue;
      seen.add(key);
      stack.push({ col: nc, row: nr });
    }
  }
  return out;
}

// Alt flips the elevation tools, so one hand can sculpt both ways.
function heightDelta() {
  const base = tool.kind === 'lower' ? -1 : 1;
  return altKey ? -base : base;
}

function paintTerrain(cells, id) {
  let changed = false;
  for (const t of cells) {
    const cell = map.cells[t.row][t.col];
    if (cell.terrain !== id) { cell.terrain = id; cell.tv = randInt(4); changed = true; }
  }
  if (changed) markDirty();
  return changed;
}

/* Commits a line/rect/fill gesture; single-tile tools stay on applyTool. */
function applySpan(cells) {
  if (tool.kind === 'terrain') return paintTerrain(cells, tool.id);
  if (tool.kind === 'raise' || tool.kind === 'lower') {
    const delta = heightDelta();
    let changed = false;
    for (const t of cells) if (adjustHeight(t.col, t.row, delta)) changed = true;
    return changed;
  }
  if (tool.kind === 'level') {
    let changed = false;
    for (const t of cells) if (levelTo(t.col, t.row, tool.levelH || 0)) changed = true;
    return changed;
  }
  if (tool.kind === 'object') {
    let changed = false;
    for (const t of cells) if (placeObject(t.col, t.row)) changed = true;
    return changed;
  }
  if (tool.kind === 'erase') {
    let changed = false;
    for (const t of cells) if (eraseAt(t.col, t.row)) changed = true;
    return changed;
  }
  return false;
}

function eyedrop(col, row) {
  const o = objAt(col, row);
  if (o) {
    selectByTool({ kind: 'object', id: o.id, variant: o.variant });
    rot = o.rot ? 1 : 0;
    updateRot();
  } else {
    selectByTool({ kind: 'terrain', id: map.cells[row][col].terrain });
  }
}

function applyTool(col, row, isDrag) {
  if (!inBounds(col, row)) return;
  if (tool.kind === 'pick') { if (!isDrag) eyedrop(col, row); return; }
  if (tool.kind === 'terrain') {
    paintTerrain(brushCells(col, row), tool.id);
  } else if (tool.kind === 'object') {
    if (!isDrag || !objAt(col, row)) placeObject(col, row);
  } else if (tool.kind === 'erase') {
    eraseAt(col, row);
  } else if (tool.kind === 'raise' || tool.kind === 'lower') {
    adjustHeight(col, row, heightDelta());
  } else if (tool.kind === 'level') {
    if (!isDrag) tool.levelH = map.cells[row][col].height;
    levelTo(col, row, tool.levelH || 0);
  } else if (tool.kind === 'label' && !isDrag) {
    const o = objAt(col, row);
    const cur = o ? o.label : map.cells[row][col].label;
    const next = window.prompt('Name this location (blank to clear):', cur || '');
    if (next !== null) {
      const v = next.trim() ? next.trim() : null;
      if (o) o.label = v; else map.cells[row][col].label = v;
      refreshLegend();
      markDirty();
    }
  }
}

/* =====================================================================
   PALETTE
   ===================================================================== */
const PALETTE = [
  { cat: 'Ground', items: [
    { kind: 'terrain', id: 'grass' }, { kind: 'terrain', id: 'cornfield' },
    { kind: 'terrain', id: 'dirt' }, { kind: 'terrain', id: 'gravel' },
    { kind: 'terrain', id: 'sand' }, { kind: 'terrain', id: 'snow' },
    { kind: 'terrain', id: 'rock' },
  ] },
  { cat: 'Water & Roads', items: [
    { kind: 'terrain', id: 'water' }, { kind: 'terrain', id: 'ice' },
    { kind: 'terrain', id: 'road' }, { kind: 'terrain', id: 'freeway' },
  ] },
  { cat: 'Elevation', items: [
    { kind: 'raise', label: 'Raise Ground' },
    { kind: 'lower', label: 'Lower Ground' },
    { kind: 'level', label: 'Level (match 1st)' },
  ] },
  { cat: 'Homes', items: [
    { kind: 'object', id: 'house', variant: 'red' }, { kind: 'object', id: 'house', variant: 'blue' },
    { kind: 'object', id: 'house', variant: 'yellow' }, { kind: 'object', id: 'house', variant: 'green' },
    { kind: 'object', id: 'house', variant: 'white' }, { kind: 'object', id: 'house2' },
    { kind: 'object', id: 'ranch' }, { kind: 'object', id: 'duplex' }, { kind: 'object', id: 'apartment' },
    { kind: 'object', id: 'farmhouse' }, { kind: 'object', id: 'cabin' }, { kind: 'object', id: 'trailer' },
    { kind: 'object', id: 'garage' },
  ] },
  { cat: 'Main Street', items: [
    { kind: 'object', id: 'diner' },
    { kind: 'object', id: 'store', variant: 'hardware' }, { kind: 'object', id: 'store', variant: 'grocery' },
    { kind: 'object', id: 'store', variant: 'video' }, { kind: 'object', id: 'store', variant: 'arcade' },
    { kind: 'object', id: 'bowling' }, { kind: 'object', id: 'cinema' }, { kind: 'object', id: 'tavern' },
    { kind: 'object', id: 'icecream' }, { kind: 'object', id: 'bank' }, { kind: 'object', id: 'postoffice' },
    { kind: 'object', id: 'gasstation' }, { kind: 'object', id: 'motel' },
  ] },
  { cat: 'Civic', items: [
    { kind: 'object', id: 'school' }, { kind: 'object', id: 'church' },
    { kind: 'object', id: 'townhall' }, { kind: 'object', id: 'library' }, { kind: 'object', id: 'sheriff' },
    { kind: 'object', id: 'firestation' }, { kind: 'object', id: 'clinic' },
  ] },
  { cat: 'Rural & Industry', items: [
    { kind: 'object', id: 'barn' }, { kind: 'object', id: 'silo' }, { kind: 'object', id: 'factory' },
    { kind: 'object', id: 'warehouse' }, { kind: 'object', id: 'watertower' },
    { kind: 'object', id: 'radiotower' }, { kind: 'object', id: 'lab' },
    { kind: 'object', id: 'greenhouse' }, { kind: 'object', id: 'boathouse' },
    { kind: 'object', id: 'lighthouse' }, { kind: 'object', id: 'haybale' },
    { kind: 'object', id: 'tractor' },
  ] },
  { cat: 'Bridges & Tunnels', items: [
    { kind: 'object', id: 'bridge', variant: 'road' }, { kind: 'object', id: 'bridge', variant: 'wood' },
    { kind: 'object', id: 'bridge', variant: 'stone' },
    { kind: 'object', id: 'ramp', variant: 'road' }, { kind: 'object', id: 'ramp', variant: 'wood' },
    { kind: 'object', id: 'ramp', variant: 'stone' },
    { kind: 'object', id: 'tunnel', variant: 'stone' }, { kind: 'object', id: 'tunnel', variant: 'brick' },
  ] },
  { cat: 'Fences & Walls', items: [
    { kind: 'object', id: 'fence', variant: 'picket' }, { kind: 'object', id: 'fence', variant: 'split' },
    { kind: 'object', id: 'fence', variant: 'chain' }, { kind: 'object', id: 'fence', variant: 'stone' },
    { kind: 'object', id: 'fence', variant: 'hedge' }, { kind: 'object', id: 'fence', variant: 'gate' },
  ] },
  { cat: 'Playground & Park', items: [
    { kind: 'object', id: 'swing' }, { kind: 'object', id: 'slide' }, { kind: 'object', id: 'seesaw' },
    { kind: 'object', id: 'sandbox' }, { kind: 'object', id: 'roundabout' },
    { kind: 'object', id: 'climbframe' }, { kind: 'object', id: 'hoop' },
    { kind: 'object', id: 'bench' }, { kind: 'object', id: 'picnic' },
    { kind: 'object', id: 'fountain' }, { kind: 'object', id: 'statue' },
    { kind: 'object', id: 'pool' }, { kind: 'object', id: 'well' },
  ] },
  { cat: 'Street Furniture', items: [
    { kind: 'object', id: 'streetlight' }, { kind: 'object', id: 'stopsign' },
    { kind: 'object', id: 'trafficlight' }, { kind: 'object', id: 'streetsign' },
    { kind: 'object', id: 'billboard' }, { kind: 'object', id: 'powerpole' },
    { kind: 'object', id: 'hydrant' }, { kind: 'object', id: 'mailbox' },
    { kind: 'object', id: 'trashcan' }, { kind: 'object', id: 'dumpster' },
    { kind: 'object', id: 'bikerack' }, { kind: 'object', id: 'phonebooth' },
    { kind: 'object', id: 'busstop' }, { kind: 'object', id: 'satellite' },
  ] },
  { cat: 'Nature', items: [
    { kind: 'object', id: 'oak', variant: 'green' }, { kind: 'object', id: 'oak', variant: 'autumn' },
    { kind: 'object', id: 'pine' }, { kind: 'object', id: 'deadtree' },
    { kind: 'object', id: 'bush' }, { kind: 'object', id: 'boulder' },
    { kind: 'object', id: 'flowerbed' }, { kind: 'object', id: 'grave' },
    { kind: 'object', id: 'campfire' }, { kind: 'object', id: 'tent' },
    { kind: 'object', id: 'woodpile' },
  ] },
  { cat: 'Vehicles', items: [
    { kind: 'object', id: 'car', variant: 'red' }, { kind: 'object', id: 'car', variant: 'blue' },
    { kind: 'object', id: 'car', variant: 'tan' }, { kind: 'object', id: 'bike' },
    { kind: 'object', id: 'pickup' }, { kind: 'object', id: 'van' },
    { kind: 'object', id: 'schoolbus' }, { kind: 'object', id: 'policecar' },
    { kind: 'object', id: 'firetruck' }, { kind: 'object', id: 'ambulance' },
    { kind: 'object', id: 'icecreamvan' },
  ] },
  { cat: 'Halloween', items: [
    { kind: 'object', id: 'jackolantern' }, { kind: 'object', id: 'scarecrow' },
    { kind: 'object', id: 'deadtree' }, { kind: 'object', id: 'haybale' },
    { kind: 'object', id: 'grave' },
  ] },
  { cat: 'Christmas', items: [
    { kind: 'object', id: 'xmastree' }, { kind: 'object', id: 'snowman' },
    { kind: 'object', id: 'presents' }, { kind: 'object', id: 'candycane' },
  ] },
  { cat: 'Easter', items: [
    { kind: 'object', id: 'eastereggs' }, { kind: 'object', id: 'bunny' },
    { kind: 'object', id: 'flowerbed' },
  ] },
  { cat: 'Tools', items: [
    { kind: 'extend', label: 'Extend Map Edge' },
    { kind: 'erase', label: 'Erase Building' },
    { kind: 'label', label: 'Name a Place' },
    { kind: 'pick', label: 'Eyedropper' },
    { kind: 'pan', label: 'Pan View' },
  ] },
];

function itemLabel(item) {
  if (item.label) return item.label;
  if (item.kind === 'terrain') return T.DEFS[item.id].label;
  return I.objectLabel(item.id, item.variant);
}

function itemIcon(item) {
  if (item.kind === 'terrain') return { canvas: T.top(item.id, 0, item.id === 'road' ? 5 : 15) };
  if (item.kind === 'object') {
    const s = I.objectSprite(item.id, item.variant, 0);
    return { canvas: s.canvas };
  }
  return null;
}

const paletteEl = document.getElementById('palette');
const statusToolEl = document.getElementById('statusTool');
const hintEl = document.getElementById('hint');
const footEl = document.getElementById('statusFoot');

const HINTS = {
  raise: 'Click or drag to raise ground. Buildings move with their pad.',
  lower: 'Click or drag to lower ground.',
  level: 'Click sets the target height, then drag to flatten to it.',
  label: 'Click a building or tile to name it — it appears in the Legend.',
  pan: 'Drag to pan. Right-drag always pans, whatever tool is active.',
  erase: 'Click a building to remove it.',
  extend: 'Click an arrow at the map edge to add ' + 4 + ' tiles on that side.',
  object: 'Click to place. Press R to rotate. Red outline = blocked.',
  terrain: 'Click or drag to paint. [ and ] change brush size.',
};

const swatchIndex = new Map();
const paletteFlat = [];      // ordered {item, btn, cat} for keyboard walking
let paletteCursor = 0;
function swatchKey(item) { return item.kind + '|' + (item.id || '') + '|' + (item.variant || ''); }

function selectItem(item, btn) {
  tool = { kind: item.kind, id: item.id, variant: item.variant };
  document.querySelectorAll('.swatch.active').forEach(function (el) { el.classList.remove('active'); });
  if (btn) {
    btn.classList.add('active');
    const group = btn.closest('.palette-group');
    if (group) group.classList.remove('collapsed');
  }
  statusToolEl.textContent = 'Tool: ' + itemLabel(item);
  hintEl.textContent = HINTS[item.kind] || '';
  if (item.kind === 'object') {
    const f = I.footprint(item.id, rot);
    footEl.textContent = 'Footprint: ' + f.fw + 'x' + f.fh;
  } else {
    footEl.textContent = '';
  }
  if (btn && btn.dataset.pi !== undefined) paletteCursor = parseInt(btn.dataset.pi, 10);
  syncModeButtons();
  syncExtendHandles();
  markDirty();
}

/* Used by the eyedropper: mirror a picked tool back onto its palette swatch. */
function selectByTool(t) {
  const btn = swatchIndex.get(swatchKey(t));
  if (btn) { btn.click(); btn.scrollIntoView({ block: 'nearest' }); return; }
  tool = { kind: t.kind, id: t.id, variant: t.variant };
  statusToolEl.textContent = 'Tool: ' + itemLabel(t);
  markDirty();
}

function makeSwatch(item) {
  const btn = document.createElement('button');
  btn.className = 'swatch';
  const icon = itemIcon(item);
  const cv = document.createElement('canvas');
  cv.width = 34; cv.height = 30;
  const ic = cv.getContext('2d');
  ic.imageSmoothingEnabled = false;
  if (icon) {
    const src = icon.canvas;
    const sc = Math.min(32 / src.width, 28 / src.height, 2);
    const dw = Math.max(1, Math.round(src.width * sc)), dh = Math.max(1, Math.round(src.height * sc));
    ic.drawImage(src, Math.round((34 - dw) / 2), Math.round((30 - dh) / 2), dw, dh);
  } else {
    ic.fillStyle = '#2de1c2';
    ic.fillRect(12, 11, 10, 8);
  }
  btn.appendChild(cv);
  const span = document.createElement('span');
  let text = itemLabel(item);
  if (item.kind === 'object') {
    const f = I.footprint(item.id, 0);
    if (f.fw > 1 || f.fh > 1) text += '  ' + f.fw + '×' + f.fh;
  }
  span.textContent = text;
  btn.title = itemLabel(item);
  btn.appendChild(span);
  btn.addEventListener('click', function () { selectItem(item, btn); });
  return btn;
}

function buildPalette() {
  paletteEl.innerHTML = '';
  swatchIndex.clear();
  paletteFlat.length = 0;
  let first = null;
  let catIdx = -1;
  for (const group of PALETTE) {
    catIdx++;
    const wrapEl = document.createElement('div');
    wrapEl.className = 'palette-group';
    const h = document.createElement('button');
    h.className = 'palette-category';
    h.innerHTML = '<span class="caret">▾</span>' + group.cat;
    h.addEventListener('click', function () { wrapEl.classList.toggle('collapsed'); });
    wrapEl.appendChild(h);
    const body = document.createElement('div');
    body.className = 'palette-items';
    for (const item of group.items) {
      const btn = makeSwatch(item);
      const key = swatchKey(item);
      if (!swatchIndex.has(key)) swatchIndex.set(key, btn);
      btn.dataset.pi = String(paletteFlat.length);
      paletteFlat.push({ item: item, btn: btn, cat: catIdx });
      body.appendChild(btn);
      if (!first) first = { item: item, btn: btn };
    }
    wrapEl.appendChild(body);
    paletteEl.appendChild(wrapEl);
  }
  if (first) selectItem(first.item, first.btn);
}

function visibleSwatch(i) {
  const e = paletteFlat[i];
  return e && e.btn.style.display !== 'none' ? e : null;
}

/* Steps through the palette in display order, skipping anything the search
   has filtered out. */
function stepPalette(delta) {
  const n = paletteFlat.length;
  if (!n) return;
  for (let k = 1; k <= n; k++) {
    const i = ((paletteCursor + delta * k) % n + n) % n;
    const e = visibleSwatch(i);
    if (e) { e.btn.click(); e.btn.scrollIntoView({ block: 'nearest' }); return; }
  }
}

/* Jumps to the first visible entry of the previous/next palette category. */
function stepCategory(delta) {
  const here = paletteFlat[paletteCursor];
  if (!here) return stepPalette(delta);
  const cats = [];
  for (const e of paletteFlat) if (!cats.length || cats[cats.length - 1] !== e.cat) cats.push(e.cat);
  const at = cats.indexOf(here.cat);
  for (let k = 1; k <= cats.length; k++) {
    const cat = cats[((at + delta * k) % cats.length + cats.length) % cats.length];
    const e = paletteFlat.find(function (x) { return x.cat === cat && x.btn.style.display !== 'none'; });
    if (e) { e.btn.click(); e.btn.scrollIntoView({ block: 'nearest' }); return; }
  }
}

function panBy(dx, dy) {
  camera.originX += dx;
  camera.originY += dy;
  markDirty();
}

function centreOnMap() {
  const m = metrics(camera);
  const p = tileXY((map.width - 1) / 2, (map.height - 1) / 2, 0, camera, m);
  camera.originX += wrap.clientWidth / 2 - p.x;
  camera.originY += wrap.clientHeight / 2 - p.y;
  markDirty();
}

function filterPalette(q) {
  const term = q.trim().toLowerCase();
  for (const group of paletteEl.querySelectorAll('.palette-group')) {
    let shown = 0;
    for (const btn of group.querySelectorAll('.swatch')) {
      const match = !term || btn.title.toLowerCase().indexOf(term) >= 0;
      btn.style.display = match ? '' : 'none';
      if (match) shown++;
    }
    group.style.display = shown ? '' : 'none';
    if (term) group.classList.remove('collapsed');
  }
}

/* =====================================================================
   LEGEND
   ===================================================================== */
const legendListEl = document.getElementById('legendList');
function refreshLegend() {
  const entries = labelEntries();
  legendListEl.innerHTML = '';
  if (!entries.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No named places yet.';
    legendListEl.appendChild(li);
    return;
  }
  entries.sort(function (a, b) { return a.label.localeCompare(b.label); });
  for (const e of entries) {
    const li = document.createElement('li');
    const name = document.createElement('div');
    name.textContent = e.label;
    const coord = document.createElement('span');
    coord.className = 'coord';
    coord.textContent = (e.obj ? I.objectLabel(e.obj.id, e.obj.variant) + ' — ' : '') + '(' + e.col + ', ' + e.row + ')';
    li.appendChild(name);
    li.appendChild(coord);
    li.addEventListener('click', function () { centerOn(e.col, e.row); });
    legendListEl.appendChild(li);
  }
}

function centerOn(col, row) {
  const m = metrics(camera);
  const p = tileXY(col, row, map.cells[row][col].height, camera, m);
  camera.originX += wrap.clientWidth / 2 - p.x;
  camera.originY += wrap.clientHeight / 2 - p.y;
  markDirty();
}

/* =====================================================================
   INPUT
   ===================================================================== */
canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });

canvas.addEventListener('mousedown', function (e) {
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left, my = e.clientY - rect.top;
  if (e.button === 2 || tool.kind === 'pan') {
    panning = true;
    panStart = { x: e.clientX, y: e.clientY, ox: camera.originX, oy: camera.originY };
    return;
  }
  if (e.button !== 0) return;
  if (tool.kind === 'extend') return;
  altKey = e.altKey;
  const t = pickTile(mx, my);
  const spanning = drawMode !== 'free' && SPANNABLE[tool.kind];

  if (drawMode === 'fill' && tool.kind === 'terrain' && inBounds(t.col, t.row)) {
    pushHistory();
    applySpan(fillCells(t.col, t.row));
    return;
  }
  if (spanning && inBounds(t.col, t.row)) {
    if (tool.kind === 'level') tool.levelH = map.cells[t.row][t.col].height;
    dragFrom = t;
    markDirty();
    return;
  }
  pushHistory();
  painting = true;
  applyTool(t.col, t.row, false);
});

const SPANNABLE = { terrain: 1, object: 1, erase: 1, raise: 1, lower: 1, level: 1 };

window.addEventListener('mousemove', function (e) {
  altKey = e.altKey;
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left, my = e.clientY - rect.top;
  if (panning && panStart) {
    camera.originX = panStart.ox + (e.clientX - panStart.x);
    camera.originY = panStart.oy + (e.clientY - panStart.y);
    markDirty();
    return;
  }
  const t = pickTile(mx, my);
  if (t.col !== hover.col || t.row !== hover.row) {
    hover = t;
    markDirty();
    document.getElementById('statusCoords').textContent = inBounds(t.col, t.row)
      ? 'Tile (' + t.col + ', ' + t.row + ')  h=' + map.cells[t.row][t.col].height
      : '—';
  }
  if (painting) applyTool(t.col, t.row, true);
});

window.addEventListener('mouseup', function () {
  if (dragFrom && inBounds(hover.col, hover.row)) {
    pushHistory();
    applySpan(spanCells(dragFrom, hover, drawMode));
  }
  dragFrom = null;
  painting = false;
  panning = false;
  panStart = null;
  markDirty();
});
canvas.addEventListener('mouseleave', function () { hover = { col: -1, row: -1 }; markDirty(); });

canvas.addEventListener('wheel', function (e) {
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left, my = e.clientY - rect.top;
  const old = camera.zoom;
  const next = clamp(old * (e.deltaY < 0 ? 1.12 : 1 / 1.12), MIN_ZOOM, MAX_ZOOM);
  camera.originX = mx - (mx - camera.originX) * (next / old);
  camera.originY = my - (my - camera.originY) * (next / old);
  camera.zoom = next;
  updateZoom();
  markDirty();
}, { passive: false });

function setZoom(z, cx, cy) {
  const old = camera.zoom;
  const next = clamp(z, MIN_ZOOM, MAX_ZOOM);
  const px = cx === undefined ? wrap.clientWidth / 2 : cx;
  const py = cy === undefined ? wrap.clientHeight / 2 : cy;
  camera.originX = px - (px - camera.originX) * (next / old);
  camera.originY = py - (py - camera.originY) * (next / old);
  camera.zoom = next;
  updateZoom();
  markDirty();
}

function updateZoom() { document.getElementById('zoomLabel').textContent = Math.round(camera.zoom * 100) + '%'; }
function updateBrush() { document.getElementById('brushLabel').textContent = brush; }
function updateRot() { document.getElementById('rotLabel').textContent = rot ? '90°' : '0°'; }

/* Line/rect/fill only apply to tools that can act on a span. */
function syncModeButtons() {
  const usable = !!SPANNABLE[tool.kind];
  for (const b of document.querySelectorAll('[data-mode]')) {
    const mode = b.dataset.mode;
    const ok = mode === 'free' || (usable && (mode !== 'fill' || tool.kind === 'terrain'));
    b.disabled = !ok;
    b.classList.toggle('on', drawMode === mode && ok);
  }
  if (!usable && drawMode !== 'free') setDrawMode('free');
}

function setDrawMode(mode) {
  drawMode = mode;
  dragFrom = null;
  syncModeButtons();
  markDirty();
}

function setSeason(s) {
  season = s;
  I.setSeason(s);
  T.setSeason(s);
  buildPalette();
  markDirty();
}

window.addEventListener('keydown', function (e) {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') {
    if (e.key === 'Escape') e.target.blur();
    return;
  }
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); undo(); return; }
  if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); redo(); return; }
  if (k === '/') { e.preventDefault(); document.getElementById('paletteSearch').focus(); return; }
  if (e.key === 'Escape') { dragFrom = null; markDirty(); return; }

  // Arrow keys pan; Shift pans a whole tile at a time.
  const PAN_ARROWS = { ArrowLeft: [1, 0], ArrowRight: [-1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };
  if (PAN_ARROWS[e.key]) {
    e.preventDefault();
    const m = metrics(camera);
    const mul = e.shiftKey ? 2 : 0.75;
    panBy(PAN_ARROWS[e.key][0] * m.hw * mul, PAN_ARROWS[e.key][1] * m.hh * mul);
    return;
  }

  // Ground sculpting sits on q/w/v: adjacent keys, one hand, no chording.
  if (k === 'q') selectByTool({ kind: 'lower' });
  else if (k === 'w') selectByTool({ kind: 'raise' });
  else if (k === 'v') selectByTool({ kind: 'level' });
  else if (k === 'd') selectByTool({ kind: 'erase' });
  else if (k === 'n') selectByTool({ kind: 'label' });
  else if (k === 'm') selectByTool({ kind: 'extend' });
  else if (k === 'h') selectByTool({ kind: 'pan' });
  else if (k === 'e') selectByTool({ kind: 'pick' });
  else if (k === 'f') setDrawMode('free');
  else if (k === 'l') setDrawMode('line');
  else if (k === 'b') setDrawMode('rect');
  else if (k === 'x') setDrawMode('fill');
  else if (e.key === ',' || e.key === '<') (e.shiftKey ? stepCategory : stepPalette)(-1);
  else if (e.key === '.' || e.key === '>') (e.shiftKey ? stepCategory : stepPalette)(1);
  else if (k === 'r') { rot = rot ? 0 : 1; updateRot(); if (tool.kind === 'object') { const f = I.footprint(tool.id, rot); footEl.textContent = 'Footprint: ' + f.fw + 'x' + f.fh; } markDirty(); }
  else if (k === 'g') { showGrid = !showGrid; document.getElementById('chkGrid').checked = showGrid; markDirty(); }
  else if (k === 'c') centreOnMap();
  else if (e.key === '0') setZoom(1);
  else if (e.key === '[') { brush = clamp(brush - 1, 1, 4); updateBrush(); markDirty(); }
  else if (e.key === ']') { brush = clamp(brush + 1, 1, 4); updateBrush(); markDirty(); }
  else if (e.key === '+' || e.key === '=') setZoom(camera.zoom * 1.2);
  else if (e.key === '-') setZoom(camera.zoom / 1.2);
  else if (e.key === 'Delete' || e.key === 'Backspace') {
    if (inBounds(hover.col, hover.row) && objAt(hover.col, hover.row)) {
      pushHistory();
      eraseAt(hover.col, hover.row);
    }
  }
});

/* =====================================================================
   HEADER
   ===================================================================== */
document.getElementById('btnZoomIn').addEventListener('click', function () { setZoom(camera.zoom * 1.2); });
document.getElementById('btnZoomOut').addEventListener('click', function () { setZoom(camera.zoom / 1.2); });
document.getElementById('chkGrid').addEventListener('change', function (e) { showGrid = e.target.checked; markDirty(); });
document.getElementById('btnUndo').addEventListener('click', undo);
document.getElementById('btnRedo').addEventListener('click', redo);
document.getElementById('btnRotate').addEventListener('click', function () {
  rot = rot ? 0 : 1;
  updateRot();
  if (tool.kind === 'object') {
    const f = I.footprint(tool.id, rot);
    footEl.textContent = 'Footprint: ' + f.fw + 'x' + f.fh;
  }
  markDirty();
});
document.getElementById('btnBrushDown').addEventListener('click', function () { brush = clamp(brush - 1, 1, 4); updateBrush(); markDirty(); });
document.getElementById('btnBrushUp').addEventListener('click', function () { brush = clamp(brush + 1, 1, 4); updateBrush(); markDirty(); });
document.getElementById('mapName').addEventListener('change', function (e) { map.name = e.target.value || 'New Town'; });

for (const b of document.querySelectorAll('[data-mode]')) {
  b.addEventListener('click', function () { setDrawMode(b.dataset.mode); });
}
document.getElementById('seasonSelect').addEventListener('change', function (e) {
  setSeason(e.target.value);
  map.season = e.target.value;
});
document.getElementById('paletteSearch').addEventListener('input', function (e) { filterPalette(e.target.value); });
document.getElementById('btnClearSearch').addEventListener('click', function () {
  const s = document.getElementById('paletteSearch');
  s.value = '';
  filterPalette('');
  s.focus();
});

function centerCamera() {
  camera.originX = wrap.clientWidth / 2;
  camera.originY = Math.max(90, wrap.clientHeight * 0.18);
}

function syncFields() {
  document.getElementById('mapName').value = map.name;
  document.getElementById('mapWidth').value = map.width;
  document.getElementById('mapHeight').value = map.height;
  document.getElementById('statusSize').textContent = map.width + ' x ' + map.height;
}

/* =====================================================================
   EXTENDING THE MAP
   ===================================================================== */
const EXTEND_STEP = 4;
const MAX_DIM = 200;

// New ground copies the edge it grows from, so hills and rivers run on.
function cloneEdgeCell(src) {
  return { terrain: src.terrain, tv: randInt(4), height: src.height, label: null };
}

/* Pans the least distance that puts at least one of `tiles` on screen, and
   nothing at all if one already is.

   Deliberately not a bounding-box test: an edge strip runs diagonally, so its
   box can straddle the viewport while every tile in it sits outside. Nor does
   it try to frame the whole set — a strip is longer than the viewport anyway,
   and centring it would undo the pinning that keeps the extend handle under
   the pointer. */
function revealTiles(tiles) {
  if (!tiles.length) return;
  const m = metrics(camera);
  const pad = 48;
  const maxX = wrap.clientWidth - pad, maxY = wrap.clientHeight - pad;
  let best = null;
  for (const t of tiles) {
    const p = tileXY(t.col, t.row, heightAt(t.col, t.row), camera, m);
    const dx = p.x < pad ? pad - p.x : p.x > maxX ? maxX - p.x : 0;
    const dy = p.y < pad ? pad - p.y : p.y > maxY ? maxY - p.y : 0;
    if (!dx && !dy) return;
    const cost = dx * dx + dy * dy;
    if (!best || cost < best.cost) best = { dx: dx, dy: dy, cost: cost };
  }
  panBy(best.dx, best.dy);
}

let hintTimer = null;
function flashHint(msg) {
  hintEl.textContent = msg;
  if (hintTimer) clearTimeout(hintTimer);
  hintTimer = setTimeout(function () { hintEl.textContent = HINTS[tool.kind] || ''; }, 2400);
}

function extendMap(side, amount) {
  const n = amount || EXTEND_STEP;
  const growsWidth = side === 'E' || side === 'W';
  if (growsWidth ? map.width + n > MAX_DIM : map.height + n > MAX_DIM) {
    flashHint('Map is at its maximum size (' + MAX_DIM + ' tiles).');
    return false;
  }
  pushHistory();

  const wasW = map.width, wasH = map.height;
  const m = metrics(camera);
  /* Where the handle sits now. It has to still be there afterwards: the button
     is 42px and growing an edge moves its anchor by n tiles, so without this
     the arrow slides out from under the pointer and the next click lands on
     bare canvas — which reads as "the button does nothing". */
  const held = edgeHandlePositions(camera, m)[side];
  if (side === 'E') {
    for (let r = 0; r < map.height; r++) {
      const src = map.cells[r][map.width - 1];
      for (let k = 0; k < n; k++) map.cells[r].push(cloneEdgeCell(src));
    }
    map.width += n;
  } else if (side === 'W') {
    for (let r = 0; r < map.height; r++) {
      const src = map.cells[r][0];
      for (let k = 0; k < n; k++) map.cells[r].unshift(cloneEdgeCell(src));
    }
    map.width += n;
    for (const o of map.objects) o.col += n;
  } else if (side === 'S') {
    const src = map.cells[map.height - 1];
    for (let k = 0; k < n; k++) map.cells.push(src.map(cloneEdgeCell));
    map.height += n;
  } else if (side === 'N') {
    const src = map.cells[0];
    for (let k = 0; k < n; k++) map.cells.unshift(src.map(cloneEdgeCell));
    map.height += n;
    for (const o of map.objects) o.row += n;
  } else {
    return false;
  }

  reindex();
  /* Pin the grown edge where it was. Existing ground slides away from the
     handle instead, which also means the new strip appears in the space the
     old edge occupied and is therefore already on screen. */
  const now = edgeHandlePositions(camera, m)[side];
  camera.originX += held.x - now.x;
  camera.originY += held.y - now.y;

  syncFields();
  refreshLegend();

  /* Belt and braces: the strip should already be visible thanks to the pinned
     edge, but at high zoom or after an odd camera state it may not be. */
  const fresh = [];
  if (side === 'E') for (let r = 0; r < map.height; r++) for (let c = wasW; c < map.width; c++) fresh.push({ col: c, row: r });
  else if (side === 'W') for (let r = 0; r < map.height; r++) for (let c = 0; c < n; c++) fresh.push({ col: c, row: r });
  else if (side === 'S') for (let r = wasH; r < map.height; r++) for (let c = 0; c < map.width; c++) fresh.push({ col: c, row: r });
  else for (let r = 0; r < n; r++) for (let c = 0; c < map.width; c++) fresh.push({ col: c, row: r });
  revealTiles(fresh);

  flashHint('Added ' + n + ' tiles along the ' + EXTEND_META[side].name + ' — now ' + map.width + ' × ' + map.height + '.');
  markDirty();
  return true;
}

/* The four map edges as they actually appear on screen. Row 0 is NOT the top
   edge in an isometric view: it runs up-and-right. Each entry carries the
   screen-outward direction so the handle sits off that edge and its arrow
   points the way the map will grow. */
/* Leaving the map across row 0 means decreasing row, which projects up-and-
   right; across col 0 it is decreasing col, which projects up-and-left. */
const EXTEND_META = {
  N: { glyph: '◥', name: 'top-right edge', ox: 1, oy: -1 },   // prepends rows
  S: { glyph: '◣', name: 'bottom-left edge', ox: -1, oy: 1 }, // appends rows
  W: { glyph: '◤', name: 'top-left edge', ox: -1, oy: -1 },   // prepends cols
  E: { glyph: '◢', name: 'bottom-right edge', ox: 1, oy: 1 }, // appends cols
};

/* Tiles along the edge a given side grows from. */
function edgeTiles(side) {
  const out = [];
  if (side === 'N') for (let c = 0; c < map.width; c++) out.push({ col: c, row: 0 });
  else if (side === 'S') for (let c = 0; c < map.width; c++) out.push({ col: c, row: map.height - 1 });
  else if (side === 'W') for (let r = 0; r < map.height; r++) out.push({ col: 0, row: r });
  else for (let r = 0; r < map.height; r++) out.push({ col: map.width - 1, row: r });
  return out;
}

function edgeHandlePositions(cam, m) {
  const midC = (map.width - 1) / 2, midR = (map.height - 1) / 2;
  const rc = Math.round(midC), rr = Math.round(midR);
  const anchor = {
    N: tileXY(midC, 0, heightAt(rc, 0), cam, m),
    S: tileXY(midC, map.height - 1, heightAt(rc, map.height - 1), cam, m),
    W: tileXY(0, midR, heightAt(0, rr), cam, m),
    E: tileXY(map.width - 1, midR, heightAt(map.width - 1, rr), cam, m),
  };
  const off = 1.7;
  const out = {};
  for (const side of ['N', 'S', 'W', 'E']) {
    const meta = EXTEND_META[side];
    out[side] = {
      x: anchor[side].x + meta.ox * off * m.hw,
      y: anchor[side].y + meta.oy * off * m.hh,
    };
  }
  return out;
}

const extendLayer = document.getElementById('extendHandles');
let extendHover = null;

/* Where the handles actually get drawn. canvasWrap clips its children, so one
   parked outside would be both invisible and unclickable; a pinned handle is
   held against the viewport edge and marked with a dashed border. */
function handleSlots(cam, m) {
  const raw = edgeHandlePositions(cam, m);
  const pad = 26;
  const maxX = Math.max(pad, wrap.clientWidth - pad);
  const maxY = Math.max(pad, wrap.clientHeight - pad);
  const out = {};
  for (const side of ['N', 'S', 'W', 'E']) {
    const x = clamp(raw[side].x, pad, maxX), y = clamp(raw[side].y, pad, maxY);
    out[side] = { x: x, y: y, pinned: x !== raw[side].x || y !== raw[side].y };
  }
  return out;
}

function syncExtendHandles() {
  const active = tool.kind === 'extend';
  extendLayer.classList.toggle('hidden', !active);
  if (!active) {
    if (extendHover) { extendHover = null; markDirty(); }
    return;
  }
  const slot = handleSlots(camera, metrics(camera));
  for (const side of ['N', 'S', 'W', 'E']) {
    let btn = extendLayer.querySelector('[data-side="' + side + '"]');
    if (!btn) {
      btn = document.createElement('button');
      btn.className = 'extend-handle';
      btn.dataset.side = side;
      btn.textContent = EXTEND_META[side].glyph;
      btn.title = 'Add ' + EXTEND_STEP + ' tiles along the ' + EXTEND_META[side].name;
      btn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        extendMap(side, EXTEND_STEP);
        syncExtendHandles();
      });
      btn.addEventListener('mouseenter', function () { extendHover = side; markDirty(); });
      btn.addEventListener('mouseleave', function () { extendHover = null; markDirty(); });
      extendLayer.appendChild(btn);
    }
    btn.style.left = Math.round(slot[side].x) + 'px';
    btn.style.top = Math.round(slot[side].y) + 'px';
    btn.classList.toggle('off-edge', slot[side].pinned);
  }
}

/* Highlights the strip that a hovered handle will duplicate. */
function drawExtendPreview(fctx, cam, m) {
  if (!extendHover) return;
  fctx.lineWidth = Math.max(1, 1.5 * cam.zoom);
  fctx.strokeStyle = '#2de1c2';
  fctx.fillStyle = 'rgba(45,225,194,0.22)';
  for (const t of edgeTiles(extendHover)) {
    diamondPath(fctx, tileXY(t.col, t.row, map.cells[t.row][t.col].height, cam, m), m);
    fctx.fill();
    fctx.stroke();
  }
}

document.getElementById('btnNew').addEventListener('click', function () {
  if (!window.confirm('Start a new map? This clears the current one.')) return;
  const name = document.getElementById('mapName').value || 'New Town';
  const w = clamp(parseInt(document.getElementById('mapWidth').value, 10) || 24, 4, 80);
  const h = clamp(parseInt(document.getElementById('mapHeight').value, 10) || 18, 4, 80);
  pushHistory();
  map = createMap(name, w, h);
  reindex();
  camera.zoom = 1;
  centerCamera();
  updateZoom(); syncFields(); refreshLegend(); markDirty();
});

document.getElementById('btnResize').addEventListener('click', function () {
  const w = clamp(parseInt(document.getElementById('mapWidth').value, 10) || map.width, 4, 80);
  const h = clamp(parseInt(document.getElementById('mapHeight').value, 10) || map.height, 4, 80);
  pushHistory();
  const cells = [];
  for (let r = 0; r < h; r++) {
    const row = [];
    for (let c = 0; c < w; c++) row.push(r < map.height && c < map.width ? map.cells[r][c] : makeCell());
    cells.push(row);
  }
  map.width = w; map.height = h; map.cells = cells;
  // Drop anything whose footprint no longer fits.
  map.objects = map.objects.filter(function (o) {
    const f = I.footprint(o.id, o.rot);
    return o.col + f.fw <= w && o.row + f.fh <= h;
  });
  reindex(); syncFields(); refreshLegend(); markDirty();
});

/* =====================================================================
   SAVE / LOAD / EXPORT
   ===================================================================== */
function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
function safeName() { return (map.name || 'town').replace(/[^a-z0-9\-_]+/gi, '_'); }

document.getElementById('btnSave').addEventListener('click', function () {
  map.version = 2;
  download(new Blob([JSON.stringify(map, null, 2)], { type: 'application/json' }), safeName() + '.json');
});

const fileInput = document.getElementById('fileInput');
document.getElementById('btnLoad').addEventListener('click', function () { fileInput.click(); });
fileInput.addEventListener('change', function () {
  const file = fileInput.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function () {
    try {
      const data = JSON.parse(reader.result);
      if (!data || typeof data.width !== 'number' || typeof data.height !== 'number' || !Array.isArray(data.cells)) {
        throw new Error('Not a recognised map file.');
      }
      pushHistory();
      map = migrate(data);
      // Objects referencing sprites this build no longer has would crash rendering.
      map.objects = map.objects.filter(function (o) { return !!I.OBJECT_DEFS[o.id]; });
      // Terrains too: an unknown id would fail the sprite lookup on first draw.
      for (const row of map.cells) {
        for (const cell of row) if (!T.DEFS[cell.terrain]) cell.terrain = 'grass';
      }
      const s = SEASONS.indexOf(map.season) >= 0 ? map.season : 'summer';
      document.getElementById('seasonSelect').value = s;
      setSeason(s);
      reindex();
      camera.zoom = 1;
      centerCamera();
      updateZoom(); syncFields(); refreshLegend(); markDirty();
    } catch (err) {
      window.alert('Could not load that file: ' + err.message);
    }
  };
  reader.readAsText(file);
  fileInput.value = '';
});

const exportModal = document.getElementById('exportOptions');
document.getElementById('btnExport').addEventListener('click', function () { exportModal.classList.remove('hidden'); });
document.getElementById('exCancel').addEventListener('click', function () { exportModal.classList.add('hidden'); });
document.getElementById('exConfirm').addEventListener('click', function () {
  exportModal.classList.add('hidden');
  exportPng({
    grid: document.getElementById('exGrid').checked,
    labels: document.getElementById('exLabels').checked,
    transparent: document.getElementById('exTransparent').checked,
    scale: parseInt(document.getElementById('exScale').value, 10) || 1,
  });
});

/* Canvas bounds for an export, kept separate so the arithmetic is testable. */
function exportSize(scale) {
  const cam = { originX: 0, originY: 0, zoom: scale };
  const m = metrics(cam);
  let maxH = 0, minH = 0;
  for (let r = 0; r < map.height; r++) for (let c = 0; c < map.width; c++) {
    const h = map.cells[r][c].height;
    if (h > maxH) maxH = h;
    if (h < minH) minH = h;
  }
  // Ask each sprite its real height: a def's zmax may be a function of context
  // (a tunnel sizes itself to its cliff), so it cannot be read directly.
  let tallest = 0;
  for (const o of map.objects) tallest = Math.max(tallest, spriteFor(o).h);

  const pad = 24 * scale;
  const headroom = (maxH * I.ALEVEL + tallest) * m.s + 40 * scale;
  const underfoot = -minH * I.ALEVEL * m.s;
  cam.originX = pad + map.height * m.hw;
  cam.originY = headroom;
  return {
    cam: cam,
    width: (map.width + map.height) * m.hw + pad * 2,
    height: (map.width + map.height) * m.hh + headroom + underfoot + pad,
  };
}

function exportPng(opts) {
  const size = exportSize(opts.scale);
  const cam = size.cam;
  const width = size.width, height = size.height;

  const off = document.createElement('canvas');
  off.width = Math.ceil(width);
  off.height = Math.ceil(height);
  const octx = off.getContext('2d');
  octx.imageSmoothingEnabled = false;
  if (!opts.transparent) {
    octx.fillStyle = '#100b1c';
    octx.fillRect(0, 0, off.width, off.height);
  }
  renderFrame(octx, cam, { grid: opts.grid, labels: opts.labels, hover: false });
  off.toBlob(function (blob) { download(blob, safeName() + '.png'); }, 'image/png');
}

/* =====================================================================
   INIT
   ===================================================================== */
window.addEventListener('resize', markDirty);
reindex();
buildPalette();
syncModeButtons();
centerCamera();
updateZoom();
updateBrush();
updateRot();
syncFields();
refreshLegend();
requestAnimationFrame(loop);
