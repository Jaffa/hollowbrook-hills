// Runs the real app.js under a DOM stub and exercises elevation / multi-tile logic.
const fs = require('fs');
const path = require('path').join(__dirname, '..') + '/';

class FakeImageData {
  constructor(d, w, h) { this.data = d; this.width = w; this.height = h; }
}
global.ImageData = FakeImageData;

function stubCtx(owner) {
  const noop = () => {};
  const target = {
    measureText: (t) => ({ width: t.length * 6 }),
    putImageData(img) { if (owner) owner._img = img; },
    canvas: owner || null,
  };
  return new Proxy(target, {
    get(t, k) { return k in t ? t[k] : noop; },
    set(t, k, v) { t[k] = v; return true; },
  });
}
class FakeCanvas {
  constructor() { this.width = 0; this.height = 0; this._img = null; this._c = stubCtx(this); }
  getContext() { return this._c; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 900, height: 600 }; }
  addEventListener() {}
  toBlob(cb) { cb({}); }
  appendChild() {}
}

const els = {};
function el(id) {
  if (els[id]) return els[id];
  const e = {
    id, value: '', textContent: '', checked: true, innerHTML: '',
    files: [], style: {}, dataset: {},
    classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
    querySelector: () => null,
    addEventListener(ev, fn) { (this._h = this._h || {})[ev] = fn; },
    appendChild() {}, remove() {},
    click() { if (this._h && this._h.click) this._h.click(); },
    querySelectorAll: () => [], closest: () => null, scrollIntoView() {}, focus() {}, blur() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 900, height: 600 }),
  };
  if (id === 'mapCanvas') {
    const cv = new FakeCanvas();
    cv.addEventListener = e.addEventListener.bind(cv);
    cv.classList = e.classList;
    cv.id = id;
    els[id] = cv;
    return cv;
  }
  if (id === 'canvasWrap') { e.clientWidth = 900; e.clientHeight = 600; }
  if (id === 'mapWidth') e.value = '24';
  if (id === 'mapHeight') e.value = '18';
  if (id === 'exScale') e.value = '2';
  els[id] = e;
  return e;
}

global.document = {
  getElementById: el,
  createElement: (t) => (t === 'canvas' ? new FakeCanvas() : el('made_' + Math.random())),
  querySelectorAll: () => [],
  body: { appendChild() {} },
};
global.window = global;
global.addEventListener = () => {};
global.requestAnimationFrame = () => 0;
global.devicePixelRatio = 1;
global.URL = { createObjectURL: () => 'blob:', revokeObjectURL() {} };
global.Blob = class { constructor(p) { this.parts = p; } };
global.FileReader = class { readAsText() {} };
global.alert = () => {};
global.confirm = () => true;
global.prompt = () => 'Test Name';

require(path + 'iso.js');
require(path + 'terrain.js');

const src = fs.readFileSync(path + 'app.js', 'utf8') + `
;module.exports = {
  get map(){return map}, get occ(){return occ}, get camera(){return camera},
  set toolV(t){tool=t}, get toolV(){return tool},
  set brushV(b){brush=b}, set rotV(r){rot=r}, get rotV(){return rot},
  pickTile, tileXY, metrics, applyTool, placeObject, adjustHeight, eraseAt,
  canPlace, brushCells, migrate, createMap, reindex, renderFrame, levelTo,
  labelEntries, roadMask, heightAt, setMap(m){map=m; reindex();},
  spanCells, fillCells, applySpan, paintTerrain, eyedrop, setSeason,
  extendMap, tunnelOpts, heightAt, drawWorld, exportSize,
  edgeHandlePositions, edgeTiles, EXTEND_META, handleSlots,
  bridgeOpts, rampOpts, surfaceZ,
  stepPalette, stepCategory, centreOnMap, panBy, selectByTool, PALETTE_FLAT: paletteFlat,
  revealTiles,
  get drawModeV(){return drawMode}, set drawModeV(v){drawMode=v},
  get seasonV(){return season},
  SEASONS, PALETTE_FOR_TEST: PALETTE,
};`;
const mod = { exports: {} };
new Function('module', 'exports', 'window', 'document', 'requestAnimationFrame', src)(
  mod, mod.exports, global, global.document, global.requestAnimationFrame);
const A = mod.exports;
const PALETTE_FOR_TEST = A.PALETTE_FOR_TEST;

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')); }
}

console.log('--- projection round-trip (flat) ---');
{
  let bad = 0, first = null;
  const m = A.metrics(A.camera);
  for (let r = 0; r < A.map.height; r++) {
    for (let c = 0; c < A.map.width; c++) {
      const p = A.tileXY(c, r, 0, A.camera, m);
      const t = A.pickTile(p.x, p.y);
      if (t.col !== c || t.row !== r) { bad++; if (!first) first = `(${c},${r}) -> (${t.col},${t.row})`; }
    }
  }
  ok('every tile centre picks itself', bad === 0, `${bad} mismatches, first ${first}`);
}

