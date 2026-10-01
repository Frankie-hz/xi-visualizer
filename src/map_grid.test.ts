// node src/map_grid.test.ts  (run by `pnpm test`)
import assert from "node:assert";
import { gridPos } from "./map_grid.ts";

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

console.log("ok");
