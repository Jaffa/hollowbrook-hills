'use strict';
/* Renders a scene with the real app renderer and writes a PNG.
   usage: node test/scene.js <out.png> [preset] [zoom] */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..') + '/';
const { Surface, Ctx, writePng } = require('./pngcanvas');

class FakeImageData {
  constructor(d, w, h) { this.data = d; this.width = w; this.height = h; }
}
global.ImageData = FakeImageData;

function stubCtx(owner) {
  const noop = () => {};
  const target = {
    measureText: t => ({ width: t.length * 6 }),
    putImageData(i) { owner._img = i; },
    canvas: owner,
  };
  return new Proxy(target, {
    get(t, k) { return k in t ? t[k] : noop; },
    set(t, k, v) { t[k] = v; return true; },
  });
}
class FakeCanvas {
  constructor() { this.width = 0; this.height = 0; this._img = null; this._c = stubCtx(this); }
  getContext() { return this._c; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 1200, height: 800 }; }
  addEventListener() {}
  toBlob(cb) { cb({}); }
}
const els = {};
function el(id) {
  if (els[id]) return els[id];
  const e = {
    id, value: '', textContent: '', checked: true, innerHTML: '', files: [], style: {}, dataset: {},
    classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
    querySelector: () => null,
    addEventListener() {}, appendChild() {}, remove() {}, click() {},
    querySelectorAll: () => [], closest: () => null, querySelector: () => null,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1200, height: 800 }),
  };
  if (id === 'mapCanvas') { const cv = new FakeCanvas(); cv.addEventListener = () => {}; cv.classList = e.classList; els[id] = cv; return cv; }
  if (id === 'canvasWrap') { e.clientWidth = 1200; e.clientHeight = 800; }
  if (id === 'mapWidth') e.value = '20';
  if (id === 'mapHeight') e.value = '16';
  if (id === 'exScale') e.value = '2';
  els[id] = e;
  return e;
}
global.document = {
  getElementById: el,
  createElement: t => (t === 'canvas' ? new FakeCanvas() : el('m' + Math.random())),
  querySelectorAll: () => [], querySelector: () => null,
  body: { appendChild() {} },
};
global.window = global;
global.addEventListener = () => {};
global.requestAnimationFrame = () => 0;
global.devicePixelRatio = 1;
global.URL = { createObjectURL: () => 'blob:', revokeObjectURL() {} };
global.Blob = class {};
global.FileReader = class { readAsText() {} };
global.alert = () => {}; global.confirm = () => true; global.prompt = () => 'X';

require(ROOT + 'iso.js');
require(ROOT + 'terrain.js');

const src = fs.readFileSync(ROOT + 'app.js', 'utf8') + `
;module.exports = {
  get map(){return map}, set mapV(m){map=m}, get camera(){return camera},
  set toolV(t){tool=t}, set rotV(r){rot=r},
  createMap, reindex, renderFrame, metrics, tileXY, placeObject, pickTile, spriteFor, extendMap,
  get seasonV(){return typeof season!=='undefined'?season:null},
  setSeason,
};`;
const mod = { exports: {} };
new Function('module', 'exports', 'window', 'document', 'requestAnimationFrame', src)(
  mod, mod.exports, global, global.document, global.requestAnimationFrame);
const A = mod.exports;
const I = global.Iso, T = global.Terrain;

const out = process.argv[2] || 'scene.png';
const preset = process.argv[3] || 'town';
const zoom = parseFloat(process.argv[4] || '2');

function put(id, variant, c, r, rot) {
  A.rotV = rot ? 1 : 0;
  A.toolV = { kind: 'object', id, variant };
  return A.placeObject(c, r);
}

