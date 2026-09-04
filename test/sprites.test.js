// Minimal DOM/canvas shim so iso.js + terrain.js can run under node.
class FakeImageData {
  constructor(d, w, h) { this.data = d; this.width = w; this.height = h; }
}
global.ImageData = FakeImageData;

class FakeCanvas {
  constructor() { this.width = 0; this.height = 0; this._img = null; }
  getContext() {
    const self = this;
    return {
      putImageData(img) { self._img = img; },
      drawImage() {},
      fillRect() {},
      set fillStyle(v) {},
      set imageSmoothingEnabled(v) {},
    };
  }
}
global.document = { createElement: (t) => { if (t !== 'canvas') throw new Error('unexpected el ' + t); return new FakeCanvas(); } };
global.window = global;

require(require('path').join(__dirname,'..','iso.js'));
require(require('path').join(__dirname,'..','terrain.js'));

const I = global.Iso, T = global.Terrain;

function stats(cv) {
  const d = cv._img.data;
  let opaque = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 0) opaque++;
  return { w: cv.width, h: cv.height, opaque, total: (d.length / 4) | 0 };
}

// ASCII preview so iso geometry can be eyeballed without a browser.
function ascii(cv, maxW = 74) {
  const d = cv._img.data, W = cv.width, H = cv.height;
  const step = Math.max(1, Math.ceil(W / maxW));
  const ramp = ' .:-=+*#%@';
  const lines = [];
  for (let y = 0; y < H; y += step * 2) {
    let s = '';
    for (let x = 0; x < W; x += step) {
      const i = (y * W + x) * 4;
      if (d[i + 3] === 0) { s += ' '; continue; }
      const lum = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) / 255;
      s += ramp[Math.min(ramp.length - 1, Math.max(1, Math.round(lum * (ramp.length - 1))))];
    }
    lines.push(s.replace(/\s+$/, ''));
  }
  return lines.join('\n');
}

const mode = process.argv[2] || 'all';
let fails = 0;

if (mode === 'all') {
  console.log('=== objects ===');
  for (const id of Object.keys(I.OBJECT_DEFS)) {
    const def = I.OBJECT_DEFS[id];
    const variants = def.variants ? Object.keys(def.variants) : [undefined];
    for (const v of variants) {
      for (const rot of [0, 1]) {
        try {
          const s = I.objectSprite(id, v, rot);
          const st = stats(s.canvas);
          const pct = ((st.opaque / st.total) * 100).toFixed(1);
          if (st.opaque === 0) { console.log(`FAIL empty: ${id}/${v}/${rot}`); fails++; }
          else if (rot === 0 && v === variants[0]) {
            console.log(`  ok ${id.padEnd(12)} ${String(s.fw)}x${s.fh} sprite=${st.w}x${st.h} fill=${pct}% anchor=(${s.ax},${s.ay})`);
          }
        } catch (e) {
          console.log(`FAIL throw: ${id}/${v}/${rot}: ${e.message}`);
          fails++;
        }
      }
    }
  }

  console.log('=== terrain tops ===');
  for (const t of Object.keys(T.DEFS)) {
    const masks = T.DEFS[t].mask ? [0, 1, 5, 15] : [0];
    for (const mk of masks) {
      for (let v = 0; v < (T.DEFS[t].variants || 1); v++) {
        try {
          const st = stats(T.top(t, v, mk));
          if (st.opaque === 0) { console.log(`FAIL empty top: ${t}/${v}/${mk}`); fails++; }
        } catch (e) { console.log(`FAIL top ${t}/${v}/${mk}: ${e.message}`); fails++; }
      }
    }
    console.log(`  ok top ${t}`);
  }

  console.log('=== walls ===');
  for (const t of Object.keys(T.DEFS)) {
    for (let d = 1; d <= I.MAX_LEVEL; d++) {
      for (const side of ['r', 'l']) {
        try {
          const st = stats(T.wall(t, side, d));
          if (st.opaque === 0) { console.log(`FAIL empty wall ${t}/${side}/${d}`); fails++; }
        } catch (e) { console.log(`FAIL wall ${t}/${side}/${d}: ${e.message}`); fails++; }
      }
    }
  }
  console.log('  ok walls');
  console.log(fails ? `\n${fails} FAILURES` : '\nALL SPRITES OK');
  process.exit(fails ? 1 : 0);
} else {
  // preview <id> [variant] [rot]
  const [, , , id, v, rot] = process.argv;
  const s = I.objectSprite(id, v === '-' ? undefined : v, Number(rot || 0));
  console.log(`${id} ${s.fw}x${s.fh}  sprite ${s.w}x${s.h}`);
  console.log(ascii(s.canvas));
}