console.log('--- projection round-trip (varied heights) ---');
{
  for (let r = 0; r < A.map.height; r++) {
    for (let c = 0; c < A.map.width; c++) {
      A.map.cells[r][c].height = (c * 7 + r * 13) % 6;
    }
  }
  // With relief, a back tile can be legitimately hidden behind a raised front
  // tile, so a centre need not pick itself. What must hold is that picking agrees
  // with paint order: never return a tile that renders BEHIND the clicked one.
  const m = A.metrics(A.camera);
  let behind = 0, firstBehind = null, misses = 0, self = 0;
  for (let r = 0; r < A.map.height; r++) {
    for (let c = 0; c < A.map.width; c++) {
      const h = A.map.cells[r][c].height;
      const p = A.tileXY(c, r, h, A.camera, m);
      const t = A.pickTile(p.x, p.y);
      if (t.col < 0) { misses++; continue; }
      if (t.col === c && t.row === r) { self++; continue; }
      if (t.col + t.row < c + r) {
        behind++;
        if (!firstBehind) firstBehind = `(${c},${r}) h=${h} -> (${t.col},${t.row})`;
      }
    }
  }
  ok('never picks a tile behind the clicked one', behind === 0, `${behind} bad, first ${firstBehind}`);
  ok('never misses entirely', misses === 0, `${misses} misses`);

  // The topmost tile at a point must be the max-depth tile covering it.
  let disagree = 0, firstDis = null;
  for (let i = 0; i < 400; i++) {
    const mx = -300 + (i * 37) % 700, my = -150 + (i * 53) % 400;
    const t = A.pickTile(mx, my);
    let best = null;
    for (let r = 0; r < A.map.height; r++) {
      for (let c = 0; c < A.map.width; c++) {
        const p = A.tileXY(c, r, A.map.cells[r][c].height, A.camera, m);
        const dx = Math.abs(mx - p.x) / m.hw, dy = Math.abs(my - p.y) / m.hh;
        if (dx + dy <= 1 && (!best || c + r >= best.col + best.row)) best = { col: c, row: r };
      }
    }
    if (best && (t.col + t.row) < (best.col + best.row)) {
      disagree++;
      if (!firstDis) firstDis = `(${mx},${my}) picked (${t.col},${t.row}) but (${best.col},${best.row}) is in front`;
    }
  }
  ok('resolves to the front-most covering tile', disagree === 0, `${disagree} bad, first ${firstDis}`);
  console.log(`       (${self}/432 centres self-picked; rest legitimately occluded by relief)`);
}

console.log('--- elevation clamping ---');
{
  A.setMap(A.createMap('t', 8, 8));
  A.brushV = 1;
  for (let i = 0; i < 40; i++) A.adjustHeight(3, 3, 1);
  ok('raise clamps at MAX_LEVEL', A.map.cells[3][3].height === window.Iso.MAX_LEVEL,
    'got ' + A.map.cells[3][3].height);
  for (let i = 0; i < 40; i++) A.adjustHeight(3, 3, -1);
  ok('lower clamps at MIN_LEVEL (ground digs below datum)',
    A.map.cells[3][3].height === -window.Iso.MAX_LEVEL, 'got ' + A.map.cells[3][3].height);
  ok('datum is reachable again from below', (function () {
    for (let i = 0; i < 12; i++) A.adjustHeight(3, 3, 1);
    return A.map.cells[3][3].height === 0;
  })(), 'got ' + A.map.cells[3][3].height);
}

console.log('--- digging below datum ---');
{
  A.setMap(A.createMap('t', 6, 6));
  A.map.cells[2][2].height = -3;
  let threw = null;
  try {
    A.renderFrame(stubCtx(), { originX: 100, originY: 100, zoom: 1 }, { grid: true, labels: false, hover: false });
  } catch (e) { threw = e; }
  ok('renders a pit without throwing', !threw, threw && threw.message);
  // the pit's neighbours are uphill, so they own the walls down into it
  ok('surrounding tiles are higher than the pit', A.heightAt(1, 2) > A.map.cells[2][2].height);
  const m = A.metrics(A.camera);
  const p = A.tileXY(2, 2, -3, A.camera, m);
  const t = A.pickTile(p.x, p.y);
  ok('a dug tile is still pickable', t.col >= 0, JSON.stringify(t));
}

console.log('--- extend map ---');
{
  A.setMap(A.createMap('t', 8, 6));
  A.map.cells[0][0].terrain = 'sand';
  A.map.cells[0][0].height = 5;
  A.rotV = 0;
  A.toolV = { kind: 'object', id: 'house' };
  A.placeObject(3, 3);
  const before = { w: A.map.width, h: A.map.height, obj: { c: A.map.objects[0].col, r: A.map.objects[0].row } };

  ok('extend east grows width', A.extendMap('E', 4) && A.map.width === before.w + 4, 'w=' + A.map.width);
  ok('east leaves object coords alone', A.map.objects[0].col === before.obj.c);

  ok('extend south grows height', A.extendMap('S', 4) && A.map.height === before.h + 4, 'h=' + A.map.height);
  ok('south leaves object coords alone', A.map.objects[0].row === before.obj.r);

  ok('extend west grows width', A.extendMap('W', 4) && A.map.width === before.w + 8, 'w=' + A.map.width);
  ok('west shifts objects to keep them in place', A.map.objects[0].col === before.obj.c + 4,
    'col=' + A.map.objects[0].col);

  ok('extend north grows height', A.extendMap('N', 4) && A.map.height === before.h + 8, 'h=' + A.map.height);
  ok('north shifts objects', A.map.objects[0].row === before.obj.r + 4, 'row=' + A.map.objects[0].row);

  // every row must stay the declared width or rendering walks off the array
  ok('all rows match map width', A.map.cells.every(row => row.length === A.map.width));
  ok('row count matches map height', A.map.cells.length === A.map.height);

  // new ground inherits the edge it grew from
  ok('new western ground copied the old edge', A.map.cells[4][0].terrain === 'sand' && A.map.cells[4][0].height === 5,
    A.map.cells[4][0].terrain + '/' + A.map.cells[4][0].height);

  ok('occupancy still resolves the moved building',
    A.occ[before.obj.r + 4][before.obj.c + 4] === 0);
  let threw = null;
  try {
    A.renderFrame(stubCtx(), { originX: 0, originY: 0, zoom: 1 }, { grid: true, labels: true, hover: false });
  } catch (e) { threw = e; }
  ok('renders after extending', !threw, threw && threw.message);
}