function build(preset) {
  if (preset === 'roads') {
    const m = A.createMap('Roads', 14, 12);
    A.mapV = m; A.reindex();
    for (let r = 0; r < 12; r++) for (let c = 0; c < 14; c++) m.cells[r][c].terrain = 'grass';
    // cross, tee, corners, straights, dead ends, and a 2-wide plaza
    for (let c = 1; c < 13; c++) m.cells[3][c].terrain = 'road';
    for (let r = 1; r < 11; r++) m.cells[r][6].terrain = 'road';
    for (let c = 8; c < 12; c++) m.cells[7][c].terrain = 'road';
    m.cells[7][8].terrain = 'road'; m.cells[8][8].terrain = 'road'; m.cells[9][8].terrain = 'road';
    m.cells[9][2].terrain = 'road'; m.cells[9][3].terrain = 'road'; m.cells[8][3].terrain = 'road';
    m.cells[5][2].terrain = 'road';
    if (T.DEFS.freeway) { for (let c = 1; c < 13; c++) m.cells[11][c].terrain = 'freeway'; }
    return m;
  }
  if (preset === 'bridge') {
    const m = A.createMap('Bridge', 14, 10);
    A.mapV = m; A.reindex();
    // river across the middle, road approaching from both sides
    for (let r = 0; r < 10; r++) for (let c = 0; c < 14; c++) {
      if (c >= 5 && c <= 6) m.cells[r][c].terrain = 'water';
    }
    for (let c = 0; c < 14; c++) if (c < 5 || c > 6) m.cells[4][c].terrain = 'road';
    put('bridge', 'road', 5, 4, 0);
    put('bridge', 'road', 6, 4, 0);
    put('bridge', 'wood', 5, 7, 0);
    put('bridge', 'wood', 6, 7, 0);
    // hillside with a tunnel portal cut into its face
    for (let r = 0; r < 10; r++) for (let c = 9; c < 14; c++) {
      m.cells[r][c].height = Math.min(3, c - 8);
    }
    for (let r = 0; r < 10; r++) m.cells[r][9].height = 0;
    for (let r = 0; r < 10; r++) for (let c = 10; c < 14; c++) m.cells[r][c].height = 3;
    put('tunnel', 'stone', 10, 4, 0);
    put('pine', undefined, 11, 2, 0);
    put('pine', undefined, 12, 6, 0);
    return m;
  }
  if (preset === 'village') {
    const m = A.createMap('Village', 13, 11);
    A.mapV = m; A.reindex();
    for (let c = 1; c < 12; c++) m.cells[5][c].terrain = 'road';
    for (let r = 0; r < 11; r++) for (let c = 0; c < 13; c++) {
      if (r > 7 && c < 4) m.cells[r][c].terrain = 'water';
    }
    put('house', 'red', 2, 2, 0); put('house', 'blue', 5, 2, 0);
    put('church', undefined, 8, 1, 0);
    put('store', 'video', 2, 7, 0); put('diner', undefined, 6, 7, 0);
    put('oak', 'green', 11, 3, 0); put('pine', undefined, 12, 6, 0);
    put('oak', 'green', 4, 4, 0);
    put('fence', 'picket', 1, 4, 0); put('fence', 'picket', 2, 4, 0);
    put('fence', 'picket', 3, 4, 0);
    put('streetlight', undefined, 7, 4, 0);
    put('car', 'red', 9, 5, 0);
    put('snowman', undefined, 9, 3, 0);
    put('xmastree', undefined, 10, 8, 0);
    put('jackolantern', undefined, 5, 4, 0);
    put('scarecrow', undefined, 11, 9, 0);
    put('swing', undefined, 8, 9, 0);
    put('slide', undefined, 9, 9, 0);
    return m;
  }
  if (preset === 'street') {
    const m = A.createMap('Street', 15, 12);
    A.mapV = m; A.reindex();
    for (let c = 1; c < 14; c++) m.cells[6][c].terrain = 'road';
    for (let c = 1; c < 14; c++) { m.cells[5][c].terrain = 'gravel'; m.cells[7][c].terrain = 'gravel'; }
    // fence run along the top, each style in turn
    const styles = ['picket', 'split', 'chain', 'stone', 'hedge', 'gate'];
    styles.forEach((v, i) => { put('fence', v, 2 + i * 2, 2, 0); put('fence', v, 2 + i * 2 + 1, 2, 0); });
    const furniture = ['streetlight', 'stopsign', 'trafficlight', 'streetsign', 'hydrant',
      'mailbox', 'trashcan', 'dumpster', 'bikerack', 'phonebooth', 'busstop', 'powerpole'];
    furniture.forEach((id, i) => put(id, undefined, 1 + i, 4, 0));
    const play = ['swing', 'slide', 'seesaw', 'sandbox', 'roundabout', 'climbframe', 'hoop',
      'bench', 'picnic', 'fountain', 'statue', 'pool', 'well'];
    play.forEach((id, i) => put(id, undefined, 1 + i, 9, 0));
    const veh = ['pickup', 'van', 'schoolbus', 'policecar', 'firetruck', 'ambulance', 'icecreamvan', 'tractor'];
    veh.forEach((id, i) => put(id, undefined, 1 + i, 6, 0));
    return m;
  }
  if (preset === 'checks') {
    const m = A.createMap('Checks', 22, 16);
    A.mapV = m; A.reindex();
    // (a) terracing to show the elevation tint: a staircase of plateaus
    for (let r = 0; r < 16; r++) for (let c = 0; c < 22; c++) {
      m.cells[r][c].height = c < 10 ? Math.floor(c / 2) - 2 : 0;
    }
    // (b) a building behind a tall ridge: terrain must occlude it
    for (let r = 0; r < 16; r++) m.cells[r][11].height = 7;
    put('house', 'red', 12, 4, 0);      // behind the ridge (lower depth)
    put('house', 'blue', 10, 10, 0);    // in front of the ridge
    // (c) a dug pit below datum
    for (let r = 9; r < 13; r++) for (let c = 14; c < 19; c++) m.cells[r][c].height = -4;
    for (let r = 10; r < 12; r++) for (let c = 15; c < 18; c++) m.cells[r][c].terrain = 'water';
    // (d) a two-tile-wide freeway
    for (let c = 13; c < 22; c++) { m.cells[2][c].terrain = 'freeway'; m.cells[3][c].terrain = 'freeway'; }
    put('car', 'red', 15, 2, 0);
    put('pickup', undefined, 18, 3, 0);
    return m;
  }
  if (preset === 'fw2') {
    const m = A.createMap('FW', 12, 10);
    A.mapV = m; A.reindex();
    // 2-wide running along col, and a 2-wide running along row
    for (let c = 0; c < 12; c++) { m.cells[3][c].terrain = 'freeway'; m.cells[4][c].terrain = 'freeway'; }
    for (let r = 5; r < 10; r++) { m.cells[r][8].terrain = 'freeway'; m.cells[r][9].terrain = 'freeway'; }
    // a single-tile freeway for comparison
    for (let c = 1; c < 6; c++) m.cells[8][c].terrain = 'freeway';
    put('car', 'red', 3, 3, 0);
    put('car', 'blue', 6, 4, 0);
    put('pickup', undefined, 9, 6, 1);
    return m;
  }
  if (preset === 'extended') {
    const m = A.createMap('Ext', 8, 6);
    A.mapV = m; A.reindex();
    for (let r = 0; r < 6; r++) for (let c = 0; c < 8; c++) {
      m.cells[r][c].height = (c === 0 || r === 0) ? 3 : 0;
      if (c === 0) m.cells[r][c].terrain = 'rock';
      if (r === 5) m.cells[r][c].terrain = 'sand';
    }
    for (let c = 1; c < 8; c++) m.cells[2][c].terrain = 'road';
    put('house', 'red', 3, 3, 0);
    put('watertower', undefined, 5, 3, 0);
    A.extendMap('E', 4); A.extendMap('S', 4); A.extendMap('W', 4); A.extendMap('N', 4);
    return A.map;
  }
  if (preset === 'falseplane') {
    const m = A.createMap('FalsePlane', 14, 14);
    A.mapV = m; A.reindex();
    // Left half: a slope dropping exactly two levels per row towards -row.
    // In this projection that is pixel-identical to flat ground.
    // Kept inside the +/-12 range so every row gets its own tint band.
    for (let r = 0; r < 14; r++) for (let c = 0; c < 7; c++) {
      m.cells[r][c].height = Math.max(-10, Math.min(10, (r - 8) * 2));
    }
    // Right half: genuinely flat, for comparison.
    for (let r = 0; r < 14; r++) for (let c = 8; c < 14; c++) m.cells[r][c].height = 0;
    // A few terraces at single-level steps too.
    for (let r = 2; r < 6; r++) for (let c = 9; c < 13; c++) m.cells[r][c].height = r - 1;
    return m;
  }
  if (preset === 'ramp') {
    const m = A.createMap('Ramp', 14, 11);
    A.mapV = m; A.reindex();
    // A river cut one level down, road approaching from both banks.
    for (let r = 0; r < 11; r++) for (let c = 6; c <= 7; c++) {
      m.cells[r][c].terrain = 'water';
      m.cells[r][c].height = -1;
    }
    for (let c = 0; c < 14; c++) if (c < 6 || c > 7) m.cells[3][c].terrain = 'road';
    put('ramp', 'road', 5, 3, 0);
    put('bridge', 'road', 6, 3, 0);
    put('bridge', 'road', 7, 3, 0);
    put('ramp', 'road', 8, 3, 0);
    put('car', 'red', 4, 3, 0);

    // And a ramp climbing a plain terrace, no bridge involved.
    for (let r = 6; r < 11; r++) for (let c = 3; c < 12; c++) m.cells[r][c].height = 2;
    for (let c = 0; c < 3; c++) m.cells[8][c].terrain = 'road';
    for (let c = 4; c < 12; c++) m.cells[8][c].terrain = 'road';
    put('ramp', 'road', 3, 8, 0);
    return m;
  }
  if (preset === 'terrains') {
    const keys = Object.keys(T.DEFS);
    const m = A.createMap('Terrains', keys.length + 2, 4);
    A.mapV = m; A.reindex();
    keys.forEach((k, i) => { for (let r = 1; r <= 2; r++) m.cells[r][i + 1].terrain = k; });
    return m;
  }
  if (preset === 'grid') {
    const m = A.createMap('Grid', 12, 12);
    A.mapV = m; A.reindex();
    // stepped tower to exercise grid occlusion on cliffs
    for (let r = 0; r < 12; r++) for (let c = 0; c < 12; c++) {
      const d = Math.max(Math.abs(c - 3), Math.abs(r - 8));
      m.cells[r][c].height = Math.max(0, 5 - d);
    }
    for (let r = 2; r < 6; r++) for (let c = 7; c < 11; c++) m.cells[r][c].height = 3;
    put('watertower', undefined, 8, 3, 0);
    return m;
  }
  if (preset === 'objects') {
    let ids = Object.keys(I.OBJECT_DEFS);
    if (process.env.OBJ_FROM || process.env.OBJ_TO) {
      ids = ids.slice(parseInt(process.env.OBJ_FROM || '0', 10), parseInt(process.env.OBJ_TO || '999', 10));
    }
    const cols = parseInt(process.env.OBJ_COLS || '8', 10);
    const m = A.createMap('Objects', cols * 5 + 2, Math.ceil(ids.length / cols) * 5 + 2);
    A.mapV = m; A.reindex();
    ids.forEach((id, i) => {
      const c = 1 + (i % cols) * 5, r = 1 + Math.floor(i / cols) * 5;
      const def = I.OBJECT_DEFS[id];
      const v = def.variants ? Object.keys(def.variants)[0] : undefined;
      put(id, v, c, r, 0);
    });
    return m;
  }
  // default town
  const m = A.createMap('Town', 20, 16);
  A.mapV = m; A.reindex();
  for (let r = 0; r < 16; r++) for (let c = 0; c < 20; c++) {
    m.cells[r][c].height = c > 14 ? Math.min(3, c - 14) : 0;
  }
  for (let c = 2; c < 18; c++) m.cells[6][c].terrain = 'road';
  for (let r = 2; r < 13; r++) m.cells[r][9].terrain = 'road';
  for (let r = 9; r < 12; r++) for (let c = 2; c < 6; c++) m.cells[r][c].terrain = 'water';
  put('house', 'red', 3, 3, 0); put('house', 'blue', 6, 3, 0);
  put('store', 'arcade', 11, 3, 0); put('diner', undefined, 14, 3, 0);
  put('church', undefined, 11, 8, 0); put('barn', undefined, 2, 13, 0);
  put('oak', 'green', 8, 12, 0); put('pine', undefined, 7, 12, 0);
  put('watertower', undefined, 16, 10, 0);
  return m;
}

