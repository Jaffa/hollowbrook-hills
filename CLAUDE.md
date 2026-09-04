# CLAUDE.md — working notes for this project

Isometric pixel-art town builder (see `README.md` for what it does from the
user's side). This file is the stuff that is expensive to rediscover.

## Shape of the thing

**No build step, no dependencies, no framework.** Three plain scripts loaded in
order from `index.html`; each attaches one global:

| File | Global | Responsibility |
| --- | --- | --- |
| `iso.js` | `window.Iso` | Software rasteriser, isometric projector, every building/prop definition (96 types, 117 variants) |
| `terrain.js` | `window.Terrain` | Ground tile tops, road/freeway markings, cliff wall sprites (11 terrains) |
| `app.js` | — | Map model, render loop, tools, palette, save/load/PNG export |

Load order matters: `terrain.js` reads `Iso` at parse time, `app.js` reads both.

Sprites are **software-rasterised into offscreen canvases and cached**, then
blitted with `imageSmoothingEnabled = false`. Nothing uses canvas paths for
sprite art — scanline fills keep pixel edges hard. Canvas paths are only used
for the grid, seam lines, hover outlines and labels.

## The projection, and why it bites

```
screen x = (col - row) * hw          hw = 32 screen px at zoom 1
screen y = (col + row) * hh - h * lv hh = 16,  lv = 16
```

Art space is half of screen space: a tile is **32×16 art px**, `PS = 2`, so
64×32 on screen at zoom 1. `ALEVEL = 8` art px per elevation level.

**`lv == hh`.** One elevation level projects to exactly the same screen offset
as one step of grid depth. This is deliberate (it makes cliff faces tile
perfectly) but it has consequences you must respect:

- Tiles `(c, r, h)` and `(c+1, r+1, h+2)` land on the **identical pixel**.
- A slope dropping **two levels per tile is pixel-identical to flat ground**.
  Mitigated by the elevation tint plus seam shading (below) — not fixable
  geometrically.
- Picking cannot be a closed-form inverse. `pickTile` scans **front-to-back**
  (descending `col+row`) and returns the first tile whose top face or cliff
  contains the point. Only ~88% of tile centres are directly clickable on a
  smooth hill; the rest are genuinely hidden. That is inherent, not a bug.

**A tile axis is an exact 2:1 diagonal.** Road markings exploit this: they walk
one half-axis in clean 2-px runs (`axisY`, `halfRange`, `phaseOf` in
`terrain.js`) rather than using a Bresenham line, which wobbles. The dash
period divides the tile span so markings line up across tiles without knowing
their grid position.

**Useful invariant** (currently unused, but it is how you get tile-aligned
texture): `x + 2y` is constant along the row axis, and shifts by 32 per step in
`+col` and 0 per step in `+row`. So any function of `(x + 2y) mod K`, where `K`
divides 32, is continuous across tile boundaries.

**Do not hardcode screen directions.** Derive them. Leaving the map across
`row 0` means *decreasing row*, which projects **up-and-right**; across `col 0`
it is **up-and-left**. I got this wrong once and shipped extend-arrows that
pointed at the wrong edges. `EXTEND_META` in `app.js` carries the derived
vectors and there is a test that re-derives them from the projection.

## Rendering: one pass, one order

`drawWorld()` in `app.js` renders **terrain, grid and objects in a single
depth-ordered pass**. Do not split it back into separate passes.

- Terrain and grid must share the pass or grid lines paint over cliffs in front
  of them.
- Objects must share it or terrain can never occlude a building. Objects are
  bucketed onto the depth of their **front-most footprint corner**
  (`col+fw-1 + row+fh-1`).

Cliff walls are drawn only on a tile's `+col` and `+row` edges, and only when
that neighbour is **lower**. Faces pointing away from the camera need no wall.
Wall depth is per-neighbour, which makes the surface watertight (each wall's
bottom edge lands exactly on the neighbour diamond's upper edge).

A drop away from the camera (`-col` / `-row`) produces no visible cliff, yet the
neighbour lands in the screen slot a same-height tile would — that is the false
plane. Those edges get a dark **seam line**. Keep it.

## Context-specialised sprites — and the trap

`Iso.objectSprite(id, variant, rot, opts)`. `opts` is JSON-stringified into the
cache key and merged over `cfg`, so a sprite can be specialised from map
context. Three objects do this, all routed through **`spriteFor(o)` in
`app.js`** — if you add a fourth, wire it there:

| Object | Derived from map | Function |
| --- | --- | --- |
| `tunnel` | which uphill neighbour's cliff is visible, and its height | `tunnelOpts` |
| `ramp` | adjacent bridge deck, else tallest uphill neighbour | `rampOpts` |
| `bridge` | height of the bank the span runs to | `bridgeOpts` |

> **⚠ `def.zmax` may be a function**, not a number, precisely because of this.
> Never read `OBJECT_DEFS[id].zmax` directly. Ask the sprite: `spriteFor(o).h`.
> Reading it directly produced `NaN` canvas dimensions and silently broke PNG
> export for any map containing a tunnel. There is a regression test.

Terrain caches key on **season and height** as well:
`T.top(terrain, variant, mask, height)`, `T.wall(terrain, side, depth, height)`.
Height drives the elevation tint. `Iso.setSeason` / `Terrain.setSeason` clear
their caches; `app.js:setSeason` calls both and rebuilds the palette.

## Testing — there is no browser here

No Playwright, no Puppeteer, no Chrome extension. Instead:

```bash
node test/sprites.test.js all     # every sprite × variant × rot × season builds non-empty
node test/app.test.js             # 132 assertions on model, tools, geometry, IO
node test/scene.js out.png <preset> <zoom>
```

`test/pngcanvas.js` is a **software 2D canvas plus a PNG encoder** (zlib only).
`test/scene.js` loads the *real* `app.js` under a DOM stub and renders to a PNG
you can then look at with the Read tool. **This is the primary way to verify
visual work — render it and actually look.** It found: a white ring at
crossroads, scattered freeway markings, school buses the size of houses, fences
half a storey tall, a church belfry that read as a black hole, tunnels floating
off their cliffs, and the NaN export hang.

Presets: `town` `roads` `fw2` `terrains` `grid` `objects` `bridge` `ramp`
`street` `village` `checks` `falseplane` `extended`.
Env: `LOAD=map.json` (render a saved map), `SEASON=winter`, `GRID=0`,
`OBJ_FROM`/`OBJ_TO`/`OBJ_COLS` (slice the object sheet — the full sheet is too
big to read usefully).

**How app.js is loaded for testing:** read it as text, append a
`module.exports = { ... }` line, run through `new Function`. To test a new
internal, add it to that export list in `test/app.test.js` (and
`test/scene.js`). Everything in `app.js` is module-scope, so nothing is
importable otherwise.

DOM-stub gotchas that have each cost time:

- A `Proxy` `set` trap must actually store. An early version swallowed
  `putImageData`, so sprites silently came out blank.
- Stub `click()` must invoke the registered handler, or anything routed through
  `btn.click()` (the eyedropper) appears to do nothing.
- Elements need `closest`, `scrollIntoView`, `querySelector`,
  `classList.toggle`, `focus`, `blur`.
- Guard against non-finite coordinates in the software canvas: a `NaN` made the
  Bresenham loop spin forever and looked like a hang.

## Traps and constraints

- **Height range is `±MAX_LEVEL` (±12).** Ground digs below the datum.
  `heightAt` returns `0` out of bounds — that is the datum, and it is what makes
  the map-edge plinth appear. Wall sprite depth can therefore reach `2×MAX_LEVEL`.
- **PNG export must budget both directions**: `maxH` for headroom above and
  `minH` for room below. `exportSize(scale)` is factored out so it is testable.
- **`season` is declared before `createMap` runs.** It used to be declared lower
  down and `createMap` hit a TDZ `ReferenceError` at load.
- **Buildings need flat pads.** Placing one flattens its footprint to the anchor
  tile's height; raising any tile under a building lifts the whole pad.
- **Palette coverage is enforced by test.** Every entry in `Iso.OBJECT_DEFS` and
  `Terrain.DEFS` must appear in `PALETTE` (17 categories) or it is unreachable
  in the UI. Adding a definition without a palette entry fails the suite.
- **Periodic texture reads as corduroy at this scale.** A height-phased hatch
  was tried and rejected by the user; the ground grain is deliberately
  unstructured 1px noise re-seeded per elevation level.
- Roads and freeways share a connectivity *family* (`Terrain.familyOf`) so they
  join; water and ice deliberately do not.
- A freeway is meant to be laid **two tiles wide** — each tile becomes one
  carriageway with the reservation on the shared edge.
- **Growing the map adds ground outside the viewport by definition.** The extend
  buttons were reported as "not working" when in fact every click grew the map
  correctly — the new strip simply appeared off-screen, so nothing visibly
  changed. `extendMap` now calls `revealTiles()` and flashes a hint. Any future
  action whose result lands off-screen needs the same treatment.
- Extend handles are **clamped into the viewport** and marked `.off-edge`
  (dashed) when pinned, because `#canvasWrap` has `overflow: hidden` and a
  handle parked outside it is invisible *and* unclickable. `handleSlots()`
  returns the clamped positions; that — not `edgeHandlePositions()` — is what
  the user actually clicks, so assert against it.
- **A control that moves itself is a control that only works once.** The extend
  arrows were then reported as unreliable — worse on some edges than others.
  Growing an edge moves its handle's anchor by `n` tiles (128×64 px at zoom 1)
  against a 42 px button, so the arrow slid out from under the pointer and
  every click after the first hit bare canvas. The edges that *seemed* to work
  were the ones whose handles were **pinned**, because the clamp held them
  still. `extendMap` now records the handle position before growing and shifts
  the camera to hold it, which also means new ground appears where the old edge
  was and is visible without panning. Tested by clicking each side five times
  and asserting the handle never moves more than half its own width.
- `revealTiles` must not try to **frame** a set of tiles, only ensure one is
  visible. An edge strip is longer than the viewport, so framing it flung the
  map hundreds of pixels to align one end. It also can't use a bounding box: an
  edge strip runs diagonally, so its box can straddle the viewport while every
  tile in it is off screen.
- **A `:active` rule from a plain-element selector can outrank a class.** The
  extend arrows were *still* unreliable after the above — user testing narrowed
  it to "only the bottom-right corner registers a click". `.extend-handle`
  positions itself purely via `transform: translate(-50%, -50%)` (it's centred
  on `left`/`top`, not anchored top-left like ordinary buttons). The sheet-wide
  `button:active { transform: translate(2px, 2px); }` has higher specificity
  (0,1,1) than `.extend-handle` (0,1,0), so on press it doesn't nudge the
  button, it **replaces** the centering transform: the box jumps from
  centred-at-`(cx,cy)` to top-left-at-`(cx+2,cy+2)`, a 23 px shift on a 42 px
  button. Only the ~19×19 px overlap between the rest and pressed boxes — the
  bottom-right corner — stayed clickable at mouseup. Fixed with a
  `.extend-handle:active` rule (specificity 0,2,0, so it wins) that keeps the
  `-50%` centering and presses by 1 px instead, leaving a 41×41 px overlap.
  Any future control whose *only* transform is a centering translate needs its
  own `:active` override rather than inheriting the generic `button:active`.

## Conventions

- Comments explain **why**, not what. Match the surrounding density; several
  files have long stretches with none.
- 2-space indent, `const`/`let`, `function` expressions inside definition
  objects, semicolons.
- Object/terrain definitions are **data-driven**: `genericBuild` in `iso.js`
  covers most buildings from a `cfg` (body height, roof type, windows, sign,
  awning, stacks, steeple, columns…). Reach for a `CUSTOM` builder only for
  shapes it cannot express.
- Roof types available to `genericBuild`: `flat`, `gable`, `gambrel`, `shed`,
  `hip`. `extrude()` handles gable/gambrel/shed from one cross-section, so new
  roof profiles are cheap.

## Recipes

**New building** — add an entry to `B` in `iso.js` (usually just `cfg`; give it
`fw`/`fh`/`zmax`), add a palette entry in `app.js`, run the sprites test, then
render the `objects` preset sliced to your new index and look at it.

**New terrain** — add to `TERRAIN` in `terrain.js` (`base`, `speck`, `lip`,
`rock`, `rockDark`, plus `mask: true` and a `family` if it autotiles), add a
palette entry, render the `terrains` preset.

**New prop** — add a `CUSTOM` builder and a def with `build:`, then a palette
entry. Use the projector `proj.p(cf, rf, z)` and the `box`/`extrude`/`cylinder`/
`pyramid` helpers rather than hand-placing pixels.

**Anything visual** — render a scene and look at it before claiming it works.

**Anything that changes map extent or camera** — check the user can actually see
the result. Silent-but-correct is indistinguishable from broken.

## Debugging UI wiring without a browser

`/tmp`-style throwaway harnesses are worth it: build an element stub whose
`querySelector('[data-side="X"]')` searches tracked children and whose `click()`
invokes the stored handler, then drive the real `syncExtendHandles()` and click
the buttons. That is how the extend-button report was pinned down to "handler
fires, map grows, result off-screen" rather than a dead listener — in about a
minute, and without guessing.