console.log('--- tunnels bind to the cliff beside them ---');
{
  A.setMap(A.createMap('t', 8, 8));
  const m = A.map;
  // cliff rising to the -col side, tunnel at its foot
  for (let r = 0; r < 8; r++) for (let c = 0; c <= 2; c++) m.cells[r][c].height = 4;
  A.rotV = 0;
  A.toolV = { kind: 'object', id: 'tunnel', variant: 'stone' };
  A.placeObject(3, 4);
  const o = m.objects[0];
  const opts = A.tunnelOpts(o);
  ok('detects the -col cliff', opts.side === 'col' && opts.depth === 4, JSON.stringify(opts));

  // and a cliff on the -row side instead
  A.setMap(A.createMap('t', 8, 8));
  const m2 = A.map;
  for (let r = 0; r <= 2; r++) for (let c = 0; c < 8; c++) m2.cells[r][c].height = 3;
  A.toolV = { kind: 'object', id: 'tunnel', variant: 'stone' };
  A.placeObject(4, 3);
  ok('detects the -row cliff', (function () {
    const t = A.tunnelOpts(m2.objects[0]);
    return t.side === 'row' && t.depth === 3;
  })(), JSON.stringify(A.tunnelOpts(m2.objects[0])));

  // flat ground: no cliff to cut into
  A.setMap(A.createMap('t', 8, 8));
  A.toolV = { kind: 'object', id: 'tunnel', variant: 'stone' };
  A.placeObject(4, 4);
  ok('falls back to depth 0 on flat ground', A.tunnelOpts(A.map.objects[0]).depth === 0);

  // the portal must scale with the cliff, not be a fixed sprite
  const shallow = window.Iso.objectSprite('tunnel', 'stone', 0, { depth: 2, side: 'col' });
  const deep = window.Iso.objectSprite('tunnel', 'stone', 0, { depth: 8, side: 'col' });
  ok('portal grows with cliff height', deep.h > shallow.h, shallow.h + ' vs ' + deep.h);
}

console.log('--- multi-tile placement ---');
{
  A.setMap(A.createMap('t', 12, 12));
  A.rotV = 0;
  A.toolV = { kind: 'object', id: 'school' };   // 4x3
  ok('school places', A.placeObject(2, 2) === true);
  const f = window.Iso.footprint('school', 0);
  let covered = 0;
  for (let r = 2; r < 2 + f.fh; r++) for (let c = 2; c < 2 + f.fw; c++) if (A.occ[r][c] === 0) covered++;
  ok('occupies full 4x3 footprint', covered === 12, 'covered ' + covered);
  ok('overlapping placement refused', A.placeObject(3, 3) === false);
  ok('adjacent placement allowed', A.placeObject(6, 2) === true);
  ok('out-of-bounds refused', A.placeObject(10, 10) === false);
}

console.log('--- placement levels its pad ---');
{
  A.setMap(A.createMap('t', 12, 12));
  A.map.cells[2][2].height = 4;
  A.map.cells[2][3].height = 0;
  A.map.cells[3][2].height = 7;
  A.map.cells[3][3].height = 1;
  A.rotV = 0;
  A.toolV = { kind: 'object', id: 'house' };    // 2x2
  A.placeObject(2, 2);
  const hs = [A.map.cells[2][2].height, A.map.cells[2][3].height, A.map.cells[3][2].height, A.map.cells[3][3].height];
  ok('footprint flattened to anchor height', hs.every(h => h === 4), 'heights ' + hs.join(','));
}

console.log('--- elevation moves whole building ---');
{
  A.setMap(A.createMap('t', 12, 12));
  A.rotV = 0;
  A.toolV = { kind: 'object', id: 'house' };
  A.placeObject(4, 4);
  A.brushV = 1;
  A.adjustHeight(4, 4, 1);   // click one corner of the 2x2
  const hs = [A.map.cells[4][4].height, A.map.cells[4][5].height, A.map.cells[5][4].height, A.map.cells[5][5].height];
  ok('all 4 pad tiles rose together', hs.every(h => h === 1), 'heights ' + hs.join(','));
}

console.log('--- rotation swaps footprint ---');
{
  A.setMap(A.createMap('t', 12, 12));
  A.rotV = 1;
  A.toolV = { kind: 'object', id: 'school' };   // 4x3 -> 3x4
  A.placeObject(1, 1);
  const f = window.Iso.footprint('school', 1);
  ok('rotated footprint is 3x4', f.fw === 3 && f.fh === 4, `${f.fw}x${f.fh}`);
  let covered = 0;
  for (let r = 1; r < 1 + f.fh; r++) for (let c = 1; c < 1 + f.fw; c++) if (A.occ[r][c] === 0) covered++;
  ok('rotated occupancy correct', covered === 12, 'covered ' + covered);
}

console.log('--- erase ---');
{
  A.setMap(A.createMap('t', 10, 10));
  A.rotV = 0;
  A.toolV = { kind: 'object', id: 'barn' };     // 3x2
  A.placeObject(1, 1);
  ok('erase from a non-anchor tile works', A.eraseAt(3, 2) === true);
  ok('occupancy cleared', A.occ[1][1] === -1 && A.occ[2][3] === -1);
  ok('object list emptied', A.map.objects.length === 0);
}

console.log('--- road autotile mask ---');
{
  A.setMap(A.createMap('t', 6, 6));
  for (const [c, r] of [[2, 2], [3, 2], [2, 3]]) A.map.cells[r][c].terrain = 'road';
  const m = A.roadMask(2, 2);
  ok('mask has +col and +row bits', (m & 1) && (m & 2), 'mask=' + m);
  ok('mask lacks -col and -row bits', !(m & 4) && !(m & 8), 'mask=' + m);
}