if (process.env.SEASON) A.setSeason(process.env.SEASON);
let m;
if (process.env.LOAD) {
  // Render a saved map exactly as the app would after loading it.
  const data = JSON.parse(fs.readFileSync(process.env.LOAD, 'utf8'));
  for (const row of data.cells) for (const c of row) {
    if (typeof c.height !== 'number') c.height = 0;
    if (typeof c.tv !== 'number') c.tv = 0;
  }
  data.objects = (data.objects || []).filter(o => !!I.OBJECT_DEFS[o.id]);
  A.mapV = data; A.reindex();
  m = data;
} else {
  m = build(preset);
}
A.reindex();

// fit the camera to the whole map
const met = A.metrics({ originX: 0, originY: 0, zoom });
let maxH = 0, tallest = 0;
for (let r = 0; r < m.height; r++) for (let c = 0; c < m.width; c++) maxH = Math.max(maxH, m.cells[r][c].height);
for (const o of m.objects) tallest = Math.max(tallest, A.spriteFor(o).h);
const pad = 16 * zoom;
const headroom = (maxH * I.ALEVEL + tallest) * met.s + 20 * zoom;
const W = Math.ceil((m.width + m.height) * met.hw + pad * 2);
const H = Math.ceil((m.width + m.height) * met.hh + headroom + pad);
const cam = { originX: pad + m.height * met.hw, originY: headroom, zoom };

const surf = new Surface(W, H);
const ctx = new Ctx(surf);
ctx.fillStyle = '#181228';
ctx.fillRect(0, 0, W, H);
const showGrid = process.env.GRID !== '0';
A.renderFrame(ctx, cam, { grid: showGrid, labels: false, hover: false });
writePng(surf, out);
console.log(`${out}  ${W}x${H}  preset=${preset} zoom=${zoom} grid=${showGrid ? 'on' : 'off'}`);
