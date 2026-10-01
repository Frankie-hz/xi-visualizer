// node src/obstacles.test.ts
import assert from "node:assert";
import { inRing } from "./geometry.ts";
import { cellKey, cellsInside, emptyPatches, findObstacles, floodPatch, groundNear, obstacleArea, obstacleAt, ringAround, ringsAround } from "./obstacles.ts";
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

const inRingXZ = (ring: Ring, x: number, z: number) => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, , zi] = ring[i], [xj, , zj] = ring[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
};
// Ground a mob was recorded on is never ringed: with samples all along x=1.5 the ring stops short.
const walked = new Set<number>();
for (let z = -3; z <= 3; z += 0.25) walked.add(cellKey(1.5, z, 0.5));
const kept = ringsAround([near], 1, 0.5, walked)[0];
assert.ok(kept.length >= 4, "a ring survives the exclusion");
assert.ok(kept.every(v => v[0] <= 1.5 + 1e-9), `no vertex enters the sampled column, got x up to ${Math.max(...kept.map(v => v[0]))}`);
assert.ok(area(kept) < area(ring), "the excluded side makes it smaller");
for (let z = -3; z <= 3; z += 0.5) assert.ok(!inRingXZ(kept, 1.75, z), `a sampled cell centre at z=${z} stays outside the ring`);

// A mesa: steep walls with a flat top four yalms up. Without a climb the obstacle is its walls;
// with one it takes the top as well, and the floor around it stays out.
const mesa = (() => {
  const out = [...trunk(0, 0, 3, 4)];
  out.push(...[-3, -4, -3, 3, -4, -3, 3, -4, 3], ...[-3, -4, -3, 3, -4, 3, -3, -4, 3]); // the top at y=-4
  return new Float32Array([...floor, ...out]);
})();
const walls = findObstacles(mesa, { cell: 0.5, join: 1 });
const whole = findObstacles(mesa, { cell: 0.5, join: 1, climb: 2 });
assert.strictEqual(walls.length, 1);
assert.strictEqual(whole.length, 1);
assert.ok(obstacleArea(whole[0]) > obstacleArea(walls[0]) + 20, `the climb takes the top: ${obstacleArea(walls[0])} -> ${obstacleArea(whole[0])} y2`);
assert.ok(obstacleArea(whole[0]) < 60, `but not the floor around it: ${obstacleArea(whole[0])} y2`);
assert.ok(whole[0].cells.some(([ix, iz]) => ix === 0 && iz === 0), "the centre of the top is in");

// Mobs recorded on top of a rock: the ring must not enclose them, so it opens a corridor to them.
const onTop = new Set<number>();
for (let x = -0.5; x <= 0.5; x += 0.5) for (let z = -0.5; z <= 0.5; z += 0.5) onTop.add(cellKey(x, z, 0.5));
const opened = ringsAround(findObstacles(mesa, { cell: 0.5, join: 1 }), 1, 0.5, onTop);
assert.ok(opened.length >= 1, "the rock still gets a ring");
assert.ok(!opened.some(r => inRingXZ(r, 0, 0)), "the sampled top is outside every ring");

// A sample near the corner of its cell, beside the ring: the staircase corner next to it stays,
// so no diagonal clips the cell and the sample stays outside.
{
  const avoid = new Set([cellKey(-3.55, 3.05, 0.5)]);
  const o = findObstacles(new Float32Array([...floor, ...trunk(0, 0, 3, 4)]), { cell: 0.5, join: 1 })[0];
  const ring = ringsAround([o], 1, 0.5, avoid)[0];
  const inside = (x: number, z: number) => {
    let ins = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, , zi] = ring[i], [xj, , zj] = ring[j];
      if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) ins = !ins;
    }
    return ins;
  };
  assert.ok(!inside(-3.55, 3.05), "the sample at the corner of its avoided cell is outside the ring");
  assert.ok(!inside(-3.95, 3.45), "and so is the far corner of that cell");
}

// A minimum span keeps the tall faces: a 4-yalm trunk passes at 2, not at 6.
assert.strictEqual(findObstacles(new Float32Array([...floor, ...trunk(0, 0, 0.5, 4)]), { cell: 0.5, minSpan: 2 }).length, 1);
assert.strictEqual(findObstacles(new Float32Array([...floor, ...trunk(0, 0, 0.5, 4)]), { cell: 0.5, minSpan: 6 }).length, 0);

// --- empty patches ---
{
  const outline: Ring = [[0, 0, 0], [20, 0, 0], [20, 0, 20], [0, 0, 20]];
  // Mobs recorded on a ring around the middle, never in it: the middle is an enclosed patch.
  const walked: number[] = [];
  for (let a = 0; a < 360; a += 3) walked.push(cellKey(10 + 5 * Math.cos((a * Math.PI) / 180), 10 + 5 * Math.sin((a * Math.PI) / 180)));
  const near = groundNear(walked, 1);
  assert.ok(near.has(cellKey(10 + 5.9, 10)), "within a yalm of a sample is ground the mobs use");
  assert.ok(!near.has(cellKey(10, 10)), "the middle is not");
  const found = emptyPatches(outline, near, 0.5, 4, 400);
  assert.strictEqual(found.length, 1, "the middle, and not the ground outside the ring, which reaches the outline");
  assert.ok(found[0].has(cellKey(10, 10)));
  // From a spot, the same flood: bounded, and it knows when it ran into the outline.
  assert.ok(!floodPatch(cellKey(10, 10), near, outline, 0.5, 400).touchesEdge);
  assert.ok(floodPatch(cellKey(1, 1), near, outline, 0.5, 4000).touchesEdge);
  assert.ok(floodPatch(cellKey(1, 1), near, outline, 0.5, 10).overBudget, "and stops at its budget");
}

// The per-row answer is the same as walking the ring for every cell, notches and all.
{
  const ring: Ring = [[0, 0, 0], [10, 0, 0.3], [10.2, 0, 7], [5.1, 0, 3.3], [4.7, 0, 9.4], [0.4, 0, 8.8], [2.2, 0, 4.4]];
  const inside = cellsInside(ring, 0.5);
  let disagree = 0, n = 0;
  for (let ix = -2; ix < 24; ix++) {
    for (let iz = -2; iz < 22; iz++) {
      n++;
      if (inside(ix, iz) !== inRing(ring, (ix + 0.5) * 0.5, (iz + 0.5) * 0.5)) disagree++;
    }
  }
  assert.strictEqual(disagree, 0, `cellsInside agrees with inRing on all ${n} cells`);
}

console.log("ok");