console.log('--- v1 migration ---');
{
  const v1 = {
    name: 'Old Town', width: 3, height: 2,
    cells: [
      [{ terrain: 'grass', groundVariant: 1, object: { id: 'house', variant: 'blue' }, label: 'Home' },
       { terrain: 'water', groundVariant: 0, object: null, label: null },
       { terrain: 'road', groundVariant: 2, object: { id: 'shop', variant: 'arcade' }, label: null }],
      [{ terrain: 'dirt', groundVariant: 0, object: { id: 'treeround' }, label: null },
       { terrain: 'grass', groundVariant: 0, object: null, label: null },
       { terrain: 'grass', groundVariant: 0, object: { id: 'cemetery' }, label: null }],
    ],
  };
  const out = A.migrate(JSON.parse(JSON.stringify(v1)));
  ok('version bumped', out.version === 2);
  ok('terrain preserved', out.cells[0][1].terrain === 'water' && out.cells[1][0].terrain === 'dirt');
  ok('heights defaulted to 0', out.cells[0][0].height === 0);
  ok('cell label preserved', out.cells[0][0].label === 'Home');
  ok('4 objects converted', out.objects.length === 4, 'got ' + out.objects.length);
  const shop = out.objects.find(o => o.col === 2 && o.row === 0);
  ok('shop -> store/arcade', shop && shop.id === 'store' && shop.variant === 'arcade',
    shop && shop.id + '/' + shop.variant);
  const tree = out.objects.find(o => o.col === 0 && o.row === 1);
  ok('treeround -> oak', tree && tree.id === 'oak', tree && tree.id);
  ok('all migrated ids exist in roster', out.objects.every(o => !!window.Iso.OBJECT_DEFS[o.id]));
}

console.log('--- render does not throw ---');
{
  A.setMap(A.createMap('Render Test', 14, 10));
  A.rotV = 0;
  for (const id of ['house', 'church', 'watertower', 'silo', 'barn', 'oak', 'car']) {
    A.toolV = { kind: 'object', id, variant: undefined };
    A.placeObject(1 + Math.floor(Math.random() * 3), 1);
  }
  for (let r = 0; r < 10; r++) for (let c = 0; c < 14; c++) {
    A.map.cells[r][c].height = (c + r) % 4;
    A.map.cells[r][c].terrain = ['grass', 'road', 'water', 'cornfield', 'dirt', 'gravel'][(c * 3 + r) % 6];
  }
  A.map.cells[0][0].label = 'Corner';
  let threw = null;
  try {
    A.renderFrame(stubCtx(), { originX: 100, originY: 100, zoom: 1 }, { grid: true, labels: true, hover: false });
  } catch (e) { threw = e; }
  ok('renderFrame on mixed terrain + objects', !threw, threw && threw.stack.split('\n').slice(0, 2).join(' | '));
}


console.log('--- clickability under gentle, realistic relief ---');
{
  A.setMap(A.createMap('Hills', 24, 18));
  // Smooth hill: heights change by at most 1 between neighbours.
  for (let r = 0; r < 18; r++) {
    for (let c = 0; c < 24; c++) {
      const d = Math.hypot(c - 9, r - 7);
      A.map.cells[r][c].height = Math.max(0, Math.round(3 - d / 3));
    }
  }
  const m = A.metrics(A.camera);
  let self = 0, total = 0, behind = 0;
  for (let r = 0; r < 18; r++) {
    for (let c = 0; c < 24; c++) {
      total++;
      const p = A.tileXY(c, r, A.map.cells[r][c].height, A.camera, m);
      const t = A.pickTile(p.x, p.y);
      if (t.col === c && t.row === r) self++;
      if (t.col >= 0 && t.col + t.row < c + r) behind++;
    }
  }
  const pct = (self / total * 100).toFixed(0);
  console.log(`       ${self}/${total} (${pct}%) tile centres directly clickable on a smooth hill`);
  ok('gentle relief keeps most tiles clickable', self / total > 0.85, pct + '%');
  ok('no behind-picks on gentle relief', behind === 0, behind + ' bad');
}

console.log('--- line/rect spans ---');
{
  A.setMap(A.createMap('t', 10, 10));
  const line = A.spanCells({col:2,row:3},{col:7,row:4},'line');
  ok('line snaps to the dominant axis', line.length === 6 && line.every(t => t.row === 3),
    JSON.stringify(line));
  const back = A.spanCells({col:7,row:3},{col:2,row:3},'line');
  ok('line works right-to-left', back.length === 6);
  const vert = A.spanCells({col:4,row:1},{col:5,row:8},'line');
  ok('line snaps to rows when taller', vert.length === 8 && vert.every(t => t.col === 4));
  const rect = A.spanCells({col:2,row:2},{col:4,row:5},'rect');
  ok('rect covers the full block', rect.length === 12, 'got ' + rect.length);
  const clipped = A.spanCells({col:8,row:8},{col:20,row:20},'rect');
  ok('rect clips to bounds', clipped.length === 4, 'got ' + clipped.length);
}

console.log('--- flood fill ---');
{
  A.setMap(A.createMap('t', 8, 8));
  const m = A.map;
  // a wall of road splits the grass into two regions
  for (let r = 0; r < 8; r++) m.cells[r][4].terrain = 'road';
  const region = A.fillCells(0, 0);
  ok('fill stops at the boundary', region.length === 32, 'got ' + region.length);
  ok('fill never crosses to the far side', region.every(t => t.col < 4));
  A.toolV = { kind: 'terrain', id: 'sand' };
  A.applySpan(region);
  ok('fill repaints the region', m.cells[0][0].terrain === 'sand' && m.cells[7][3].terrain === 'sand');
  ok('fill leaves the far side alone', m.cells[0][5].terrain === 'grass');
}

