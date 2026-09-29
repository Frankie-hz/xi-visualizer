// node src/terrain.test.ts  (run by `pnpm test`)
import assert from "node:assert";
import type { Ring } from "./regions.ts";
import { putOnGround } from "./terrain.ts";

// Flat ground at y = 10 (y points down, so that is below y = 9).
const flat = () => [10];

// A vertex a little off the ground snaps onto it; one on it stays.
let [out, moved] = putOnGround([[0, 9, 0], [10, 10, 0], [10, 10, 10], [0, 10, 10]], flat);
assert.deepStrictEqual(out.map(v => v[1]), [10, 10, 10, 10]);
assert.strictEqual(moved, 1);

// A spike with no ground near it comes back to its neighbours.
const ring: Ring = [[0, 10, 0], [2, 30, 0], [4, 10, 0], [4, 10, 4], [0, 10, 4]];
[out] = putOnGround(ring, (x, y) => (x === 2 ? [] : [10]));
assert.strictEqual(out[1][1], 10, "the spike is pulled back between its neighbours");

// A ring climbing a hill on long edges keeps its heights: the slope allowance covers them.
const hill: Ring = [[0, 10, 0], [20, 0, 0], [40, 10, 0], [20, 10, 20]];
[out, moved] = putOnGround(hill, (x, y) => [y]);
assert.strictEqual(moved, 0, "a hillside is not a spike");

console.log("ok");
