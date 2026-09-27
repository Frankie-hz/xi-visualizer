// node src/obstacles.test.ts
import assert from "node:assert";
import { cellKey, findObstacles, obstacleArea, obstacleAt, ringAround, ringsAround } from "./obstacles.ts";
import type { Ring } from "./regions.ts";

// A square trunk one yalm across standing on flat ground: four vertical quads (two triangles
// each) from y=0 down to y=-4 (up is negative), plus a floor quad around it that must not count.
function trunk(cx: number, cz: number, half = 0.5, height = 4): number[] {
  const tri = (a: number[], b: number[], c: number[]) => [...a, ...b, ...c];
  const corners = [[cx - half, cz - half], [cx + half, cz - half], [cx + half, cz + half], [cx - half, cz + half]];
  const out: number[] = [];
  for (let i = 0; i < 4; i++) {
    const [x0, z0] = corners[i];
    const [x1, z1] = corners[(i + 1) % 4];
    out.push(...tri([x0, 0, z0], [x1, 0, z1], [x1, -height, z1]));
    out.push(...tri([x0, 0, z0], [x1, -height, z1], [x0, -height, z0]));
  }
  return out;
}
const floor = [
  ...[-20, 0, -20, 20, 0, -20, 20, 0, 20],
  ...[-20, 0, -20, 20, 0, 20, -20, 0, 20],
];

const pos = new Float32Array([...floor, ...trunk(0, 0), ...trunk(10, 0)]);
const found = findObstacles(pos, { cell: 0.5, join: 1 });
assert.strictEqual(found.length, 2, "two trunks, the floor ignored");
const near = found.find(o => Math.hypot(o.x, o.z) < 1)!;
assert.ok(near, "one obstacle sits at the origin");
assert.ok(Math.abs(near.foot - 0) < 1e-6 && Math.abs(near.top + 4) < 1e-6, "foot at the ground, top four yalms up");
assert.ok(obstacleArea(near) >= 1 && obstacleArea(near) <= 4, `a one-yalm trunk covers about a square yalm of cells, got ${obstacleArea(near)}`);

// Two trunks closer than the join distance are one obstacle.
const joined = findObstacles(new Float32Array([...trunk(0, 0), ...trunk(1.6, 0)]), { cell: 0.5, join: 1 });
assert.strictEqual(joined.length, 1, "trunks a yalm apart join up");

// The ring sits a margin out from the trunk all round and is a proper closed shape.
const area = (ring: Ring) =>
  Math.abs(ring.reduce((s, a, i) => {
    const b = ring[(i + 1) % ring.length];
    return s + a[0] * b[2] - b[0] * a[2];
  }, 0)) / 2;
const ring = ringAround(near, 1, 0.5);
assert.ok(ring.length >= 8, `a rounded ring has corners, got ${ring.length}`);
assert.ok(ring.every(v => Math.abs(v[1]) < 1e-6), "the ring sits at the foot height");
const radius = ring.map(v => Math.hypot(v[0], v[2]));
assert.ok(
  Math.min(...radius) >= 1.0 && Math.max(...radius) <= 2.5,
  `every vertex is between 1 and 2.5 yalms out, got ${Math.min(...radius)}..${Math.max(...radius)}`,
);
assert.ok(area(ring) > Math.PI * 1.0 ** 2 && area(ring) < Math.PI * 2.5 ** 2, `ring area is disc-like, got ${area(ring)}`);
const tight = ringAround(near, 0.25, 0.5);
assert.ok(area(tight) < area(ring), "a smaller margin gives a smaller ring");

// Picking by position finds the obstacle under the cursor, within the margin, and nothing far off.
assert.strictEqual(obstacleAt(found, 0.3, 0.2, 1), near);
assert.strictEqual(obstacleAt(found, 1.4, 0, 1), near, "a click inside the margin ring still picks it");
assert.strictEqual(obstacleAt(found, 5, 5, 1), undefined);

// A cliff face is kept out by the caller's filter, not by the finder.
const onlyFirst = findObstacles(pos, { cell: 0.5, keep: t => t < 2 + 8 });
assert.strictEqual(onlyFirst.length, 1, "the keep filter limits which triangles are read");

// Two obstacles whose margins overlap ring as one; far apart they stay two.
const pair = findObstacles(new Float32Array([...trunk(0, 0), ...trunk(3, 0)]), { cell: 0.5, join: 1 });
assert.strictEqual(pair.length, 2, "three yalms apart is two obstacles");
assert.strictEqual(ringsAround(pair, 1, 0.5).length, 1, "but their margin rings meet, so one hole");
assert.strictEqual(ringsAround(pair, 0.25, 0.5).length, 2, "at a small margin they stay two holes");
assert.ok(ringsAround(pair, 1, 0.5)[0].every(v => Math.abs(v[1]) < 1e-6), "merged ring keeps the foot height");

// Ground a mob was recorded on is never ringed: with samples all along x=1.5 the ring stops short.
const walked = new Set<number>();
for (let z = -3; z <= 3; z += 0.25) walked.add(cellKey(1.5, z, 0.5));
const kept = ringsAround([near], 1, 0.5, walked)[0];
assert.ok(kept.length >= 4, "a ring survives the exclusion");
assert.ok(kept.every(v => v[0] <= 1.5 + 1e-9), `no vertex enters the sampled column, got x up to ${Math.max(...kept.map(v => v[0]))}`);
assert.ok(area(kept) < area(ring), "the excluded side makes it smaller");

console.log("ok");