console.log('--- road family connectivity ---');
{
  A.setMap(A.createMap('t', 6, 6));
  const m = A.map;
  m.cells[2][2].terrain = 'road';
  m.cells[2][3].terrain = 'freeway';
  ok('road connects to freeway', (A.roadMask(2, 2) & 1) !== 0, 'mask=' + A.roadMask(2, 2));
  m.cells[3][2].terrain = 'water';
  ok('road does not connect to water', (A.roadMask(2, 2) & 2) === 0);
  m.cells[4][4].terrain = 'water';
  m.cells[4][5].terrain = 'ice';
  ok('water and ice are separate families', (A.roadMask(4, 4) & 1) === 0);
}

console.log('--- eyedropper ---');
{
  A.setMap(A.createMap('t', 8, 8));
  A.map.cells[1][1].terrain = 'snow';
  A.toolV = { kind: 'terrain', id: 'grass' };
  A.eyedrop(1, 1);
  ok('picks terrain under cursor', A.toolV.kind === 'terrain' && A.toolV.id === 'snow',
    JSON.stringify(A.toolV));
  A.rotV = 0;
  A.toolV = { kind: 'object', id: 'church' };
  A.placeObject(3, 3);
  A.toolV = { kind: 'terrain', id: 'grass' };
  A.eyedrop(4, 3);
  ok('picks a building from any footprint tile', A.toolV.kind === 'object' && A.toolV.id === 'church',
    JSON.stringify(A.toolV));
}

console.log('--- seasons ---');
{
  // sample the diamond centre; the sprite corners are transparent
  const centre = (cv) => {
    const d = cv._img.data, w = cv.width;
    const i = ((cv.height / 2 | 0) * w + (w / 2 | 0)) * 4;
    return [d[i], d[i + 1], d[i + 2], d[i + 3]].join(',');
  };
  const grassSummer = centre(window.Terrain.top('grass', 0, 0));
  A.setSeason('winter');
  const grassWinter = centre(window.Terrain.top('grass', 0, 0));
  ok('winter retints the ground', grassSummer !== grassWinter, grassSummer + ' vs ' + grassWinter);
  const oakWinter = window.Iso.objectSprite('oak', 'green', 0);
  A.setSeason('summer');
  const oakSummer = window.Iso.objectSprite('oak', 'green', 0);
  ok('winter changes the oak sprite', oakWinter.canvas._img.data.join(',') !== oakSummer.canvas._img.data.join(','));
  let threw = null;
  for (const s of A.SEASONS) {
    try {
      A.setSeason(s);
      for (const id of Object.keys(window.Iso.OBJECT_DEFS)) {
        const def = window.Iso.OBJECT_DEFS[id];
        const v = def.variants ? Object.keys(def.variants)[0] : undefined;
        window.Iso.objectSprite(id, v, 0);
      }
      for (const t of Object.keys(window.Terrain.DEFS)) window.Terrain.top(t, 0, 5);
    } catch (e) { threw = s + ': ' + e.message; }
  }
  ok('every sprite builds in every season', !threw, threw);
  A.setSeason('summer');
}

console.log('--- new content is reachable from the palette ---');
{
  const inPalette = new Set();
  for (const g of PALETTE_FOR_TEST) for (const it of g.items) {
    if (it.kind === 'object') inPalette.add(it.id);
    if (it.kind === 'terrain') inPalette.add('terrain:' + it.id);
  }
  const missingObjects = Object.keys(window.Iso.OBJECT_DEFS).filter(id => !inPalette.has(id));
  ok('every object type appears in the palette', missingObjects.length === 0, missingObjects.join(', '));
  const missingTerrain = Object.keys(window.Terrain.DEFS).filter(t => !inPalette.has('terrain:' + t));
  ok('every terrain type appears in the palette', missingTerrain.length === 0, missingTerrain.join(', '));
}

console.log('--- export sizing stays finite ---');
{
  A.setMap(A.createMap('t', 10, 8));
  // A tunnel's zmax is a function of its cliff, so reading def.zmax directly
  // yields NaN and silently produced a broken canvas.
  for (let r = 0; r < 8; r++) A.map.cells[r][0].height = 5;
  A.rotV = 0;
  A.toolV = { kind: 'object', id: 'tunnel', variant: 'stone' };
  A.placeObject(1, 3);
  A.toolV = { kind: 'object', id: 'radiotower' };
  A.placeObject(5, 5);
  for (const scale of [1, 2, 3]) {
    const sz = A.exportSize(scale);
    ok('export size finite at ' + scale + 'x',
      Number.isFinite(sz.width) && Number.isFinite(sz.height) && sz.width > 0 && sz.height > 0,
      sz.width + 'x' + sz.height);
  }
  // digging below datum must add room underneath, not clip it
  const flat = A.exportSize(2).height;
  A.map.cells[4][4].height = -6;
  ok('a pit makes the export taller', A.exportSize(2).height > flat,
    flat + ' -> ' + A.exportSize(2).height);
}

console.log('--- terrain in front occludes objects ---');
{
  A.setMap(A.createMap('t', 10, 10));
  const m = A.map;
  // a tall ridge one step in front (greater depth) of a house
  for (let r = 0; r < 10; r++) m.cells[r][5].height = 8;
  A.rotV = 0;
  A.toolV = { kind: 'object', id: 'house', variant: 'red' };
  A.placeObject(3, 3);

  // record the order sprites reach the canvas
  const seq = [];
  const recCtx = new Proxy({
    drawImage(src) { seq.push(src); },
    measureText: (t) => ({ width: t.length * 6 }),
  }, { get(t, k) { return k in t ? t[k] : function () {}; }, set() { return true; } });
  A.drawWorld(recCtx, { originX: 0, originY: 0, zoom: 1 }, A.metrics({ zoom: 1 }), null, false);

  const objSpr = window.Iso.objectSprite('house', 'red', 0).canvas;
  const objAt_ = seq.indexOf(objSpr);
  ok('the building was drawn', objAt_ >= 0);

  // the ridge tiles are deeper than the house, so some terrain must follow it
  const ridgeTop = window.Terrain.top('grass', m.cells[6][5].tv, 0, 8);
  const laterTerrain = seq.slice(objAt_ + 1).some(function (s) { return s === ridgeTop; });
  ok('terrain in front is drawn after the building', laterTerrain);

  // and terrain behind it must come first
  const behind = window.Terrain.top('grass', m.cells[0][0].tv, 0, 0);
  const behindAt = seq.indexOf(behind);
  ok('terrain behind is drawn before the building', behindAt >= 0 && behindAt < objAt_,
    behindAt + ' vs ' + objAt_);
}

