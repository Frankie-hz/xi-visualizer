// node src/spawn_sim.test.ts  (run by `pnpm test`)
import assert from "node:assert";
import type { Region } from "./regions.ts";
import { indexNav, simulate, snapToNav, triangulate } from "./spawn_sim.ts";

// A deterministic stand-in for Math.random.
let seed = 7;
const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;

// Walkable ground: a 10 x 10 square at y = 0 from x 0..10, z 0..10.
const floor = indexNav([[0, 0, 0, 10, 0, 0, 10, 0, 10, 0, 0, 0, 10, 0, 10, 0, 0, 10]]);

const square = (x0: number, z0: number, size: number): Region => ({
  rings: [[[x0, 0, z0], [x0 + size, 0, z0], [x0 + size, 0, z0 + size], [x0, 0, z0 + size]]],
});

// Drawn by area: two thirds of the draws land in the part twice the size.
const tris = triangulate({ rings: [[[0, 0, 0], [30, 0, 0], [30, 0, 10], [0, 0, 10]]] });
assert.strictEqual(tris.at(-1)!.upTo, 300);

// Standing over the floor, a point drops onto it; beside it, it goes to the nearest edge.
assert.deepStrictEqual(snapToNav(floor, [5, -3, 5])!.map(n => +n.toFixed(3)), [5, 0, 5]);
assert.deepStrictEqual(snapToNav(floor, [14, 0, 5])!.map(n => +n.toFixed(3)), [10, 0, 5]);
assert.strictEqual(snapToNav(floor, [100, 0, 100]), null, "nothing walkable within the pick box");

// A region wholly on the floor keeps every draw.
assert.ok(simulate(square(1, 1, 8), floor, 200, random).every(d => d.ok));

// Half on the floor and half beyond it: past 2.5 yalms off the edge, the snap moves a draw too far.
const half = simulate(square(5, 0, 10), floor, 400, random);
const kept = half.filter(d => d.ok).length / half.length;
assert.ok(kept > 0.65 && kept < 0.85, `about three quarters kept (on the floor, or within 2.5 of it), got ${kept}`);
assert.ok(half.some(d => "why" in d && d.why === "snap moved it"));

// A hole is never drawn from.
const holed: Region = { rings: [...square(0, 0, 10).rings, [[2, 0, 2], [8, 0, 2], [8, 0, 8], [2, 0, 8]]] };
assert.ok(simulate(holed, floor, 300, random).every(d => !(d.at[0] > 2 && d.at[0] < 8 && d.at[2] > 2 && d.at[2] < 8)));

console.log("ok");
