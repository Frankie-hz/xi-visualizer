// node src/map_grid.test.ts  (run by `pnpm test`)
import assert from "node:assert";
import { gridOf, gridPos, sheetOf } from "./map_grid.ts";

// West Ronfaure (100), one map: scale 256, offsets -312, -248. The middle of the zone sits at map
// pixel (312, 248), nine squares right of the margin and seven down.
assert.strictEqual(gridPos(100, 0, 0, 0), "J-8");
// A square is 32 pixels, 160 yalms at this scale; east is right, north is up.
assert.strictEqual(gridPos(100, 0, 160, 0), "K-8");
assert.strictEqual(gridPos(100, 0, 0, 160), "J-7");
// Off the left edge the client's division rounds toward zero, so it still reads A.
assert.strictEqual(gridPos(100, 0, -1600, 0), "A-8");
// No map for the zone, or for that floor of it, and <pos> prints nothing.
assert.strictEqual(gridPos(100, 3, 0, 0), null);
assert.strictEqual(gridPos(9999, 0, 0, 0), null);
assert.strictEqual(gridPos(100, null, 0, 0), null);
// Garlaige Citadel (200): floors pick different sheets, so one spot reads differently by floor.
assert.notStrictEqual(gridPos(200, 1, 0, 0), null);
assert.strictEqual(gridPos(200, 0, 0, 0), null);

// The grid drawn on the map agrees with <pos>: the middle of every square reads as that square.
{
  const grid = gridOf(100, 0)!;
  assert.strictEqual(grid.squares.length, 225);
  assert.strictEqual(grid.lines.length, 32);
  assert.strictEqual(grid.size, 160, "160 yalms a square at West Ronfaure's scale");
  for (const sq of grid.squares) assert.strictEqual(gridPos(100, 0, sq.x, sq.z), sq.name);
  assert.strictEqual(gridOf(100, 3), null);
  assert.strictEqual(gridOf(200, 1)!.squares.length, 225, "Garlaige's floors each have a map");
}

// The map sheet spans the grid: its 16-pixel margins sit outside the A-1 and O-15 corners.
{
  const sheet = sheetOf(100, 0)!;
  const grid = gridOf(100, 0)!;
  const [x, , z] = [grid.lines[0][0], 0, grid.lines[1][1]];
  assert.ok(sheet.x0 < x && sheet.z0 > z, "the sheet starts above and left of the grid");
  assert.strictEqual(sheet.file, "1", "West Ronfaure's sheet is map image 1");
  assert.strictEqual(sheetOf(93, 3)!.file, "z93_3", "a zone whose image numbers are not its own is kept by floor");
  assert.strictEqual(gridPos(100, 0, (sheet.x0 + sheet.x1) / 2, (sheet.z0 + sheet.z1) / 2), "H-8", "its middle is the middle square");
}

console.log("ok");