console.log('--- extend handles point the way the map grows ---');
{
  // Derived from the projection, not hardcoded: x=(col-row)*hw, y=(col+row)*hh.
  // Leaving across row 0 decreases row -> up-right. Across col 0 -> up-left.
  A.setMap(A.createMap('t', 10, 8));
  const cam = { originX: 0, originY: 0, zoom: 1 };
  const m = A.metrics(cam);
  const centre = A.tileXY((A.map.width - 1) / 2, (A.map.height - 1) / 2, 0, cam, m);
  const pos = A.edgeHandlePositions(cam, m);

  for (const side of ['N', 'S', 'W', 'E']) {
    // Where do the tiles that this side adds actually live?
    const before = { w: A.map.width, h: A.map.height };
    const probe = side === 'N' ? { col: (before.w - 1) / 2, row: -2 }
      : side === 'S' ? { col: (before.w - 1) / 2, row: before.h + 1 }
      : side === 'W' ? { col: -2, row: (before.h - 1) / 2 }
      : { col: before.w + 1, row: (before.h - 1) / 2 };
    const target = A.tileXY(probe.col, probe.row, 0, cam, m);
    const wantX = Math.sign(target.x - centre.x), wantY = Math.sign(target.y - centre.y);
    const gotX = Math.sign(pos[side].x - centre.x), gotY = Math.sign(pos[side].y - centre.y);
    ok('handle ' + side + ' sits toward the new ground', gotX === wantX && gotY === wantY,
      'want (' + wantX + ',' + wantY + ') got (' + gotX + ',' + gotY + ')');
    const meta = A.EXTEND_META[side];
    ok('handle ' + side + ' arrow matches that direction',
      Math.sign(meta.ox) === wantX && Math.sign(meta.oy) === wantY,
      'meta (' + meta.ox + ',' + meta.oy + ')');
  }

  // The highlighted strip must be the one that gets duplicated.
  ok('N highlights row 0', A.edgeTiles('N').every(t => t.row === 0));
  ok('S highlights the last row', A.edgeTiles('S').every(t => t.row === A.map.height - 1));
  ok('W highlights col 0', A.edgeTiles('W').every(t => t.col === 0));
  ok('E highlights the last col', A.edgeTiles('E').every(t => t.col === A.map.width - 1));
}

console.log('--- each side duplicates its own edge ---');
{
  const build = function () {
    A.setMap(A.createMap('t', 6, 5));
    const m = A.map;
    for (let c = 0; c < 6; c++) { m.cells[0][c].terrain = 'snow'; m.cells[4][c].terrain = 'sand'; }
    for (let r = 0; r < 5; r++) { m.cells[r][0].terrain = 'rock'; m.cells[r][5].terrain = 'water'; }
    return m;
  };
  build(); A.extendMap('N', 3);
  ok('N copies row 0 (snow)', A.map.cells[0][3].terrain === 'snow', A.map.cells[0][3].terrain);
  build(); A.extendMap('S', 3);
  ok('S copies the last row (sand)', A.map.cells[A.map.height - 1][3].terrain === 'sand',
    A.map.cells[A.map.height - 1][3].terrain);
  build(); A.extendMap('W', 3);
  ok('W copies col 0 (rock)', A.map.cells[2][0].terrain === 'rock', A.map.cells[2][0].terrain);
  build(); A.extendMap('E', 3);
  ok('E copies the last col (water)', A.map.cells[2][A.map.width - 1].terrain === 'water',
    A.map.cells[2][A.map.width - 1].terrain);
  // and never the opposite edge
  build(); A.extendMap('W', 3);
  ok('W does not pull in the far edge', A.map.cells[2][1].terrain !== 'water');
}

console.log('--- bridge decks level with the bank ---');
{
  const ALEVEL = window.Iso.ALEVEL;
  const river = function (dig) {
    A.setMap(A.createMap('t', 12, 5));
    const m = A.map;
    for (let r = 0; r < 5; r++) for (const c of [5, 6]) {
      m.cells[r][c].terrain = 'water';
      m.cells[r][c].height = -dig;
    }
    for (let c = 0; c < 12; c++) if (c < 5 || c > 6) m.cells[2][c].terrain = 'road';
    A.rotV = 0;
    A.toolV = { kind: 'object', id: 'bridge', variant: 'road' };
    A.placeObject(5, 2);
    A.placeObject(6, 2);
    return m;
  };

  // River level with the road: the deck must lift clear of the water.
  river(0);
  const flat = A.bridgeOpts(A.map.objects[0]).deckZ;
  ok('deck clears water when the river is not dug', flat >= 5, 'deckZ=' + flat);

  // River dug down: the deck should land level with the bank, not the riverbed.
  const m1 = river(1);
  const o1 = A.map.objects[0];
  const deckAbs = A.surfaceZ(o1.col, o1.row);
  const bankAbs = m1.cells[2][4].height * ALEVEL;
  ok('deck meets the bank when the river is dug one level', deckAbs === bankAbs,
    'deck=' + deckAbs + ' bank=' + bankAbs);

  // Both tiles of the span agree, or the deck would be crooked.
  ok('every tile of the span shares one deck height',
    A.bridgeOpts(A.map.objects[0]).deckZ === A.bridgeOpts(A.map.objects[1]).deckZ);

  // Dug deeper still keeps the deck at the bank.
  const m2 = river(3);
  ok('deck still meets the bank when dug deeper',
    A.surfaceZ(A.map.objects[0].col, A.map.objects[0].row) === m2.cells[2][4].height * ALEVEL);
}

