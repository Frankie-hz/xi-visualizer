// node src/density.test.ts  (run by `pnpm test`)
import assert from "node:assert";
import { densityBands } from "./density.ts";
import type { Spawn } from "./regions.ts";

const spawn = (id: string, at?: [number, number, number]): Spawn => ({ id, name: "m", x: at?.[0] ?? 0, y: at?.[1] ?? 0, z: at?.[2] ?? 0, at });
// Ten mobs in a 20-yalm square region at the origin, one fixed mob far off, and one on a placeholder.
const regions = { camp: { rings: [[[-10, 0, -10], [10, 0, -10], [10, 0, 10], [-10, 0, 10]]] } } as never;
const spawns = [...Array.from({ length: 10 }, (_, i) => spawn(`r${i}`)), spawn("far", [300, 0, 300]), spawn("nowhere", [1, 1, 1])];
const assign = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`r${i}`, ["camp"]]));
const bands = densityBands(spawns, regions, assign, {});
assert.ok(bands.length >= 3, "several bands");
const top = bands[bands.length - 1];
const inside = (x: number, z: number, b: typeof top) =>
  b.polygons.some(([outline]) => {
    let hit = false;
    for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
      const [xi, zi] = outline[i], [xj, zj] = outline[j];
      if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) hit = !hit;
    }
    return hit;
  });
assert.ok(inside(0, 0, top), "the densest band is on the camp");
assert.ok(!inside(300, 300, top), "not on the lone mob");
assert.ok(!bands.some(b => inside(1, 1, b) && !inside(0, 0, b)), "the placeholder adds nothing");
assert.deepStrictEqual(densityBands([], regions, {}, {}), []);

console.log("ok");
