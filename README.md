# Hollowbrook Hills — Isometric Town Builder

A pixel-art isometric map builder for tabletop games, built for a **Kids on Bikes**
campaign set in an 1980s Minnesota / mid-Western town. Draw the town, name the
places your players will visit, and export a PNG for your campaign notes.

No install, no build step, no dependencies — **open `index.html` in a browser**.

---

## Getting started

1. Open `index.html`.
2. Pick something from the palette on the left (or press `/` and type to search).
3. Click or drag on the map to place it.
4. **Save** writes a `.json` you can reload later; **PNG** exports a picture.

Everything lives in the browser — nothing is uploaded anywhere.

## Building a town

**Ground.** Grass, cornfield, dirt, gravel, sand, snow, bare rock, water, ice,
road and freeway. Roads and rivers join themselves up automatically: lay two
road tiles side by side and the lane markings connect, with junction gaps and
kerbs worked out for you.

**Draw modes** (top toolbar) save a lot of clicking:

| Mode | What it does |
| --- | --- |
| **Free** | Paint one tile at a time |
| **Line** | Drag a straight run — ideal for roads |
| **Rect** | Drag a filled rectangle |
| **Fill** | Flood-fill an area of matching ground |

**Buildings** come in footprints from 1×1 up to 4×3 — houses, Main Street
shops, a diner, arcade, cinema, school, church, town hall, factory, barn, water
tower, and a suitably ominous government lab. Press `R` to rotate before
placing. A red outline means it will not fit.

Buildings need level ground, so placing one flattens its footprint, and raising
any tile under a building lifts the whole pad together.

**Props** — fences (picket, split-rail, chain-link, stone, hedge), playground
equipment, street furniture, vehicles, trees and seasonal decorations.

## Hills and valleys

**W** raises ground, **Q** lowers it, **V** levels an area to the first tile you
click. Hold **Alt** to invert whichever you are using. `[` and `]` change the
brush size.

Ground goes **below** the starting level as well as above, so you can dig
cuttings, quarries and sunken riverbeds. Higher ground is drawn slightly
lighter and lower ground slightly darker, which is what lets you read terraces
at a glance.

### Bridges and tunnels

Both work out their surroundings for you:

- **Bridges** set their deck level with the bank they run to (while still
  clearing the water). The tidiest crossing is to **dig the river down a level
  or two**, then lay bridge tiles across — the road then meets the deck flush.
- **Ramps** slope up to whatever they are next to: an adjacent bridge deck, or
  the tallest uphill neighbour. Drop one at each end of a bridge and the road
  joins cleanly.
- **Tunnel portals** cut an arch into the cliff face beside them, sized to that
  cliff. Place one on the *low* tile at the foot of the cliff.

### Growing the map

Pick the **Extend Map Edge** tool (`M`). Four arrows appear just off the map's
edges; hovering one highlights the strip it will duplicate, and clicking adds
four tiles on that side. New ground inherits the terrain *and* height of the
edge it grows from, so hills and rivers carry on rather than stopping dead, and
the status line confirms the new size.

The arrow **stays put under your pointer**, so you can click it repeatedly to
keep growing that edge. The map slides away from it instead, which means the
new ground always appears right where you are looking.

If an edge is scrolled out of view its arrow stays reachable, pinned to the side
of the window and drawn with a dashed border.

Remember this is an isometric view: the map's four edges run diagonally, so the
arrows sit at the top-left, top-right, bottom-left and bottom-right.

The `W`/`H` boxes in the header set an exact size instead, cropping from the far
edges.

## Seasons

The **Season** menu retints the whole map, not just the props: ground colours
shift, oaks turn gold then bare and snow-dusted, pines pick up snow, roofs gain
snow caps, and Christmas adds coloured lights along the eaves. The Halloween,
Christmas and Easter prop groups stay available whichever season you pick, so
you can build a Halloween street in high summer.

## Naming places

Use **Name a Place** (`N`) on a building or a bare tile. Named spots collect in
the **Legend** panel on the right — click one to jump the view to it. Handy for
handing a list of locations to your players.

## Keyboard

| | |
| --- | --- |
| `W` / `Q` / `V` | Raise / lower / level ground |
| `Alt` + drag | Invert raise & lower |
| `[` `]` | Brush size |
| `E` | Eyedropper (copy what's under the cursor) |
| `D` | Erase building |
| `N` | Name a place |
| `M` | Extend map edge |
| `H` | Pan tool |
| `R` | Rotate building |
| `/` | Search the palette |
| `,` `.` | Previous / next palette item |
| `<` `>` | Previous / next palette category |
| `F` `L` `B` `X` | Free / Line / Rect / Fill |
| `Del` | Remove the building under the cursor |
| `Esc` | Cancel a drag |
| `Ctrl+Z` / `Ctrl+Y` | Undo / redo |
| Arrow keys | Pan (hold `Shift` to go faster) |
| `C` | Centre on the map |
| `0` | Zoom to 100% |
| `+` `−` / wheel | Zoom |
| `G` | Grid on/off |
| Right-drag | Pan |

## Saving and exporting

**Save** produces a `.json` holding the whole map — ground, heights, buildings,
names and season. **Load** reads it back; older files from earlier versions are
migrated automatically.

**PNG** exports the full map regardless of where the view is scrolled, at 1×, 2×
or 3× scale, with optional grid lines, place names and a transparent background.

## A note on the isometric view

A steep hill can hide tiles behind it — there is no way around that in an
isometric projection. Lower the tile in front, or pan around, to reach them.

For the same reason, a slope that drops two levels per tile is drawn in exactly
the same place as flat ground would be. The elevation shading and the darker
seam lines on hidden drops are there to keep those cases readable.

## Files

| File | |
| --- | --- |
| `index.html` | Page and toolbar |
| `style.css` | Styling |
| `iso.js` | Isometric sprite engine and every building/prop definition |
| `terrain.js` | Ground tiles, road markings, cliff faces |
| `app.js` | Map model, rendering, tools, save/load/export |
| `test/` | Headless test suite (see `CLAUDE.md`) |