console.log('--- ramps aim at what they climb ---');
{
  const ALEVEL = window.Iso.ALEVEL;
  // Bridge deck raised above the road: the ramp should rise towards it.
  A.setMap(A.createMap('t', 12, 5));
  let m = A.map;
  for (let r = 0; r < 5; r++) for (const c of [5, 6]) m.cells[r][c].terrain = 'water';
  A.rotV = 0;
  A.toolV = { kind: 'object', id: 'bridge', variant: 'road' };
  A.placeObject(5, 2);
  A.toolV = { kind: 'object', id: 'ramp', variant: 'road' };
  A.placeObject(4, 2);
  const ramp = A.map.objects.find(o => o.id === 'ramp');
  const ro = A.rampOpts(ramp);
  ok('ramp rises towards the bridge (+col)', ro.dir === 'col+', ro.dir);
  ok('ramp rise matches the deck height',
    ro.riseZ === A.surfaceZ(5, 2) - m.cells[2][4].height * ALEVEL,
    'riseZ=' + ro.riseZ);
  ok('ramp takes the bridge deck colour', !!ro.deck, JSON.stringify(ro));

  // No bridge: climb the tallest uphill neighbour instead.
  A.setMap(A.createMap('t', 9, 9));
  m = A.map;
  for (let r = 0; r < 9; r++) for (let c = 5; c < 9; c++) m.cells[r][c].height = 3;
  m.cells[3][4].height = 0;
  A.toolV = { kind: 'object', id: 'ramp', variant: 'road' };
  A.placeObject(4, 3);
  const r2 = A.rampOpts(A.map.objects[0]);
  ok('ramp climbs a plain terrace', r2.dir === 'col+' && r2.riseZ === 3 * ALEVEL,
    JSON.stringify(r2));

  // Uphill to -row instead, to prove it is not hardcoded to +col.
  A.setMap(A.createMap('t', 9, 9));
  m = A.map;
  for (let r = 0; r < 4; r++) for (let c = 0; c < 9; c++) m.cells[r][c].height = 2;
  A.toolV = { kind: 'object', id: 'ramp', variant: 'road' };
  A.placeObject(4, 4);
  ok('ramp can face -row', A.rampOpts(A.map.objects[0]).dir === 'row-',
    A.rampOpts(A.map.objects[0]).dir);

  // Flat ground: falls back without throwing or producing a zero-size sprite.
  A.setMap(A.createMap('t', 6, 6));
  A.toolV = { kind: 'object', id: 'ramp', variant: 'road' };
  A.placeObject(3, 3);
  const flatRamp = A.rampOpts(A.map.objects[0]);
  ok('flat ground still yields a usable ramp', flatRamp.riseZ >= 1, JSON.stringify(flatRamp));
  ok('ramp sprite builds for every direction', ['col+', 'col-', 'row+', 'row-'].every(function (d) {
    const spr = window.Iso.objectSprite('ramp', 'road', 0, { dir: d, riseZ: 8 });
    return spr.w > 0 && spr.h > 0;
  }));
}

console.log('--- keyboard tool shortcuts ---');
{
  A.setMap(A.createMap('t', 8, 8));
  // Every shortcut must resolve to a real palette entry, or the key is dead.
  const bound = { q: 'lower', w: 'raise', v: 'level', d: 'erase', n: 'label', m: 'extend', h: 'pan', e: 'pick' };
  for (const key of Object.keys(bound)) {
    A.selectByTool({ kind: bound[key] });
    ok('"' + key + '" selects the ' + bound[key] + ' tool', A.toolV.kind === bound[key],
      'got ' + A.toolV.kind);
  }
  // No two shortcuts may claim the same tool.
  const kinds = Object.values(bound);
  ok('no shortcut collisions', new Set(kinds).size === kinds.length);

  // Raise/lower must actually move ground in opposite directions.
  A.brushV = 1;
  A.selectByTool({ kind: 'raise' });
  A.applyTool(3, 3, false);
  const up = A.map.cells[3][3].height;
  A.selectByTool({ kind: 'lower' });
  A.applyTool(3, 3, false);
  A.applyTool(3, 3, false);
  ok('raise then lower moves ground both ways', up === 1 && A.map.cells[3][3].height === -1,
    'up=' + up + ' now=' + A.map.cells[3][3].height);
}

console.log('--- palette walking ---');
{
  A.setMap(A.createMap('t', 8, 8));
  ok('palette flat index is populated', A.PALETTE_FLAT.length > 50, 'n=' + A.PALETTE_FLAT.length);
  A.PALETTE_FLAT[0].btn.click();
  const first = A.toolV.kind + '|' + (A.toolV.id || '');
  A.stepPalette(1);
  const second = A.toolV.kind + '|' + (A.toolV.id || '');
  ok('next steps to a different item', first !== second, first + ' -> ' + second);
  A.stepPalette(-1);
  ok('previous steps back', (A.toolV.kind + '|' + (A.toolV.id || '')) === first);
  // wraps rather than sticking at the ends
  A.stepPalette(-1);
  ok('stepping past the start wraps', (A.toolV.kind + '|' + (A.toolV.id || '')) !== first);
  const catBefore = A.toolV.kind + '|' + (A.toolV.id || '');
  A.stepCategory(1);
  ok('category step moves somewhere', (A.toolV.kind + '|' + (A.toolV.id || '')) !== catBefore);
}

console.log('--- view helpers ---');
{
  A.setMap(A.createMap('t', 12, 9));
  const ox = A.camera.originX, oy = A.camera.originY;
  A.panBy(40, -25);
  ok('panBy moves the camera', A.camera.originX === ox + 40 && A.camera.originY === oy - 25);
  A.centreOnMap();
  const m = A.metrics(A.camera);
  const c = A.tileXY((A.map.width - 1) / 2, (A.map.height - 1) / 2, 0, A.camera, m);
  const wrapEl = document.getElementById('canvasWrap');
  ok('centreOnMap puts the map middle in the viewport centre',
    Math.abs(c.x - wrapEl.clientWidth / 2) < 1.5 && Math.abs(c.y - wrapEl.clientHeight / 2) < 1.5,
    c.x + ',' + c.y + ' vs ' + (wrapEl.clientWidth / 2) + ',' + (wrapEl.clientHeight / 2));
}

console.log('--- extending reveals the new ground ---');
{
  const wrapEl = document.getElementById('canvasWrap');
  const vw = wrapEl.clientWidth, vh = wrapEl.clientHeight;
  const onScreen = function (tiles) {
    const m = A.metrics(A.camera);
    return tiles.some(function (t) {
      const p = A.tileXY(t.col, t.row, A.heightAt(t.col, t.row), A.camera, m);
      return p.x > 0 && p.x < vw && p.y > 0 && p.y < vh;
    });
  };

  // A map big enough that its far edges start outside the viewport, which is
  // exactly when an extend click used to look like it did nothing.
  for (const side of ['N', 'S', 'W', 'E']) {
    A.setMap(A.createMap('t', 30, 26));
    A.camera.originX = vw / 2;
    A.camera.originY = 90;
    const wasW = A.map.width, wasH = A.map.height;
    ok('extend ' + side + ' grows the map', A.extendMap(side, 4));

    const fresh = [];
    if (side === 'E') for (let r = 0; r < A.map.height; r++) for (let c = wasW; c < A.map.width; c++) fresh.push({ col: c, row: r });
    else if (side === 'W') for (let r = 0; r < A.map.height; r++) for (let c = 0; c < 4; c++) fresh.push({ col: c, row: r });
    else if (side === 'S') for (let r = wasH; r < A.map.height; r++) for (let c = 0; c < A.map.width; c++) fresh.push({ col: c, row: r });
    else for (let r = 0; r < 4; r++) for (let c = 0; c < A.map.width; c++) fresh.push({ col: c, row: r });

    ok('extend ' + side + ' brings the new strip into view', onScreen(fresh));
  }

  // Already-visible tiles must not cause a pointless jump.
  A.setMap(A.createMap('t', 6, 6));
  A.centreOnMap();
  const ox = A.camera.originX, oy = A.camera.originY;
  A.revealTiles([{ col: 3, row: 3 }]);
  ok('revealTiles leaves an on-screen tile alone',
    A.camera.originX === ox && A.camera.originY === oy);
}

console.log('--- the clicked edge handle stays under the pointer ---');
{
  /* Growing an edge shifts its anchor by n tiles — 128x64 at zoom 1, versus a
     42px button. Uncompensated, the arrow slid out from under the pointer and
     every click after the first landed on bare canvas, which is what "the
     button does nothing" actually was. A reveal pan may still nudge it, so the
     bound is the button's own half-width: the cursor must stay on it. */
  const REACH = 21;
  const wrapEl = document.getElementById('canvasWrap');
  for (const side of ['N', 'S', 'W', 'E']) {
    A.setMap(A.createMap('t', 30, 26));
    A.camera.originX = wrapEl.clientWidth / 2;
    A.camera.originY = 90;
    let drifted = null;
    for (let i = 0; i < 5 && !drifted; i++) {
      const before = A.handleSlots(A.camera, A.metrics(A.camera))[side];
      A.extendMap(side, 4);
      const after = A.handleSlots(A.camera, A.metrics(A.camera))[side];
      const dx = after.x - before.x, dy = after.y - before.y;
      if (Math.abs(dx) >= REACH || Math.abs(dy) >= REACH) {
        drifted = `click ${i + 1} moved it by (${dx.toFixed(0)},${dy.toFixed(0)})`;
      }
    }
    ok('repeated ' + side + ' clicks keep the handle under the cursor', !drifted, drifted);
  }

  // With the map comfortably in view there is no reveal pan, so it must not move at all.
  for (const side of ['N', 'S', 'W', 'E']) {
    A.setMap(A.createMap('t', 10, 8));
    A.centreOnMap();
    const before = A.handleSlots(A.camera, A.metrics(A.camera))[side];
    A.extendMap(side, 4);
    const after = A.handleSlots(A.camera, A.metrics(A.camera))[side];
    ok('extend ' + side + ' does not move the handle when the edge is in view',
      Math.abs(after.x - before.x) <= 1 && Math.abs(after.y - before.y) <= 1,
      `(${(after.x - before.x).toFixed(0)},${(after.y - before.y).toFixed(0)})`);
  }

  // Zoom changes the tile size, so a hardcoded offset would not cancel.
  A.setMap(A.createMap('t', 30, 26));
  A.camera.zoom = 2;
  A.camera.originX = 200; A.camera.originY = 60;
  const b = A.handleSlots(A.camera, A.metrics(A.camera)).S;
  A.extendMap('S', 4);
  const a = A.handleSlots(A.camera, A.metrics(A.camera)).S;
  ok('handle stays put when zoomed in',
    Math.abs(a.x - b.x) <= 1 && Math.abs(a.y - b.y) <= 1, `(${a.x - b.x},${a.y - b.y})`);
  A.camera.zoom = 1;
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
